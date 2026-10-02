/**
 * wayback.js — reading the Internet Archive's copies of a post, as this
 * project's record shape.
 *
 * Two callers, one implementation. `tools/import-wayback.mjs` is a command-line
 * tool that walks an account and writes an envelope file; the extension's
 * service worker fetches the same bytes and writes them straight into
 * IndexedDB. They must agree exactly about what an archived payload means, so
 * there is one copy of that knowledge and it lives here — in the shipped
 * package, where the extension can reach it, and importable from Node, where
 * the tests can.
 *
 * Nothing here touches `chrome` at module scope, and the two functions that
 * touch the network use the global fetch rather than reaching for it. That is
 * what lets tools/test-import.mjs exercise the whole mapping without a browser
 * and without a single request.
 *
 * Why `id_` and not `if_`:
 *   Those archived records are `application/json` — the raw X API v2 response.
 *   `if_` wraps it in the Archive's own viewer page and you would then have to
 *   parse HTML to get back what `id_` hands over directly. This is a plain
 *   JSON fetch, no scraping at any point.
 *
 * The record shape written here is the one `sanitizeRecord` in background.js
 * produces — same field names, same nesting — because the reader was written
 * against that shape and nothing else. It is rebuilt field by field rather
 * than passed through, for the same reason the extension rebuilds: this is a
 * trust boundary too, and these bytes came off the network.
 */

/* Version of the RECORD shape, taken from the one place that owns it. It used
   to be a number copied in here by hand with a comment telling the next person
   to keep it in step, which is a promise nobody can keep. */
import { SCHEMA_VERSION } from './db.js';

export { SCHEMA_VERSION };

/* Mirrors ALLOWED_MEDIA_HOSTS in background.js. The archive stores original
   `pbs.twimg.com` / `video.twimg.com` addresses, so these pass unchanged. */
const ALLOWED_MEDIA_HOSTS = ['pbs.twimg.com', 'video.twimg.com'];

const CDX = 'https://web.archive.org/cdx/search/cdx';
const WAYBACK = 'https://web.archive.org/web';

const DELAY_MS = 250;
const ATTEMPTS = 3;

/* One request may not hang forever. See getJson for why a deadline matters more
   inside a service worker than it does on a command line. */
const FETCH_TIMEOUT_MS = 30000;

/* The origin this module needs permission for, in the form
   chrome.permissions wants it. */
export const WAYBACK_ORIGINS = ['https://web.archive.org/*'];

/* A ceiling on the snapshot list, which is the one structure here that has to
   outlive the browser session. A CDX query returns one row per CAPTURE, so the
   same post appears several times over, and an account can have a great many
   posts. This is a bound on what one run may remember, not a limit anybody
   should reach. */
const WAYBACK_MAX_ROWS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* fetching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One request, retried the way a flaky archive needs.
 *
 * Three answers, and they are deliberately different:
 *   - 429 or 5xx is worth trying again — the server is busy, not wrong.
 *   - any other non-ok status is NOT: a 404 will still be a 404 in two seconds,
 *     and retrying it only costs the archive another request.
 *   - a body that will not parse is a failure like any other. Measured once:
 *     with the archive offline it answers 200 with an HTML "Temporarily
 *     Offline" page, so `response.ok` is true and `JSON.parse` is what fails.
 *
 * `options` exists for the tests, which cannot afford to sleep for real. Every
 * caller passes nothing and gets the real behaviour.
 */
async function getJson(url, options) {
  const opts = options || {};
  const attempts = Number.isInteger(opts.attempts) ? opts.attempts : ATTEMPTS;
  const timeoutMs = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : FETCH_TIMEOUT_MS;
  const wait = typeof opts.wait === 'function' ? opts.wait : sleep;
  const doFetch = typeof opts.fetch === 'function' ? opts.fetch : fetch;

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let timer = null;
    try {
      // A request with no deadline is worse than a failed one here: the worker
      // is torn down after thirty seconds of inactivity and would take the
      // whole job's in-memory state with it, with nothing written down about
      // why. The deadline turns that into an ordinary failure that the caller
      // already knows how to count.
      let signal;
      try {
        const controller = new AbortController();
        signal = controller.signal;
        timer = setTimeout(() => controller.abort(), timeoutMs);
      } catch (_) {
        signal = undefined;
      }

      const response = await doFetch(url, { redirect: 'follow', signal: signal });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error('HTTP ' + response.status);
        await wait(1200 * (attempt + 1));
        continue;
      }
      if (!response.ok) return { ok: false, error: 'HTTP ' + response.status };
      const text = await response.text();
      return { ok: true, value: JSON.parse(text) };
    } catch (err) {
      lastError = err;
      await wait(600 * (attempt + 1));
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError ? lastError.message : 'unknown' };
}

async function listSnapshots(handle) {
  const url = CDX +
    '?url=' + encodeURIComponent('twitter.com/' + handle + '/status/') +
    '&matchType=prefix&output=json&fl=timestamp,original&limit=20000';
  const result = await getJson(url);
  if (!result.ok) throw new Error('CDX query failed: ' + result.error);

  const rows = result.value;
  const snapshots = [];
  for (let i = 1; i < rows.length; i++) {
    const timestamp = rows[i][0];
    const original = rows[i][1];
    if (typeof timestamp === 'string' && typeof original === 'string') {
      snapshots.push({ timestamp, original });
    }
  }
  return snapshots;
}

/**
 * Pick `count` snapshots spread evenly across the whole span rather than the
 * first `count`. A validation run wants a sample of every period, not a
 * hundred records from one afternoon.
 */
function spread(snapshots, count) {
  if (snapshots.length === 0) return [];
  // One is a special case rather than the loop's own limit, because the loop
  // divides by `count - 1`: at one that is 0/0, Math.floor gives NaN, and the
  // result was a one-element array holding `undefined` — which then threw on
  // `.timestamp` several frames away from the arithmetic that caused it.
  if (count <= 1) return [snapshots[0]];
  if (snapshots.length <= count) return snapshots;
  const picked = [];
  const seen = new Set();
  for (let k = 0; k < count; k++) {
    const index = Math.floor((snapshots.length - 1) * k / (count - 1));
    if (!seen.has(index)) { seen.add(index); picked.push(snapshots[index]); }
  }
  return picked;
}

/* -------------------------------------------------------------------------- */
/* field mapping — archive JSON to this project's record shape                */
/* -------------------------------------------------------------------------- */

function twimgUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (url.protocol !== 'https:') return null;
  if (ALLOWED_MEDIA_HOSTS.indexOf(url.hostname.toLowerCase()) === -1) return null;
  return url.href;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Turn an offset X supplied into one a JavaScript string understands.
 *
 * X counts characters the way a person does: an emoji is ONE. A JavaScript
 * string counts that same emoji as TWO UTF-16 units. So an offset taken from X
 * and used directly on a JavaScript string lands one place early for every
 * emoji before it — and the further into the text, the further wrong.
 *
 * Measured on a real record rather than reasoned about. Its text
 * `…(🇺🇸) https://t.co/SNd7IatgUW` is 301 UTF-16 units and 299 characters, and X
 * gave the link's offset as [276,299):
 *
 *     slice(276, 299)  ->  ") https://t.co/SNd7Iatg"     the address, cut short
 *     slice(279, 302)  ->  "https://t.co/SNd7IatgUW"     what X meant
 *
 * Every offset that arrives from X goes through here. This is the whole reason
 * `keepAlignedSpans` below can compare anything: two offsets counted the same
 * way can be checked against each other, and two counted differently cannot.
 */
