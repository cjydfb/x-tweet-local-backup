/* ============================================================================
 * test-import.mjs — the Wayback converter, checked without touching the network.
 *
 * tools/import-wayback.mjs is the only program in this project that builds a
 * record by hand instead of handing raw bytes to `sanitizeRecord`, and what it
 * builds goes straight into an archive. It was also the only program here with
 * no test at all, and it earned that reputation twice: a retweet whose every
 * entity offset was shifted by an "RT @name: " prefix that had been dropped
 * from the body, and a schema version left behind at the old number. Both were
 * found by reading it, not by running it.
 *
 * So it is checked three ways, in increasing order of how much of the real path
 * each one covers:
 *
 *   1. the mapping, on archived payloads built to the shape a real one has;
 *   2. the envelope, scanned back by the READER's own byte scanner — the
 *      converter's only consumer, and the thing whose contract actually matters;
 *   3. a real output file, if one is on disk, against the invariants that must
 *      hold for every record whatever version produced it.
 *
 * It never fetches anything. A test that pulled from web.archive.org would be
 * slow, would fail whenever the archive is down, and would be reporting on the
 * archive rather than on this code.
 *
 *   node tools/test-import.mjs
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* The mapping lives in the shipped module now, because the extension's service
   worker needs the same one — so these tests exercise the copy that goes into
   the package rather than a command-line-only duplicate of it. The three things
   below are the command line's own. */
import {
  toRecord, toEntities, toMedia, toQuotedTweet, toPostedVia, twimgUrl, SCHEMA_VERSION
} from '../wayback.js';
import { serializeEnvelope, spread, parseArgs } from './import-wayback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

/* ------------------------------------------------------------------ reader -- */

/* The converter's output is read by one program and one only, so the round trip
   below runs the reader's own scanner rather than a second JSON.parse that
   would agree with itself. The two slices are cut exactly as test-reader.mjs
   cuts them. */
function sliceBetween(html, beginWord, endWord, mustContain) {
  const begin = html.indexOf(beginWord);
  const end = html.indexOf(endWord);
  if (begin < 0 || end < 0 || end < begin) {
    console.error('could not find ' + beginWord + ' / ' + endWord + ' in reader/reader.html');
    process.exit(1);
  }
  const body = html.slice(html.indexOf('*/', begin) + 2, html.lastIndexOf('/*', end));
  if (mustContain && body.indexOf(mustContain) < 0) {
    console.error('the ' + beginWord + ' block came out empty');
    process.exit(1);
  }
  return body;
}

const readerHtml = fs.readFileSync(path.join(REPO, 'reader', 'reader.html'), 'utf8');

const M = new Function(sliceBetween(readerHtml, 'CORE BEGIN', 'CORE END', 'findTweetsArray') + `
  return { findTweetsArray, createArrayScanner, scanChunk, readRecordAt };
`)();

const P = new Function(sliceBetween(readerHtml, 'PURE BEGIN', 'PURE END', 'resolveSpans') + `
  return { resolveSpans, envelopeHasList };
`)();

/* ----------------------------------------------------------------- harness -- */

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') await result;
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    failures.push(name + ' :: ' + message);
    console.log('  FAIL  ' + name + '   ->  ' + message);
  }
}

function ok(cond, message) {
  if (!cond) throw new Error(message || 'not true');
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message ? message + ': ' : '') +
      'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function deepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((message ? message + ': ' : '') + 'expected ' + b + ', got ' + a);
}

/** Run the reader's byte scanner over an envelope and return its element ranges. */
function scan(text) {
  const bytes = new TextEncoder().encode(text);
  const arrayStart = M.findTweetsArray(bytes, 0, bytes.length);
  ok(arrayStart >= 0, 'the reader could not find the "tweets" array');
  const st = M.createArrayScanner(arrayStart);
  // Small chunks on purpose: the record boundaries are the thing most likely to
  // be got wrong, and a boundary that only breaks across a read would never show
  // up in a single-pass scan.
  const CHUNK = 997;
  for (let off = arrayStart; off < bytes.length && !st.closed; off += CHUNK) {
    M.scanChunk(st, bytes.subarray(off, Math.min(off + CHUNK, bytes.length)), off);
  }
  return { st, bytes };
}

/* ----------------------------------------------------------------- fixtures -- */

const SEEN_AT = '2026-10-01T12:00:00.000Z';

/**
 * One archived v2 payload, built to the shape a real one has.
 *
 * The shape is not a guess: it was read off a real archived record, whose top
 * level is `{data, includes}` with `includes` holding `users`, `media` and
 * `tweets`, and whose `data` carries `author_id`, `conversation_id`,
 * `created_at`, `edit_history_tweet_ids`, `entities`, `lang`, `note_tweet`,
 * `possibly_sensitive`, `public_metrics`, `referenced_tweets`, `reply_settings`
 * and `text`.
 */
/* Offsets are converted against the text they index into, so a fixture with no
   text at all converts every offset to zero. These unit tests are about the
   lists and the offsets as built, so they measure against a plain string long
   enough to contain every offset used below — one where counting characters and
   counting UTF-16 units are the same thing. */
const BLANK = 'x'.repeat(400);

function payload(over) {
  const baseData = {
    id: '1800000000000000001',
    text: 'hello world',
    lang: 'en',
    created_at: '2026-03-15T12:59:16.000Z',
    author_id: '424242',
    conversation_id: '1800000000000000001',
    edit_history_tweet_ids: ['1800000000000000001'],
    possibly_sensitive: false,
    reply_settings: 'everyone',
    public_metrics: { like_count: 3, retweet_count: 1, reply_count: 0, quote_count: 0, bookmark_count: 0, impression_count: 120 },
    entities: { urls: [], hashtags: [], mentions: [] }
  };
  const baseIncludes = {
    users: [{ id: '424242', username: 'alice', name: 'Alice', profile_image_url: 'https://pbs.twimg.com/a.jpg' }],
    media: [],
    tweets: []
  };
  const o = over || {};
  return {
    data: Object.assign({}, baseData, o.data),
    includes: Object.assign({}, baseIncludes, o.includes)
  };
}

/* ========================================================================== */
/* 1. the mapping                                                             */
/* ========================================================================== */

console.log('== import: a plain archived post ==');

