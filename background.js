/* ============================================================================
 * background.js  —  MV3 service worker (ES module).
 *
 * The ONLY component allowed to persist archive data. It owns the extension's
 * IndexedDB, re-validates everything that arrives from the page realm, and
 * answers the popup.
 *
 * Message surface (strict whitelist, nothing else is accepted):
 *   from content.js : X_TWEET_CAPTURE, X_TWEET_BACKFILL, X_TWEET_DELETE,
 *                     X_TWEET_LINKS, XTB_DIAG
 *   from popup      : XTB_GET_STATE, XTB_SET_SETTINGS, XTB_DELETE_TWEET,
 *                     XTB_CLEAR_ALL, XTB_RESET_STATS, XTB_SYNC_MEDIA_PERMISSION
 *
 * There is deliberately no "administrative" message that a web page could
 * reach: a page can at worst forge a capture, and a forged capture is still
 * shape-validated, id-validated and stripped to known fields before storage.
 * ========================================================================== */

import {
  openDB,
  upsertTweet,
  upsertBackfill,
  mergeLinkEntities,
  markSuperseded,
  markDeleted,
  recordDeletion,
  listDeletions,
  deleteTweet,
  clearAll,
  countTweets,
  countMedia,
  getTweet,
  countTweetsByFilter,
  purgeTweets,
  forEachTweet,
  PURGE_FILTERS,
  SCHEMA_VERSION
} from './db.js';

import {
  getSettings,
  saveSettings,
  getStats,
  resetStats,
  bumpLifetime,
  mergePageDiag,
  noteCaptureTime,
  getOwnAuthors,
  rememberOwnAuthors
} from './settings.js';

import { cacheMediaForTweet, hasMediaPermission } from './media-cache.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether a hostname belongs to X.
 *
 * The manifest injects the content script into `https://*.x.com/*` and
 * `https://*.twitter.com/*`, so a capture can legitimately arrive from
 * mobile.x.com or www.x.com. The old prefix test only accepted the bare
 * domains and silently refused those tabs. This is the same hostname test
 * inject.js applies to the requests it observes.
 */
function isXHostname(hostname) {
  const h = typeof hostname === 'string' ? hostname.toLowerCase() : '';
  return h === 'x.com' || h.endsWith('.x.com') ||
         h === 'twitter.com' || h.endsWith('.twitter.com');
}
const MAX_TEXT_CHARS = 200000;
const MAX_MEDIA_ITEMS = 64;
const MAX_VARIANTS_PER_MEDIA = 32;
const MAX_POLL_CHOICES = 4;
const MAX_EDIT_VERSIONS = 64;
const MAX_ENTITY_URLS = 64;
const MAX_ENTITY_TAGS = 64;
const MAX_ENTITY_MENTIONS = 64;
const LANG_PATTERN = /^[A-Za-z0-9-]{1,16}$/;
const TWEET_ID_PATTERN = /^[0-9]{1,25}$/;
const ALLOWED_MEDIA_HOSTS = ['pbs.twimg.com', 'video.twimg.com'];
const ALLOWED_TWEET_HOSTS = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.x.com'];

let debugEnabled = false;

function log() {
  if (!debugEnabled) return;
  try {
    // eslint-disable-next-line no-console
    console.debug('[X Tweet Backup]', ...arguments);
  } catch (_) { /* ignore */ }
}

/* -------------------------------------------------------------------------- */
/* Type helpers                                                               */
/* -------------------------------------------------------------------------- */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const limit = typeof maxLength === 'number' ? maxLength : 1000;
  return value.length > limit ? value.slice(0, limit) : value;
}

function asNonEmptyString(value, maxLength) {
  const s = asString(value, maxLength);
  return (s !== null && s.length > 0) ? s : null;
}

function asNumberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asBooleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function normalizeId(value) {
  if (typeof value === 'string' && TWEET_ID_PATTERN.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    const s = String(value);
    return TWEET_ID_PATTERN.test(s) ? s : null;
  }
  return null;
}

function asIsoString(value, fallback) {
  const s = asString(value, 64);
  if (s === null) return fallback;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return fallback;
  try {
    return new Date(ms).toISOString();
  } catch (_) {
    return fallback;
  }
}

function sanitizeTweetUrl(value, id) {
  const fallback = 'https://x.com/i/web/status/' + id;
  const s = asString(value, 300);
  if (s === null) return fallback;
  let url;
  try {
    url = new URL(s);
  } catch (_) {
    return fallback;
  }
  if (url.protocol !== 'https:') return fallback;
  if (ALLOWED_TWEET_HOSTS.indexOf(url.hostname.toLowerCase()) === -1) return fallback;
  return url.href;
}

