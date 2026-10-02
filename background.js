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
  upsertConnection,
  countConnections,
  upsertProfile,
  listProfiles,
  countProfiles,
  CONNECTION_LISTS,
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
  rememberOwnAuthors,
  forgetOwnAuthor
} from './settings.js';

import { cacheMediaForTweet, cacheAvatar, hasMediaPermission } from './media-cache.js';

import {
  getJson,
  listSnapshots,
  normalizeSnapshots,
  sanitizeStoredJob,
  runImportPass,
  isHandle,
  hasWaybackPermission,
  IMPORT_STOP,
  WAYBACK_MAX_ROWS
} from './wayback.js';

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
/* The same number inject.js clamps a quoted post's body to, applied again on
   this side because nothing arriving over the bridge is trusted to have been
   clamped. X's own long-post ceiling, so the cap can never cut off something
   X would have let its author write. */
const MAX_QUOTED_TEXT_CHARS = 25000;
const MAX_CLIENT_NAME_CHARS = 200;
const MAX_CLIENT_URL_CHARS = 300;
const MAX_MEDIA_ITEMS = 64;
const MAX_VARIANTS_PER_MEDIA = 32;
const MAX_POLL_CHOICES = 4;
const MAX_EDIT_VERSIONS = 64;
const MAX_ENTITY_URLS = 64;
const MAX_ENTITY_TAGS = 64;
const MAX_ENTITY_MENTIONS = 64;
/* The three lists above can hold 64 each, so this is the room for all of them
   together plus slack — a body cannot legitimately mark up more spans than it
   has entities to mark. */
const MAX_ENTITY_SPANS = 256;
const LANG_PATTERN = /^[A-Za-z0-9-]{1,16}$/;
/* X's reply settings are short lowercase words — "everyone", "following",
   "mentioned". A pattern rather than a closed list: a value X adds later should
   arrive as an unknown-but-well-formed word, not be silently dropped as junk. */
const REPLY_SETTINGS_PATTERN = /^[a-z][a-z_]{0,31}$/;
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

/**
 * A whole number, or null. An offset into a string has no meaningful fraction,
 * and rounding one would move a span to a place the sender never named — so a
 * fractional value is refused rather than nudged.
 */
function asFiniteInteger(value) {
  const n = asNumberOrNull(value);
  if (n === null || !Number.isSafeInteger(n)) return null;
  return n;
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
 * The quoted post's own content, as far as it was captured.
 *
 * Rebuilt field by field like everything else here, even though inject.js
 * produced it a moment ago: the bridge is a boundary, and a value that crossed
 * it is treated as arriving from the page, not from ourselves. Media, metrics
 * and entities are deliberately NOT carried — inject.js does not extract them
 * and this would drop them anyway, so the two ends agree on the same small
 * shape instead of one of them quietly expecting more.
 *
 * `null` when there is no usable id, which is also what a record with no quote
 * carries. An object with an id and an empty body is a real case — a quoted
 * post that is only media has no text — and is kept.
 */
function sanitizeQuotedTweet(rawQuoted) {
  if (!isObject(rawQuoted)) return null;

  const tweetId = normalizeId(rawQuoted.tweetId);
  if (tweetId === null) return null;

  const text = asString(rawQuoted.text, MAX_QUOTED_TEXT_CHARS);

  return {
    tweetId: tweetId,
    text: text === null ? '' : text,
    createdAt: asIsoString(rawQuoted.createdAt, null),
    createdAtRaw: asNonEmptyString(rawQuoted.createdAtRaw, 100),
    author: sanitizeAuthor(rawQuoted.author)
  };
}

/**
 * Which client the post was made from.
 *
 * The page hands this over as an HTML anchor; inject.js already strips the
 * markup down to a label and an href, and this is the second pass that decides
 * what the two are allowed to be. `http`/`https` only, on any host — the label
 * is a product name X wrote, not a link the archive will ever follow — so
 * anything else is dropped rather than carried.
 */
function sanitizePostedVia(rawPostedVia) {
  if (!isObject(rawPostedVia)) return null;

  const name = asNonEmptyString(rawPostedVia.name, MAX_CLIENT_NAME_CHARS);

  let url = null;
  const rawUrl = asString(rawPostedVia.url, MAX_CLIENT_URL_CHARS);
  if (rawUrl !== null) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:') url = parsed.href;
    } catch (_) { /* not a URL, so nothing to carry */ }
  }

  if (name === null && url === null) return null;
  return { name: name, url: url };
}

/**
 * How the account itself had reacted when the post was seen.
 *
 * Three booleans, and `=== true` on each rather than coercion: a missing key
 * and a false one mean the same thing to X here (it did not react), but only
 * one of them is an answer, and a truthy string must never become a yes.
 */
function sanitizeViewerState(rawViewerState) {
  if (!isObject(rawViewerState)) return null;
  return {
    liked: rawViewerState.liked === true,
    bookmarked: rawViewerState.bookmarked === true,
    reposted: rawViewerState.reposted === true
  };
}

/**
 * X's sensitive-content mark — true, false, or nothing at all.
 *
 * `null` is a third answer here, not a missing one. X omits the field when it
 * has nothing to say, and writing that omission down as `false` would be
 * recording an answer nobody gave.
 */
function sanitizeSensitive(rawSensitive) {
  if (rawSensitive === true) return true;
  if (rawSensitive === false) return false;
  return null;
}