await check('the body, author, time and url come through', () => {
  const r = toRecord(payload(), 'alice', SEEN_AT);
  ok(r !== null, 'the record was refused outright');
  equal(r.id, '1800000000000000001');
  equal(r.text, 'hello world');
  equal(r.lang, 'en');
  equal(r.createdAt, '2026-03-15T12:59:16.000Z');
  equal(r.createdAtRaw, '2026-03-15T12:59:16.000Z');
  equal(r.author.id, '424242');
  equal(r.author.screenName, 'alice');
  equal(r.author.name, 'Alice');
  equal(r.tweetUrl, 'https://x.com/alice/status/1800000000000000001');
});

await check('the metrics are the archived ones, not zeroed', () => {
  const r = toRecord(payload(), 'alice', SEEN_AT);
  equal(r.metrics.likeCount, 3);
  equal(r.metrics.retweetCount, 1);
  equal(r.metrics.replyCount, 0, 'a real zero must stay a zero, not become null');
  equal(r.metrics.viewCount, 120);
});

await check('the record is stamped with the version db.js uses', () =>
  equal(toRecord(payload(), 'alice', SEEN_AT).schemaVersion, SCHEMA_VERSION));

await check('it is marked as a backfilled record, not a live one', () => {
  const r = toRecord(payload(), 'alice', SEEN_AT);
  equal(r.source.operationName, 'WaybackImport');
  equal(r.source.backfilled, true);
});

await check('the reader state is null, because the archive never had it', () => {
  const r = toRecord(payload(), 'alice', SEEN_AT);
  equal(r.viewerState, null, 'the archive cannot know how the account reacted');
  equal(r.sensitive, false, 'but a sensitive flag it DID carry is kept');
  equal(r.replySettings, 'everyone');
});

await check('a payload that is not a tweet is refused, not half-written', () => {
  equal(toRecord(null, 'alice', SEEN_AT), null);
  equal(toRecord({}, 'alice', SEEN_AT), null);
  equal(toRecord({ data: {} }, 'alice', SEEN_AT), null);
  equal(toRecord({ data: { id: '' } }, 'alice', SEEN_AT), null);
  equal(toRecord({ data: { id: 12345 } }, 'alice', SEEN_AT), null, 'an id must be a string');
});

console.log('\n== import: a conversation id that is a guess, not a fact ==');

await check('a named conversation is recorded as known', () => {
  const r = toRecord(payload({ data: { conversation_id: '1700000000000000000' } }), 'alice', SEEN_AT);
  equal(r.conversationId, '1700000000000000000');
  equal(r.conversationIdInferred, false);
});

await check('a missing conversation is substituted AND flagged as a guess', () => {
  // This is the bug the merge rule would otherwise walk into: the substitute is
  // a perfectly good string, so without the flag it would overwrite a
  // conversation id a live capture actually knew.
  const r = toRecord(payload({ data: { conversation_id: undefined } }), 'alice', SEEN_AT);
  equal(r.conversationId, '1800000000000000001');
  equal(r.conversationIdInferred, true, 'a substituted id must not be recorded as a fact');
});

console.log('\n== import: a long post ==');

await check('the note_tweet body wins over the truncated text', () => {
  const r = toRecord(payload({
    data: { text: '看看这个 @bob…', note_tweet: { text: '看看这个 @bob 然后是一段很长的正文，长到必须用 note_tweet 才装得下。' } }
  }), 'alice', SEEN_AT);
  ok(r.text.indexOf('长到必须用') > -1, 'the full body was not used: ' + r.text);
});

await check('an empty note_tweet does not blank the body', () => {
  const r = toRecord(payload({ data: { text: 'the real text', note_tweet: { text: '' } } }), 'alice', SEEN_AT);
  equal(r.text, 'the real text');
});

await check('offsets measured against the truncated text are dropped, not carried wrong', () => {
  // The shape of a real archived record, measured rather than imagined:
  // `data.text` was 151 characters and ended with the t.co link, the note text
  // was 240 characters and did not contain that link anywhere, and X had
  // measured the link's offset against the SHORT one. Stored against the long
  // body, [128,151) landed 23 characters into "北京国际电影节：象人，撒旦探戈…".
  const short = '法国艺术中心：你们所有人的脸 https://t.co/m8swHduCyH';
  const long = '法国艺术中心：你们所有人的脸\n北京国际电影节：象人，撒旦探戈，都灵之马，楚门之鼠';

  const r = toRecord(payload({
    data: {
      text: short,
      note_tweet: { text: long },
      entities: {
        urls: [Object.assign({
          url: 'https://t.co/m8swHduCyH',
          expanded_url: 'https://x.com/fcjdfb/status/1/photo/1',
          display_url: 'pic.x.com/m8swHduCyH'
        }, offsetsIn(short, 'https://t.co/m8swHduCyH'))]
      }
    }
  }), 'alice', SEEN_AT);

  equal(r.text, long, 'the whole body is still the one stored');
  deepEqual(r.entities.spans, [], 'an offset that names nothing must be dropped');
  equal(r.entities.urls.length, 1, 'but the link itself is still known');
});

await check('an offset the two texts agree about is kept', () => {
  // A long post's truncated body is a PREFIX of the whole one, so anything the
  // two agree about is at the same place in both and the offset is as good as
  // it ever was. Dropping everything would be the easy rule and a lossy one.
  const short = '看看这个 https://t.co/keepme 后面还有很长很长的一段尾巴';
  const long = short + '，长到需要 note_tweet 才装得下，因此正文取的是这一份。';

  const r = toRecord(payload({
    data: {
      text: short,
      note_tweet: { text: long },
      entities: {
        urls: [Object.assign({ url: 'https://t.co/keepme', expanded_url: 'https://example.com/k', display_url: 'example.com/k' },
          offsetsIn(short, 'https://t.co/keepme'))]
      }
    }
  }), 'alice', SEEN_AT);

  equal(r.text, long);
  equal(r.entities.spans.length, 1, 'an offset both texts agree about must survive');
  equal(r.text.slice(r.entities.spans[0].start, r.entities.spans[0].end), 'https://t.co/keepme');
});

console.log('\n== import: a retweet, and the offsets that go with it ==');

/* The body kept is the ORIGINAL's, because a retweet's own text is cut to 140
   characters. Its entity offsets, though, were measured against the retweet's
   own rendering — so pairing them with the original's body shifts every one of
   them by the length of a prefix that is no longer there. That is a silent bug:
   the numbers stay in range and only the highlight lands on the wrong words. */
const ORIGINAL = '看看这个 @bob #测试 和 https://t.co/abc';
const RT_PREFIX = 'RT @bob: ';
const RETWEETED_ID = '1700000000000000999';