function sanitizeTwimgUrl(value) {
  const s = asString(value, 2000);
  if (s === null) return null;
  let url;
  try {
    url = new URL(s);
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (ALLOWED_MEDIA_HOSTS.indexOf(url.hostname.toLowerCase()) === -1) return null;
  return url.href;
}

/* -------------------------------------------------------------------------- */
/* Record sanitizer — the trust boundary                                      */
/* -------------------------------------------------------------------------- */

function sanitizeMedia(rawMedia) {
  if (!Array.isArray(rawMedia)) return [];
  const out = [];
  const limit = Math.min(rawMedia.length, MAX_MEDIA_ITEMS);

  for (let i = 0; i < limit; i++) {
    const item = rawMedia[i];
    if (!isObject(item)) continue;

    const variants = [];
    if (Array.isArray(item.variants)) {
      const variantLimit = Math.min(item.variants.length, MAX_VARIANTS_PER_MEDIA);
      for (let v = 0; v < variantLimit; v++) {
        const variant = item.variants[v];
        if (!isObject(variant)) continue;
        const variantUrl = sanitizeTwimgUrl(variant.url);
        if (variantUrl === null) continue;
        variants.push({
          url: variantUrl,
          bitrate: asNumberOrNull(variant.bitrate),
          contentType: asNonEmptyString(variant.contentType, 100)
        });
      }
    }

    let aspectRatio = null;
    if (Array.isArray(item.aspectRatio) && item.aspectRatio.length === 2) {
      const w = asNumberOrNull(item.aspectRatio[0]);
      const h = asNumberOrNull(item.aspectRatio[1]);
      if (w !== null && h !== null) aspectRatio = [w, h];
    }

    out.push({
      id: asNonEmptyString(item.id, 100),
      mediaKey: asNonEmptyString(item.mediaKey, 100),
      type: asNonEmptyString(item.type, 32),
      url: sanitizeTwimgUrl(item.url),
      thumbnailUrl: sanitizeTwimgUrl(item.thumbnailUrl),
      width: asNumberOrNull(item.width),
      height: asNumberOrNull(item.height),
      altText: asNonEmptyString(item.altText, 4000),
      durationMs: asNumberOrNull(item.durationMs),
      aspectRatio: aspectRatio,
      variants: variants
    });
  }
  return out;
}

function sanitizeMetrics(rawMetrics) {
  const metrics = isObject(rawMetrics) ? rawMetrics : {};
  return {
    likeCount: asNumberOrNull(metrics.likeCount),
    retweetCount: asNumberOrNull(metrics.retweetCount),
    replyCount: asNumberOrNull(metrics.replyCount),
    quoteCount: asNumberOrNull(metrics.quoteCount),
    bookmarkCount: asNumberOrNull(metrics.bookmarkCount),
    viewCount: asNumberOrNull(metrics.viewCount)
  };
}

function sanitizeAuthor(rawAuthor) {
  const author = isObject(rawAuthor) ? rawAuthor : {};
  return {
    id: normalizeId(author.id),
    screenName: asNonEmptyString(author.screenName, 100),
    name: asNonEmptyString(author.name, 200),
    avatarUrl: sanitizeTwimgUrl(author.avatarUrl)
  };
}

function sanitizeReplyTo(rawReplyTo) {
  const replyTo = isObject(rawReplyTo) ? rawReplyTo : {};
  return {
    tweetId: normalizeId(replyTo.tweetId),
    userId: normalizeId(replyTo.userId),
    screenName: asNonEmptyString(replyTo.screenName, 100)
  };
}

/**
 * A poll is rebuilt field by field like everything else. `choicesFromResponse`
 * is what makes the archive honest: when X does not inline the poll card in the
 * create response, the record still says "this is a poll" but reports that the
 * labels were not available, instead of the poll quietly looking like a plain
 * text post.
 */
/**
 * A link the user typed can point anywhere, so unlike media URLs the host is
 * not constrained — but the scheme still is. Without this a javascript: or
 * data: URL could be archived and later handed to an <a href> by a reader UI.
 */
function sanitizeHttpUrl(value) {
  const s = asString(value, 2000);
  if (s === null) return null;
  let url;
  try {
    url = new URL(s);
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.href;
}

/**
 * Rebuild one `entities.urls` list field by field.
 *
 * Shared by the capture sanitizer and the link fill, so that there is exactly
 * one definition of a stored link entity: a URL whose scheme is not http(s) is
 * dropped, and an entry left with nothing usable is dropped whole.
 */
function sanitizeEntityUrls(rawUrls) {
  const out = [];
  if (!Array.isArray(rawUrls)) return out;
  const limit = Math.min(rawUrls.length, MAX_ENTITY_URLS);
  for (let i = 0; i < limit; i++) {
    const item = rawUrls[i];
    if (!isObject(item)) continue;
    const url = sanitizeHttpUrl(item.url);
    const expandedUrl = sanitizeHttpUrl(item.expandedUrl);
    if (url === null && expandedUrl === null) continue;
    out.push({
      url: url,
      expandedUrl: expandedUrl,
      displayUrl: asNonEmptyString(item.displayUrl, 500)
    });
  }
  return out;
}

/**
 * Rebuild the link / hashtag / mention lists field by field. The expanded URL
 * is the whole point: X stores only a t.co shortlink in the text, and that
 * shortlink stops resolving through anyone but X.
 */
function sanitizeEntities(rawEntities) {
  const src = isObject(rawEntities) ? rawEntities : {};

  const urls = sanitizeEntityUrls(src.urls);

  const hashtags = [];
  if (Array.isArray(src.hashtags)) {
    const limit = Math.min(src.hashtags.length, MAX_ENTITY_TAGS);
    for (let i = 0; i < limit; i++) {
      const tag = asNonEmptyString(src.hashtags[i], 200);
      if (tag !== null) hashtags.push(tag);
    }
  }

  const mentions = [];
  if (Array.isArray(src.mentions)) {
    const limit = Math.min(src.mentions.length, MAX_ENTITY_MENTIONS);
    for (let i = 0; i < limit; i++) {
      const item = src.mentions[i];
      if (!isObject(item)) continue;
      const screenName = asNonEmptyString(item.screenName, 100);
      const name = asNonEmptyString(item.name, 200);
      if (screenName === null && name === null) continue;
      mentions.push({ id: normalizeId(item.id), screenName: screenName, name: name });
    }
  }

  return { urls: urls, hashtags: hashtags, mentions: mentions };
}

function sanitizePoll(rawPoll) {
  const poll = isObject(rawPoll) ? rawPoll : null;
  if (poll === null) return null;

  const choices = [];
  if (Array.isArray(poll.choices)) {
    const limit = Math.min(poll.choices.length, MAX_POLL_CHOICES);
    for (let i = 0; i < limit; i++) {
      const choice = asNonEmptyString(poll.choices[i], 200);
      if (choice !== null) choices.push(choice);
    }
  }

  return {
    // Only a card named "poll*" makes this a poll; a card_uri on its own is
    // recorded but does not claim a type.
    isPoll: poll.isPoll === true,
    cardUri: asNonEmptyString(poll.cardUri, 200),
    cardName: asNonEmptyString(poll.cardName, 100),
    choices: choices,
    choicesFromResponse: choices.length > 0,
    endDatetimeUtc: asIsoString(poll.endDatetimeUtc, null),
    countsAreFinal: asBooleanOrNull(poll.countsAreFinal)
  };
}

/** The edit version chain, oldest first, with the current version last. */
function sanitizeEditIds(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  const out = [];
  const limit = Math.min(rawIds.length, MAX_EDIT_VERSIONS);
  for (let i = 0; i < limit; i++) {
    const id = normalizeId(rawIds[i]);
    if (id !== null && out.indexOf(id) === -1) out.push(id);
  }
  return out;
}

function sanitizeSource(rawSource) {
  const source = isObject(rawSource) ? rawSource : {};
  return {
    operationName: asNonEmptyString(source.operationName, 64),
    queryId: asNonEmptyString(source.queryId, 64),
    // Which transport the response was observed on. x.com used to publish over
    // fetch and now uses XHR; recording it makes future transport changes
    // visible in the archive instead of silent.
    capturedVia: source.capturedVia === 'xhr' ? 'xhr' : 'fetch',
    httpStatus: asNumberOrNull(source.httpStatus),
    textFromRequest: asBooleanOrNull(source.textFromRequest) === true,
    // True when the row was recovered from a profile timeline sweep rather than
    // observed at publish time. `capturedAt` on such a row is when the sweep
    // ran, not when the post was made, and the row may be missing fields the
    // publish path would have had — so the archive says which is which instead
    // of presenting a thinner record as an equal one.
    backfilled: asBooleanOrNull(source.backfilled) === true,
    tombstone: false
  };
}

/**
 * Rebuild a record from known fields only. Anything not listed here — cookies,
 * tokens, headers, or any field a forged message might try to smuggle in — is
 * dropped by construction rather than filtered out.
 *
 * Returns null when the payload cannot be a real published tweet.
 */
function sanitizeRecord(raw) {
  if (!isObject(raw)) return null;

  const id = normalizeId(raw.id);
  if (id === null) return null;

  const text = asString(raw.text, MAX_TEXT_CHARS);
  if (text === null) return null;

  const capturedAt = asIsoString(raw.capturedAt, new Date().toISOString());
  const createdAt = asIsoString(raw.createdAt, capturedAt);

  const author = sanitizeAuthor(raw.author);
  const replyTo = sanitizeReplyTo(raw.replyTo);
  const media = sanitizeMedia(raw.media);
  const poll = sanitizePoll(raw.poll);

  let conversationId = normalizeId(raw.conversationId);
  let conversationIdInferred = asBooleanOrNull(raw.conversationIdInferred) === true;
  if (conversationId === null) {
    conversationId = replyTo.tweetId !== null ? replyTo.tweetId : id;
    conversationIdInferred = true;
  }

  const rawLang = asNonEmptyString(raw.lang, 16);

  return {
    id: id,
    text: text,
    lang: rawLang !== null && LANG_PATTERN.test(rawLang) ? rawLang : null,
    createdAt: createdAt,
    createdAtRaw: asNonEmptyString(raw.createdAtRaw, 100),
    capturedAt: capturedAt,
    firstCapturedAt: capturedAt,
    updatedAt: capturedAt,
    tweetUrl: sanitizeTweetUrl(raw.tweetUrl, id),
    isReply: replyTo.tweetId !== null,
    isRetweet: raw.isRetweet === true,
    retweetedTweetId: raw.isRetweet === true ? normalizeId(raw.retweetedTweetId) : null,
    isEdit: raw.isEdit === true,
    // An edit returns a new tweet id, so each version is archived as its own
    // record and this field is what chains them together.
    editedFrom: raw.isEdit === true ? normalizeId(raw.editedFrom) : null,
    editTweetIds: raw.isEdit === true ? sanitizeEditIds(raw.editTweetIds) : [],
    editInitialTweetId: raw.isEdit === true ? normalizeId(raw.editInitialTweetId) : null,
    editsRemaining: raw.isEdit === true ? asNumberOrNull(raw.editsRemaining) : null,
    isPoll: poll !== null && poll.isPoll === true,
    poll: poll,
    replyTo: replyTo,
    conversationId: conversationId,
    conversationIdInferred: conversationIdInferred,
    quoteTweetId: normalizeId(raw.quoteTweetId),
    author: author,
    entities: sanitizeEntities(raw.entities),
    media: media,
    metrics: sanitizeMetrics(raw.metrics),
    source: sanitizeSource(raw.source),
    schemaVersion: SCHEMA_VERSION
  };
}

/**
 * Rebuild a link-fill payload — an id plus link entities — from a whitelist.
 *
 * It deliberately does NOT go through sanitizeRecord. There is no text, author
 * or media in a focal-tweet message to validate, and accepting a capture-shaped
 * payload here would invite a forged one to be treated as a capture. Two fields
 * come out, both already existing concepts; nothing else survives by
 * construction.
 *
 * Returns null when the payload cannot be one, which includes "nothing to add" —
 * an empty list can only ever make the write path do nothing.
 */
function sanitizeLinkFill(raw) {
  if (!isObject(raw)) return null;

  const id = normalizeId(raw.id);
  if (id === null) return null;

  const urls = sanitizeEntityUrls(raw.urls);
  if (urls.length === 0) return null;

  return { id: id, urls: urls };
}

/* -------------------------------------------------------------------------- */
/* Media cache queue (best effort, never blocks the tweet write)              */
/* -------------------------------------------------------------------------- */

/**
 * chrome.storage.local key holding the ids that were still waiting when the
 * last service-worker life ended.
 */
const MEDIA_QUEUE_KEY = 'xtbMediaQueue';

/**
 * Ceiling on the persisted pending list.
 *
 * The same number as the largest queue any single pass may build (see
 * MEDIA_QUEUE_LIMIT_FILL), so it cannot truncate anything a caller was allowed
 * to queue. A tweet id is at most 25 characters, so the whole list is ~50 KB in
 * one storage value — nowhere near chrome.storage.local's quota. The ceiling is
 * here because this is the one structure that outlives the worker: a list that
 * could grow without bound would be a way for a page to fill storage.
 */
const MEDIA_QUEUE_MAX_PENDING = 2000;

/**
 * How long to wait before retrying a drain whose database open failed.
 *
 * Long enough not to spin against a database that is still blocked (the open
 * itself now spends its own deadline before failing), and short enough that the
 * retry has a chance to run inside this worker life, which MV3 ends after
 * roughly thirty idle seconds.
 */
const MEDIA_QUEUE_RETRY_MS = 15000;

const mediaQueue = [];
let mediaWorkerRunning = false;
let mediaRetryTimer = null;
let mediaRestoreInFlight = null;
let mediaRestoreSettled = false;
let mediaWriteChain = Promise.resolve();
/**
 * Ids read from storage that have not been re-queued yet. While a restore is
 * running these are part of the pending set — the stored list is the only copy
 * of that work, and writing out just `mediaQueue` mid-restore would drop the
 * remainder, which is the same silent loss in a different place.
 */
let mediaRestorePending = [];

/**
 * The ids that have to be re-queued if this worker disappears right now: the
 * queue itself, plus — while a restore is running — the stored ids that have
 * not been read back yet. Both halves matter, because the in-memory queue is
 * only ever a partial copy of the persisted list during a restore.
 */
function pendingMediaIds() {
  const ids = [];
  const add = (id) => {
    if (typeof id === 'string' && ids.indexOf(id) === -1) ids.push(id);
  };
  for (const id of mediaRestorePending) add(id);
  for (const tweet of mediaQueue) add(tweet && typeof tweet.id === 'string' ? tweet.id : null);
  return ids;
}

/**
 * Mirror the pending queue into chrome.storage.local.
 *
 * MV3 tears an idle service worker down after about thirty seconds, and a
 * pending `await fetch()` does not hold it open. An in-memory queue is
 * therefore not a queue: a single「补下缺失的媒体」pass can leave two thousand
 * entries waiting, and everything still there when the worker dies simply
 * disappears. Nothing moves — `mediaFailed` is not bumped, `mediaCached` just
 * stops growing — and that reads exactly like "there was nothing left to
 * download", which is the one thing it is not.
 *
 * Ids are enough. The record stays in IndexedDB, and cacheMediaForTweet looks
 * each file up by tweetId:mediaId and skips what is already stored, so
 * re-running a restored entry downloads only what is genuinely missing.
 *
 * Writes are chained and each is a complete snapshot of the pending set, so
 * two of them completing out of order can only ever leave a *stale* list —
 * never a half-written one. A stale list is safe: the ids in it are re-checked
 * against the media store before anything is fetched.
 */
function persistMediaQueue() {
  const all = pendingMediaIds();
  const ids = all.slice(0, MEDIA_QUEUE_MAX_PENDING);
  if (all.length > ids.length) {
    log('media queue: ' + (all.length - ids.length) + ' pending ids beyond the ' +
        MEDIA_QUEUE_MAX_PENDING + '-id persistence cap were NOT written');
  }
  mediaWriteChain = mediaWriteChain.then(
    () => writeStoredMediaQueue(ids),
    () => writeStoredMediaQueue(ids)
  );
}

/** One write of the pending list. Never rejects: losing the mirror is not
 *  losing the work, and there is nothing useful to do about it here. */
function writeStoredMediaQueue(ids) {
  return new Promise((resolve) => {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }
      const result = chrome.storage.local.set({ [MEDIA_QUEUE_KEY]: ids });
      if (result && typeof result.then === 'function') result.then(resolve, resolve);
      else resolve();
    } catch (_) {
      resolve();
    }
  });
}