/**
 * Who was allowed to reply — "everyone", "following", "mentioned".
 *
 * Only the archive carries this. Measured on two live responses (a focal-tweet
 * fetch and a twenty-post timeline), `reply_settings` appeared zero times in
 * both, while the archived copy of the same posts has it. So on a record
 * captured live this is null and says nothing, and it fills in only when the
 * post is imported from the archive. `null` therefore means "not known", and
 * must never be read as "everyone".
 */
function sanitizeReplySettings(rawReplySettings) {
  const s = asNonEmptyString(rawReplySettings, 32);
  if (s === null || !REPLY_SETTINGS_PATTERN.test(s)) return null;
  return s;
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
 * The accounts named inside a bio, rebuilt field by field.
 *
 * Same shape the post text uses for its mentions, and the same reason: a handle
 * is what a reader can act on and a display name is what a reader recognises,
 * and the response carries them separately. A handle that is not a handle is
 * dropped rather than stored — the bio's own text still shows whatever was
 * written there, so nothing is lost by refusing to call it a username.
 */
function sanitizeBioMentions(rawMentions) {
  const out = [];
  if (!Array.isArray(rawMentions)) return out;
  const limit = Math.min(rawMentions.length, MAX_BIO_MENTIONS);
  for (let i = 0; i < limit; i++) {
    const item = rawMentions[i];
    if (!isObject(item)) continue;
    const handle = asNonEmptyString(item.screenName, 20);
    if (handle === null || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) continue;
    out.push({
      screenName: handle,
      name: asNonEmptyString(item.name, MAX_SHORT_CHARS)
    });
  }
  return out;
}

/**
 * Rebuild the link / hashtag / mention lists field by field. The expanded URL
 * is the whole point: X stores only a t.co shortlink in the text, and that
 * shortlink stops resolving through anyone but X.
 */
/**
 * Where each link, hashtag and mention sits in the post's text.
 *
 * A separate list rather than extra keys on the three existing ones, for two
 * reasons. `hashtags` is a list of bare strings and turning it into objects
 * would break every reader that already walks it; and the shape below is the
 * one the reader builds for itself internally, so the day it trusts stored
 * positions it can read this straight out instead of translating.
 *
 * Only `kind`, `start` and `end` live here. What a span *points at* stays in
 * the three lists — this says where, not what, and keeping the two apart means
 * a position never has to be re-validated as a URL.
 *
 * Empty is the normal case: X sends no positions in a timeline response, so
 * anything captured by a profile sweep has none. Absence means "not known",
 * never "there is nothing here".
 */
function sanitizeEntitySpans(rawSpans) {
  const out = [];
  if (!Array.isArray(rawSpans)) return out;

  const kinds = ['url', 'tag', 'who'];
  const limit = Math.min(rawSpans.length, MAX_ENTITY_SPANS);

  for (let i = 0; i < limit; i++) {
    const item = rawSpans[i];
    if (!isObject(item)) continue;

    const kind = asNonEmptyString(item.kind, 8);
    if (kind === null || kinds.indexOf(kind) === -1) continue;

    const start = asFiniteInteger(item.start);
    const end = asFiniteInteger(item.end);
    /* `end > start` and both non-negative: a span of zero width marks nothing,
       and a negative offset cannot be a position in any text. Where it lands
       relative to the actual body is the reader's business — this side has no
       text to check it against, and guessing here would only invent a rule the
       reader would then have to work around. */
    if (start === null || end === null || start < 0 || end <= start) continue;

    out.push({ kind: kind, start: start, end: end });
  }
  return out;
}

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

  return {
    urls: urls,
    hashtags: hashtags,
    mentions: mentions,
    spans: sanitizeEntitySpans(src.spans)
  };
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
    quotedTweet: sanitizeQuotedTweet(raw.quotedTweet),
    postedVia: sanitizePostedVia(raw.postedVia),
    viewerState: sanitizeViewerState(raw.viewerState),
    sensitive: sanitizeSensitive(raw.sensitive),
    replySettings: sanitizeReplySettings(raw.replySettings),
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

/**
 * A screen name, or an empty string. Never null.
 *
 * The empty string is load-bearing: `screenNameLower` is part of the roster's
 * index key, and IndexedDB writes NO index entry at all for a record whose key
 * component is invalid. A null there would leave the row in the store but
 * missing from every listing, which is the silent loss this archive exists to
 * prevent. An empty string is a valid key that sorts to the top, where a
 * nameless person is easy to see and fix.
 */
function asHandle(value) {
  const s = asString(value, 20);
  if (s === null || !/^[A-Za-z0-9_]{1,15}$/.test(s)) return null;
  return s;
}

/**
 * Rebuild one roster row from a whitelist.
 *
 * Like sanitizeLinkFill this does NOT go through sanitizeRecord: a person is not
 * a tweet, and accepting a capture-shaped payload here would invite a forged one
 * to be stored as one. Every field is either copied through a coercion or
 * dropped; nothing arrives by default.
 *
 * `list` and `ownerId` come from the MESSAGE, not the row — see validateConnections
 * in content.js. They are the row's primary key, and a key a row could assert
 * for itself is a key a forged row could pick.
 */
function sanitizeConnection(raw, list, ownerId) {
  if (!isObject(raw)) return null;

  const userId = normalizeId(raw.userId);
  if (userId === null) return null;

  const handle = asHandle(raw.screenName);
  const bioUrls = sanitizeEntityUrls(raw.bioUrls);

  return {
    list: list,
    userId: userId,
    screenName: handle,
    screenNameLower: handle === null ? '' : handle.toLowerCase(),
    name: asNonEmptyString(raw.name, 200),
    accountCreatedAt: asIsoString(raw.accountCreatedAt, null),
    bio: asString(raw.bio, 2000),
    bioUrls: bioUrls,
    location: asString(raw.location, 200),
    websiteUrl: sanitizeHttpUrl(raw.websiteUrl),
    lang: (() => {
      const s = asString(raw.lang, 20);
      return (s !== null && /^[a-zA-Z][a-zA-Z0-9-]{0,19}$/.test(s)) ? s : null;
    })(),
    blueVerified: asBooleanOrNull(raw.blueVerified),
    verified: asBooleanOrNull(raw.verified),
    followersCount: asNumberOrNull(raw.followersCount),
    followingCount: asNumberOrNull(raw.followingCount),
    tweetCount: asNumberOrNull(raw.tweetCount),
    avatarUrl: sanitizeTwimgUrl(raw.avatarUrl),
    // The account this was seen through. Part of the row's own history, not the
    // page's data, so it is stamped here rather than read from the payload.
    ownerIds: [ownerId],
    source: {
      operationName: asString(raw.source && raw.source.operationName, 60),
      capturedVia: asString(raw.source && raw.source.capturedVia, 10)
    },
    schemaVersion: SCHEMA_VERSION
  };
}

/** Every usable row in one follow-list message. Returns null if the batch cannot be one. */
function sanitizeConnections(payload) {
  if (!isObject(payload)) return null;
  if (CONNECTION_LISTS.indexOf(payload.list) === -1) return null;

  const ownerId = normalizeId(payload.ownerId);
  if (ownerId === null) return null;
  if (!Array.isArray(payload.records) || payload.records.length === 0) return null;

  const records = [];
  let rejected = 0;
  for (let i = 0; i < payload.records.length; i++) {
    const record = sanitizeConnection(payload.records[i], payload.list, ownerId);
    if (record === null) {
      rejected++;
      continue;
    }
    records.push(record);
  }
  return { records: records, rejected: rejected };
}

/* ------------------------------------------------------------ own profile */

/** How much bio to keep. The same number inject.js clamps to, applied again. */
const MAX_PROFILE_BIO = 2000;
const MAX_BIO_URLS = 8;
const MAX_BIO_MENTIONS = 8;
const MAX_TEXT_CHARS_PROFILE = 2000;
const MAX_SHORT_CHARS = 200;

/**
 * Rebuild your own profile card from a whitelist.
 *
 * Like sanitizeConnection this does NOT go through sanitizeRecord: a person is
 * not a tweet, and accepting a capture-shaped payload here would invite a forged
 * one to be treated as a capture. Every field is either copied through a
 * coercion or dropped; nothing arrives by default.
 *
 * It does not take an owner id, unlike sanitizeConnection. That parameter exists
 * because a roster row's primary key is not something the row may assert; here
 * the account IS the row, and inject.js has already refused to send any card
 * whose id is not one this browser has watched publish.
 */
function sanitizeProfile(raw) {
  if (!isObject(raw)) return null;

  const userId = normalizeId(raw.userId);
  if (userId === null) return null;

  const handle = asNonEmptyString(raw.screenName, 20);
  const screenName = handle !== null && /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;

  return {
    userId: userId,
    screenName: screenName,
    // Always a string. `connections` has an index keyed on this and a null there
    // silently removes a row from every listing; this store has no index, but
    // the field is the same field and two meanings for one name is how that
    // hazard gets reintroduced somewhere else.
    screenNameLower: screenName === null ? '' : screenName.toLowerCase(),
    name: asNonEmptyString(raw.name, MAX_SHORT_CHARS),
    accountCreatedAt: asIsoString(raw.accountCreatedAt, null),
    bio: asString(raw.bio, MAX_PROFILE_BIO),
    bioUrls: sanitizeEntityUrls(raw.bioUrls).slice(0, MAX_BIO_URLS),
    /* The accounts named in the bio. The bio TEXT already contains "@name"
       verbatim — these are the offsets' worth of structure beside it, kept for
       the same reason the post text keeps its entity lists: the archive is the
       copy that is supposed to have everything the response carried. */
    bioMentions: sanitizeBioMentions(raw.bioMentions),
    location: asString(raw.location, MAX_SHORT_CHARS),
    websiteUrl: sanitizeHttpUrl(raw.websiteUrl),
    lang: (() => {
      const s = asString(raw.lang, 20);
      return (s !== null && /^[a-zA-Z][a-zA-Z0-9-]{0,19}$/.test(s)) ? s : null;
    })(),
    blueVerified: asBooleanOrNull(raw.blueVerified),
    verified: asBooleanOrNull(raw.verified),
    followersCount: asNumberOrNull(raw.followersCount),
    followingCount: asNumberOrNull(raw.followingCount),
    tweetCount: asNumberOrNull(raw.tweetCount),
    /* The other three numbers the response carries. `likeCount` here is the
       account's lifetime likes GIVEN — the same key on a tweet means the likes
       that post received, which is why this is only ever read off a profile. */
    listedCount: asNumberOrNull(raw.listedCount),
    mediaCount: asNumberOrNull(raw.mediaCount),
    likeCount: asNumberOrNull(raw.likeCount),
    /* Whether the account is locked. Null, not false, when the response did not
       say: "not recorded" and "open account" are different answers. */
    protected: asBooleanOrNull(raw.protected),
    pinnedTweetId: normalizeId(raw.pinnedTweetId),
    avatarUrl: sanitizeTwimgUrl(raw.avatarUrl),
    bannerUrl: sanitizeTwimgUrl(raw.bannerUrl),
    source: {
      operationName: asString(raw.source && raw.source.operationName, 60),
      capturedVia: asString(raw.source && raw.source.capturedVia, 10)
    },
    schemaVersion: SCHEMA_VERSION
  };
}

/**
 * Store one sighting of your own profile.
 *
 * The timestamp comes from this machine's clock, never from the payload, for the
 * same reason a roster row's does: the row means "when this browser last saw it",
 * and only this browser knows that.
 */
async function handleProfile(payload) {
  const record = sanitizeProfile(payload);
  if (record === null) return { ok: false, error: 'malformed profile payload' };

  let db;
  try {
    db = await openDB();
  } catch (err) {
    await bumpLifetime({ upsertFailed: 1 }, 'IndexedDB open failed: ' + describe(err));
    return { ok: false, error: 'database unavailable' };
  }

  const seenAt = new Date().toISOString();
  try {
    const result = await upsertProfile(db, record, seenAt);
    await bumpLifetime(result.existed ? { profileRefreshed: 1 } : { profileAdded: 1 });
  } catch (err) {
    return { ok: false, error: describe(err) };
  }

  /* And the picture, once. Awaited rather than fired and forgotten: this
     handler's promise is what keeps the worker alive, and a floating fetch in a
     service worker is a fetch that may simply never land. It costs one request
     on the first sighting of a profile and nothing at all afterwards.
   *
   * Deliberately not gated on the media-cache switch. That switch is about
   * downloading hundreds of photographs; this is one small picture of the
   * account's own face, and a user who granted the host permission for either
   * reason has already answered. */
  try {
    const avatar = await cacheAvatar(db, record);
    if (avatar.cached) await bumpLifetime({ avatarCached: 1 });
    else if (avatar.reason !== null) await bumpLifetime({ avatarFailed: 1 });
  } catch (_) { /* the card is stored; the picture is a bonus */ }

  // Nothing else moves: no media is queued and lastCaptureAt is untouched,
  // because a profile card is not a post and must not make the popup claim one
  // was captured.
  return { ok: true };
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
          await bumpLifetime({
            mediaCached: result.cached,
            mediaFailed: result.failed,
            mediaFromArchive: result.fromArchive
          });
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
/* Internet Archive import                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The same shape as the media queue above, for the same reason, one step up.
 *
 *   `xtbWaybackRows` holds the snapshot list one run is working through — the
 *   addresses of the archived copies of one account's posts. It is written once
 *   per run, because it does not change while a run is going.
 *
 *   `xtbWaybackJob` holds the position: which row is being worked on and what
 *   has happened so far. It is written AFTER EVERY ITEM, because that is the
 *   only thing standing between a browser that kills an idle worker and a run
 *   that silently starts over — or worse, one that skips whatever it was
 *   holding when it died.
 *
 * Both are complete snapshots written through one chain, so two writes
 * completing out of order can leave a stale value but never a torn one. A stale
 * value is safe: the engine re-reads the database before it writes anything.
 */
const WAYBACK_ROWS_KEY = 'xtbWaybackRows';
const WAYBACK_JOB_KEY = 'xtbWaybackJob';

/**
 * The alarm that keeps a run moving when nothing else is happening.
 *
 * MV3 ends an idle service worker after about thirty seconds and a pending
 * `await fetch()` does not hold it open. The media queue gets its wake-ups for
 * free — the user is browsing x.com, so something is always arriving — but a
 * three-minute import runs while the user is doing something else entirely, and
 * without this the run would stall until they next opened a tab. Nothing wakes
 * a dead worker on its own; an alarm is the one thing that does.
 */
const WAYBACK_ALARM = 'xtbWayback';
const WAYBACK_ALARM_MINUTES = 1;

let waybackRows = [];
let waybackRowsHandle = null;
let waybackJob = null;
let waybackWorkerRunning = false;
let waybackWriteChain = Promise.resolve();
let waybackRestoreSettled = false;

/** What the popup shows when a run has just finished, before it polls again. */
let waybackLastResult = null;

function persistWaybackRows() {
  const payload = {
    v: 1,
    handle: waybackRowsHandle,
    rows: waybackRows.map((snapshot) => ({ timestamp: snapshot.timestamp, original: snapshot.original }))
  };
  waybackWriteChain = waybackWriteChain.then(
    () => writeStoredWayback(WAYBACK_ROWS_KEY, payload),
    () => writeStoredWayback(WAYBACK_ROWS_KEY, payload)
  );
}

function persistWaybackJob() {
  const payload = waybackJob === null ? null : Object.assign({}, waybackJob);
  waybackWriteChain = waybackWriteChain.then(
    () => writeStoredWayback(WAYBACK_JOB_KEY, payload),
    () => writeStoredWayback(WAYBACK_JOB_KEY, payload)
  );
}

/** One write. Never rejects: losing the mirror is not losing the archive. */
function writeStoredWayback(key, value) {
  return new Promise((resolve) => {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }
      const result = chrome.storage.local.set({ [key]: value });
      if (result && typeof result.then === 'function') result.then(resolve, resolve);
      else resolve();
    } catch (_) {
      resolve();
    }
  });
}