/** Offsets of `part` inside `text`, as the archive would have measured them. */
function offsetsIn(text, part) {
  const start = text.indexOf(part);
  if (start < 0) throw new Error('fixture is wrong: ' + JSON.stringify(part) + ' is not in the text');
  return { start: start, end: start + part.length };
}

function retweetedFixture(originalEntities) {
  const rtText = RT_PREFIX + ORIGINAL;
  const shift = (span) => ({ start: span.start + RT_PREFIX.length, end: span.end + RT_PREFIX.length });

  return payload({
    data: {
      id: '1800000000000000002',
      text: rtText,
      conversation_id: '1800000000000000002',
      referenced_tweets: [{ type: 'retweeted', id: RETWEETED_ID }],
      entities: {
        urls: [Object.assign({ url: 'https://t.co/abc', expanded_url: 'https://example.com/abc', display_url: 'example.com/abc' },
          shift(offsetsIn(rtText, 'https://t.co/abc')))],
        hashtags: [Object.assign({ tag: '测试' }, shift(offsetsIn(rtText, '#测试')))],
        mentions: [Object.assign({ username: 'bob', id: '777' }, shift(offsetsIn(rtText, '@bob', 1)))]
      }
    },
    includes: {
      tweets: [Object.assign({
        id: RETWEETED_ID,
        text: ORIGINAL,
        created_at: '2026-01-01T00:00:00.000Z',
        author_id: '777'
      }, originalEntities === undefined ? {} : { entities: originalEntities })],
      users: [
        { id: '424242', username: 'alice', name: 'Alice', profile_image_url: 'https://pbs.twimg.com/a.jpg' },
        { id: '777', username: 'bob', name: 'Bob', profile_image_url: 'https://pbs.twimg.com/b.jpg' }
      ]
    }
  });
}

/** The offsets of each marked-up thing inside the ORIGINAL, as X measured them. */
const ORIGINAL_ENTITIES = {
  urls: [Object.assign({ url: 'https://t.co/abc', expanded_url: 'https://example.com/abc', display_url: 'example.com/abc' },
    offsetsIn(ORIGINAL, 'https://t.co/abc'))],
  hashtags: [Object.assign({ tag: '测试' }, offsetsIn(ORIGINAL, '#测试'))],
  mentions: [Object.assign({ username: 'bob', id: '777' }, offsetsIn(ORIGINAL, '@bob'))]
};

await check('the body stored is the original, not the 140-character preview', () => {
  const r = toRecord(retweetedFixture(ORIGINAL_ENTITIES), 'alice', SEEN_AT);
  equal(r.text, ORIGINAL);
  equal(r.isRetweet, true);
  equal(r.retweetedTweetId, RETWEETED_ID);
});

await check('every offset still lands on the words it names', () => {
  const r = toRecord(retweetedFixture(ORIGINAL_ENTITIES), 'alice', SEEN_AT);

  const sliced = {};
  for (const span of r.entities.spans) {
    sliced[span.kind] = r.text.slice(span.start, span.end);
  }
  equal(sliced.who, '@bob', 'the mention points at the wrong characters');
  equal(sliced.tag, '#测试', 'the hashtag points at the wrong characters');
  equal(sliced.url, 'https://t.co/abc', 'the link points at the wrong characters');
});

await check('an original with no entities drops the offsets but keeps the names', () => {
  // The lists name what is linked and stay true whichever text they came from.
  // Only the numbers are meaningless, and those must go rather than be carried
  // wrong — a highlight on the wrong words is worse than no highlight.
  const r = toRecord(retweetedFixture(null), 'alice', SEEN_AT);
  equal(r.text, ORIGINAL);
  deepEqual(r.entities.spans, [], 'unusable offsets must be dropped');
  equal(r.entities.urls.length, 1, 'but the link itself is still known');
  equal(r.entities.mentions.length, 1);
  equal(r.entities.hashtags.length, 1);
});

await check('no two offsets overlap, or the reader would silently drop one', () => {
  const r = toRecord(retweetedFixture(ORIGINAL_ENTITIES), 'alice', SEEN_AT);
  const resolved = P.resolveSpans(r.entities.spans);
  equal(resolved.length, r.entities.spans.length,
    'the reader resolved away ' + (r.entities.spans.length - resolved.length) + ' of the offsets as overlapping');
});

console.log('\n== import: the link X appends to a post\'s own photographs ==');

/* Measured on the real files before this was written. Of the 97 imported
   records, 22 have media and 20 of those ended in a t.co address that expands
   to the post's OWN permalink — a link X appends itself, never displays, and
   does not count as part of the text. The live capture path meets it too, on
   the timeline responses, so the same post looked different depending on where
   it came from. X says where the author's words stop; that is what is obeyed. */
const PHOTO_LINK = 'https://t.co/m8swHduCyH';
const AUTHOR_ONLY = '法国艺术中心：你们所有人的脸';
const WITH_TAIL = AUTHOR_ONLY + ' ' + PHOTO_LINK;

await check('the appended link is cut off the text, using X\'s own answer', () => {
  const r = toRecord(payload({
    data: {
      text: WITH_TAIL,
      display_text_range: [0, AUTHOR_ONLY.length],
      attachments: { media_keys: ['3_1'] },
      entities: {
        urls: [Object.assign({
          url: PHOTO_LINK,
          expanded_url: 'https://x.com/fcjdfb/status/1/photo/1',
          display_url: 'pic.x.com/m8swHduCyH'
        }, offsetsIn(WITH_TAIL, PHOTO_LINK))]
      }
    },
    includes: { media: [{ media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }] }
  }), 'alice', SEEN_AT);

  equal(r.text, AUTHOR_ONLY, 'the stray link is still in the text');
  deepEqual(r.entities.spans, [], 'its offset must go with it');
  equal(r.entities.urls.length, 1, 'but the link itself is still known');
  equal(r.media.length, 1, 'and so is the picture');
  equal(r.media[0].url, 'https://pbs.twimg.com/media/a.jpg', 'the address of the picture, which is what the link was for');
});

await check('a range that covers the whole text trims nothing', () => {
  // Measured on a real archived record: display_text_range [0,61] against a
  // 61-character text. X does not always leave the link out, and when it does
  // not, that is its answer too — so the range decides, not a guess about
  // trailing links.
  const r = toRecord(payload({
    data: { text: WITH_TAIL, display_text_range: [0, WITH_TAIL.length] }
  }), 'alice', SEEN_AT);
  equal(r.text, WITH_TAIL);
});

