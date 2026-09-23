/* ============================================================================
 * background.js  —  MV3 service worker (ES module).
 *
 * The ONLY component allowed to persist archive data. It owns the extension's
 * IndexedDB, re-validates everything that arrives from the page realm, and
 * answers the popup.
 *
 * Message surface (strict whitelist, nothing else is accepted):
 *   from content.js : X_TWEET_CAPTURE, XTB_DIAG
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
  markSuperseded,
  markDeleted,
  recordDeletion,
  listDeletions,
  deleteTweet,
  clearAll,
  countTweets,
  countMedia,
  countTweetsByFilter,
  purgeTweets,
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
  noteCaptureTime
} from './settings.js';

import { cacheMediaForTweet, hasMediaPermission } from './media-cache.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const ALLOWED_PAGE_URL_PREFIXES = ['https://x.com/', 'https://twitter.com/'];
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
 * Rebuild the link / hashtag / mention lists field by field. The expanded URL
 * is the whole point: X stores only a t.co shortlink in the text, and that
 * shortlink stops resolving through anyone but X.
 */
function sanitizeEntities(rawEntities) {
  const src = isObject(rawEntities) ? rawEntities : {};

  const urls = [];
  if (Array.isArray(src.urls)) {
    const limit = Math.min(src.urls.length, MAX_ENTITY_URLS);
    for (let i = 0; i < limit; i++) {
      const item = src.urls[i];
      if (!isObject(item)) continue;
      const url = sanitizeHttpUrl(item.url);
      const expandedUrl = sanitizeHttpUrl(item.expandedUrl);
      if (url === null && expandedUrl === null) continue;
      urls.push({
        url: url,
        expandedUrl: expandedUrl,
        displayUrl: asNonEmptyString(item.displayUrl, 500)
      });
    }
  }

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

/* -------------------------------------------------------------------------- */
/* Media cache queue (best effort, never blocks the tweet write)              */
/* -------------------------------------------------------------------------- */

const mediaQueue = [];
let mediaWorkerRunning = false;

function enqueueMedia(tweet) {
  if (mediaQueue.length >= 50) return;
  mediaQueue.push(tweet);
  void runMediaQueue();
}

async function runMediaQueue() {
  if (mediaWorkerRunning) return;
  mediaWorkerRunning = true;
  try {
    const db = await openDB();
    while (mediaQueue.length > 0) {
      const tweet = mediaQueue.shift();
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
    }
  } catch (err) {
    log('media queue failed', err);
  } finally {
    mediaWorkerRunning = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

function isTrustedPageSender(sender) {
  try {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (!sender.tab) return false;
    const url = typeof sender.url === 'string' ? sender.url : (sender.tab.url || '');
    for (const prefix of ALLOWED_PAGE_URL_PREFIXES) {
      if (url.indexOf(prefix) === 0) return true;
    }
    return false;
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
      enqueueMedia(record);
    }

    log('stored tweet', record.id, result.existed ? '(updated)' : '(new)');
    return { ok: true, id: record.id, existed: result.existed };
  } catch (err) {
    await bumpLifetime({ upsertFailed: 1 }, 'IndexedDB write failed: ' + describe(err));
    return { ok: false, error: 'write failed' };
  }
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

    case 'X_TWEET_DELETE': {
      if (!isTrustedPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      return handleDeletion(message.payload);
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
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

void initialize();