function toJsOffset(text, pointOffset) {
  if (!Number.isSafeInteger(pointOffset) || pointOffset <= 0) return 0;

  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (seen === pointOffset) return i;
    const code = text.charCodeAt(i);
    // A high surrogate followed by a low one is a single character that the
    // string stores twice. It is consumed as one, so the two counts stay apart
    // by exactly the number of these that have gone by.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    seen++;
  }
  return text.length;
}

/**
 * Keep only the offsets that still point at the same characters.
 *
 * An entity's `start` and `end` index into the text it arrived WITH, and that
 * is not always the text being stored.
 *
 * A long post is delivered twice: cut short in `data.text` and complete in
 * `note_tweet.text`. X measures its entity offsets against the TRUNCATED one.
 * Measured on a real record, `data.text` was 151 characters ending in a t.co
 * link, the note text was 240 characters and did not contain that link at all,
 * and the link's offset landed 23 characters into
 * "北京国际电影节：象人，撒旦探戈…". The same thing happens one level down, to a
 * retweet whose original is itself a long post.
 *
 * So an offset is kept exactly when the two texts agree about what sits there.
 * Where they agree it is as good as it ever was — a link in the truncated
 * prefix is at the same place in the whole text — and where they do not, it is
 * a number that names nothing, and dropping it is the only honest thing to do
 * with it. `null` for the text it was measured against means there is nothing
 * to check it against at all, which is the case when the lists and the offsets
 * come from different posts entirely.
 */
function keepAlignedSpans(spans, body, measuredAgainst) {
  if (measuredAgainst === null) return [];
  if (measuredAgainst === body) return spans;
  const out = [];
  for (const span of spans) {
    if (measuredAgainst.slice(span.start, span.end) === body.slice(span.start, span.end)) out.push(span);
  }
  return out;
}

function toEntities(raw, body, measuredAgainst, ownIds = []) {
  const src = raw && typeof raw === 'object' ? raw : {};

  /* Where each marked-up thing sits in the text.
   *
   * This is the one thing the archive has that a live capture mostly cannot:
   * measured on real responses, a profile timeline carries no entities at all
   * and only a single-post page carries them, while every archived v2 record
   * has them with offsets. Storing the offsets means a reader can mark the
   * body exactly instead of scanning it and hoping.
   *
   * The three lists below stay exactly as they were — the offsets go in their
   * own list rather than as extra keys on the entries, because `hashtags` is a
   * list of bare strings and turning those into objects would break every
   * reader that already walks it. */
  /* X repeats itself, and the repetition is not noise to pass through.
   *
   * Measured across the 97 records of a real import: seven of them carried the
   * same link two, three or four times in `entities.urls`, and the count was
   * exactly the number of attached photographs — the four-photo posts listed it
   * four times and the two-photo posts twice, every copy at one and the same
   * offset. Carried through, that makes a record claim a post links to
   * something four times when it links to it once, and it leaves the reader
   * resolving three of the four away as overlaps — reaching the right answer by
   * accident rather than by rule. These lists say what the post links to, so
   * each thing appears in them once. */
  const seen = new Set();
  const once = (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  const spans = [];
  const addSpans = (list, kind, keep) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (!keep(item)) continue;
      if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)) continue;
      if (item.start < 0 || item.end <= item.start) continue;
      /* Counted the way X counts, converted to the way a string counts. With no
         text to measure against there is nothing to convert against either, and
         the span is dropped below anyway. */
      const start = measuredAgainst === null ? item.start : toJsOffset(measuredAgainst, item.start);
      const end = measuredAgainst === null ? item.end : toJsOffset(measuredAgainst, item.end);
      if (end <= start) continue;
      // Two things cannot sit at the same place in one text, so an exact repeat
      // of kind and offsets is one thing written down twice.
      if (!once('span\0' + kind + '\0' + start + '\0' + end)) continue;
      spans.push({ kind: kind, start: start, end: end });
    }
  };

  /* X's own link to a post's photographs, dropped from the list exactly when
     the body no longer contains it — which is the case `visibleText` creates by
     cutting it off the end. Leaving it listed makes the record contradict
     itself: a link named as one the post makes, that the post's own text does
     not contain. Measured on two real archived retweets, both had the body
     trimmed and the entry still there, pointing at the retweeted author's photo
     page rather than at anything either author wrote.
     The body test is what keeps this narrow. The trim only ever touches the
     END of a text, so a post that genuinely links to its own photo page in the
     middle keeps the entry — dropped on where it points alone, that link would
     vanish from a body that still shows it.
     One predicate, used by the list and by the offsets below, so the two cannot
     drift apart. */
  const dropsOwnMedia = (item) => typeof item.url === 'string' &&
    body.indexOf(item.url) === -1 && isOwnMediaLink(item, ownIds);

  const urls = [];
  if (Array.isArray(src.urls)) {
    for (const item of src.urls) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.url !== 'string') continue;
      if (dropsOwnMedia(item)) continue;
      const entry = {
        url: item.url,
        expandedUrl: typeof item.expanded_url === 'string' ? item.expanded_url : null,
        displayUrl: typeof item.display_url === 'string' ? item.display_url : null
      };
      if (!once('url\0' + JSON.stringify(entry))) continue;
      urls.push(entry);
    }
  }
  addSpans(src.urls, 'url', (item) => typeof item.url === 'string' && !dropsOwnMedia(item));

  const hashtags = [];
  if (Array.isArray(src.hashtags)) {
    for (const item of src.hashtags) {
      if (!item || typeof item.tag !== 'string' || item.tag.length === 0) continue;
      if (!once('tag\0' + item.tag.toLowerCase())) continue;
      hashtags.push(item.tag);
    }
  }
  addSpans(src.hashtags, 'tag', (item) => typeof item.tag === 'string' && item.tag.length > 0);

  const mentions = [];
  if (Array.isArray(src.mentions)) {
    for (const item of src.mentions) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.username !== 'string' || item.username.length === 0) continue;
      if (!once('who\0' + item.username.toLowerCase())) continue;
      /* The v2 response carries no display name for a mention, only the handle
         and the id. A null name is honest; inventing one would not be. */
      mentions.push({ screenName: item.username, name: null });
    }
  }
  addSpans(src.mentions, 'who',
    (item) => typeof item.username === 'string' && item.username.length > 0);

  spans.sort((a, b) => a.start - b.start);

  return {
    urls: urls,
    hashtags: hashtags,
    mentions: mentions,
    /* The lists above name what is marked up and are right whichever text they
       came from. The offsets are not, so each one has to survive a check
       against the text it was measured on — see keepAlignedSpans. */
    spans: keepAlignedSpans(spans, body, measuredAgainst)
  };
}