await check('no range at all trims nothing', () => {
  const r = toRecord(payload({ data: { text: WITH_TAIL } }), 'alice', SEEN_AT);
  equal(r.text, WITH_TAIL);
});

await check('a nonsense range is ignored rather than obeyed', () => {
  const bad = [[0, 0], [0, -1], [0, 99999], [0, 1.5], [0], [], 'nope', null, {}];
  for (const range of bad) {
    const r = toRecord(payload({ data: { text: WITH_TAIL, display_text_range: range } }), 'alice', SEEN_AT);
    equal(r.text, WITH_TAIL, 'range ' + JSON.stringify(range) + ' was obeyed');
  }
});

await check('a long post uses the note text and ignores the range', () => {
  // The note is already the author's words; the range describes the truncated
  // preview, so obeying it would cut the real body down to the preview.
  const note = '短'.repeat(300);
  const r = toRecord(payload({
    data: { text: '短的预览 https://t.co/m8swHduCyH', display_text_range: [0, 5], note_tweet: { text: note } }
  }), 'alice', SEEN_AT);
  equal(r.text, note);
});

await check('a retweet of a post with the appended link is trimmed too', () => {
  const original = '看看这个 https://t.co/abc';
  const r = toRecord(payload({
    data: {
      id: '1800000000000000010',
      text: 'RT @bob: ' + original,
      referenced_tweets: [{ type: 'retweeted', id: RETWEETED_ID }]
    },
    includes: {
      tweets: [{
        id: RETWEETED_ID, text: original, display_text_range: [0, 4],
        created_at: '2026-01-01T00:00:00.000Z', author_id: '777'
      }],
      users: [{ id: '424242', username: 'alice', name: 'Alice', profile_image_url: null }]
    }
  }), 'alice', SEEN_AT);
  equal(r.text, '看看这个', 'the original\'s own appended link survived');
});

console.log('\n== import: the same link, on a record that carries no range at all ==');

/* The range is not always there. Measured on a real archived record — and on
   the retweeted original inside its `includes.tweets` — `display_text_range`
   was absent altogether while the appended link sat at the end of the text. So
   the link is identified positively instead: it expands to THIS post's own
   permalink. That is the one thing an author's own link can never be. */
const OWN_ID = '1800000000000000001';
const OWN_PERMALINK = 'https://x.com/alice/status/' + OWN_ID + '/photo/1';

function trailingLinkCase(expandedUrl, id) {
  return toRecord(payload({
    data: {
      id: id || OWN_ID,
      text: WITH_TAIL,
      attachments: { media_keys: ['3_1'] },
      entities: {
        urls: [Object.assign({
          url: PHOTO_LINK, expanded_url: expandedUrl, display_url: 'pic.x.com/m8swHduCyH'
        }, offsetsIn(WITH_TAIL, PHOTO_LINK))]
      }
    },
    includes: { media: [{ media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }] }
  }), 'alice', SEEN_AT);
}

await check('a link to this post\'s own photo goes, even with no range to consult', () => {
  const r = trailingLinkCase(OWN_PERMALINK);
  equal(r.text, AUTHOR_ONLY, 'the appended link survived');
  deepEqual(r.entities.spans, [], 'and its offset must go with it');
  equal(r.media.length, 1, 'while the picture itself is untouched');
});

await check('a link to this post\'s own video goes too', () => {
  const r = trailingLinkCase('https://x.com/alice/status/' + OWN_ID + '/video/1');
  equal(r.text, AUTHOR_ONLY);
});

await check('a bare permalink to this post counts as well', () => {
  const r = trailingLinkCase('https://x.com/alice/status/' + OWN_ID);
  equal(r.text, AUTHOR_ONLY);
});

await check('a link to somebody ELSE\'s photo stays', () => {
  // The common false positive: the author linked to another post, one that
  // happens to be a photo. The id in the address is not this post's.
  const r = trailingLinkCase('https://x.com/someone/status/1700000000000000123/photo/1');
  equal(r.text, WITH_TAIL, 'a link the author chose must not be taken away');
  equal(r.entities.spans.length, 1, 'nor its offset');
});

await check('a link the author typed to their own profile stays', () => {
  const r = trailingLinkCase('https://x.com/alice');
  equal(r.text, WITH_TAIL);
});

await check('an id buried inside a longer address is not this post', () => {
  // `/status/<id>` has to END the address, or be followed by a media sub-page.
  // A URL that merely contains the id somewhere in a query string is a
  // different address entirely.
  const r = trailingLinkCase('https://example.com/r?ref=x.com/status/' + OWN_ID + '/photo/1');
  equal(r.text, WITH_TAIL);
});

await check('a link in the middle of the text is never touched', () => {
  const r = toRecord(payload({
    data: {
      id: OWN_ID,
      text: '看看 ' + PHOTO_LINK + ' 后面还有话',
      entities: {
        urls: [Object.assign({ url: PHOTO_LINK, expanded_url: OWN_PERMALINK, display_url: 'pic.x.com/x' },
          offsetsIn('看看 ' + PHOTO_LINK + ' 后面还有话', PHOTO_LINK))]
      }
    }
  }), 'alice', SEEN_AT);
  equal(r.text, '看看 ' + PHOTO_LINK + ' 后面还有话', 'only a trailing link can be the appended one');
});

await check('a retweet drops the ORIGINAL\'s own media link', () => {
  const original = '看看这个 https://t.co/abc';
  const r = toRecord(payload({
    data: {
      id: '1800000000000000011',
      text: 'RT @bob: ' + original,
      referenced_tweets: [{ type: 'retweeted', id: RETWEETED_ID }]
    },
    includes: {
      tweets: [Object.assign({
        id: RETWEETED_ID,
        text: original,
        created_at: '2026-01-01T00:00:00.000Z',
        author_id: '777'
      }, {
        entities: {
          urls: [Object.assign({
            url: 'https://t.co/abc',
            expanded_url: 'https://x.com/bob/status/' + RETWEETED_ID + '/photo/1',
            display_url: 'pic.x.com/abc'
          }, offsetsIn(original, 'https://t.co/abc'))]
        }
      })],
      users: [{ id: '424242', username: 'alice', name: 'Alice', profile_image_url: null }]
    }
  }), 'alice', SEEN_AT);
  equal(r.text, '看看这个', 'the original\'s own media link survived');
  deepEqual(r.entities.spans, [], 'and its offset must go with it');
});