function readStoredMediaQueue() {
  return new Promise((resolve) => {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) {
        resolve([]);
        return;
      }
      const result = chrome.storage.local.get({ [MEDIA_QUEUE_KEY]: [] });
      if (!result || typeof result.then !== 'function') {
        resolve([]);
        return;
      }
      result.then(
        (stored) => {
          const list = stored ? stored[MEDIA_QUEUE_KEY] : null;
          if (!Array.isArray(list)) {
            resolve([]);
            return;
          }
          // Storage is shared with the settings and survives upgrades, so what
          // comes back is treated as input: only strings that could be a tweet
          // id may become a database lookup.
          resolve(list.filter((id) => typeof id === 'string' && TWEET_ID_PATTERN.test(id)));
        },
        () => resolve([])
      );
    } catch (_) {
      resolve([]);
    }
  });
}

/**
 * Queue a tweet's media for download.
 *
 * Returns false when the queue is already at its cap. The cap exists so a
 * runaway cannot fill memory, but a caller that drops work has to be able to
 * say so — a silently skipped download looks exactly like a tweet that had no
 * media, and those are very different things.
 *
 * `limit` lets a timeline sweep use a larger cap: it arrives as one batch of up
 * to 200 posts, and the live-capture cap would discard most of it.
 */
function enqueueMedia(tweet, limit) {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : MEDIA_QUEUE_LIMIT;
  if (mediaQueue.length >= cap) return false;
  mediaQueue.push(tweet);
  // Mirrored before the download starts, not after: the point of the mirror is
  // the entry that has not run yet.
  persistMediaQueue();
  void runMediaQueue();
  return true;
}