function toMedia(mediaKeys, includesMedia) {
  const byKey = new Map();
  for (const item of includesMedia) {
    if (item && typeof item.media_key === 'string') byKey.set(item.media_key, item);
  }

  const out = [];
  for (const key of mediaKeys) {
    const item = byKey.get(key);
    if (!item) continue;

    const type = typeof item.type === 'string' ? item.type : '';
    const isVideo = type === 'video' || type === 'animated_gif';

    const variants = [];
    if (Array.isArray(item.variants)) {
      for (const variant of item.variants) {
        if (!variant || typeof variant !== 'object') continue;
        const url = twimgUrl(variant.url);
        if (url === null) continue;
        variants.push({
          url,
          bitrate: numberOrNull(variant.bit_rate),
          contentType: typeof variant.content_type === 'string' ? variant.content_type : null
        });
      }
    }

    /* A photo's `url` is the picture; a video's `url` is absent and the MP4
       has to come out of `variants`. Highest bitrate wins — the archive has
       every rendition and the reader should not get the 320px one. */
    let url = twimgUrl(item.url);
    if (isVideo) {
      let best = null;
      for (const variant of variants) {
        if (variant.contentType !== 'video/mp4') continue;
        if (best === null || (variant.bitrate !== null && variant.bitrate > (best.bitrate || 0))) best = variant;
      }
      url = best === null ? null : best.url;
    }

    const width = numberOrNull(item.width);
    const height = numberOrNull(item.height);

    out.push({
      id: key,
      mediaKey: key,
      type,
      url,
      thumbnailUrl: twimgUrl(item.preview_image_url) || (isVideo ? null : url),
      width,
      height,
      altText: typeof item.alt_text === 'string' ? item.alt_text : null,
      durationMs: numberOrNull(item.duration_ms),
      aspectRatio: width !== null && height !== null ? [width, height] : null,
      variants
    });
  }
  return out;
}

/**
 * The quoted post, in the shape a live capture writes.
 *
 * X hands the whole quoted tweet over in `includes.tweets`, and that copy is
 * the only one that outlives the original being deleted or its author being
 * suspended. Text and authorship are all that is kept: the archive also
 * carries the quoted post's media and its own metrics, and every one of those
 * widens the record, while the text is the part that is genuinely gone for
 * good once the other side disappears.
 */
function toQuotedTweet(sourceNode, users) {
  if (!sourceNode || typeof sourceNode !== 'object') return null;
  if (typeof sourceNode.id !== 'string' || sourceNode.id.length === 0) return null;

  const authorId = typeof sourceNode.author_id === 'string' ? sourceNode.author_id : null;
  let me = null;
  for (const user of users) {
    if (user && user.id === authorId) { me = user; break; }
  }

  const createdAtRaw = typeof sourceNode.created_at === 'string' ? sourceNode.created_at : null;

  return {
    tweetId: sourceNode.id,
    text: typeof sourceNode.text === 'string' ? sourceNode.text : '',
    createdAt: isoOrNull(createdAtRaw),
    createdAtRaw: createdAtRaw,
    author: {
      id: authorId,
      screenName: me && typeof me.username === 'string' ? me.username : null,
      name: me && typeof me.name === 'string' ? me.name : null,
      avatarUrl: me ? twimgUrl(me.profile_image_url) : null
    }
  };
}

/**
 * Which client posted this.
 *
 * v2 reports it as a plain product name. The web client reports an anchor, and
 * that markup is unwrapped rather than carried — an archive has no business
 * storing a fragment of somebody else's HTML. `null` when the field is absent,
 * which is what the sampled archive records looked like.
 */
function toPostedVia(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const text = raw.replace(/<[^>]*>/g, '').trim();
  return text.length === 0 ? null : { name: text, url: null };
}

/**
 * Is this link one X appended to point at a post's own photographs?
 *
 * Recognisable without asking anyone: it expands to the post's OWN permalink
 * with /photo/N or /video/N on the end. Nothing else can look like that. A link
 * the author typed points wherever the author chose; a link to somebody else's
 * photograph carries somebody else's id; and the author cannot have linked to
 * the post they were writing, because it did not exist when they wrote it.
 *
 * This exists as well as `display_text_range`, not instead of it. Measured on a
 * real archived record, the range was absent altogether — on the record AND on
 * the retweeted original inside `includes.tweets` — while the appended link was
 * sitting at the end of the text. The range is X's answer when X gives one; this
 * is the answer when it does not.
 */
/** The hosts a post permalink can live on. X serves the same post from all. */
const X_PERMALINK_HOSTS = ['x.com', 'www.x.com', 'mobile.x.com',
  'twitter.com', 'www.twitter.com', 'mobile.twitter.com'];

function isOwnMediaLink(entry, ownIds) {
  /* `visibleText` is handed a RAW archived payload node, which uses the API's
     own snake_case. Both spellings are accepted because the mapped shape this
     project stores — and that `toEntities` produces — uses camelCase, and a
     caller passing that instead would otherwise silently find no links at all
     and quietly stop trimming. */
  const expanded = typeof entry.expanded_url === 'string' ? entry.expanded_url
    : (typeof entry.expandedUrl === 'string' ? entry.expandedUrl : '');
  if (expanded.length === 0) return false;

  /* Parsed, not searched. Looking for `/status/<id>` inside the string matched
     an address like `https://example.com/r?ref=x.com/status/<id>/photo/1`,
     whose path is `/r` — a different address that merely mentions this one. */
  let parsed;
  try { parsed = new URL(expanded); } catch (_) { return false; }
  if (parsed.protocol !== 'https:') return false;
  if (X_PERMALINK_HOSTS.indexOf(parsed.hostname.toLowerCase()) === -1) return false;

  const parts = parsed.pathname.split('/').filter((part) => part.length > 0);
  if (parts.length < 3 || parts[1] !== 'status') return false;
  if (ownIds.indexOf(parts[2]) === -1) return false;

  // Nothing after the id, or exactly the media sub-page of that same post.
  const rest = parts.slice(3);
  if (rest.length === 0) return true;
  return rest.length === 2 && (rest[0] === 'photo' || rest[0] === 'video') && /^\d+$/.test(rest[1]);
}

/** A t.co address sitting at the very end of the text, with its leading space. */
const TRAILING_SHORTLINK = /\s*(https:\/\/t\.co\/[A-Za-z0-9]+)\s*$/;

function trimOwnMediaLink(text, entities, ownIds) {
  const match = TRAILING_SHORTLINK.exec(text);
  if (match === null) return text;

  const urls = entities && Array.isArray(entities.urls) ? entities.urls : [];
  for (const entry of urls) {
    if (!entry || entry.url !== match[1]) continue;
    return isOwnMediaLink(entry, ownIds) ? text.slice(0, match.index) : text;
  }
  return text;
}

/**
 * A post's text as its author actually wrote it.
 *
 * Two things sit in front of that, and both have been mistaken for the text.
 *
 * A long post arrives cut short in `data.text` and complete in
 * `note_tweet.text`; the complete one is the post.
 *
 * And X appends a link to a post's own photographs — a t.co address that
 * expands to the post's own permalink — which it does NOT count as part of the
 * text and does not show. Carried through, it appears in the archive as a stray
 * pic.x.com address the author never typed.
 *
 * That link goes two ways, and it needs both. `display_text_range` is X's own
 * statement of where the author's words stop, and where it is given it is
 * obeyed — with its end converted first, because X counts characters and a
 * JavaScript string counts UTF-16 units (see toJsOffset). But it is not always
 * given: one real record carried the appended link with the field absent
 * altogether, on itself AND on the retweeted original beside it, and there the
 * link is found by where it points instead.
 *
 * Note this trims the TAIL only. The offsets below are checked against the
 * untrimmed text, so one that pointed into the removed part is dropped rather
 * than kept pointing at nothing.
 */
function visibleText(node, ownIds) {
  const note = node.note_tweet && typeof node.note_tweet.text === 'string'
    ? node.note_tweet.text : null;
  if (note !== null && note.length > 0) return note;

  let text = typeof node.text === 'string' ? node.text : '';

  const range = Array.isArray(node.display_text_range) ? node.display_text_range : null;
  const rawCut = range !== null && Number.isSafeInteger(range[1]) ? range[1] : null;
  if (rawCut !== null && rawCut > 0) {
    const cut = toJsOffset(text, rawCut);
    if (cut > 0 && cut < text.length) text = text.slice(0, cut);
  }

  return trimOwnMediaLink(text, node.entities, ownIds);
}