await check('a post that is nothing but its own photo link keeps an empty body', () => {
  // Real case: a photo with no caption at all. X's text is then the link on
  // its own, and the honest body is an empty string — not the link.
  const r = toRecord(payload({
    data: {
      id: OWN_ID,
      text: PHOTO_LINK,
      attachments: { media_keys: ['3_1'] },
      entities: { urls: [{ url: PHOTO_LINK, expanded_url: OWN_PERMALINK, display_url: 'pic.x.com/m8swHduCyH' }] }
    },
    includes: { media: [{ media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }] }
  }), 'alice', SEEN_AT);
  equal(r.text, '');
  equal(r.media.length, 1, 'the picture is still there, which is the whole post');
});

console.log('\n== import: X counts characters, a string counts UTF-16 units ==');

/* Measured, not reasoned about. A real archived record read
   `…(🇺🇸) https://t.co/SNd7IatgUW` — 301 UTF-16 units and 299 characters — and X
   gave the link's offset as [276,299). Used raw on a JavaScript string that
   slices ") https://t.co/SNd7Iatg": the address missing its last three
   characters. Every offset X sends is counted the way a person counts. */

await check('an offset that sits after an emoji is converted, not used raw', () => {
  const body = 'señoro que impuso el castigo. (🇺🇸) https://t.co/SNd7IatgUW';
  const link = 'https://t.co/SNd7IatgUW';
  const points = Array.from(body);

  const r = toRecord(payload({
    data: {
      text: body,
      entities: {
        urls: [{
          url: link,
          expanded_url: 'https://example.com/x',
          display_url: 'example.com/x',
          // Exactly what X would have sent: counted in characters.
          start: points.length - link.length,
          end: points.length
        }]
      }
    }
  }), 'alice', SEEN_AT);

  equal(r.entities.spans.length, 1, 'the offset was dropped instead of converted');
  equal(r.text.slice(r.entities.spans[0].start, r.entities.spans[0].end), link,
    'the offset was used without converting it');
});

await check('a display range counted in characters cuts in the right place', () => {
  const body = '看看这个 😭 好可爱 https://t.co/abc';
  const trailing = ' https://t.co/abc';
  const points = Array.from(body);

  const r = toRecord(payload({
    data: { text: body, display_text_range: [0, points.length - trailing.length] }
  }), 'alice', SEEN_AT);

  equal(r.text, '看看这个 😭 好可爱', 'the cut landed one character late, inside the text');
});

await check('a text with no emoji converts to itself', () => {
  // The conversion must be a no-op where the two countings agree, or every
  // offset in the archive would shift.
  const body = '看看这个 https://t.co/abc';
  const r = toRecord(payload({
    data: {
      text: body,
      entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/x', display_url: 'example.com/x', start: 5, end: 28 }] }
    }
  }), 'alice', SEEN_AT);
  equal(r.entities.spans.length, 1);
  equal(r.text.slice(r.entities.spans[0].start, r.entities.spans[0].end), 'https://t.co/abc');
});

console.log('\n== import: a quoted post ==');

await check('the quoted post is kept whole, with its own author', () => {
  const r = toRecord(payload({
    data: {
      id: '1800000000000000003',
      referenced_tweets: [{ type: 'quoted', id: RETWEETED_ID }]
    },
    includes: {
      tweets: [{
        id: RETWEETED_ID,
        text: '被引用的原帖',
        created_at: '2026-02-02T03:04:05.000Z',
        author_id: '777'
      }],
      users: [
        { id: '424242', username: 'alice', name: 'Alice', profile_image_url: 'https://pbs.twimg.com/a.jpg' },
        { id: '777', username: 'bob', name: 'Bob', profile_image_url: 'https://pbs.twimg.com/b.jpg' }
      ]
    }
  }), 'alice', SEEN_AT);

  equal(r.quoteTweetId, RETWEETED_ID);
  ok(r.quotedTweet !== null, 'the quoted post was not kept');
  equal(r.quotedTweet.tweetId, RETWEETED_ID);
  equal(r.quotedTweet.text, '被引用的原帖');
  equal(r.quotedTweet.createdAt, '2026-02-02T03:04:05.000Z');
  equal(r.quotedTweet.author.screenName, 'bob');
  equal(r.quotedTweet.author.name, 'Bob');
});

await check('a quote whose original is not included is an id with no body', () => {
  const r = toRecord(payload({
    data: { referenced_tweets: [{ type: 'quoted', id: RETWEETED_ID }] }
  }), 'alice', SEEN_AT);
  equal(r.quoteTweetId, RETWEETED_ID);
  equal(r.quotedTweet, null, 'an id alone must not produce an empty quoted post');
});

console.log('\n== import: replies and media ==');

await check('a reply keeps the parent it answers', () => {
  const r = toRecord(payload({
    data: {
      in_reply_to_user_id: '777',
      referenced_tweets: [{ type: 'replied_to', id: RETWEETED_ID }]
    }
  }), 'alice', SEEN_AT);
  equal(r.isReply, true);
  equal(r.replyTo.tweetId, RETWEETED_ID);
  equal(r.replyTo.userId, '777');
});

await check('a photo keeps its picture and a thumbnail', () => {
  const r = toRecord(payload({
    data: { attachments: { media_keys: ['3_1'] } },
    includes: {
      media: [{
        media_key: '3_1', type: 'photo',
        url: 'https://pbs.twimg.com/media/one.jpg',
        preview_image_url: 'https://pbs.twimg.com/media/one.jpg?name=small',
        width: 1200, height: 800,
        alt_text: '一张图'
      }]
    }
  }), 'alice', SEEN_AT);

  equal(r.media.length, 1);
  equal(r.media[0].url, 'https://pbs.twimg.com/media/one.jpg');
  equal(r.media[0].thumbnailUrl, 'https://pbs.twimg.com/media/one.jpg?name=small');
  deepEqual(r.media[0].aspectRatio, [1200, 800]);
  equal(r.media[0].altText, '一张图');
});

await check('a video gets the highest-bitrate mp4, not the smallest', () => {
  const r = toRecord(payload({
    data: { attachments: { media_keys: ['7_1'] } },
    includes: {
      media: [{
        media_key: '7_1', type: 'video',
        preview_image_url: 'https://pbs.twimg.com/media/poster.jpg',
        variants: [
          { url: 'https://video.twimg.com/v/320.mp4', bit_rate: 320000, content_type: 'video/mp4' },
          { url: 'https://video.twimg.com/v/1024.mp4', bit_rate: 1024000, content_type: 'video/mp4' },
          { url: 'https://video.twimg.com/v/x.m3u8', content_type: 'application/x-mpegURL' },
          { url: 'https://evil.example.com/v/a.mp4', bit_rate: 9999999, content_type: 'video/mp4' }
        ]
      }]
    }
  }), 'alice', SEEN_AT);

  equal(r.media[0].url, 'https://video.twimg.com/v/1024.mp4', 'the best usable rendition');
  equal(r.media[0].variants.length, 3, 'the non-twimg variant must be dropped');
  equal(r.media[0].thumbnailUrl, 'https://pbs.twimg.com/media/poster.jpg');
});

