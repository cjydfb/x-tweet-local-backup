/* ============================================================================
 * media-cache.js  —  OPTIONAL module: download media blobs into the extension's
 * IndexedDB so the archive stays readable offline.
 *
 * DESIGN CONSTRAINTS (all intentional)
 *   - Fully asynchronous and strictly off the critical path: the tweet text is
 *     already committed before a single byte is downloaded.
 *   - Any failure here is recorded as a counter and then ignored. It can never
 *     affect the tweet record.
 *   - Only ever contacts pbs.twimg.com / video.twimg.com, and only when the user
 *     has explicitly granted those optional host permissions from the popup.
 *   - Uses plain fetch with credentials omitted. It never touches, modifies or
 *     replays any x.com request; it is a separate read of a public CDN URL.
 *   - Bounded: per-file cap, total cache cap, and a small concurrency window so
 *     a media-heavy timeline cannot blow up IndexedDB or the service worker.
 * ========================================================================== */

import { getMediaRecord, putMediaRecord } from './db.js';

export const MEDIA_HOSTS = ['pbs.twimg.com', 'video.twimg.com'];
export const MEDIA_ORIGINS = ['https://pbs.twimg.com/*', 'https://video.twimg.com/*'];

const MAX_FILE_BYTES = 15 * 1024 * 1024;        // per file
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;      // whole media store
const FETCH_TIMEOUT_MS = 30000;
const MAX_MEDIA_PER_TWEET = 8;

let runningTotalBytes = null;   // lazily measured once per service-worker life
let activeDownloads = 0;
const MAX_CONCURRENT = 2;

/* -------------------------------------------------------------------------- */
/* Permission helpers                                                         */
/* -------------------------------------------------------------------------- */