/**
 * The entity list that belongs with a post's long-form body, or null if it has
 * no long-form body.
 *
 * A long post keeps its whole text in `note_tweet.text`, and the offsets that
 * index into THAT text in `note_tweet.entities` — a second list X only ships
 * alongside a note. `data.entities` for the same post indexes the truncated
 * preview instead, so pairing it with the full body points every link at the
 * wrong place and `keepAlignedSpans` drops the lot. Measured on real archived
 * payloads: both objects are present, `data.text` is the cut preview and
 * `note_tweet.text` the whole thing.
 *
 * Null means "not a long post" — which is the answer for every post short
 * enough to fit, and leaves the caller on `data.entities`, where it belongs.
 */
function noteEntities(node) {
  const note = node && node.note_tweet && typeof node.note_tweet === 'object'
    ? node.note_tweet : null;
  if (note === null) return null;
  if (typeof note.text !== 'string' || note.text.length === 0) return null;
  if (!note.entities || typeof note.entities !== 'object') return null;
  return { entities: note.entities, text: note.text };
}

function toRecord(envelope, handle, seenAt) {
  if (!envelope || typeof envelope !== 'object') return null;
  const data = envelope.data;
  if (!data || typeof data !== 'object') return null;
  if (typeof data.id !== 'string' || data.id.length === 0) return null;

  const users = envelope.includes && Array.isArray(envelope.includes.users) ? envelope.includes.users : [];
  const media = envelope.includes && Array.isArray(envelope.includes.media) ? envelope.includes.media : [];
  /* `includes.tweets` carries the full objects for whatever this record
     references — the quoted post, the post being replied to, and the original
     behind a retweet. For a retweet that is the only place the whole thing
     exists: see the body resolution below. */
  const refTweets = envelope.includes && Array.isArray(envelope.includes.tweets)
    ? envelope.includes.tweets : [];

  const refs = Array.isArray(data.referenced_tweets) ? data.referenced_tweets : [];
  const refOf = (type) => {
    for (const ref of refs) {
      if (ref && ref.type === type && typeof ref.id === 'string') return ref.id;
    }
    return null;
  };

  const authorId = typeof data.author_id === 'string' ? data.author_id : null;
  let me = null;
  for (const user of users) {
    if (user && user.id === authorId) { me = user; break; }
  }

  const repliedTo = refOf('replied_to');
  const quoted = refOf('quoted');
  const retweeted = refOf('retweeted');

  let quotedTweet = null;
  if (quoted !== null) {
    for (const candidate of refTweets) {
      if (candidate && candidate.id === quoted) {
        quotedTweet = toQuotedTweet(candidate, users);
        break;
      }
    }
  }

  const metrics = data.public_metrics && typeof data.public_metrics === 'object' ? data.public_metrics : {};
  const mediaKeys = data.attachments && Array.isArray(data.attachments.media_keys)
    ? data.attachments.media_keys : [];

  /* The edit chain, oldest first, and the three fields that hang off it.
   *
   * The chain alone says nothing: X hands it back for every post, and for one
   * that was never edited it holds the post's own id and nothing else — which
   * is why db.js is explicit that `editTweetIds` must never be read as "this
   * is an edit". What does say it is a chain longer than the post itself, and
   * that is also the test X's own client applies before it shows an Edited
   * label (see extractEditInfo in inject.js). So the chain is kept in full, and
   * the two ids derived from it are only written when there is a previous
   * version to name.
   *
   * `chainEndsHere` is the other half of that: the last element is the version
   * the post currently is, the same rule X uses to pick a permalink. A chain
   * that ends somewhere else is not this post's — and an id read out of a list
   * about some other post would be a confident lie, so nothing is derived.
   */
  const editChain = Array.isArray(data.edit_history_tweet_ids)
    ? data.edit_history_tweet_ids.filter((id) => typeof id === 'string' && id.length > 0) : [];
  const chainEndsHere = editChain.length > 0 && editChain[editChain.length - 1] === data.id;
  const wasEdited = chainEndsHere && editChain.length > 1;
  const editControls = data.edit_controls && typeof data.edit_controls === 'object'
    ? data.edit_controls : {};

  /* Who this is a reply to.
   *
   * The id has always been carried; the handle was always null, on the reading
   * that a v2 response names no user for `in_reply_to_user_id`. It does —
   * measured on two real archived replies, the replied-to author is in
   * `includes.users` under that id, the same array the author and the mentioned
   * accounts come from. A reader can print "@name" instead of an id and an
   * apology, and the id stays for the case where the user was not included. */
  const replyUserId = typeof data.in_reply_to_user_id === 'string' ? data.in_reply_to_user_id : null;
  let replyScreenName = null;
  if (replyUserId !== null) {
    for (const user of users) {
      if (user && user.id === replyUserId &&
          typeof user.username === 'string' && user.username.length > 0) {
        replyScreenName = user.username;
        break;
      }
    }
  }

  const screenName = me && typeof me.username === 'string' ? me.username : handle;
  const createdAt = isoOrNull(data.created_at);

  /* Two different truncations live in this payload, and both look like an
     innocent ellipsis in the finished archive.
   *
   * A long post is cut in `data.text` and continued in `note_tweet.text`.
   *
   * A retweet is worse: `data.text` is cut to exactly 140 characters — X's
   * preview limit — and `note_tweet` is empty. Measured on three real records,
   * one of them a 301-character original delivered as a 140-character stub.
   * The untouched original is in `includes.tweets` under the retweeted id, so
   * that is where the body comes from when one is found.
   *
   * The record keeps `isRetweet` and `retweetedTweetId` either way, which is
   * what should mark it in a reader. The text here is the post as written, not
   * a rendering of the retweet, so the "RT @name:" prefix is deliberately not
   * manufactured — X itself includes it only sometimes (two of those three
   * records had it, one did not), so it is not a marker anything can rely on.
   */
  /* The ids this record may legitimately call its own: itself, and — for a
     retweet — the post behind it, whose media link is the one that ends up at
     the end of the text that gets stored. */
  const ownIds = [data.id, retweeted];
  let body = visibleText(data, ownIds);

  /* Which entity set the offsets below were measured against.
   *
   * An entity's `start` and `end` index into the text it arrived with. A
   * retweet's own entities point into "RT @name: …", and the body kept above is
   * the original's, so pairing them would shift every position by the length of
   * a prefix that is no longer in the record — measured on a real one, an
   * @mention landed three characters to the right of where it belonged. The
   * included original carries its own entities and those line up with the text
   * that was kept, so they are the ones used. */
  let entitySource = data.entities;
  /* The text those offsets were measured against. X indexes entities into
     `data.text`, which for a long post is the TRUNCATED preview — so this is
     that, and keepAlignedSpans does the rest. */
  let measuredAgainst = typeof data.text === 'string' ? data.text : null;

  /* Except that a long post carries a SECOND set of offsets, measured against
     its full text, and that is the pair that actually lines up. Taking it is
     what turns a long post's links from "dropped as misaligned" into standing
     where they should. */
  const ownNote = noteEntities(data);
  if (ownNote !== null) {
    entitySource = ownNote.entities;
    measuredAgainst = ownNote.text;
  }

  if (retweeted !== null) {
    let source = null;
    for (const candidate of refTweets) {
      if (candidate && candidate.id === retweeted) { source = candidate; break; }
    }
    if (source !== null) {
      const sourceBody = visibleText(source, ownIds);
      /* Take the original whenever it is there, not merely when it is longer.
         "Longer wins" was the first attempt and it produced two shapes for one
         thing: long retweets fell back to the original and lost the "RT @name:"
         prefix, short ones kept the prefix because it made them longer. Which
         of the two X emits is not even consistent — 16 of 21 retweets in one
         sample carried the prefix and 5 did not. So the text is always the
         post as its author wrote it, and `isRetweet` is what says it was
         reposted. */
      body = sourceBody;
      /* Offsets are only meaningful against the body they were measured on, so
         they come from the original. If the original arrived with no entities
         object at all — which means it had nothing to mark up — the retweet's
         lists are still the names of what is linked, since the original's text
         is embedded in the retweet verbatim; only its offsets are unusable, and
         those are dropped rather than carried wrong. */
      if (source.entities && typeof source.entities === 'object') {
        entitySource = source.entities;
        // And the original's own offsets were measured against the original's
        // own `text`, which for a long original is again the truncated one —
        // so the same substitution applies one level down.
        measuredAgainst = typeof source.text === 'string' ? source.text : null;
        const sourceNote = noteEntities(source);
        if (sourceNote !== null) {
          entitySource = sourceNote.entities;
          measuredAgainst = sourceNote.text;
        }
      } else {
        entitySource = data.entities;
        // The lists stay, because the original's text is embedded in the
        // retweet verbatim and so they still name what is linked. The offsets
        // cannot: they were measured against the retweet's own rendering,
        // which is a different text from end to end.
        measuredAgainst = null;
      }
    }
  }

  return {
    id: data.id,
    text: body,
    lang: typeof data.lang === 'string' ? data.lang : null,
    createdAt: createdAt === null ? seenAt : createdAt,
    createdAtRaw: typeof data.created_at === 'string' ? data.created_at : null,
    capturedAt: seenAt,
    firstCapturedAt: seenAt,
    updatedAt: seenAt,
    tweetUrl: 'https://x.com/' + screenName + '/status/' + data.id,
    isReply: repliedTo !== null,
    isRetweet: retweeted !== null,
    retweetedTweetId: retweeted,
    /* Edits are separate records in X's model; the archive keeps the id chain,
       so it is carried across rather than dropped. The three derived fields
       follow `wasEdited` above — see there for why the chain length is the
       test and why it has to end at this record. */
    isEdit: wasEdited,
    editedFrom: wasEdited ? editChain[editChain.length - 2] : null,
    editTweetIds: editChain.slice(0, 50),
    editInitialTweetId: wasEdited ? editChain[0] : null,
    editsRemaining: numberOrNull(editControls.edits_remaining),
    /* The source cannot answer this one. A poll's choices come in
       `includes.polls`, and it is absent from every archived payload measured —
       the crawl asked for a fixed set of expansions and polls were not among
       them. So an archived poll is stored as an ordinary post, and there is no
       way to tell from the record that anything is missing. */
    isPoll: false,
    poll: null,
    replyTo: {
      tweetId: repliedTo,
      userId: replyUserId,
      screenName: replyScreenName
    },
    conversationId: typeof data.conversation_id === 'string' ? data.conversation_id : data.id,
    /* The flag has to follow the substitution above, not be a constant. When
       the archive names the conversation this is a fact; when it does not, the
       post's own id is written in its place, and that is a GUESS — right for a
       top-level post, wrong for a reply further down a thread. Recording it as
       a fact would let this row overwrite a conversation id the live capture
       actually knew, which is the one thing the merge rule refuses to let an
       empty or substituted value do. */
    conversationIdInferred: typeof data.conversation_id !== 'string',
    quoteTweetId: quoted,
    quotedTweet: quotedTweet,
    postedVia: toPostedVia(data.source),
    /* v2 reports no reader state: whether the account had liked, bookmarked or
       reposted a post is a fact about the person asking, and the archive's
       records were not fetched as anyone. Null, not false — "not recorded" and
       "did not" are different answers and this is the first. */
    viewerState: null,
    sensitive: typeof data.possibly_sensitive === 'boolean' ? data.possibly_sensitive : null,
    /* Only the archive has this; the live responses carry it zero times. */
    replySettings: typeof data.reply_settings === 'string' ? data.reply_settings : null,
    author: {
      id: authorId,
      screenName: typeof me?.username === 'string' ? me.username : null,
      name: me && typeof me.name === 'string' ? me.name : null,
      avatarUrl: me ? twimgUrl(me.profile_image_url) : null
    },
    entities: toEntities(entitySource, body, measuredAgainst, ownIds),
    media: toMedia(mediaKeys, media),
    metrics: {
      likeCount: numberOrNull(metrics.like_count),
      retweetCount: numberOrNull(metrics.retweet_count),
      replyCount: numberOrNull(metrics.reply_count),
      quoteCount: numberOrNull(metrics.quote_count),
      bookmarkCount: numberOrNull(metrics.bookmark_count),
      viewCount: numberOrNull(metrics.impression_count)
    },
    source: {
      operationName: 'WaybackImport',
      queryId: null,
      capturedVia: 'fetch',
      httpStatus: 200,
      textFromRequest: false,
      /* True, and load-bearing: this row was not observed at publish time, and
         its metrics are whatever they were when the archive took it — which is
         usually zero. */
      backfilled: true,
      tombstone: false
    },
    schemaVersion: SCHEMA_VERSION
  };
}