await check('a media key with nothing behind it produces no entry', () => {
  const r = toRecord(payload({
    data: { attachments: { media_keys: ['3_missing'] } },
    includes: { media: [] }
  }), 'alice', SEEN_AT);
  deepEqual(r.media, []);
});

await check('no media at all is an empty list, not a missing field', () => {
  const r = toRecord(payload(), 'alice', SEEN_AT);
  deepEqual(r.media, []);
});

console.log('\n== import: small pieces ==');

await check('a poster name with markup in it is unwrapped, never stored raw', () => {
  deepEqual(toPostedVia('<a href="https://mobile.twitter.com" rel="nofollow">Twitter Web App</a>'),
    { name: 'Twitter Web App', url: null });
  equal(toPostedVia('Twitter for iPhone').name, 'Twitter for iPhone');
  equal(toPostedVia(''), null);
  equal(toPostedVia(null), null);
});

await check('only twimg hosts survive, and only over https', () => {
  equal(twimgUrl('https://pbs.twimg.com/media/a.jpg'), 'https://pbs.twimg.com/media/a.jpg');
  equal(twimgUrl('http://pbs.twimg.com/media/a.jpg'), null, 'plain http');
  equal(twimgUrl('https://evil.example.com/a.jpg'), null, 'a host that is not twimg');
  equal(twimgUrl('javascript:alert(1)'), null);
  equal(twimgUrl(''), null);
  equal(twimgUrl(null), null);
});

await check('an entities block full of junk produces empty lists, not a crash', () => {
  const e = toEntities({ urls: 'nope', hashtags: [null, 5, { tag: '' }], mentions: [{ username: '' }] }, BLANK, BLANK);
  deepEqual(e.urls, []);
  deepEqual(e.hashtags, []);
  deepEqual(e.mentions, []);
  deepEqual(e.spans, []);
  deepEqual(toEntities(null, BLANK, BLANK), { urls: [], hashtags: [], mentions: [], spans: [] });
});

await check('an offset that cannot be a position is dropped, not stored', () => {
  const e = toEntities({
    urls: [
      { url: 'https://t.co/a', start: -1, end: 5 },
      { url: 'https://t.co/b', start: 5, end: 5 },
      { url: 'https://t.co/c', start: 9, end: 4 },
      { url: 'https://t.co/d', start: 0.5, end: 3 },
      { url: 'https://t.co/ok', start: 0, end: 3 }
    ]
  }, BLANK, BLANK);
  deepEqual(e.spans, [{ kind: 'url', start: 0, end: 3 }], 'only the sane one survives');
  equal(e.urls.length, 5, 'but all five links are still known');
});

await check('spans come out in order however the input was ordered', () => {
  const e = toEntities({
    mentions: [{ username: 'b', start: 20, end: 22 }],
    hashtags: [{ tag: 't', start: 10, end: 12 }],
    urls: [{ url: 'https://t.co/a', start: 0, end: 8 }]
  }, BLANK, BLANK);
  deepEqual(e.spans.map((s) => s.start), [0, 10, 20]);
});

console.log('\n== import: X repeats itself, and that must not reach the archive ==');

/* Found in the real output file, not by reading the code: seven of its 97
   records listed one link two, three or four times — exactly as many times as
   the post had photographs — all at the same offset. */
await check('the same link four times becomes one link', () => {
  const link = { url: 'https://t.co/IxFDWCv3CD', expanded_url: 'https://x.com/a/status/1/photo/1', display_url: 'pic.x.com/IxFDWCv3CD' };
  const at7 = Object.assign({ start: 16, end: 39 }, link);
  const e = toEntities({
    urls: [Object.assign({}, at7), Object.assign({}, at7), Object.assign({}, at7), Object.assign({}, at7)]
  }, BLANK, BLANK);
  equal(e.urls.length, 1, 'the link was stored once per photograph');
  deepEqual(e.spans, [{ kind: 'url', start: 16, end: 39 }], 'four copies of one position');
});

await check('but two links to the same place at different places both survive', () => {
  const link = { url: 'https://t.co/abc', expanded_url: 'https://example.com/x', display_url: 'example.com/x' };
  const e = toEntities({
    urls: [
      Object.assign({ start: 0, end: 8 }, link),
      Object.assign({ start: 30, end: 38 }, link)
    ]
  }, BLANK, BLANK);
  equal(e.urls.length, 1, 'the list says what is linked, so the same link is listed once');
  deepEqual(e.spans.map((s) => s.start), [0, 30], 'but both positions are kept');
});

await check('repeated hashtags and mentions collapse too, whatever their case', () => {
  const e = toEntities({
    hashtags: [{ tag: '测试', start: 0, end: 3 }, { tag: '测试', start: 40, end: 43 }],
    mentions: [
      { username: 'Bob', start: 5, end: 9 },
      { username: 'bob', start: 50, end: 54 }
    ]
  }, BLANK, BLANK);
  deepEqual(e.hashtags, ['测试']);
  deepEqual(e.mentions, [{ screenName: 'Bob', name: null }], 'one handle is one person');
  equal(e.spans.length, 4, 'the positions are all still there');
});

await check('nothing is collapsed that is not actually identical', () => {
  const e = toEntities({
    urls: [
      { url: 'https://t.co/a', expanded_url: 'https://example.com/1', display_url: 'example.com/1', start: 0, end: 4 },
      { url: 'https://t.co/a', expanded_url: 'https://example.com/2', display_url: 'example.com/2', start: 0, end: 4 }
    ]
  }, BLANK, BLANK);
  equal(e.urls.length, 2, 'two links that merely share a short address are two links');
});

/* ========================================================================== */
/* 2. the envelope, read back by the reader                                   */
/* ========================================================================== */

console.log('\n== import: the envelope, scanned by the reader itself ==');