/**
 * Give a drain whose database open failed another chance in this same worker
 * life.
 *
 * The persisted list is what covers a termination; this covers the case where
 * the worker survives. Neither replaces the other: a timer does not keep an
 * MV3 worker alive, and a restored list only helps once the worker starts
 * again.
 */
function scheduleMediaQueueRetry() {
  if (mediaRetryTimer !== null || mediaQueue.length === 0) return;
  mediaRetryTimer = setTimeout(() => {
    mediaRetryTimer = null;
    void runMediaQueue();
  }, MEDIA_QUEUE_RETRY_MS);
}

async function runMediaQueue() {
  if (mediaWorkerRunning) return;
  mediaWorkerRunning = true;
  // A retry that fired to get here must not fire again on top of this run.
  if (mediaRetryTimer !== null) {
    clearTimeout(mediaRetryTimer);
    mediaRetryTimer = null;
  }
  try {
    let db;
    try {
      db = await openDB();
    } catch (err) {
      // The queue is not lost — it is mirrored — but nothing else calls back in
      // until the next enqueue, so what is left is retried rather than
      // abandoned. If the worker dies first, the mirror covers that.
      log('media queue: database unavailable, ' + describe(err));
      scheduleMediaQueueRetry();
      return;
    }
    while (mediaQueue.length > 0) {
      // Peeked, not shifted: the entry stays in the queue, and so in the
      // mirror, until its download has finished one way or the other. A
      // termination mid-fetch then resumes it, while a download that fails —
      // a 404 the origin will keep answering — still leaves the queue below and
      // so cannot wedge it forever.
      const tweet = mediaQueue[0];
      try {
        const result = await cacheMediaForTweet(db, tweet, {});
        if (result.cached > 0 || result.failed > 0) {
          await bumpLifetime({ mediaCached: result.cached, mediaFailed: result.failed });
        }
        log('media cache', tweet.id, result);
      } catch (err) {
        // Never allowed to affect the tweet record.
        log('media cache failed', err);
      }
      mediaQueue.shift();
      persistMediaQueue();
    }
  } catch (err) {
    log('media queue failed', err);
  } finally {
    mediaWorkerRunning = false;
  }
}