/* How many links a bio may keep. The same number as MAX_BIO_URLS in
   background.js and inject.js; it is here as well because the command-line
   tool writes an envelope with nobody downstream to clamp it, and the two
   outputs are supposed to be the same file. */
const MAX_PROFILE_BIO_URLS = 8;
const MAX_PROFILE_BIO_MENTIONS = 8;

/**
 * The account's own profile card, out of the same payload the post came from.
 *
 * The archive import used to write posts and no profile at all, so an archive
 * built only from it had no header: no name, no bio, no picture, no banner.
 * Nothing had to be fetched to fix that — every post payload carries the
 * author's whole user object in `includes.users`, and only three of its fields
 * (`username`, `name`, `profile_image_url`) were being read.
 *
 * Measured on real archived payloads, that object holds all of:
 *   created_at, description, location, url, profile_image_url,
 *   profile_banner_url, verified, verified_type, protected, public_metrics
 * with `entities.description.mentions` and `entities.url.urls` beside them.
 *
 * A profile page is NOT the way to get this. `x.com/<handle>` has zero
 * snapshots in the Archive for the handles that were checked, and the
 * dedicated `UserByScreenName` responses that do exist are for a handful of
 * news accounts — someone else's crawl, not the one that holds these posts.
 *
 * Which user: the one whose handle is the account being imported, not the
 * author of the post. They are the same for an ordinary post and different for
 * a retweet, where the author is whoever reposted it.
 */
/**
 * The accounts named inside a bio, from the archived user object.
 *
 * `entities.description.mentions` is the same `{start, end, username}` list a
 * post carries, and measured on a real archived payload it is present and
 * populated where the bio names somebody. The offsets are deliberately not
 * kept: the bio is stored as one string and drawn as one string, so a position
 * within it would be structure nothing reads — unlike a post, where the offsets
 * are what mark the body up.
 */