const SAMPLE = [
  toRecord(payload(), 'alice', SEEN_AT),
  toRecord(retweetedFixture(ORIGINAL_ENTITIES), 'alice', SEEN_AT),
  toRecord(payload({
    data: { id: '1800000000000000003', text: '一条中文推文，带 emoji 🎉 和引号 " \\ { }' },
    includes: { users: [{ id: '424242', username: 'alice', name: '爱丽丝 🎉', profile_image_url: null }] }
  }), 'alice', SEEN_AT)
];

await check('the reader finds every record the converter wrote', () => {
  const text = serializeEnvelope(SAMPLE, SEEN_AT);
  const { st } = scan(text);
  equal(st.closed, true, 'the reader never saw the array close');
  equal(st.elements.length, SAMPLE.length, 'records found');
  deepEqual(st.problems, [], 'the scanner reported a malformed envelope');
});

await check('every record reads back as the exact object that went in', async () => {
  const text = serializeEnvelope(SAMPLE, SEEN_AT);
  const { st, bytes } = scan(text);
  const blob = new Blob([bytes]);
  for (let i = 0; i < SAMPLE.length; i++) {
    const res = await M.readRecordAt(blob, st.elements[i]);
    ok(res.ok, 'record ' + i + ' failed to read: ' + res.error);
    deepEqual(res.value, SAMPLE[i], 'record ' + i + ' changed on the way through');
  }
});

await check('the count field matches the number of records', () => {
  const text = serializeEnvelope(SAMPLE, SEEN_AT);
  const envelope = JSON.parse(text);
  equal(envelope.count, SAMPLE.length);
  equal(envelope.tweets.length, SAMPLE.length);
});

await check('the envelope keys are in the order the reader depends on', () => {
  const text = serializeEnvelope(SAMPLE, SEEN_AT);
  const keys = Object.keys(JSON.parse(text));
  // `tweets` is found by a byte scan, so nothing large may sit in front of it,
  // and the reader probes only a bounded window backwards from the end for the
  // two lists after it.
  deepEqual(keys, ['schemaVersion', 'generator', 'generatorVersion', 'exportedAt',
    'timezone', 'tweets', 'count', 'profile', 'deletions', 'connections']);
});

await check('the account card rides in the envelope, where popup.js puts it', () => {
  const card = { userId: '9', screenName: 'fcjdfb', name: 'cjy' };
  const envelope = JSON.parse(serializeEnvelope(SAMPLE, SEEN_AT, card));
  deepEqual(envelope.profile, card);
});

await check('no card is written as an explicit null, so the key order never moves', () => {
  // Key order is what the reader's byte scan depends on; a key that comes and
  // goes with the data would move `deletions` and `connections` around.
  const envelope = JSON.parse(serializeEnvelope(SAMPLE, SEEN_AT));
  equal(envelope.profile, null);
  deepEqual(Object.keys(envelope), Object.keys(JSON.parse(serializeEnvelope(SAMPLE, SEEN_AT, { userId: '9' }))));
});

await check('empty deletions and connections do not register as data', () => {
  const text = serializeEnvelope(SAMPLE, SEEN_AT);
  equal(P.envelopeHasList(text, 'deletions'), false, 'an empty tombstone list was read as a real one');
  equal(P.envelopeHasList(text, 'connections'), false, 'an empty roster was read as a real one');
});

await check('an empty archive is still a readable envelope', () => {
  const { st } = scan(serializeEnvelope([], SEEN_AT));
  equal(st.closed, true);
  equal(st.elements.length, 0);
});

await check('one record per line, so the file stays compact', () => {
  const text = serializeEnvelope(SAMPLE, SEEN_AT);
  // Pretty-printing every record inflates the file by about a third; measured
  // at 100 records that was 217 KB against 151 KB. Counting lines that BEGIN a
  // record is the durable way to say that — a total line count would break
  // every time a header key is added.
  const recordLines = text.split('\n').filter((line) => line.trimStart().startsWith('{"id":'));
  equal(recordLines.length, SAMPLE.length, 'a record is not contained to its own line');
});

/* ========================================================================== */
/* 3. the real output file                                                    */
/* ========================================================================== */

console.log('\n== import: a real output file, if one is on disk ==');

const REAL = path.join(REPO, 'wayback-fcjdfb.json');

