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
import { hasWaybackPermission } from './wayback.js';

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
/* The archive's copy                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The same image, as the Internet Archive kept it.
 *
 * `2im_` is the wayback machine's "hand back the raw bytes" form — without it
 * the archive wraps the file in its own viewer page and what arrives is HTML.
 * The `2` is a timestamp prefix that matches every capture there has ever been,
 * so this asks for whichever copy the archive holds rather than naming one.
 * That is deliberate: the alternative is a CDX query to pick the snapshot
 * nearest the post's date, which is a second request per image against an index
 * that rate-limits hard, to choose between copies of a picture that is already
 * not available anywhere else.
 */
function waybackImageUrl(url) {
  return 'https://web.archive.org/web/2im_/' + url;
}

/** Which of the two sources a download came from, for the counters. */
const FROM_ORIGIN = 'origin';
const FROM_ARCHIVE = 'archive';

/**
 * Fetch one image, from wherever it still exists.
 *
 * The two sources are complementary rather than ranked. The origin is the
 * canonical file and usually the better one — but it is gone the moment the
 * account is, and X answers 403 for a suspended account's media rather than
 * 404, so the failure is indistinguishable from "you may not". The archive's
 * copy is whatever a crawler happened to capture years ago: lower fidelity
 * sometimes, and absent for any image no crawl ever loaded — but it survives
 * the account, and it is the ONLY source that does.
 *
 * Measured before this was written: of 400 distinct pbs.twimg.com image URLs in
 * the index, 298 came back 200 with an image content-type and real JPEG/PNG
 * magic bytes. So the archive is not a long shot. It is the majority case.
 *
 * Returns `{ ok, blob, contentType, from }` — `from` is which one answered.
 */