function bioMentionsOf(user) {
  const out = [];
  const bioEntity = user && user.entities && user.entities.description &&
    typeof user.entities.description === 'object' ? user.entities.description : null;
  if (bioEntity === null || !Array.isArray(bioEntity.mentions)) return out;
  for (const item of bioEntity.mentions) {
    if (out.length >= MAX_PROFILE_BIO_MENTIONS) break;
    if (!item || typeof item !== 'object') continue;
    if (typeof item.username !== 'string' || item.username.length === 0) continue;
    out.push({ screenName: item.username, name: null });
  }
  return out;
}

export function toProfile(envelope, handle) {
  if (!envelope || typeof envelope !== 'object') return null;
  if (typeof handle !== 'string' || handle.length === 0) return null;

  const users = envelope.includes && Array.isArray(envelope.includes.users)
    ? envelope.includes.users : [];
  const wanted = handle.toLowerCase();

  let user = null;
  for (const candidate of users) {
    if (candidate && typeof candidate.username === 'string' &&
        candidate.username.toLowerCase() === wanted) {
      user = candidate;
      break;
    }
  }
  if (user === null) return null;
  if (typeof user.id !== 'string' || user.id.length === 0) return null;

  const metrics = user.public_metrics && typeof user.public_metrics === 'object'
    ? user.public_metrics : {};

  /* The bio's own links, in the same shape the roster and the profile card use:
     the t.co address as written, plus where it really goes. */
  const bioEntity = user.entities && user.entities.description && typeof user.entities.description === 'object'
    ? user.entities.description : null;
  const bioUrls = [];
  if (bioEntity !== null && Array.isArray(bioEntity.urls)) {
    for (const item of bioEntity.urls) {
      if (bioUrls.length >= MAX_PROFILE_BIO_URLS) break;
      if (!item || typeof item !== 'object') continue;
      const expanded = typeof item.expanded_url === 'string' && item.expanded_url.length > 0
        ? item.expanded_url
        : (typeof item.url === 'string' && item.url.length > 0 ? item.url : null);
      if (expanded === null) continue;
      bioUrls.push({
        url: typeof item.url === 'string' && item.url.length > 0 ? item.url : expanded,
        expandedUrl: expanded,
        displayUrl: typeof item.display_url === 'string' ? item.display_url : null
      });
    }
  }

  /* The website in the profile header, which is a different thing from the
     links inside the bio. `url` on the user object is the t.co address; the
     real destination is one level down in `entities.url.urls`. */
  const websiteEntity = user.entities && user.entities.url && Array.isArray(user.entities.url.urls)
    ? user.entities.url.urls[0] : null;
  let websiteUrl = null;
  if (websiteEntity && typeof websiteEntity === 'object') {
    websiteUrl = typeof websiteEntity.expanded_url === 'string' && websiteEntity.expanded_url.length > 0
      ? websiteEntity.expanded_url
      : (typeof websiteEntity.url === 'string' && websiteEntity.url.length > 0 ? websiteEntity.url : null);
  }
  if (websiteUrl === null && typeof user.url === 'string' && user.url.length > 0) {
    websiteUrl = user.url;
  }

  const screenName = typeof user.username === 'string' && user.username.length > 0
    ? user.username : null;

  return {
    userId: user.id,
    screenName: screenName,
    screenNameLower: screenName === null ? '' : screenName.toLowerCase(),
    name: typeof user.name === 'string' && user.name.length > 0 ? user.name : null,
    accountCreatedAt: isoOrNull(user.created_at),
    bio: typeof user.description === 'string' ? user.description : null,
    bioUrls: bioUrls,
    location: typeof user.location === 'string' && user.location.length > 0 ? user.location : null,
    websiteUrl: websiteUrl,
    /* Not in the payload. The live capture reads `profile_description_language`
       off the user node; the archived v2 object has no such key — checked on
       three real ones. Null rather than guessed from the bio's script. */
    lang: null,
    /* The blue check, told apart from the other two flags the payload carries.
       `is_identity_verified` is false for a blue-checked account as well as an
       unverified one, so it is not this — checked against both. What matches is
       `verified_type`, which reads "blue" on the checked account and "none" on
       the other. `verified` alone would be wrong too: it is true for
       organisation and government accounts, which are not blue. */
    blueVerified: user.verified_type === 'blue',
    verified: typeof user.verified === 'boolean' ? user.verified : null,
    followersCount: numberOrNull(metrics.followers_count),
    followingCount: numberOrNull(metrics.following_count),
    tweetCount: numberOrNull(metrics.tweet_count),
    /* The other three the v2 user object carries. `like_count` here is the
       account's lifetime likes GIVEN — the same name on a tweet means the likes
       that post received, which is why it is only ever read off a profile. */
    listedCount: numberOrNull(metrics.listed_count),
    mediaCount: numberOrNull(metrics.media_count),
    likeCount: numberOrNull(metrics.like_count),
    /* Null, not false, when the payload did not say. */
    protected: typeof user.protected === 'boolean' ? user.protected : null,
    pinnedTweetId: typeof user.pinned_tweet_id === 'string' && user.pinned_tweet_id.length > 0
      ? user.pinned_tweet_id : null,
    /* The accounts named in the bio — the same shape a post's mentions use, and
       the same reason `name` is null: the v2 response carries no display name
       for a mention, only the handle and the offset it sits at. */
    bioMentions: bioMentionsOf(user),
    avatarUrl: twimgUrl(user.profile_image_url),
    /* The archived address has no size segment — `profile_banners/<uid>/<ts>`
       with nothing after it. Measured: that bare form returns the full picture
       (a 90 KB JPEG on a live account), so it is used as it arrives. The live
       capture's addresses end in `/1500x500`; both resolve. */
    bannerUrl: twimgUrl(user.profile_banner_url),
    source: {
      operationName: 'WaybackImport',
      capturedVia: 'fetch'
    },
    schemaVersion: SCHEMA_VERSION
  };
}

/* -------------------------------------------------------------------------- */
/* permission                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whether this browser has granted access to archive.org.
 *
 * The same shape as hasMediaPermission in media-cache.js, and for the same
 * reason: every failure — no API, a thrown error, lastError — has to come back
 * as a plain "no". The caller's next move is to turn a switch off and say why,
 * and an exception thrown here would leave that switch claiming something
 * untrue.
 */