export function hasMediaPermission() {
  return new Promise((resolve) => {
    try {
      if (!chrome || !chrome.permissions || typeof chrome.permissions.contains !== 'function') {
        resolve(false);
        return;
      }
      chrome.permissions.contains({ origins: MEDIA_ORIGINS }, (granted) => {
        try {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
        } catch (_) { /* ignore */ }
        resolve(granted === true);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

export function requestMediaPermission() {
  return new Promise((resolve) => {
    try {
      if (!chrome || !chrome.permissions || typeof chrome.permissions.request !== 'function') {
        resolve(false);
        return;
      }
      chrome.permissions.request({ origins: MEDIA_ORIGINS }, (granted) => {
        try {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
        } catch (_) { /* ignore */ }
        resolve(granted === true);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

/** Protocol + host allow-list. Applied to every URL before it is fetched. */
export function isAllowedMediaUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return MEDIA_HOSTS.indexOf(url.hostname.toLowerCase()) !== -1;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function pickBestSource(media) {
  if (!media || typeof media !== 'object') return null;

  const variants = Array.isArray(media.variants) ? media.variants : [];
  if (media.type === 'video' || media.type === 'animated_gif') {
    let best = null;
    for (const variant of variants) {
      if (!variant || typeof variant !== 'object') continue;
      const contentType = typeof variant.contentType === 'string' ? variant.contentType : '';
      if (contentType.indexOf('video/mp4') === -1) continue;
      if (!isAllowedMediaUrl(variant.url)) continue;
      const bitrate = typeof variant.bitrate === 'number' ? variant.bitrate : 0;
      if (best === null || bitrate > best.bitrate) best = { url: variant.url, bitrate: bitrate };
    }
    if (best !== null) return best.url;
  }

  if (isAllowedMediaUrl(media.url)) {
    // For photos, ask twimg for a reasonably large but not original-size render.
    if (media.type === 'photo' || media.type === null || media.type === undefined) {
      return media.url + (media.url.indexOf('?') === -1 ? '?' : '&') + 'name=large';
    }
    return media.url;
  }
  return null;
}

async function measureStore(db) {
  if (runningTotalBytes !== null) return runningTotalBytes;
  let total = 0;
  try {
    await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction('media', 'readonly');
      } catch (_) {
        resolve();
        return;
      }
      const request = tx.objectStore('media').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const value = cursor.value;
        if (value && typeof value.size === 'number' && Number.isFinite(value.size)) {
          total += value.size;
        }
        cursor.continue();
      };
      request.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch (_) {
    total = 0;
  }
  runningTotalBytes = total;
  return runningTotalBytes;
}

async function fetchBlob(url) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller !== null
    ? setTimeout(() => {
        try {
          controller.abort();
        } catch (_) { /* ignore */ }
      }, FETCH_TIMEOUT_MS)
    : null;

  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      mode: 'cors',
      cache: 'force-cache',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller !== null ? controller.signal : undefined
    });

    if (!response || response.ok !== true) {
      return { ok: false, reason: 'http ' + (response ? response.status : 'unknown') };
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
      return { ok: false, reason: 'file larger than cap' };
    }

    const blob = await response.blob();
    if (!blob || typeof blob.size !== 'number') return { ok: false, reason: 'no blob' };
    if (blob.size === 0) return { ok: false, reason: 'empty blob' };
    if (blob.size > MAX_FILE_BYTES) return { ok: false, reason: 'blob larger than cap' };

    return {
      ok: true,
      blob: blob,
      contentType: blob.type || response.headers.get('content-type') || null
    };
  } catch (err) {
    return { ok: false, reason: (err && err.message) ? String(err.message) : 'fetch failed' };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Cache the media of one tweet. Never throws.
 * Returns { cached, skipped, failed } counters.
 */
export async function cacheMediaForTweet(db, tweet, options) {
  const result = { cached: 0, skipped: 0, failed: 0, reason: null };

  try {
    const opts = options || {};
    if (!tweet || typeof tweet !== 'object') return result;
    if (typeof tweet.id !== 'string' || !Array.isArray(tweet.media) || tweet.media.length === 0) {
      return result;
    }

    const granted = await hasMediaPermission();
    if (!granted) {
      result.reason = 'media host permission not granted';
      return result;
    }

    const total = await measureStore(db);
    let budget = MAX_TOTAL_BYTES - total;

    const items = tweet.media.slice(0, MAX_MEDIA_PER_TWEET);

    for (let index = 0; index < items.length; index++) {
      const media = items[index];
      if (!media || typeof media !== 'object') continue;

      const mediaId = (typeof media.id === 'string' && media.id.length > 0)
        ? media.id
        : String(index);
      const key = tweet.id + ':' + mediaId;

      try {
        const existing = await getMediaRecord(db, key);
        if (existing) {
          result.skipped++;
          continue;
        }
      } catch (_) { /* treat a read failure as "not cached" */ }

      const sourceUrl = pickBestSource(media);
      if (sourceUrl === null) {
        result.skipped++;
        continue;
      }

      if (budget <= 0) {
        result.skipped++;
        result.reason = 'media cache budget exhausted';
        continue;
      }

      while (activeDownloads >= MAX_CONCURRENT) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      activeDownloads++;

      let downloaded;
      try {
        downloaded = await fetchBlob(sourceUrl);
      } finally {
        activeDownloads--;
      }

      if (!downloaded.ok) {
        result.failed++;
        result.reason = downloaded.reason || 'download failed';
        continue;
      }

      if (downloaded.blob.size > budget) {
        result.skipped++;
        result.reason = 'media cache budget exhausted';
        continue;
      }

      try {
        await putMediaRecord(db, {
          key: key,
          tweetId: tweet.id,
          mediaId: mediaId,
          type: typeof media.type === 'string' ? media.type : null,
          sourceUrl: sourceUrl,
          contentType: downloaded.contentType,
          size: downloaded.blob.size,
          width: typeof media.width === 'number' ? media.width : null,
          height: typeof media.height === 'number' ? media.height : null,
          altText: typeof media.altText === 'string' ? media.altText : null,
          cachedAt: new Date().toISOString(),
          blob: downloaded.blob
        });
        runningTotalBytes = (runningTotalBytes === null ? 0 : runningTotalBytes) + downloaded.blob.size;
        budget -= downloaded.blob.size;
        result.cached++;
      } catch (err) {
        result.failed++;
        result.reason = (err && err.message) ? String(err.message) : 'IndexedDB write failed';
      }
    }
  } catch (err) {
    result.failed++;
    result.reason = (err && err.message) ? String(err.message) : 'unexpected media cache error';
  }

  return result;
}