function readStoredWayback(key) {
  return new Promise((resolve) => {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) {
        resolve(undefined);
        return;
      }
      const result = chrome.storage.local.get({ [key]: null });
      if (result && typeof result.then === 'function') {
        result.then((got) => resolve(got ? got[key] : undefined), () => resolve(undefined));
      } else {
        resolve(undefined);
      }
    } catch (_) {
      resolve(undefined);
    }
  });
}

/** Drop the wake-up alarm: see the end of runWaybackJob for when and why. */
function clearWaybackAlarm() {
  try {
    if (chrome && chrome.alarms) chrome.alarms.clear(WAYBACK_ALARM);
  } catch (_) { /* an alarm that will not clear is not worth failing a run over */ }
}

/** Put the alarm in step with whether a run is live. */
function syncWaybackAlarm() {
  try {
    if (!chrome || !chrome.alarms) return;
    if (waybackJob !== null && !waybackJob.cancelRequested && waybackJob.pauseReason === null) {
      chrome.alarms.create(WAYBACK_ALARM, { periodInMinutes: WAYBACK_ALARM_MINUTES });
    } else {
      chrome.alarms.clear(WAYBACK_ALARM);
    }
  } catch (_) { /* an alarm that will not arm is not a reason to stop the run */ }
}

/** Stop for a reason the user should see: off, or no permission. */
function pauseWayback(reason) {
  if (waybackJob === null) return;
  // 'stopped' is the user's own decision, and it outranks a reason the code
  // worked out by itself. Without this, pressing Stop and then having a
  // permission revoked would replace the marker — and a job with a reason the
  // code can satisfy on its own is one the next worker start is allowed to
  // pick back up, which is exactly what Stop promised would not happen.
  if (waybackJob.pauseReason !== 'stopped') waybackJob.pauseReason = reason;
  persistWaybackJob();
  syncWaybackAlarm();
}