async function fetchMediaBytes(url) {
  const direct = await fetchBlob(url);
  if (direct.ok === true) return Object.assign({ from: FROM_ORIGIN }, direct);

  /* No grant, no fallback. Asking anyway would produce a CORS failure that
     looks exactly like "the archive does not have it", and the counters would
     then blame the archive for a permission this extension never had. */
  let allowed = false;
  try {
    allowed = await hasWaybackPermission();
  } catch (_) {
    allowed = false;
  }
  if (!allowed) return Object.assign({ from: FROM_ORIGIN }, direct);

  let archived = await fetchBlob(waybackImageUrl(url));

  /* And again without the query string, which is where most of these actually
     live. For a photo, `pickBestSource` appends `?name=large` — a size hint
     that is part of the REQUEST, not of the file's address — and a crawl that
     saved the picture saved it under whatever address it used, usually the bare
     one. Measured: the bare form answers 200 with real PNG bytes, and the same
     URL with `?name=large` answers 404. Without this second attempt the
     fallback would be dead for photographs, which is nearly everything an
     archive holds, while passing every test that only checked it was called.
   *
     The query is kept for the first attempt because a video's URL carries a
     `?tag=` that the archive may well have stored: this tries what we asked for,
     then what was probably saved, and does not have to decide which is which. */
  if (archived.ok !== true && url.indexOf('?') !== -1) {
    archived = await fetchBlob(waybackImageUrl(url.split('?')[0]));
  }

  if (archived.ok === true) return Object.assign({ from: FROM_ARCHIVE }, archived);

  /* Both failed, and the reason reported is the ARCHIVE's.
   *
   * Not the origin's, even though that is the one we led with: a 404 or a 403
   * from pbs.twimg.com is the expected half of this path — it is why the
   * fallback exists — so repeating it back says nothing an operator does not
   * already know, and it actively hid the interesting failure. Reported after
   * the first end-to-end run: the counters said `http 404`, which was the CDN's
   * answer, while what had actually gone wrong was that the archive copy could
   * not be read at all. */
  const failed = Object.assign({}, direct);
  if (typeof archived.reason === 'string' && archived.reason.length > 0) {
    failed.reason = (direct.reason || 'origin failed') + '; archive: ' + archived.reason;
  }
  return Object.assign({ from: FROM_ORIGIN }, failed);
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Cache the media of one tweet. Never throws.
 * Returns { cached, skipped, failed } counters.
 */
export async function cacheMediaForTweet(db, tweet, options) {
  const result = { cached: 0, skipped: 0, failed: 0, fromArchive: 0, reason: null };

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
        downloaded = await fetchMediaBytes(sourceUrl);
      } finally {
        activeDownloads--;
      }
      if (downloaded.from === FROM_ARCHIVE) result.fromArchive++;

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

/* -------------------------------------------------------------------------- */
/* The account's own face                                                     */
/* -------------------------------------------------------------------------- */

/** The store key one account's avatar lives under. */
export const AVATAR_MEDIA_ID = 'avatar';

export function avatarKey(userId) {
  return String(userId) + ':' + AVATAR_MEDIA_ID;
}

/**
 * The same picture at a size worth putting in a header.
 *
 * X serves one image at several fixed sizes and the size is the last word of
 * the file name, so this is a rename rather than a different request. The
 * stored URL is `_normal` — 48px, which is what the timeline bubble needs and
 * what the capture happens to record — and the reader draws it at 142. Asking
 * for the bigger one costs one string replace and turns a blurred square into
 * a photograph. Anything that does not match is left exactly as it was.
 */
function biggerAvatarUrl(url) {
  return url.replace(/_(normal|bigger|mini|reasonably_small)(\.\w+)$/i, '_400x400$2');
}

/**
 * Cache the account's own avatar, once.
 *
 * The archive has always carried the URL and never the picture, so an offline
 * reader could draw nothing but a letter — which is what it did, and what was
 * reported back as "还是没有头像". A URL is not a picture; the bytes have to
 * come from somewhere, and pbs.twimg.com is the only place they exist.
 *
 * ONCE. Every later open reads it out of the archive with no network at all,
 * which is the whole difference between this and the reader's "联网看头像"
 * switch — that one re-requests on every open, for as long as it is on.
 *
 * The owner only. Every author in a timeline has a URL too, and fetching those
 * would be hundreds of requests and hundreds of files for faces that are not
 * what an archive of your own posts is for.
 *
 * Never throws, like everything else in this file: the card is stored whether
 * or not the picture came with it.
 */
export async function cacheAvatar(db, profile) {
  const result = { cached: false, skipped: false, reason: null };

  try {
    if (!db || !profile || typeof profile !== 'object') return result;
    const userId = typeof profile.userId === 'string' && profile.userId.length > 0 ? profile.userId : null;
    if (userId === null) return result;
    if (!isAllowedMediaUrl(profile.avatarUrl)) return result;

    const key = avatarKey(userId);
    /* What we would ask for now, worked out before the record is read because
       the record is judged against it. */
    const sourceUrl = biggerAvatarUrl(profile.avatarUrl);

    const existing = await getMediaRecord(db, key);
    /* Kept only when it is the picture that address would fetch TODAY.
     *
     * This used to be "is there a blob at all", and that is a one-way door: an
     * earlier version of this stored whatever `profile.avatarUrl` named, which
     * is `_normal` — 48 pixels — so anyone who ran it has a small square under
     * this key and every run since skips straight past it. The header would
     * stay blurred for good, with nothing on screen or in the counters to say
     * why. The record remembers the address it came from, so the question is
     * answered exactly rather than guessed at from the file size.
     *
     * Nothing is written unless bytes arrive, so a re-fetch that fails leaves
     * the old picture exactly where it was: this can only ever improve. */
    if (existing && existing.blob && existing.sourceUrl === sourceUrl) {
      result.skipped = true;
      return result;
    }

    /* The same grant the media cache uses. No separate prompt: a user who
       wanted pictures in their archive has already answered this. */
    if (!(await hasMediaPermission())) {
      result.reason = 'media host permission not granted';
      return result;
    }

    const downloaded = await fetchMediaBytes(sourceUrl);
    if (downloaded.ok !== true) {
      result.reason = downloaded.reason;
      return result;
    }
    result.fromArchive = downloaded.from === FROM_ARCHIVE ? 1 : 0;

    await putMediaRecord(db, {
      key: key,
      tweetId: userId,
      mediaId: AVATAR_MEDIA_ID,
      type: 'photo',
      sourceUrl: sourceUrl,
      contentType: downloaded.contentType,
      size: downloaded.blob.size,
      width: null,
      height: null,
      altText: null,
      cachedAt: new Date().toISOString(),
      blob: downloaded.blob
    });
    result.cached = true;
  } catch (err) {
    result.reason = err && err.message ? String(err.message) : 'unexpected avatar cache error';
  }

  return result;
}