export function hasWaybackPermission() {
  return new Promise((resolve) => {
    try {
      if (!chrome || !chrome.permissions || typeof chrome.permissions.contains !== 'function') {
        resolve(false);
        return;
      }
      chrome.permissions.contains({ origins: WAYBACK_ORIGINS }, (granted) => {
        try {
          if (chrome.runtime.lastError) { resolve(false); return; }
        } catch (_) { /* ignore */ }
        resolve(granted === true);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

/**
 * Ask for it.
 *
 * MUST be called from a live user gesture in an extension page: the service
 * worker cannot ask at all, and a call that has lost its activation is refused
 * without ever showing a prompt. See enableMediaCache in popup.js.
 */
export function requestWaybackPermission() {
  return new Promise((resolve) => {
    try {
      if (!chrome || !chrome.permissions || typeof chrome.permissions.request !== 'function') {
        resolve(false);
        return;
      }
      chrome.permissions.request({ origins: WAYBACK_ORIGINS }, (granted) => {
        try {
          if (chrome.runtime.lastError) { resolve(false); return; }
        } catch (_) { /* ignore */ }
        resolve(granted === true);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* job state                                                                  */
/* -------------------------------------------------------------------------- */

/** A handle, as X allows one: letters, digits and underscore, up to 15. */
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

export function isHandle(value) {
  return typeof value === 'string' && HANDLE_PATTERN.test(value);
}

/** `/<handle>/status/<id>` and nothing else is a post permalink. */
const TWEET_PERMALINK = /^\/[^/]+\/status\/(\d{1,25})(?:\/|$)/;

/**
 * The post id inside a CDX `original`, or null.
 *
 * This is what makes "only fetch what is missing" possible: the snapshot list
 * carries the address of the post, so a run can ask the database whether it
 * already has that post WITHOUT spending a request on archive.org to find out.
 * Anything that is not a post permalink — a profile page, a status page for an
 * account that is not a tweet — comes back null and is dropped from the list.
 */
export function snapshotTweetId(original) {
  if (typeof original !== 'string' || original.length === 0) return null;
  let parsed;
  try { parsed = new URL(original); } catch (_) { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (X_PERMALINK_HOSTS.indexOf(parsed.hostname.toLowerCase()) === -1) return null;
  const match = TWEET_PERMALINK.exec(parsed.pathname);
  return match === null ? null : match[1];
}

/**
 * Where the raw JSON of one snapshot lives.
 *
 * `id_` gives back the archived bytes themselves; without it the Archive wraps
 * the response in its own viewer and this would be HTML parsing.
 */
export function snapshotEnvelopeUrl(snapshot) {
  return WAYBACK + '/' + snapshot.timestamp + 'id_/' + snapshot.original;
}

/**
 * Clean up a CDX listing: drop what is not a post, and keep ONE row per post.
 *
 * A CDX query returns one row per CAPTURE, not per post — the same tweet is
 * usually archived several times over, and each of those rows would cost a
 * separate request for the same bytes. Measured on this account: 1666 rows for
 * a few hundred distinct posts. The newest capture of each post is the one
 * kept.
 */
export function normalizeSnapshots(list) {
  if (!Array.isArray(list)) return [];
  const at = new Map();
  const out = [];

  for (const item of list) {
    if (!item || typeof item.timestamp !== 'string' || typeof item.original !== 'string') continue;
    if (!/^\d{14}$/.test(item.timestamp)) continue;

    const id = snapshotTweetId(item.original);
    if (id === null) continue;

    const index = at.get(id);
    if (index === undefined) {
      if (out.length >= WAYBACK_MAX_ROWS) continue;
      at.set(id, out.length);
      out.push(item);
    } else if (item.timestamp > out[index].timestamp) {
      out[index] = item;
    }
  }

  /* Ordered by POST ID, and the reason is the position the list is resumed
     against. The cursor is an INDEX into this array, and the array is rebuilt
     from scratch every time a fresh run starts, while the archive keeps
     crawling underneath it. For an index saved yesterday to still name the same
     post today, the order has to be one that only ever grows at the end.

     Capture time does not qualify, which is not obvious: the archive re-captures
     OLD posts, and a re-captured post's newest row would jump to the end,
     shifting every row after it. A post's id is the one thing about it that
     never changes, and ids are issued in increasing order, so ordering by id
     puts every post the archive has not seen before after every post it has.

     Compared as decimal strings by length first: these are snowflake ids of
     nineteen digits, well past what a double can hold exactly, so Number()
     would quietly round two different posts onto the same value. */
  const ordered = out.map((item) => ({ item: item, id: snapshotTweetId(item.original) }));
  ordered.sort((a, b) => compareIds(a.id, b.id));
  return ordered.map((pair) => pair.item);
}

/** Decimal strings of arbitrary length, in numeric order. */
function compareIds(a, b) {
  if (a === null || b === null) return 0;
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function clampInt(value, low, high, fallback) {
  if (!Number.isInteger(value) || value < low || value > high) return fallback;
  return value;
}

/**
 * What a stored job is allowed to be, read back from disk.
 *
 * Storage is input, exactly as a response from the page is: it survives a
 * version of this extension that no longer exists, it can be edited by hand,
 * and it can be half-written by a browser that was killed at the wrong moment.
 * A job that does not survive this comes back null and the run is dropped,
 * rather than a corrupted cursor sending the loop somewhere arbitrary.
 */
export function sanitizeStoredJob(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.v !== 1) return null;
  if (raw.mode !== 'gaps' && raw.mode !== 'verify') return null;
  if (!isHandle(raw.handle)) return null;

  const seenAt = isoOrNull(raw.seenAt);
  const startedAt = isoOrNull(raw.startedAt);
  if (seenAt === null || startedAt === null) return null;

  return {
    v: 1,
    mode: raw.mode,
    handle: raw.handle,
    // The ceiling is the list's own limit rather than the number the user is
    // allowed to type. "Fetch to the end" is expressed as a batch as large as
    // the list can be, and clamping that back down to 500 on the way in from
    // disk would turn a resumed run into one that stops at the first 500.
    batch: clampInt(raw.batch, 1, WAYBACK_MAX_ROWS, 100),
    seenAt: seenAt,
    startedAt: startedAt,
    // A cursor past the end of the list is not a cursor. It is clamped to zero
    // by the caller's own bounds check, which is why the ceiling here is only
    // the structure's own limit.
    cursor: clampInt(raw.cursor, 0, WAYBACK_MAX_ROWS, 0),
    fetched: clampInt(raw.fetched, 0, WAYBACK_MAX_ROWS, 0),
    imported: clampInt(raw.imported, 0, WAYBACK_MAX_ROWS, 0),
    enriched: clampInt(raw.enriched, 0, WAYBACK_MAX_ROWS, 0),
    skipped: clampInt(raw.skipped, 0, WAYBACK_MAX_ROWS, 0),
    failed: clampInt(raw.failed, 0, WAYBACK_MAX_ROWS, 0),
    consecutiveFailures: clampInt(raw.consecutiveFailures, 0, 1000, 0),
    cancelRequested: raw.cancelRequested === true,
    pauseReason: typeof raw.pauseReason === 'string' && raw.pauseReason.length > 0
      ? raw.pauseReason : null
  };
}

/**
 * The copy of an archived record that may be merged into a row that already
 * exists.
 *
 * THE MERGE RULE IS "the newest answer wins, unless it is empty" — which is
 * right for a capture and WRONG for an archived copy landing on a live row.
 * Two fields have to be taken out of its hands first:
 *
 *   - `metrics`. The Archive's numbers are whatever they were when it took the
 *     snapshot and are frequently zero — measured on this account's real
 *     records, a post with likes came back with `like_count: 0`. Zero is a real
 *     answer to the merge rule, so it would win, and a real like count would be
 *     replaced by a zero that was never true.
 *   - `source`. The archived copy says `backfilled: true`, which is correct for
 *     a row that came from the Archive and a lie about one that was captured
 *     live. Merging it would relabel the user's own posts as recovered.
 *
 * Both become null, which the merge rule reads as "no answer", so the stored
 * values survive. Everything the Archive is uniquely good for — the positions
 * of links in the text, who was allowed to reply, a fuller copy of a quoted
 * post — still fills in, because those fields are not touched.
 */
export function protectExisting(record) {
  const copy = Object.assign({}, record);
  copy.metrics = null;
  copy.source = null;
  return copy;
}

/* -------------------------------------------------------------------------- */
/* the pass                                                                   */
/* -------------------------------------------------------------------------- */

/** Why a pass stopped. `batch` and `done` are ordinary; the rest need saying. */
export const IMPORT_STOP = {
  DONE: 'done',
  BATCH: 'batch',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
  ARCHIVE_DOWN: 'archive-down'
};

/**
 * How many failures in a row mean the Archive is not answering.
 *
 * Without this, a dead archive costs one request per snapshot: measured at
 * about 1.8 seconds each, that is three quarters of an hour of hammering a
 * service that is already down, and the user sees nothing but a slow bar.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Do one pass of the job: at most `job.batch` fetches, then stop and leave the
 * whole position on `job` for whoever calls this next.
 *
 * Everything it touches outside its own two objects is injected, which is the
 * only reason it can be tested at all — this is the piece that has to survive
 * the browser killing the process between any two lines, and a browser is the
 * one place that cannot be arranged on demand. The caller supplies:
 *
 *   blockedReason()   null when the run may proceed, else 'off' / 'permission'
 *   readRecord(id)    the stored row for a post id, or null
 *   fetchJson(url)    { ok: true, value } or { ok: false, error }
 *   writeRecord(rec)  stores it; { existed } says whether a row was already there
 *   saveProfile(card) stores the account's profile card, at most once per run
 *   save()            persists `job` before the next risky step
 *   bump(bumps, err)  lifetime counters
 *   sleep(ms)         politeness delay
 *
 * The cursor is PEEKED, never advanced before the item is finished, and only
 * moved once the item resolved one way or the other. A process killed mid-item
 * therefore resumes by repeating it. That is safe because the write is an
 * idempotent merge — the worst case is one wasted request and one item counted
 * as "enriched" instead of "imported", which is a number in a diagnostic panel
 * and not a lost post.
 *
 * `job.fetched` is counted per PRESS, not per process lifetime, which the
 * caller is responsible for: it resets `fetched` to zero when the user starts a
 * new pass, and leaves it alone when it is resuming a pass the browser
 * interrupted. Getting that backwards is one of two failures — a resume that
 * runs far past the batch the user asked for, or a second press that fetches
 * nothing at all because the counter is still full.
 */
export async function runImportPass(options) {
  const job = options.job;
  const rows = options.rows;
  const deps = options.deps;

  /* Local to this run on purpose — see where it is used. `profileTaken` is true
     once a payload has named the account; the card is derived then and never
     again. */
  let profileTaken = false;

  const stopped = (reason) => ({
    reason: reason,
    cursor: job.cursor,
    total: rows.length,
    fetched: job.fetched,
    imported: job.imported,
    enriched: job.enriched,
    skipped: job.skipped,
    failed: job.failed
  });

  while (job.cursor < rows.length && job.fetched < job.batch) {
    if (job.cancelRequested) return stopped(IMPORT_STOP.CANCELLED);

    const blocked = await deps.blockedReason();
    if (blocked !== null) {
      job.pauseReason = blocked;
      await deps.save();
      return stopped(IMPORT_STOP.BLOCKED);
    }

    // Peeked. `rows[job.cursor]` stays the current item until it is finished.
    const snapshot = rows[job.cursor];
    const id = snapshotTweetId(snapshot.original);

    let existing = null;
    if (id !== null) {
      try {
        existing = await deps.readRecord(id);
      } catch (_) {
        // A read that fails is not a reason to stop the whole run; it only
        // means this item cannot be skipped and cannot be protected.
        existing = null;
      }
    }

    // The whole point of "fill the gaps": a post this archive already has costs
    // one database read, not one request to a third party.
    if (job.mode === 'gaps' && existing !== null) {
      job.skipped++;
      job.cursor++;
      deps.bump({ waybackSkipped: 1 });
      await deps.save();
      continue;
    }

    const result = await deps.fetchJson(snapshotEnvelopeUrl(snapshot));

    // Cancelled while that request was in flight: it is allowed to finish, and
    // what it brought back is deliberately NOT written. The user asked for it
    // to stop, and a record appearing after that is the archive changing under
    // them.
    if (job.cancelRequested) return stopped(IMPORT_STOP.CANCELLED);

    let record = null;
    if (result && result.ok === true) {
      try {
        record = toRecord(result.value, job.handle, job.seenAt);
      } catch (_) {
        record = null;
      }
    }

    if (record === null) {
      job.failed++;
      job.consecutiveFailures++;
      job.fetched++;
      job.cursor++;
      deps.bump({ waybackFailed: 1 }, (result && result.error) || 'not a tweet payload');
      await deps.save();

      if (job.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        job.pauseReason = 'archive-down';
        await deps.save();
        return stopped(IMPORT_STOP.ARCHIVE_DOWN);
      }
      await deps.sleep(DELAY_MS);
      continue;
    }

    job.consecutiveFailures = 0;

    /* The account's card, which rides in the very bytes already in hand.
     *
     * The payloads disagree with each other — measured on three real snapshots
     * of one account, its follower count read 0, 407 and 810 — but WHICH one
     * wins is not this engine's decision. The store takes a card only when the
     * account has none (see saveProfile in background.js), so the first card
     * offered is the one that lands and no later crawl, older or newer, can
     * replace it. A run whose first payload is the account's first day may
     * therefore offer the store a 0-follower card; that is a true sighting of
     * the account, and a visit to its own page refreshes the card from live
     * bytes. Comparing crawl timestamps here bought nothing the store would
     * honour, so it is not done.
     *
     * One card is derived per run, and only until one has been found: every
     * post after that carries the same account, so re-deriving it would only
     * produce a card the store refuses — or one the validator refuses again.
     *
     * The flag is not persisted on the job — a resumed run starts its own
     * search, and the most that can come of it is one more card offered to a
     * store that already has one, which is a refusal and not a downgrade.
     *
     * Deliberately not counted as a post and never allowed to fail the item:
     * the card is a bonus on top of the record already in hand. */
    if (!profileTaken) {
      let profile = null;
      try {
        profile = toProfile(result.value, job.handle);
      } catch (_) {
        profile = null;
      }
      if (profile !== null) {
        /* Set before the offer, not after it succeeds. Whether the store keeps
           the card or the validator refuses it, there is nothing more to learn
           from later payloads — they name the same account, and the answer to
           "may this card be stored" will be the same — so a rejected card is
           not retried once per post for the rest of the run. */
        profileTaken = true;
        // Deliberately not counted. The counters are about posts — imported,
        // enriched, skipped, failed — and a fifth one for a card that the "我"
        // page either shows or does not would be a row of diagnostics for
        // something the user can already see.
        try {
          await deps.saveProfile(profile);
        } catch (_) { /* the posts still land */ }
      }
    }

    try {
      const written = await deps.writeRecord(existing !== null ? protectExisting(record) : record);
      const landedOnAnExistingRow = existing !== null || (written && written.existed === true);
      if (landedOnAnExistingRow) {
        job.enriched++;
        deps.bump({ waybackEnriched: 1 });
      } else {
        job.imported++;
        deps.bump({ waybackImported: 1 });
      }
    } catch (err) {
      // One unwritable post must not cost the rest of the batch.
      job.failed++;
      deps.bump({ waybackFailed: 1 }, err && err.message ? err.message : String(err));
    }

    job.fetched++;
    job.cursor++;
    await deps.save();
    await deps.sleep(DELAY_MS);
  }

  return stopped(job.cursor >= rows.length ? IMPORT_STOP.DONE : IMPORT_STOP.BATCH);
}

/* -------------------------------------------------------------------------- */
/* exports                                                                    */
/* -------------------------------------------------------------------------- */

/* Everything the two callers need, plus the pieces the tests reach in for. */
export {
  toRecord, toEntities, toMedia, toQuotedTweet, toPostedVia,
  twimgUrl, toJsOffset, keepAlignedSpans, visibleText, isOwnMediaLink,
  getJson, listSnapshots,
  DELAY_MS, ATTEMPTS, FETCH_TIMEOUT_MS, WAYBACK, CDX, WAYBACK_MAX_ROWS
};