/**
 * Why the run may not proceed, or null.
 *
 * Read fresh on every item rather than once at the start: the switch can be
 * turned off and the permission can be revoked from chrome://extensions while a
 * three-minute run is in the middle of its batch, and the answer to "may I make
 * one more request to somebody else's server" has to be the answer NOW.
 */
async function waybackBlockedReason() {
  const settings = await getSettings();
  if (settings.waybackEnabled !== true) return 'off';
  if (!(await hasWaybackPermission())) return 'permission';
  return null;
}

/**
 * Do one pass. Returns the engine's summary, or null when there was nothing to
 * do because another pass is already running.
 */
async function runWaybackJob() {
  if (waybackWorkerRunning) return null;
  if (waybackJob === null) return null;
  // A paused job does not move. `chrome.alarms.clear` is asynchronous, so an
  // alarm that had already been delivered — but not yet dispatched — when the
  // pause was written will still arrive here afterwards, and without this it
  // would start the very run the pause exists to hold. Worse for 'stopped',
  // where the whole promise is that nothing but a press brings it back.
  // Every legitimate caller clears the pause first, so this refuses nothing.
  if (waybackJob.pauseReason !== null) return null;

  waybackWorkerRunning = true;
  syncWaybackAlarm();

  try {
    let db;
    try {
      db = await openDB();
    } catch (err) {
      // Not fatal and not counted as a failure: the archive is fine, this
      // browser is not. Leaving the job untouched means the next wake retries
      // it from exactly where it stopped.
      log('wayback: database unavailable, run left where it stands', err);
      return null;
    }

    const job = waybackJob;
    const result = await runImportPass({
      job: job,
      rows: waybackRows,
      deps: {
        blockedReason: waybackBlockedReason,
        readRecord: async (id) => {
          try {
            const row = await getTweet(db, id);
            return row === undefined || row === null ? null : row;
          } catch (_) {
            return null;
          }
        },
        fetchJson: (url) => getJson(url),
        writeRecord: async (record) => {
          // The same trust boundary every other writer goes through: these
          // bytes came off the network, whoever is holding the other end.
          const clean = sanitizeRecord(record);
          if (clean === null) throw new Error('the archived record failed validation');
          return upsertTweet(db, clean);
        },
        /* The account's own card, which the archived payloads carry and the
           import used to drop — see toProfile. Same trust boundary as a record:
           these bytes came off the network, so they go through sanitizeProfile
           and then the same store the live capture writes to. */
        saveProfile: async (card) => {
          const clean = sanitizeProfile(card);
          if (clean === null) throw new Error('the archived profile failed validation');

          /* One rule: an import may write a card only when the store has NONE
           * for this account. If any card is already there — live-captured or
           * imported — it stays untouched.
           *
           * mergeProfile applies "the newest answer wins" by arrival order, and
           * an imported card arrives now, so writing one over an existing card
           * would replace it with a sighting from whenever the crawl ran and
           * stamp `lastSeenAt` with the import time as if the browser had just
           * looked. That is the reported bug: an archived payload from the day
           * the account started posting carries 0 followers / 1 post, and once
           * it is stamped with the import time listProfiles returns it first.
           *
           * Nothing in the card says which crawl it came from — the engine's
           * in-run "newest wins" cannot tell one run's card from a previous
           * run's, and a resumed run can hold an older list than the one
           * already stored. So the comparison is not attempted at all: no card,
           * write; card of any origin, leave it. A live capture is what the
           * account looks like now, and an imported card, however old, is still
           * a true sighting of it. The reverse is not blocked: handleProfile
           * has no such guard, so a later visit to the account's own page
           * refreshes an imported card from live bytes. */
          let existing;
          try {
            existing = await listProfiles(db);
          } catch (_) {
            /* A read that failed means "cannot tell whether a card is there",
               and the two ways to be wrong are not equally bad: skipping the
               write loses nothing that is not in the archive to fetch again,
               while writing over a card the browser captured live loses it for
               good. So a failed read skips. */
            return;
          }
          for (const row of existing) {
            if (String(row.userId) === String(clean.userId)) return;
          }

          await upsertProfile(db, clean, job.seenAt);
        },
        save: async () => { persistWaybackJob(); },
        bump: (bumps, error) => { void bumpLifetime(bumps, error || undefined); },
        // A quarter of a second between requests, which is the same politeness
        // the command-line tool shows. The engine takes this as an argument so
        // that its tests do not spend three minutes asleep.
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      }
    });

    waybackLastResult = result;

    if (result.reason === IMPORT_STOP.DONE) {
      log('wayback: finished', result);
      waybackJob = null;
      waybackRows = [];
      waybackRowsHandle = null;
      await writeStoredWayback(WAYBACK_JOB_KEY, null);
    } else if (result.reason === IMPORT_STOP.BATCH) {
      log('wayback: batch finished, position kept', result);
    } else if (result.reason === IMPORT_STOP.CANCELLED) {
      // Stopped by the user, and the position STAYS. Clearing it was the one
      // case where "it picks up where it left off" was not true, and it was not
      // true in the one situation where the user is most likely to look: they
      // watched it stop on purpose.
      //
      // What keeps this from turning into an auto-resume is `pauseReason`. A
      // job carrying one is never started by anything except a press — not by
      // the alarm, not by a worker restart — so "I stopped it" survives having
      // the browser closed and reopened underneath it.
      log('wayback: stopped by the user, position kept', result);
      if (waybackJob === job) {
        waybackJob.pauseReason = 'stopped';
        // The request is served. Leaving it set would make the next press look
        // like a run that had already been told to stop.
        waybackJob.cancelRequested = false;
      }
      persistWaybackJob();
    }

    /* The alarm exists to wake a worker the browser KILLED mid-pass. A batch
       that finished did not die — it stopped, which is the whole contract of
       "run in batches, keep the position" — so nothing should keep waking to
       continue it. Leaving the alarm armed here meant a service-worker start
       and a storage read every minute, for ever, each one calling
       runImportPass and returning BATCH on its first check because
       `fetched === batch`; and the Stop button is not even offered in that
       state. Clearing it costs one more wake at most, since the alarm's own
       handler lands here too. */
    if (result.reason === IMPORT_STOP.BATCH) clearWaybackAlarm();
    else syncWaybackAlarm();
    return result;
  } finally {
    waybackWorkerRunning = false;
  }
}