/**
 * Re-arm the queue from the previous worker life.
 *
 * Ids are what is stored; a record is what the downloader needs, so each id is
 * read back through getTweet. An id whose record is gone — the user removed
 * that backup, or cleared the archive — is dropped rather than retried forever:
 * there is nothing left to download, and a queue that cannot empty is worse
 * than a short one.
 *
 * Runs once per worker life. A run that could not read or open anything leaves
 * the stored list untouched and un-settles, so the next start retries it.
 */
async function restoreMediaQueue() {
  if (mediaRestoreSettled || mediaRestoreInFlight !== null) return mediaRestoreInFlight;
  mediaRestoreInFlight = restoreMediaQueueInternal().then(
    (settled) => {
      mediaRestoreInFlight = null;
      if (settled) mediaRestoreSettled = true;
    },
    (err) => {
      mediaRestoreInFlight = null;
      log('media queue restore failed', describe(err));
    }
  );
  return mediaRestoreInFlight;
}

async function restoreMediaQueueInternal() {
  const ids = await readStoredMediaQueue();
  if (ids.length === 0) return true;

  // Nothing is downloaded behind an off switch. The list is left exactly as it
  // is — not dropped — so switching media caching back on, or the next worker
  // start, still finds the work that was queued while it was on.
  const settings = await getSettings();
  if (settings.mediaCache !== true) return false;

  let db;
  try {
    db = await openDB();
  } catch (err) {
    // The stored list is the only copy of this work, so it is left alone.
    log('media queue restore: database unavailable, ' + describe(err));
    return false;
  }

  mediaRestorePending = ids;
  let restored = 0;
  for (const id of ids) {
    // Taken out of the pending set before the enqueue, so the mirror never
    // lists it twice: from here on the queue entry is what carries it.
    const at = mediaRestorePending.indexOf(id);
    if (at !== -1) mediaRestorePending.splice(at, 1);

    let record = null;
    try {
      record = await getTweet(db, id);
    } catch (err) {
      log('media queue restore: could not read', id, describe(err));
    }
    if (!record || typeof record !== 'object' ||
        !Array.isArray(record.media) || record.media.length === 0) {
      continue; // nothing left to download for this id
    }
    if (enqueueMedia(record, MEDIA_QUEUE_MAX_PENDING)) restored++;
  }
  // Every id has been accounted for, so the queue alone is now the pending set.
  // (An unexpected throw above skips this, leaving the remainder in the mirror
  // for the next start rather than dropping it.)
  mediaRestorePending = [];
  persistMediaQueue();
  if (restored > 0) {
    log('media queue restored: ' + restored + ' of ' + ids.length + ' pending tweets re-queued');
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

function isTrustedPageSender(sender) {
  try {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (!sender.tab) return false;
    const url = typeof sender.url === 'string' ? sender.url : (sender.tab.url || '');
    // Parsed, not prefix-matched: the hostname is the part that says whose page
    // this is, and only a parsed one can tell x.com from x.com.evil.example.
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return isXHostname(parsed.hostname);
  } catch (_) {
    return false;
  }
}

/**
 * An extension page is identified by its URL, NOT by the absence of
 * sender.tab. Chrome sets sender.tab for anything opened from a tab, which
 * includes popup.html when the user opens it as a full tab — testing for
 * "no tab" wrongly rejected that case and left the tab UI with no data.
 * A content script's sender.url is the page's own https:// URL, so the URL
 * prefix alone separates the two reliably.
 */
function isExtensionPageSender(sender) {
  try {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    return typeof sender.url === 'string' &&
           sender.url.indexOf(chrome.runtime.getURL('')) === 0;
  } catch (_) {
    return false;
  }
}

async function handleCapture(payload) {
  const record = sanitizeRecord(payload);
  if (record === null) {
    await bumpLifetime({ rejected: 1 }, 'rejected a capture payload that failed validation');
    return { ok: false, error: 'invalid payload' };
  }

  let db;
  try {
    db = await openDB();
  } catch (err) {
    await bumpLifetime({ upsertFailed: 1 }, 'IndexedDB open failed: ' + describe(err));
    return { ok: false, error: 'database unavailable' };
  }

  try {
    const result = await upsertTweet(db, record);
    await bumpLifetime({ upsertOk: 1 });
    await noteCaptureTime(record.capturedAt);

    // Every published post names its author, which is how the extension learns
    // whose account this is. That id is what lets the profile-timeline sweep
    // tell "my profile" from "somebody else's profile" — without it the sweep
    // would have to either stay off or archive other people's posts.
    if (record.author.id !== null) {
      try {
        await rememberOwnAuthors([record.author.id]);
      } catch (err) {
        log('could not record the author id', err);
      }
    }

    // An edit arrives as a brand-new tweet id. Point the older version at it so
    // the archive shows the chain instead of two unrelated-looking records.
    // Failure here must never cost us the record that was just written.
    if (record.isEdit && record.editedFrom !== null) {
      try {
        await markSuperseded(db, record.editedFrom, record.id);
      } catch (err) {
        log('could not link the previous edit version', err);
      }
    }

    const settings = await getSettings();
    if (settings.mediaCache && record.media.length > 0) {
      // enqueueMedia refuses when the queue is at its cap. Dropping that answer
      // made a download that never happened look exactly like a post that had no
      // media, so the count is kept — the record itself must never be affected.
      if (!enqueueMedia(record)) {
        await bumpLifetime({ mediaDropped: 1 });
        log('media queue full: the download for', record.id, 'was NOT queued');
      }
    }

    log('stored tweet', record.id, result.existed ? '(updated)' : '(new)');
    return { ok: true, id: record.id, existed: result.existed };
  } catch (err) {
    await bumpLifetime({ upsertFailed: 1 }, 'IndexedDB write failed: ' + describe(err));
    return { ok: false, error: 'write failed' };
  }
}

/** A timeline response carries at most a page or two; anything larger is a bug. */
const MAX_BACKFILL_BATCH = 200;

/**
 * Media queue caps. The standing one keeps a burst of live captures bounded;
 * the sweep one is large enough to hold a whole recovered page without
 * discarding any of it, since a sweep is a deliberate action with a known size.
 */
const MEDIA_QUEUE_LIMIT = 50;
const MEDIA_QUEUE_LIMIT_SWEEP = 500;
/** A gap-filling pass covers whatever is already archived, so it needs more room. */
const MEDIA_QUEUE_LIMIT_FILL = 2000;

/**
 * Store the rows recovered from one profile-timeline sweep.
 *
 * These are posts the browser never saw published — most often made from the
 * phone, which an extension cannot observe at all. Opening your own profile
 * makes X fetch the timeline itself, and that response contains your posts
 * regardless of which device posted them, so reading it fills the gap without
 * the extension ever making a request of its own.
 *
 * Two rules make this safe:
 *   - the page filters to this account's own author ids before sending, so
 *     other people's posts are never even transmitted;
 *   - `upsertBackfill` never overwrites an existing row, so the thinner
 *     timeline view cannot replace a record the publish path captured properly.
 *
 * Counters are deliberately separate from the live-capture ones: "received 40
 * records" meaning 2 published and 38 swept back in is a materially different
 * thing, and a shared counter could not tell them apart.
 */
async function handleBackfill(payload) {
  const records = isObject(payload) && Array.isArray(payload.records) ? payload.records : null;
  if (records === null) {
    await bumpLifetime({ rejected: 1 }, 'rejected a backfill payload with no records array');
    return { ok: false, error: 'invalid payload' };
  }

  let db;
  try {
    db = await openDB();
  } catch (err) {
    await bumpLifetime({ upsertFailed: 1 }, 'IndexedDB open failed: ' + describe(err));
    return { ok: false, error: 'database unavailable' };
  }

  // Read the settings once for the whole batch rather than per record.
  const settings = await getSettings();
  const wantMedia = settings.mediaCache === true && settings.backfillMedia === true;

  let inserted = 0;
  let skipped = 0;
  let rejected = 0;
  let mediaQueued = 0;
  let mediaDropped = 0;

  const limit = Math.min(records.length, MAX_BACKFILL_BATCH);
  for (let i = 0; i < limit; i++) {
    const record = sanitizeRecord(records[i]);
    if (record === null) {
      rejected++;
      continue;
    }
    try {
      const result = await upsertBackfill(db, record);
      if (result.existed) {
        skipped++;
        // Already archived, so its media was queued when it was written. Do not
        // queue it again.
        continue;
      }
      inserted++;
      if (wantMedia && record.media.length > 0) {
        if (enqueueMedia(record, MEDIA_QUEUE_LIMIT_SWEEP)) mediaQueued++;
        else mediaDropped++;
      }
    } catch (err) {
      // One bad row must not cost the rest of the batch.
      rejected++;
      log('backfill row failed', describe(err));
    }
  }

  // `rejected` is a lifetime counter, not only a return value: a sweep that
  // stored nothing has to be visible in the diagnostics panel afterwards, long
  // after the page that sent it is gone.
  await bumpLifetime({ backfilled: inserted, backfillSkipped: skipped, rejected: rejected });
  if (inserted > 0) await noteCaptureTime(new Date().toISOString());

  // A dropped download must never be quiet: it looks identical to a post that
  // simply had no media.
  if (mediaDropped > 0) {
    log('timeline sweep: ' + mediaDropped + ' media downloads were NOT queued (queue full)');
  }
  log('timeline sweep: ' + inserted + ' recovered, ' + skipped +
      ' already archived, ' + rejected + ' rejected, ' +
      mediaQueued + ' with media queued');

  // Nothing stored, nothing already there, at least one row refused: the sweep
  // accomplished nothing at all. Returning ok here was the one answer that could
  // not be true — every row failed — and saying so is what turns a silent dead
  // sweep into something the page can report and the panel can show.
  if (inserted === 0 && skipped === 0 && rejected > 0) {
    return {
      ok: false, error: 'every row in the batch was rejected (' + rejected + ')',
      inserted: inserted, skipped: skipped, rejected: rejected,
      mediaQueued: mediaQueued, mediaDropped: mediaDropped
    };
  }

  return {
    ok: true, inserted: inserted, skipped: skipped, rejected: rejected,
    mediaQueued: mediaQueued, mediaDropped: mediaDropped
  };
}

/**
 * Fetch the media files for posts that have a media address but no file.
 *
 * Two ways an archive ends up in that state: it was written before media
 * caching was switched on, or the media belonged to a post recovered by a
 * profile sweep — a sweep deliberately does not re-queue rows that are already
 * archived, so those never got a second chance.
 *
 * No new download code is needed. `cacheMediaForTweet` looks up each file by
 * `tweetId:mediaId` and skips anything already stored, so re-queuing every post
 * that has media downloads exactly the missing ones and touches nothing else.
 *
 * What this cannot do is recover media X no longer serves — a deleted post's
 * pictures are gone from the origin, and the request will simply fail.
 */
async function handleFillMedia() {
  const settings = await getSettings();
  if (settings.mediaCache !== true) {
    return { ok: false, error: 'media caching is off' };
  }
  if (!(await hasMediaPermission())) {
    return { ok: false, error: 'media host permission not granted' };
  }

  let db;
  try {
    db = await openDB();
  } catch (err) {
    await bumpLifetime({ upsertFailed: 1 }, 'IndexedDB open failed: ' + describe(err));
    return { ok: false, error: 'database unavailable' };
  }

  let withMedia = 0;
  let queued = 0;
  let overflow = 0;

  try {
    await forEachTweet(db, (record) => {
      if (!record || !Array.isArray(record.media) || record.media.length === 0) return;
      withMedia++;
      if (enqueueMedia(record, MEDIA_QUEUE_LIMIT_FILL)) queued++;
      else overflow++;
    });
  } catch (err) {
    log('gap fill scan failed', describe(err));
    return { ok: false, error: 'scan failed' };
  }

  // Saying how many were left out is the whole point: a silent cap here would
  // look exactly like "everything is cached now".
  if (overflow > 0) {
    log('gap fill: ' + overflow + ' posts did not fit the queue and were NOT queued');
  }
  log('gap fill: ' + queued + ' posts queued out of ' + withMedia + ' with media');
  return { ok: true, withMedia: withMedia, queued: queued, overflow: overflow };
}

/**
 * A deletion never creates a tweet record and never removes one. It does two
 * separate things:
 *
 *   1. records the deletion event itself, always, even when this machine never
 *      archived the tweet. That is what lets a merge apply the deletion to a
 *      machine that DID archive it — the usual case when you post on one
 *      computer and delete from another;
 *   2. marks the local record when there is one, which is what the list shows.
 *
 * Note there is deliberately no upsert fallback: inventing a content-free row
 * in the tweet list would put an entry in the archive with no text, no author
 * and no media.
 */
async function handleDeletion(payload) {
  if (!isObject(payload)) return { ok: false, error: 'invalid payload' };

  const id = normalizeId(payload.id);
  if (id === null) return { ok: false, error: 'invalid payload' };

  const deletedAt = asIsoString(payload.deletedAt, new Date().toISOString());

  let db;
  try {
    db = await openDB();
  } catch (err) {
    await bumpLifetime({ upsertFailed: 1 }, 'IndexedDB open failed: ' + describe(err));
    return { ok: false, error: 'database unavailable' };
  }

  try {
    // The event first: losing it would be worse than losing the local mark,
    // because nothing else can reconstruct it.
    await recordDeletion(db, id, deletedAt);

    const marked = await markDeleted(db, id, deletedAt);
    await bumpLifetime({ deletedMarked: marked ? 1 : 0, deletedUnmatched: marked ? 0 : 1 });
    log('deletion seen', id, marked ? '(marked)' : '(not archived here; event recorded)');
    return { ok: true, marked: marked };
  } catch (err) {
    await bumpLifetime({ upsertFailed: 1 }, 'deletion write failed: ' + describe(err));
    return { ok: false, error: 'write failed' };
  }
}

/**
 * Fill in the link targets of a record that is already archived.
 *
 * A swept record often has an empty `entities.urls`, so a post whose text holds
 * a t.co shortlink has no stored record of where that link pointed — and the
 * shortlink dies long before the archive does. Opening the post's own page
 * makes X fetch the full entity set, and this reads it back out of a response
 * that already happened.
 *
 * There is no setting for this, unlike backfillMedia and captureReplies, and it
 * needs none. Those two each add something with a cost: media files to
 * download, or a large number of conversation rows to store. This path issues
 * no request of its own, can only ADD a value that is missing, and can replace
 * none of the values already there — the worst it can do to the archive is
 * leave it exactly as it was. Nothing is decided by the user here, so there is
 * no moment at which to ask them.
 */
async function handleLinks(payload) {
  const fill = sanitizeLinkFill(payload);
  if (fill === null) {
    await bumpLifetime({ rejected: 1 }, 'rejected a link fill payload that failed validation');
    return { ok: false, error: 'invalid payload' };
  }

  let db;
  try {
    db = await openDB();
  } catch (err) {
    await bumpLifetime({ upsertFailed: 1 }, 'IndexedDB open failed: ' + describe(err));
    return { ok: false, error: 'database unavailable' };
  }

  try {
    const result = await mergeLinkEntities(db, fill.id, fill.urls);
    // Counted apart from one another, like the two deletion outcomes: a tweet
    // this machine never archived has nothing to fill, which is normal and not
    // a failure, while a fill that wrote nothing when a record WAS there would
    // be worth noticing.
    await bumpLifetime({
      linksFilled: result.updated ? 1 : 0,
      linksUnmatched: result.found ? 0 : 1
    });
    log('link targets', fill.id, result.updated ? '(added)' : '(left as it was)');
    return { ok: true, updated: result.updated };
  } catch (err) {
    await bumpLifetime({ upsertFailed: 1 }, 'link fill write failed: ' + describe(err));
    return { ok: false, error: 'write failed' };
  }
}

async function handleMessage(message, sender) {
  if (!isObject(message) || typeof message.type !== 'string') {
    return { ok: false, error: 'malformed message' };
  }

  switch (message.type) {
    /* ---------------------------- from the page ---------------------------- */

    case 'X_TWEET_CAPTURE': {
      if (!isTrustedPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      await bumpLifetime({ received: 1 });
      return handleCapture(message.payload);
    }

    case 'XTB_FILL_MEDIA': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      return handleFillMedia();
    }

    case 'X_TWEET_BACKFILL': {
      if (!isTrustedPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      return handleBackfill(message.payload);
    }

    case 'X_TWEET_DELETE': {
      if (!isTrustedPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      return handleDeletion(message.payload);
    }

    case 'X_TWEET_LINKS': {
      if (!isTrustedPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      return handleLinks(message.payload);
    }

    case 'XTB_DIAG': {
      if (!isTrustedPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      await mergePageDiag(message.payload);
      return { ok: true };
    }

    /* ---------------------------- from the popup --------------------------- */

    case 'XTB_GET_STATE': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      const settings = await getSettings();
      debugEnabled = settings.debug;
      const stats = await getStats();
      let purgeCounts = { superseded: 0, deleted: 0 };
      try {
        purgeCounts = await countTweetsByFilter(await openDB());
      } catch (err) {
        // The list is still usable without these; never fail the whole state
        // request over a count.
        log('purge counts unavailable', err);
      }
      let tweets = null;
      let media = null;
      try {
        const db = await openDB();
        tweets = await countTweets(db);
        media = await countMedia(db);
      } catch (err) {
        log('count failed', err);
      }
      const mediaPermission = await hasMediaPermission();
      return {
        ok: true,
        settings: settings,
        stats: stats,
        counts: { tweets: tweets, media: media },
        purgeCounts: purgeCounts,
        mediaPermission: mediaPermission
      };
    }

    case 'XTB_SET_SETTINGS': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      const settings = await saveSettings(message.patch);
      debugEnabled = settings.debug;
      return { ok: true, settings: settings };
    }

    case 'XTB_SYNC_MEDIA_PERMISSION': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      const granted = await hasMediaPermission();
      if (!granted) {
        const settings = await saveSettings({ mediaCache: false });
        return { ok: true, mediaPermission: false, settings: settings };
      }
      return { ok: true, mediaPermission: true };
    }

    case 'XTB_PURGE': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      if (PURGE_FILTERS.indexOf(message.filter) === -1) {
        return { ok: false, error: 'unknown filter' };
      }
      try {
        const db = await openDB();
        const removed = await purgeTweets(db, message.filter);
        await bumpLifetime({ purged: removed });
        log('purged', message.filter, removed);
        return { ok: true, removed: removed };
      } catch (err) {
        await bumpLifetime({ upsertFailed: 1 }, 'purge failed: ' + describe(err));
        return { ok: false, error: 'purge failed' };
      }
    }

    case 'XTB_DELETE_TWEET': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      const id = normalizeId(message.id);
      if (id === null) return { ok: false, error: 'invalid id' };
      try {
        const db = await openDB();
        await deleteTweet(db, id);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: describe(err) };
      }
    }

    case 'XTB_CLEAR_ALL': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      try {
        const db = await openDB();
        await clearAll(db);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: describe(err) };
      }
    }

    case 'XTB_RESET_STATS': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      const stats = await resetStats();
      return { ok: true, stats: stats };
    }

    default:
      return { ok: false, error: 'unknown message type' };
  }
}

function describe(err) {
  try {
    if (err && err.message) return String(err.message).slice(0, 300);
    return String(err).slice(0, 300);
  } catch (_) {
    return 'unknown error';
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(
    (response) => {
      try {
        sendResponse(response);
      } catch (_) { /* channel already closed */ }
    },
    (err) => {
      try {
        sendResponse({ ok: false, error: describe(err) });
      } catch (_) { /* channel already closed */ }
    }
  );
  return true; // keep the message channel open for the async response
});

async function initialize() {
  try {
    const settings = await getSettings();
    debugEnabled = settings.debug;
    await getStats();
    await openDB();
    log('service worker ready');
  } catch (err) {
    log('initialize failed', err);
  }
  // Deliberately outside the block above: a failed open must not also skip the
  // restore, which is the only thing that can bring back the work a previous
  // worker life left behind. It opens the database itself and leaves the
  // stored list untouched when it cannot.
  await restoreMediaQueue();
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

void initialize();