if (!fs.existsSync(REAL)) {
  console.log('  (skipped — no ' + path.basename(REAL) + ' in the repo root)');
} else {
  const text = fs.readFileSync(REAL, 'utf8');
  const { st } = scan(text);
  const records = JSON.parse(text.slice(text.indexOf('"tweets"'))
    .replace(/^"tweets"\s*:\s*/, '').replace(/,\s*"count"[\s\S]*$/, ''));

  await check('the reader finds every record in it', () => {
    equal(st.closed, true, 'the array never closed');
    equal(st.elements.length, records.length, 'the scanner and JSON.parse disagree on how many records there are');
    deepEqual(st.problems, []);
  });

  await check('every record carries an id, a body, a time and the current version', () => {
    for (const r of records) {
      ok(typeof r.id === 'string' && /^\d+$/.test(r.id), 'not a tweet id: ' + JSON.stringify(r.id));
      ok(typeof r.text === 'string', 'missing body on ' + r.id);
      ok(Number.isFinite(Date.parse(r.createdAt)), 'unparseable createdAt on ' + r.id + ': ' + r.createdAt);
      equal(r.schemaVersion, SCHEMA_VERSION, 'stale schemaVersion on ' + r.id);
      ok(r.tweetUrl.endsWith('/status/' + r.id), 'the url does not match the id on ' + r.id);
    }
  });

  await check('every offset in it lands on the words it names', () => {
    let checked = 0;
    for (const r of records) {
      ok(Array.isArray(r.entities.spans), 'missing spans on ' + r.id);
      for (const span of r.entities.spans) {
        checked++;
        const slice = r.text.slice(span.start, span.end);
        /* EXACT, not "contains". `\.co\/` was the first version of this check
           and it passed a slice of ") https://t.co/SNd7Iatg" — a link with its
           last three characters missing, which is exactly what a miscounted
           offset produces. Asking whether the slice IS an address rather than
           whether one is somewhere inside it is the difference between catching
           that and not. */
        const looksRight = span.kind === 'who' ? /^@[A-Za-z0-9_]{1,20}$/.test(slice)
          : span.kind === 'tag' ? /^#\S+$/.test(slice)
            : /^https?:\/\/\S+$/.test(slice);
        ok(looksRight, 'a ' + span.kind + ' offset on ' + r.id + ' points at ' + JSON.stringify(slice));
      }
    }
    ok(checked > 0, 'the file holds no offsets at all, so this proves nothing');
    console.log('        (' + checked + ' offsets checked across ' + records.length + ' records)');
  });

  await check('no link is stored twice, so no offset is dropped as an overlap', () => {
    // A file written by a converter older than the de-duplication keeps a link
    // once per attached photograph, and the reader then resolves the repeats
    // away as overlaps — the right answer reached by luck. So this failing
    // means the file on disk is stale, not that the reader is wrong.
    for (const r of records) {
      const seen = new Set();
      for (const u of r.entities.urls) {
        const key = JSON.stringify(u);
        ok(!seen.has(key), 'the same link is listed twice on ' + r.id +
          ' — this file predates the de-duplication; regenerate it with:' +
          ' node tools/import-wayback.mjs fcjdfb --limit=100');
        seen.add(key);
      }
      equal(P.resolveSpans(r.entities.spans).length, r.entities.spans.length,
        'an offset was resolved away on ' + r.id);
    }
  });

  await check('no post still carries the link X appended to its own photographs', () => {
    // The invariant, on the real file: a post whose text ends in a t.co address
    // that expands to its own permalink is carrying something X never showed.
    const offenders = [];
    let checked = 0;
    for (const r of records) {
      const tail = /\s*(https:\/\/t\.co\/[A-Za-z0-9]+)\s*$/.exec(String(r.text));
      if (!tail) continue;
      const entry = r.entities.urls.find((u) => u && u.url === tail[1]);
      if (!entry) continue;
      checked++;
      const expanded = String(entry.expandedUrl || '');
      if (/\/photo\/\d+$/.test(expanded) || expanded.indexOf('/status/' + r.id) !== -1) {
        offenders.push(r.id + ' -> ' + expanded);
      }
    }
    // The control. Trimming every trailing link would make the check above pass
    // by emptying the archive, so this asks that the material it works on is
    // still there: posts with photographs, and posts with links at the end.
    const withMedia = records.filter((r) => r.media.length > 0).length;
    ok(withMedia > 0, 'no record has media at all, so the check above proves nothing');
    ok(checked > 0, 'no record ends in a link any more, so the check above proves nothing');
    equal(offenders.length, 0, 'still carrying their own photo link: ' + offenders.join(', '));
    console.log('        (' + withMedia + ' posts with media, ' + checked + ' trailing links examined)');
  });

  await check('no post was emptied unless it was a photograph with no caption', () => {
    // The trim removes text, which makes it the one thing here that could eat
    // something real. A post that ends up with an empty body must therefore be
    // one that had nothing but its own picture to begin with.
    for (const r of records) {
      if (r.text.length > 0) continue;
      ok(r.media.length > 0 || r.quotedTweet !== null || r.quoteTweetId !== null || r.isRetweet,
        'the text of ' + r.id + ' was emptied and it has nothing else to show');
    }
  });

  await check('the reader state stays null: the archive could not have known it', () => {
    for (const r of records) {
      equal(r.viewerState, null, 'a fabricated viewer state on ' + r.id);
    }
  });

  await check('every field is one the extension knows, and none is missing', () => {
    // The same list test-background.mjs pins sanitizeRecord's OUTPUT to. Two
    // pins on one invariant, from the two programs that build a record.
    const SHAPE = ['id', 'text', 'lang', 'createdAt', 'createdAtRaw', 'capturedAt',
      'firstCapturedAt', 'updatedAt', 'tweetUrl', 'isReply', 'isRetweet', 'retweetedTweetId',
      'isEdit', 'editedFrom', 'editTweetIds', 'editInitialTweetId', 'editsRemaining',
      'isPoll', 'poll', 'replyTo', 'conversationId', 'conversationIdInferred', 'quoteTweetId',
      'quotedTweet', 'postedVia', 'viewerState', 'sensitive', 'replySettings', 'author',
      'entities', 'media', 'metrics', 'source', 'schemaVersion'].sort();
    for (const r of records) {
      deepEqual(Object.keys(r).sort(), SHAPE, 'the shape of ' + r.id + ' is not the documented one');
    }
  });

  await check('every conversation id it wrote is a fact, not a stored guess', () => {
    for (const r of records) {
      if (r.conversationIdInferred === true) {
        // A guess is allowed to exist; it is not allowed to claim to be one.
        equal(r.conversationId, r.id, 'an inferred id on ' + r.id + ' is not the substitution it claims to be');
      }
    }
  });
}

/* ========================================================================== */

console.log('\n== import: arguments and sampling ==');

await check('the handle loses its @ and the flags are read', () => {
  const a = parseArgs(['@fcjdfb', '--limit=25', '--out=x.json', '--all']);
  equal(a.handle, 'fcjdfb');
  equal(a.limit, 25);
  equal(a.out, 'x.json');
  equal(a.all, true);
});

await check('a nonsense limit falls back rather than producing zero records', () => {
  equal(parseArgs(['alice', '--limit=0']).limit, 100);
  equal(parseArgs(['alice', '--limit=-5']).limit, 100);
  equal(parseArgs(['alice', '--limit=abc']).limit, 100);
  equal(parseArgs(['alice']).limit, 100);
});

await check('sampling spreads across the whole span, not the first N', () => {
  const snapshots = [];
  for (let i = 0; i < 100; i++) snapshots.push({ timestamp: String(i), original: 'u' + i });
  const picked = spread(snapshots, 5);
  equal(picked.length, 5);
  equal(picked[0].timestamp, '0');
  equal(picked[4].timestamp, '99');
  ok(picked[2].timestamp > '40' && picked[2].timestamp < '60', 'the middle sample is not near the middle');
});

await check('asking for everything returns everything, in order', () => {
  const snapshots = [{ timestamp: 'a', original: 'u' }, { timestamp: 'b', original: 'u' }];
  deepEqual(spread(snapshots, 10), snapshots);
});

await check('asking for a single snapshot returns one snapshot', () => {
  // `--limit=1` divided by zero here: (n-1)*k/(count-1) is 0/0, Math.floor gives
  // NaN, and the result was a one-element array holding `undefined` — which then
  // threw on `.timestamp` several frames away from the arithmetic that caused it.
  const snapshots = [];
  for (let i = 0; i < 10; i++) snapshots.push({ timestamp: String(i), original: 'u' + i });
  const picked = spread(snapshots, 1);
  equal(picked.length, 1);
  ok(picked[0] !== undefined && picked[0] !== null, 'spread returned a hole');
  equal(picked[0].timestamp, '0');
});

/* ========================================================================== */

console.log('\n=========================================');
console.log('passed: ' + passed + '   failed: ' + failures.length);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