/** Start a run, or resume the one already on disk. */
async function startWayback(handle, batch, mode) {
  if (waybackWorkerRunning) {
    return { ok: false, error: 'already running', wayback: waybackSummary() };
  }

  const resuming = waybackJob !== null && waybackJob.handle === handle && waybackJob.mode === mode;
  if (!resuming) {
    if (waybackJob !== null) {
      // A different handle or a different mode: the stored position describes a
      // list that is no longer the one being worked on, so it goes.
      waybackJob = null;
      waybackRows = [];
      waybackRowsHandle = null;
      await writeStoredWayback(WAYBACK_JOB_KEY, null);
    }

    const listed = await listSnapshots(handle);
    const rows = normalizeSnapshots(listed);
    if (rows.length === 0) {
      return { ok: false, error: 'no snapshots for that handle' };
    }

    waybackRows = rows;
    waybackRowsHandle = handle;
    persistWaybackRows();

    waybackJob = {
      v: 1,
      mode: mode,
      handle: handle,
      batch: batch,
      // One clock reading for the whole run, so every record it writes carries
      // the same capturedAt and the list stays ordered by publish time under it.
      seenAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      cursor: 0,
      fetched: 0,
      imported: 0,
      enriched: 0,
      skipped: 0,
      failed: 0,
      consecutiveFailures: 0,
      cancelRequested: false,
      pauseReason: null
    };
  } else {
    // A new press. The batch is counted per press, so this is what makes the
    // second press do anything at all.
    waybackJob.batch = batch;
    waybackJob.fetched = 0;
    waybackJob.cancelRequested = false;
    waybackJob.pauseReason = null;
  }

  persistWaybackJob();
  syncWaybackAlarm();
  void runWaybackJob();
  return { ok: true, wayback: waybackSummary() };
}

/** What the popup shows. Never touches the database. */
function waybackSummary() {
  if (waybackJob === null) {
    return waybackLastResult === null
      ? { running: false, job: null, total: 0, last: null }
      : { running: false, job: null, total: 0, last: waybackLastResult };
  }
  return {
    running: waybackWorkerRunning,
    job: Object.assign({}, waybackJob),
    total: waybackRows.length,
    last: waybackLastResult
  };
}

/** Ask the run to stop. The flag goes to disk BEFORE this returns. */
async function cancelWayback() {
  if (waybackJob === null) return { ok: true, wayback: waybackSummary() };
  waybackJob.cancelRequested = true;
  persistWaybackJob();
  syncWaybackAlarm();
  // Deliberately does not wait for the loop: the request in flight is allowed
  // to finish, and the loop is what will notice. The flag is already on disk,
  // so a worker that dies before that still comes back cancelled.
  return { ok: true, wayback: waybackSummary() };
}

/**
 * Pick up a run the previous worker life left behind.
 *
 * Called from initialize() alongside the media queue's restore, and for the
 * same reason: this is the only thing that makes "kept running after the popup
 * closed" true rather than aspirational.
 */
async function restoreWaybackJob() {
  if (waybackRestoreSettled) return false;
  waybackRestoreSettled = true;

  const storedJob = sanitizeStoredJob(await readStoredWayback(WAYBACK_JOB_KEY));
  if (storedJob === null) {
    await writeStoredWayback(WAYBACK_JOB_KEY, null);
    return false;
  }

  const storedRows = await readStoredWayback(WAYBACK_ROWS_KEY);
  if (!storedRows || typeof storedRows !== 'object' || storedRows.handle !== storedJob.handle ||
      !Array.isArray(storedRows.rows)) {
    // The position without its list is not a job; it is half of one. Dropping
    // both is the only honest move — resuming against the wrong list would
    // import from somewhere the user never asked about.
    log('wayback: a stored position had no matching snapshot list; both dropped');
    await writeStoredWayback(WAYBACK_JOB_KEY, null);
    return false;
  }

  // A stop request that reached the disk but never reached the loop — the
  // worker died in between — means the same thing as a stop the loop did act
  // on. Both become the same pause, so the question later is only ever "is
  // there a pause on this job", not "which of two ways did it stop".
  if (storedJob.cancelRequested) {
    storedJob.cancelRequested = false;
    storedJob.pauseReason = 'stopped';
    log('wayback: a stop that arrived too late to be acted on is now a pause');
  }

  waybackJob = storedJob;
  waybackRows = storedRows.rows;
  waybackRowsHandle = storedRows.handle;

  if (storedJob.pauseReason === 'stopped') {
    // Loaded, so the popup can say where it stopped, and deliberately NOT
    // started. Every other pause here means "the code is waiting for a
    // condition" and is allowed to lift itself; this one means "the user said
    // stop", and only a press may lift it.
    persistWaybackJob();
    syncWaybackAlarm();
    return false;
  }

  if ((await waybackBlockedReason()) !== null) {
    // Off, or no permission. Nothing was lost: the position and the list stay
    // on disk, and re-granting plus a press continues from the same cursor.
    syncWaybackAlarm();
    return false;
  }

  log('wayback: resuming at ' + storedJob.cursor + ' of ' + waybackRows.length);
  syncWaybackAlarm();
  void runWaybackJob();
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
 * Store one page of a Following or Followers list.
 *
 * The batch's `seenAt` is taken once, here, from this machine's clock. The
 * page's clock is forgeable and the row's meaning is "when this browser last
 * saw them", which only this side knows.
 *
 * Nothing here queues media. A roster keeps an avatar URL, not the file, and
 * enqueueMedia takes a tweet — it reads `tweet.media` — so handing it a person
 * would be an error the language cannot catch.
 *
 * `lastCaptureAt` is deliberately NOT moved by this. That figure sits beside a
 * count of archived posts and is read as "when did I last back something up";
 * a follow list being paged through is not that, and moving it would make the
 * number answer a different question than the one it is displayed for.
 */
async function handleConnections(payload) {
  const sanitized = sanitizeConnections(payload);
  if (sanitized === null) {
    await bumpLifetime({ rejected: 1 }, 'rejected a follow-list payload that could not be one');
    return { ok: false, error: 'invalid payload' };
  }

  let db;
  try {
    db = await openDB();
  } catch (err) {
    await bumpLifetime({ upsertFailed: 1 }, 'IndexedDB open failed: ' + describe(err));
    return { ok: false, error: 'database unavailable' };
  }

  const seenAt = new Date().toISOString();
  let added = 0;
  let refreshed = 0;
  let rejected = sanitized.rejected;

  for (let i = 0; i < sanitized.records.length; i++) {
    try {
      const result = await upsertConnection(db, sanitized.records[i], seenAt);
      if (result.existed) refreshed++;
      else added++;
    } catch (err) {
      // One bad row must not cost the rest of the page.
      rejected++;
      log('connection row failed', describe(err));
    }
  }

  await bumpLifetime({ connectionsAdded: added, connectionsRefreshed: refreshed, rejected: rejected });
  log('follow list (' + sanitized.records[0].list + '): ' + added + ' new, ' + refreshed +
      ' already known, ' + rejected + ' rejected');

  // Nothing written and at least one row refused: the page accomplished nothing,
  // and saying so is what turns a silent dead capture into something the panel
  // can show. A page where every person was ALREADY known is a success, not a
  // failure, and does not land here.
  if (added === 0 && refreshed === 0 && rejected > 0) {
    return {
      ok: false, error: 'every row in the follow list was rejected (' + rejected + ')',
      added: added, refreshed: refreshed, rejected: rejected
    };
  }

  return { ok: true, added: added, refreshed: refreshed, rejected: rejected };
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

    case 'X_CONNECTIONS_SEEN': {
      if (!isTrustedPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      return handleConnections(message.payload);
    }

    case 'X_TWEET_DELETE': {
      if (!isTrustedPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      return handleDeletion(message.payload);
    }

    case 'X_TWEET_LINKS': {
      if (!isTrustedPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      return handleLinks(message.payload);
    }

    case 'X_PROFILE_SEEN': {
      if (!isTrustedPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      return handleProfile(message.payload);
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
      let following = null;
      let followers = null;
      let profiles = null;
      try {
        const db = await openDB();
        tweets = await countTweets(db);
        media = await countMedia(db);
        following = await countConnections(db, 'following');
        followers = await countConnections(db, 'followers');
        // Reported so the popup can tell "you have not opened your profile yet"
        // apart from "the card is here and the reader will draw it". Those two
        // states look identical from an empty archive otherwise.
        profiles = await countProfiles(db);
      } catch (err) {
        log('count failed', err);
      }
      // The popup cannot learn this any other way from here, and it is what
      // decides which of the two things the roster note says: an empty roster on
      // a browser that has never seen you publish is not the same state as an
      // empty one on a browser that has, and only this count tells them apart.
      let ownAuthors = [];
      try {
        ownAuthors = await getOwnAuthors();
      } catch (err) {
        log('own author list failed', err);
      }
      const mediaPermission = await hasMediaPermission();
      const waybackPermission = settings.waybackEnabled === true
        ? await hasWaybackPermission()
        : false;
      return {
        ok: true,
        settings: settings,
        stats: stats,
        counts: {
          tweets: tweets, media: media,
          following: following, followers: followers, profiles: profiles
        },
        ownAuthors: ownAuthors,
        purgeCounts: purgeCounts,
        mediaPermission: mediaPermission,
        waybackPermission: waybackPermission,
        wayback: waybackSummary()
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

    /* Forget one id that was being treated as this account.
     *
     * Routed through here rather than written straight from the popup, because
     * settings.js's write queue is per context: the popup and the worker each
     * have their own, so two contexts doing read-modify-write on the same list
     * can lose one of the two edits. Every other settings write already goes
     * this way for the same reason. */
    case 'XTB_FORGET_OWN_AUTHOR': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      if (typeof message.id !== 'string' || message.id.length === 0) {
        return { ok: false, error: 'invalid id' };
      }
      const remaining = await forgetOwnAuthor(message.id);
      return { ok: true, ownAuthors: remaining };
    }

    case 'XTB_RESET_STATS': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      const stats = await resetStats();
      return { ok: true, stats: stats };
    }

    /* ----------------------- the Internet Archive import ------------------- */

    case 'XTB_WAYBACK_START': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      if (!isHandle(message.handle)) return { ok: false, error: 'invalid handle' };
      if (message.mode !== 'gaps' && message.mode !== 'verify') {
        return { ok: false, error: 'invalid mode' };
      }
      // `all` is the "run to the end of the list" switch. It is turned into a
      // batch as large as the list can be rather than being a second mode the
      // engine has to know about — there is only ever one stop condition.
      const runToTheEnd = message.all === true;
      if (!runToTheEnd && (!Number.isInteger(message.batch) || message.batch < 1 || message.batch > 500)) {
        return { ok: false, error: 'invalid batch' };
      }
      const batch = runToTheEnd ? WAYBACK_MAX_ROWS : message.batch;

      // The switch and the permission are checked here as well as per item, so
      // that a press with the feature off says so immediately instead of
      // starting a run that pauses on its first step.
      const blocked = await waybackBlockedReason();
      if (blocked !== null) return { ok: false, error: blocked };

      try {
        return await startWayback(message.handle, batch, message.mode);
      } catch (err) {
        // The only thing that throws out here is the CDX query, which is the
        // one request whose failure means there is nothing to work on.
        log('wayback: could not list snapshots', err);
        return { ok: false, error: 'could not reach the archive' };
      }
    }

    case 'XTB_WAYBACK_CANCEL': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      return cancelWayback();
    }

    case 'XTB_WAYBACK_STATUS': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      return { ok: true, wayback: waybackSummary() };
    }

    case 'XTB_SYNC_WAYBACK_PERMISSION': {
      if (!isExtensionPageSender(sender)) return { ok: false, error: 'untrusted sender' };
      const granted = await hasWaybackPermission();
      if (!granted) {
        // Revoked from chrome://extensions while the switch claimed otherwise.
        // The switch goes off rather than describing a capability that is gone.
        const settings = await saveSettings({ waybackEnabled: false });
        pauseWayback('permission');
        return { ok: true, waybackPermission: false, settings: settings };
      }
      return { ok: true, waybackPermission: true };
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
  await restoreWaybackJob();
}

/**
 * The wake-up call.
 *
 * An alarm is the only thing that starts a service worker when the user is not
 * browsing anything. The wayback import runs for minutes while they are doing
 * something else, so without this the run would simply stop at whatever item it
 * was holding when the browser tore the worker down, and nothing would start it
 * again until they happened to open x.com. `runWaybackJob`'s own guard makes
 * the race with initialize()'s restore harmless — whichever arrives second does
 * nothing.
 */
try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== WAYBACK_ALARM) return;
    void runWaybackJob();
  });
} catch (_) { /* no alarms API: the run still works while the worker lives */ }

/**
 * Put the first-run setup in front of the user, in a tab, once.
 *
 * The five questions cannot be answered in the popup: two of them need a
 * browser permission, the prompt takes the focus, and the popup closes the
 * moment it loses focus — so the popup can ask at most one of them and cannot
 * read back even that answer. A tab has none of those limits, which makes
 * opening one the difference between a setup flow that finishes and one the
 * user has to walk through twice.
 *
 * It runs on update as well as install, and that is deliberate: the condition
 * is "never answered", not "just installed", so anyone who has already been
 * through it — which is everyone who has used the extension — sees nothing.
 * `tabs.create` needs no permission; the `tabs` permission gates reading tab
 * properties, not making one.
 */
async function openSetupTabIfUnanswered() {
  try {
    if (!chrome || !chrome.tabs || typeof chrome.tabs.create !== 'function') return;
    if (typeof chrome.runtime.getURL !== 'function') return;
    const settings = await getSettings();
    if (settings.choicePanelAnswered === true) return;
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  } catch (_) {
    // No tab: the popup says where to go instead, so nothing is stranded.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
  void openSetupTabIfUnanswered();
});

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

void initialize();
