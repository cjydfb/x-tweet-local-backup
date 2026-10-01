/* ============================================================================
 * test-wayback.mjs — the archive import job, checked without a browser and
 * without a single request.
 *
 * Three things here are load-bearing enough to deserve their own file:
 *
 *   1. THE CURSOR. The job is designed to be killed mid-item by a browser that
 *      tears down an idle service worker, and to resume by repeating whatever
 *      it was doing. "Killed mid-item" is not something a browser can be asked
 *      to do on demand, so the whole engine takes its side effects as
 *      arguments — which is what makes the failure testable at all.
 *
 *   2. THE MERGE GUARD. An archived copy carries `metrics` measured whenever
 *      the Archive looked (frequently zero) and `source.backfilled: true`. The
 *      merge rule is "the newest answer wins", so both would win, and both
 *      would be wrong: a real like count replaced by a zero, and the user's own
 *      live-captured post relabelled as recovered.
 *
 *   3. THE OFFSET UNIT. X counts characters; a JavaScript string counts UTF-16
 *      units. Those are the same number until an emoji appears.
 *
 *   node tools/test-wayback.mjs
 * ========================================================================== */

import assert from 'node:assert';

import {
  snapshotTweetId, snapshotEnvelopeUrl, normalizeSnapshots, sanitizeStoredJob,
  protectExisting, runImportPass, isHandle, getJson, toRecord, toProfile, toJsOffset,
  IMPORT_STOP, FETCH_TIMEOUT_MS, DELAY_MS
} from '../wayback.js';

/* --------------------------------------------------------------- harness -- */

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

/* ========================================================================== */
/* 1. the snapshot list                                                       */
/* ========================================================================== */

console.log('== wayback: reading a post id out of a snapshot address ==');

await check('a plain permalink gives its id', () => {
  assert.equal(snapshotTweetId('https://twitter.com/fcjdfb/status/2102648774476935519'), '2102648774476935519');
});

await check('every host X serves the same post from is accepted', () => {
  const hosts = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'];
  for (const host of hosts) {
    assert.equal(snapshotTweetId('https://' + host + '/a/status/123'), '123', host + ' was refused');
  }
});

await check('a media sub-page still gives the post id', () => {
  assert.equal(snapshotTweetId('https://twitter.com/a/status/123/photo/1'), '123');
  assert.equal(snapshotTweetId('https://twitter.com/a/status/123/video/1'), '123');
});

await check('a query string does not confuse it', () => {
  assert.equal(snapshotTweetId('https://twitter.com/a/status/123?s=20&t=abc'), '123');
});

await check('things that are not a post permalink give nothing', () => {
  const notPosts = [
    'https://twitter.com/fcjdfb',
    'https://twitter.com/fcjdfb/followers',
    'https://twitter.com/i/web/status/123',
    'https://twitter.com/a/status/notanumber',
    'https://twitter.com/a/status/',
    'https://example.com/a/status/123',
    'http://twitter.com/a/status/123',
    'not a url at all',
    '',
    null
  ];
  for (const value of notPosts) {
    assert.equal(snapshotTweetId(value), null, 'accepted ' + JSON.stringify(value));
  }
});

await check('the envelope address is the raw JSON, not the viewer page', () => {
  const url = snapshotEnvelopeUrl({ timestamp: '20260913192738', original: 'https://twitter.com/a/status/1' });
  assert.equal(url, 'https://web.archive.org/web/20260913192738id_/https://twitter.com/a/status/1');
  assert.ok(url.indexOf('id_/') > 0, 'without id_ the Archive wraps the response in its own viewer');
});

console.log('\n== wayback: the list is one row per CAPTURE, not per post ==');

const row = (timestamp, id) => ({ timestamp: timestamp, original: 'https://twitter.com/a/status/' + id });

await check('four captures of one post become one row', () => {
  const rows = normalizeSnapshots([
    row('20260101000000', '111'),
    row('20260201000000', '111'),
    row('20260301000000', '111'),
    row('20260401000000', '111')
  ]);
  assert.equal(rows.length, 1, 'the same post would have cost four requests');
});

await check('...and it is the NEWEST capture that is kept', () => {
  const rows = normalizeSnapshots([
    row('20260101000000', '111'),
    row('20260401000000', '111'),
    row('20260201000000', '111')
  ]);
  assert.equal(rows[0].timestamp, '20260401000000');
});

await check('captures that arrived newest-first also keep the newest', () => {
  const rows = normalizeSnapshots([
    row('20260401000000', '111'),
    row('20260101000000', '111')
  ]);
  assert.equal(rows[0].timestamp, '20260401000000');
});

await check('rows that are not posts are dropped', () => {
  const rows = normalizeSnapshots([
    { timestamp: '20260101000000', original: 'https://twitter.com/a' },
    { timestamp: '20260101000000', original: 'https://twitter.com/a/followers' },
    { timestamp: '20260101000000', original: 'https://example.com/a/status/1' },
    row('20260101000000', '222')
  ]);
  assert.equal(rows.length, 1);
  assert.equal(snapshotTweetId(rows[0].original), '222');
});

await check('junk rows do not throw', () => {
  assert.deepEqual(normalizeSnapshots(null), []);
  assert.deepEqual(normalizeSnapshots([null, 5, 'x', {}, { timestamp: 1, original: 2 }]), []);
  assert.deepEqual(normalizeSnapshots([{ timestamp: 'nope', original: 'https://twitter.com/a/status/1' }]), []);
});

/* The next four are about the CURSOR, not about tidiness.
 *
 * A run's position is an index into this array, and the array is rebuilt from
 * scratch every time a fresh run is started — while the archive keeps crawling
 * and the list keeps growing. If the order were whatever order CDX happened to
 * answer in, an index saved yesterday could name a different post today: the
 * run would silently re-fetch some posts and, in the other direction, skip
 * others. So the order has to be one that only ever grows at the end.
 *
 * Post id is that order. Capture time is not, and the last of these four is the
 * one that says so. */

const idsOf = (rows) => rows.map((r) => snapshotTweetId(r.original));

await check('posts come out in id order, whatever order CDX answered in', () => {
  const rows = normalizeSnapshots([
    row('20260301000000', '3'), row('20260101000000', '1'), row('20260201000000', '2')
  ]);
  assert.deepEqual(idsOf(rows), ['1', '2', '3']);
});

await check('snowflake ids beyond a double\'s reach still sort correctly', () => {
  // Nineteen digits. Number() would round these two onto the same value and the
  // sort would leave them in whatever order they arrived in.
  const a = '1900000000000000001';
  const b = '1900000000000000002';
  assert.equal(Number(a) === Number(b), true, 'these are no longer the pair this test is about');
  assert.deepEqual(idsOf(normalizeSnapshots([row('20260101000000', b), row('20260201000000', a)])), [a, b]);
});

await check('so a list that has grown since yesterday only grows at the end', () => {
  // Everything the run had already walked past is still at the same index, and
  // whatever the archive captured overnight is after it.
  const yesterday = ['20260101000000', '20260201000000', '20260301000000'];
  const before = normalizeSnapshots(yesterday.map((ts, i) => row(ts, String(i + 1))));

  const today = yesterday.concat(['20260401000000', '20260501000000']);
  const after = normalizeSnapshots(today.map((ts, i) => row(ts, String(i + 1))));

  assert.equal(after.length, 5);
  assert.deepEqual(idsOf(after.slice(0, before.length)), idsOf(before),
    'the prefix moved, so a saved cursor no longer names the post it named');
});

await check('and a re-capture of an old post does not stir the list', () => {
  // The archive does re-crawl old posts. The re-captured row has to replace the
  // old one WITHOUT moving — a sort by capture time would send it to the end and
  // shift every row after it, which is why the order is by id instead.
  const original = [
    row('20260101000000', '1'), row('20260201000000', '2'), row('20260301000000', '3')
  ];
  const rows = normalizeSnapshots(original.concat([row('20260601000000', '2')]));
  assert.deepEqual(idsOf(rows), ['1', '2', '3']);
  assert.equal(rows[1].timestamp, '20260601000000', 'the newer capture of the middle post was not the one kept');
});

/* ========================================================================== */
/* 2. the stored job, read back as untrusted input                            */
/* ========================================================================== */

console.log('\n== wayback: a stored job is input, not a promise ==');

const goodJob = () => ({
  v: 1, mode: 'gaps', handle: 'fcjdfb', batch: 100,
  seenAt: '2026-10-01T00:00:00.000Z', startedAt: '2026-10-01T00:00:00.000Z',
  cursor: 0, fetched: 0, imported: 0, enriched: 0, skipped: 0, failed: 0,
  consecutiveFailures: 0, cancelRequested: false, pauseReason: null
});

await check('a well-formed job comes back', () => {
  const job = sanitizeStoredJob(goodJob());
  assert.equal(job.mode, 'gaps');
  assert.equal(job.handle, 'fcjdfb');
  assert.equal(job.cursor, 0);
});

await check('junk comes back null rather than half-read', () => {
  const bad = [null, undefined, 'x', 5, [], {}, { v: 2, mode: 'gaps', handle: 'a' },
    { v: 1, mode: 'nonsense', handle: 'a' }, { v: 1, mode: 'gaps', handle: 'not a handle' },
    { v: 1, mode: 'gaps', handle: 'a', seenAt: 'nope', startedAt: 'x' }];
  for (const value of bad) {
    assert.equal(sanitizeStoredJob(value), null, 'accepted ' + JSON.stringify(value));
  }
});

await check('an out-of-range cursor is not obeyed', () => {
  assert.equal(sanitizeStoredJob(Object.assign(goodJob(), { cursor: -5 })).cursor, 0);
  assert.equal(sanitizeStoredJob(Object.assign(goodJob(), { cursor: 1.5 })).cursor, 0);
  assert.equal(sanitizeStoredJob(Object.assign(goodJob(), { cursor: 999999 })).cursor, 0);
});

await check('a batch that is not a sane number falls back rather than running wild', () => {
  for (const batch of [0, -1, 1.5, 100000, 'x', null]) {
    assert.equal(sanitizeStoredJob(Object.assign(goodJob(), { batch: batch })).batch, 100,
      'batch ' + JSON.stringify(batch));
  }
});

await check('but "fetch to the end" survives the round trip from disk', () => {
  // The switch is expressed as a batch as large as the list can be. Clamping it
  // back to what the user is allowed to TYPE would turn a resumed run into one
  // that stops at the first 500 — and it would stop by looking like it had
  // finished.
  const huge = sanitizeStoredJob(Object.assign(goodJob(), { batch: 20000 }));
  assert.equal(huge.batch, 20000, 'a resumed run would have been cut short');
});

await check('a cancel flag survives the round trip — it is the only thing that does', () => {
  // If this were dropped, a cancelled job would come back to life on the next
  // worker start and start fetching again.
  assert.equal(sanitizeStoredJob(Object.assign(goodJob(), { cancelRequested: true })).cancelRequested, true);
  assert.equal(sanitizeStoredJob(Object.assign(goodJob(), { cancelRequested: 'yes' })).cancelRequested, false);
});

/* ========================================================================== */
/* 3. the merge guard                                                         */
/* ========================================================================== */

console.log('\n== wayback: an archived copy must not overwrite a live capture ==');

await check('metrics and source are taken out of its hands', () => {
  const archived = {
    id: '1', text: 'hello',
    metrics: { likeCount: 0, retweetCount: 0, viewCount: 0 },
    source: { operationName: 'WaybackImport', backfilled: true },
    entities: { urls: [], hashtags: [], mentions: [], spans: [{ kind: 'url', start: 0, end: 5 }] },
    replySettings: 'following'
  };
  const safe = protectExisting(archived);
  assert.equal(safe.metrics, null, 'a zero would win the merge and replace a real like count');
  assert.equal(safe.source, null, 'the row would be relabelled as recovered');
});

await check('everything the archive is uniquely good for is left alone', () => {
  const archived = {
    id: '1',
    entities: { urls: [], hashtags: [], mentions: [], spans: [{ kind: 'url', start: 0, end: 5 }] },
    replySettings: 'following',
    quotedTweet: { tweetId: '9', text: 'quoted' }
  };
  const safe = protectExisting(archived);
  assert.deepEqual(safe.entities.spans, [{ kind: 'url', start: 0, end: 5 }]);
  assert.equal(safe.replySettings, 'following');
  assert.equal(safe.quotedTweet.tweetId, '9');
});

await check('it copies rather than mutates', () => {
  const archived = { id: '1', metrics: { likeCount: 7 }, source: { backfilled: true } };
  protectExisting(archived);
  assert.equal(archived.metrics.likeCount, 7, 'the original was modified in place');
});

/* ========================================================================== */
/* media                                                                      */
/* ========================================================================== */

console.log('\n== wayback: the media URLs, which are all the archive has of a picture ==');

/**
 * The archive stores no media FILES — that is settled and not fixable. What it
 * does store is the URL of each one, and the whole of "补齐媒体" depends on those
 * surviving this far: the extension never fetches a picture it has no address
 * for, and a null url here is a photograph that is silently gone.
 *
 * Built from a real payload's shape, down to the field names, because the
 * failure this guards against is Twitter renaming one of them.
 */
function mediaEnvelope() {
  return {
    data: {
      id: '500', text: 'two pictures and a film', lang: 'en',
      created_at: '2026-01-01T00:00:00.000Z', author_id: '9',
      conversation_id: '500', edit_history_tweet_ids: ['500'],
      attachments: { media_keys: ['3_1', '3_2', '7_1'] },
      public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0 },
      entities: { urls: [], hashtags: [], mentions: [] }
    },
    includes: {
      users: [{ id: '9', username: 'fcjdfb', name: 'cjy', profile_image_url: null }],
      media: [
        { media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/AAA111.jpg',
          width: 1200, height: 800, alt_text: 'a cat' },
        { media_key: '3_2', type: 'photo', url: 'https://pbs.twimg.com/media/BBB222.jpg',
          width: 800, height: 1200, alt_text: null },
        { media_key: '7_1', type: 'video', url: null, width: 710, height: 1280,
          preview_image_url: 'https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/CCC.jpg',
          duration_ms: 4200,
          variants: [
            { url: 'https://video.twimg.com/x/320x568/low.mp4', bit_rate: 320000, content_type: 'video/mp4' },
            { url: 'https://video.twimg.com/x/710x1280/high.mp4', bit_rate: 1400000, content_type: 'video/mp4' },
            { url: 'https://video.twimg.com/x/playlist.m3u8', bit_rate: null, content_type: 'application/x-mpegURL' }
          ] }
      ],
      tweets: []
    }
  };
}

await check('a photo keeps the address of the picture itself', () => {
  const r = toRecord(mediaEnvelope());
  assert.equal(r.media.length, 3);
  assert.equal(r.media[0].type, 'photo');
  assert.equal(r.media[0].url, 'https://pbs.twimg.com/media/AAA111.jpg');
  assert.equal(r.media[0].altText, 'a cat');
  assert.equal(r.media[0].width, 1200);
});

await check('a video keeps the highest bitrate MP4, not the first one listed', () => {
  const r = toRecord(mediaEnvelope());
  const film = r.media[2];
  assert.equal(film.type, 'video');
  // The m3u8 is a playlist, not a file, and the 320k rendition is the one that
  // looks bad. Highest bitrate mp4 is the only right answer.
  assert.equal(film.url, 'https://video.twimg.com/x/710x1280/high.mp4');
  assert.equal(film.thumbnailUrl, 'https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/CCC.jpg');
});

await check('every URL it kept is one the media cache would accept', () => {
  const r = toRecord(mediaEnvelope());
  const hosts = ['pbs.twimg.com', 'video.twimg.com'];
  for (const m of r.media) {
    assert.equal(typeof m.url, 'string', 'media url must never be null: ' + m.id);
    assert.ok(hosts.indexOf(new URL(m.url).hostname) !== -1, 'host not allowed: ' + m.url);
  }
});

await check('a media key with nothing behind it produces no entry', () => {
  const env = mediaEnvelope();
  env.includes.media = [env.includes.media[0]];
  const r = toRecord(env);
  // Two of the three keys are now dangling. A record that lists a picture it
  // cannot name is worse than one that lists two instead of three.
  assert.equal(r.media.length, 1);
  assert.equal(r.media[0].url, 'https://pbs.twimg.com/media/AAA111.jpg');
});

await check('a photo URL on some other host is dropped, not carried', () => {
  const env = mediaEnvelope();
  env.includes.media[0].url = 'https://example.com/tracker.gif';
  const r = toRecord(env);
  assert.equal(r.media[0].url, null);
});

/* -------------------------------------------------------------------------- */
/* 3b. the fields that were sitting in the payload and not being read          */
/* -------------------------------------------------------------------------- */

console.log('\n== wayback: what else the archived payload carries ==');

/**
 * A long post. `data.text` is the truncated preview X puts on a timeline and
 * `note_tweet.text` is the whole thing; each has its own entity list, and the
 * offsets in each only mean anything against its own text.
 *
 * The two lists name DIFFERENT links on purpose, so an assertion can tell which
 * one was read rather than just that something was.
 */
const NOTE_LINK = 'https://t.co/LINK';
const NOTE_TEXT = 'a'.repeat(300) + ' ' + NOTE_LINK + ' ' + 'b'.repeat(50);
const NOTE_AT = NOTE_TEXT.indexOf(NOTE_LINK);

function longEnvelope() {
  return {
    data: {
      id: '600', lang: 'en', author_id: '9',
      created_at: '2026-01-01T00:00:00.000Z', conversation_id: '600',
      edit_history_tweet_ids: ['600'],
      // 150 characters and an ellipsis: the shape X puts in `data.text`
      text: NOTE_TEXT.slice(0, 150) + '…',
      note_tweet: {
        text: NOTE_TEXT,
        entities: {
          urls: [{
            url: 'https://t.co/LINK', expanded_url: 'https://example.com/real',
            display_url: 'example.com/real', start: NOTE_AT, end: NOTE_AT + NOTE_LINK.length
          }],
          hashtags: [], mentions: []
        }
      },
      // Measured against the preview, pointing at nothing once the full text is
      // what gets stored.
      entities: {
        urls: [{
          url: 'https://t.co/WRONG', expanded_url: 'https://example.com/wrong',
          display_url: 'example.com/wrong', start: NOTE_AT, end: NOTE_AT + NOTE_LINK.length
        }],
        hashtags: [], mentions: []
      },
      public_metrics: { like_count: 3 }
    },
    includes: {
      users: [{ id: '9', username: 'fcjdfb', name: 'cjy', profile_image_url: null }],
      media: [], tweets: []
    }
  };
}

await check('a long post keeps its whole text', () => {
  const r = toRecord(longEnvelope());
  assert.equal(r.text, NOTE_TEXT);
});

await check('a long post takes its offsets from the note, not from the preview', () => {
  const r = toRecord(longEnvelope());
  // The note's list names the real link; the preview's names a different one.
  assert.equal(r.entities.urls.length, 1);
  assert.equal(r.entities.urls[0].url, 'https://t.co/LINK', 'read data.entities, whose offsets do not line up');
  assert.equal(r.entities.spans.length, 1, 'the span was dropped instead of aligned');
  assert.equal(r.text.slice(r.entities.spans[0].start, r.entities.spans[0].end), 'https://t.co/LINK');
});

await check('a long post with no entity list of its own still drops the bad offsets', () => {
  const env = longEnvelope();
  delete env.data.note_tweet.entities;
  const r = toRecord(env);
  // Falls back to data.entities, whose offsets were measured against a text
  // that is not the one stored — so the names survive and the offsets do not.
  assert.equal(r.entities.urls[0].url, 'https://t.co/WRONG');
  assert.equal(r.entities.spans.length, 0);
});

/** An edit chain and the id the record itself is. */
function editEnvelope(chain, id) {
  const env = envelopeFor(id || chain[chain.length - 1]);
  env.data.edit_history_tweet_ids = chain;
  return env;
}

await check('a post that was never edited does not claim to be one', () => {
  const r = toRecord(editEnvelope(['700']));
  assert.equal(r.editTweetIds.length, 1);
  assert.equal(r.isEdit, false);
  assert.equal(r.editedFrom, null);
  assert.equal(r.editInitialTweetId, null);
});

await check('a real edit chain names both ends of it', () => {
  const r = toRecord(editEnvelope(['700', '701', '702']));
  assert.equal(r.isEdit, true);
  assert.equal(r.editedFrom, '701', 'the version this one replaced');
  assert.equal(r.editInitialTweetId, '700', 'the first version');
  assert.deepEqual(r.editTweetIds, ['700', '701', '702']);
});

await check('a chain that does not end at this record has nothing read out of it', () => {
  // The record is 702, but the chain stops at 701 — so whatever that list is
  // about, it is not this post, and ids taken from it would be confidently
  // wrong rather than merely absent.
  const r = toRecord(editEnvelope(['700', '701'], '702'));
  assert.equal(r.isEdit, false);
  assert.equal(r.editedFrom, null);
  assert.equal(r.editInitialTweetId, null);
  assert.deepEqual(r.editTweetIds, ['700', '701']);
});

await check('edits remaining is read from the payload', () => {
  const env = editEnvelope(['700']);
  env.data.edit_controls = { edits_remaining: 5, editable_until: '2026-01-02T00:00:00.000Z' };
  assert.equal(toRecord(env).editsRemaining, 5);
});

await check('no edit controls means no number, not zero', () => {
  // "not recorded" and "none left" are different answers.
  assert.equal(toRecord(editEnvelope(['700'])).editsRemaining, null);
});

await check('a reply names who it is replying to', () => {
  const env = envelopeFor('800');
  env.data.in_reply_to_user_id = '77';
  env.data.referenced_tweets = [{ type: 'replied_to', id: '799' }];
  env.includes.users.push({ id: '77', username: 'someone', name: 'Some One', profile_image_url: null });
  const r = toRecord(env);
  assert.equal(r.isReply, true);
  assert.equal(r.replyTo.tweetId, '799');
  assert.equal(r.replyTo.screenName, 'someone');
  assert.equal(r.replyTo.userId, '77');
});

await check('a reply to someone the payload left out keeps the id and no name', () => {
  const env = envelopeFor('801');
  env.data.in_reply_to_user_id = '77';
  env.data.referenced_tweets = [{ type: 'replied_to', id: '799' }];
  const r = toRecord(env);
  assert.equal(r.replyTo.userId, '77');
  assert.equal(r.replyTo.screenName, null);
});

/* -------------------------------------------------------------------------- */
/* 3c. the account's own card, which every payload was carrying anyway         */
/* -------------------------------------------------------------------------- */

console.log('\n== wayback: the profile that comes with every post ==');

/** A user object shaped like the ones the Archive really delivers. */
function profileUser() {
  return {
    id: '2018248488773898240',
    name: 'Box🍥',
    username: 'Box3_ji',
    created_at: '2026-02-02T09:02:14.000Z',
    description: '泥豪\n小盒子：@Box3_jilil',
    location: '粉丝的心里',
    url: 'https://t.co/ICYysRSi06',
    profile_image_url: 'https://pbs.twimg.com/profile_images/2092930234664574976/i9QCz-sY_normal.jpg',
    profile_banner_url: 'https://pbs.twimg.com/profile_banners/2018248488773898240/1789314183',
    verified: true,
    verified_type: 'blue',
    is_identity_verified: false,
    protected: false,
    pinned_tweet_id: '2102784376706867410',
    public_metrics: {
      followers_count: 810, following_count: 61, tweet_count: 445,
      listed_count: 2, media_count: 42, like_count: 196
    },
    entities: {
      description: { mentions: [{ start: 11, end: 21, username: 'Box3_jilil' }] },
      url: { urls: [{
        display_url: 'ngl.link/box3_ji/bit', end: 23, start: 0,
        expanded_url: 'https://ngl.link/box3_ji/bit', url: 'https://t.co/ICYysRSi06'
      }] }
    }
  };
}

/** An envelope whose `includes.users` holds this card, plus somebody else. */
function profileEnvelope() {
  const env = envelopeFor('1100');
  const other = { id: '77', username: 'someone', name: 'Some One' };
  env.includes.users = [other, profileUser()];
  return env;
}

await check('the card is read from the post payload, needing no extra request', () => {
  const p = toProfile(profileEnvelope(), 'Box3_ji');
  assert.ok(p !== null, 'no card came out');
  assert.equal(p.userId, '2018248488773898240');
  assert.equal(p.screenName, 'Box3_ji');
  assert.equal(p.screenNameLower, 'box3_ji');
  assert.equal(p.name, 'Box🍥');
  assert.equal(p.accountCreatedAt, '2026-02-02T09:02:14.000Z');
  assert.equal(p.bio, '泥豪\n小盒子：@Box3_jilil');
  assert.equal(p.location, '粉丝的心里');
});

await check('the counts and the picture come across', () => {
  const p = toProfile(profileEnvelope(), 'Box3_ji');
  assert.equal(p.followersCount, 810);
  assert.equal(p.followingCount, 61);
  assert.equal(p.tweetCount, 445);
  assert.equal(p.avatarUrl, 'https://pbs.twimg.com/profile_images/2092930234664574976/i9QCz-sY_normal.jpg');
  // The archived banner address has no size segment; it is stored as it arrives
  // because that bare form is the one that resolves.
  assert.equal(p.bannerUrl, 'https://pbs.twimg.com/profile_banners/2018248488773898240/1789314183');
});

await check('the website is the destination, not the t.co address in front of it', () => {
  const p = toProfile(profileEnvelope(), 'Box3_ji');
  assert.equal(p.websiteUrl, 'https://ngl.link/box3_ji/bit');
});

await check('the three extra counts come across, each from its own place', () => {
  const p = toProfile(profileEnvelope(), 'Box3_ji');
  assert.equal(p.listedCount, 2);
  assert.equal(p.mediaCount, 42);
  assert.equal(p.likeCount, 196);
  // likeCount off a PROFILE is the account's likes GIVEN. The same key on a
  // tweet means the likes that post received, and reading one as the other
  // would be a number about something else entirely.
  assert.notEqual(p.likeCount, undefined);
});

await check('a missing count is null, not zero', () => {
  const env = profileEnvelope();
  delete env.includes.users[1].public_metrics.listed_count;
  const p = toProfile(env, 'Box3_ji');
  assert.equal(p.listedCount, null);
  assert.equal(p.mediaCount, 42, 'the others were disturbed');
});

await check('the locked flag and the pinned post come across', () => {
  const p = toProfile(profileEnvelope(), 'Box3_ji');
  assert.equal(p.protected, false);
  assert.equal(p.pinnedTweetId, '2102784376706867410');
});

await check('an unstated locked flag stays null rather than becoming false', () => {
  // "not recorded" and "open account" are different answers, and the reader
  // draws a lock from `true` — so a false here would be a claim the payload
  // never made.
  const env = profileEnvelope();
  delete env.includes.users[1].protected;
  assert.equal(toProfile(env, 'Box3_ji').protected, null);
});

await check('the accounts named in the bio are kept, without their offsets', () => {
  const p = toProfile(profileEnvelope(), 'Box3_ji');
  assert.deepEqual(p.bioMentions, [{ screenName: 'Box3_jilil', name: null }]);
});

await check('a bio that names nobody yields an empty list', () => {
  const env = profileEnvelope();
  delete env.includes.users[1].entities.description.mentions;
  assert.deepEqual(toProfile(env, 'Box3_ji').bioMentions, []);
  const env2 = profileEnvelope();
  env2.includes.users[1].entities.description.mentions = [{ username: '' }, null, 'x'];
  assert.deepEqual(toProfile(env2, 'Box3_ji').bioMentions, []);
});

await check('the blue check is read from verified_type, not from the other two flags', () => {
  // Checked against two real accounts: on the blue one `verified_type` reads
  // "blue" while `is_identity_verified` is false; on the other it reads "none".
  // `verified` alone would call an organisation account blue.
  const p = toProfile(profileEnvelope(), 'Box3_ji');
  assert.equal(p.blueVerified, true);

  const env = profileEnvelope();
  env.includes.users[1].verified_type = 'none';
  env.includes.users[1].verified = false;
  assert.equal(toProfile(env, 'Box3_ji').blueVerified, false);

  const org = profileEnvelope();
  org.includes.users[1].verified_type = 'business';
  org.includes.users[1].verified = true;
  const asOrg = toProfile(org, 'Box3_ji');
  assert.equal(asOrg.verified, true, 'the plain verified flag is still carried');
  assert.equal(asOrg.blueVerified, false, 'a business account was called blue');
});

await check('the card is the handle asked for, not the author of the post', () => {
  // A retweet puts the original author in the same array. Picking the wrong one
  // writes somebody else's face and bio onto this account.
  const env = envelopeFor('1101');
  env.includes.users = [
    { id: '888', username: 'retweeter', name: 'RT' },
    profileUser()
  ];
  assert.equal(toProfile(env, 'Box3_ji').userId, '2018248488773898240');
  assert.equal(toProfile(env, 'retweeter').userId, '888');
  // And the handle match is case-insensitive, because a stored handle's case is
  // whatever the user typed into the box.
  assert.equal(toProfile(env, 'box3_JI').userId, '2018248488773898240');
});

await check('a payload naming nobody we asked about yields no card, not an empty one', () => {
  const env = profileEnvelope();
  assert.equal(toProfile(env, 'nobodyhere'), null);
  assert.equal(toProfile(env, ''), null);
  assert.equal(toProfile(null, 'Box3_ji'), null);
  assert.equal(toProfile({}, 'Box3_ji'), null);
});

await check('a user object with no id cannot become a card', () => {
  // The id is the row's key everywhere else; without one this is not a person
  // this project can store.
  const env = profileEnvelope();
  delete env.includes.users[1].id;
  assert.equal(toProfile(env, 'Box3_ji'), null);
});

await check('a bio with no links in it yields an empty list', () => {
  const env = profileEnvelope();
  delete env.includes.users[1].entities.description.urls;
  assert.deepEqual(toProfile(env, 'Box3_ji').bioUrls, []);
});

await check('a link inside the bio is kept in the same shape as everywhere else', () => {
  const env = profileEnvelope();
  env.includes.users[1].entities.description.urls = [{
    url: 'https://t.co/AAAA', expanded_url: 'https://example.com/x',
    display_url: 'example.com/x'
  }];
  const p = toProfile(env, 'Box3_ji');
  assert.equal(p.bioUrls.length, 1);
  assert.deepEqual(p.bioUrls[0], {
    url: 'https://t.co/AAAA', expandedUrl: 'https://example.com/x', displayUrl: 'example.com/x'
  });
});

await check('a picture on some other host is dropped, not carried', () => {
  const env = profileEnvelope();
  env.includes.users[1].profile_image_url = 'https://example.com/tracker.gif';
  env.includes.users[1].profile_banner_url = 'https://example.com/tracker.gif';
  const p = toProfile(env, 'Box3_ji');
  assert.equal(p.avatarUrl, null);
  assert.equal(p.bannerUrl, null);
});

await check('the bio language is null, because the source does not carry it', () => {
  // The live capture reads `profile_description_language`; the archived v2 user
  // object has no such key — checked on three real ones. Guessing it from the
  // script the bio is written in would be a confident mistake.
  assert.equal(toProfile(profileEnvelope(), 'Box3_ji').lang, null);
});

await check('a retweet of a long post gets the same offset treatment', () => {
  const original = longEnvelope().data;
  original.id = '900';
  original.author_id = '9';
  const env = envelopeFor('901');
  env.data.referenced_tweets = [{ type: 'retweeted', id: '900' }];
  env.data.text = 'RT @fcjdfb: ' + NOTE_TEXT.slice(0, 130) + '…';
  env.includes.tweets = [original];
  const r = toRecord(env);
  assert.equal(r.isRetweet, true);
  assert.equal(r.text, NOTE_TEXT);
  assert.equal(r.entities.spans.length, 1, 'the original long post lost its link');
  assert.equal(r.text.slice(r.entities.spans[0].start, r.entities.spans[0].end), 'https://t.co/LINK');
});

/** X's own appended link: a t.co address that expands to a post's photo page. */
const ownPhoto = (tweetId, start, end) => ({
  url: 'https://t.co/SELF',
  expanded_url: 'https://x.com/fcjdfb/status/' + tweetId + '/photo/1',
  display_url: 'pic.x.com/SELF',
  start: start, end: end
});

await check('the photograph link X appends is not listed as a link the post makes', () => {
  const env = envelopeFor('1000');
  env.data.referenced_tweets = [{ type: 'retweeted', id: '900' }];
  env.data.text = 'RT @fcjdfb: a picture https://t.co/SELF';
  // Points at the RETWEETED post, which is one of the ids this record may call
  // its own — that is what makes it X's appended link rather than a link.
  env.includes.tweets = [{
    id: '900', author_id: '9', text: 'a picture https://t.co/SELF',
    entities: { urls: [ownPhoto('900', 10, 27)], hashtags: [], mentions: [] }
  }];
  const r = toRecord(env);
  // The body has it trimmed, so the list must not still name it — that would be
  // a record claiming a link its own text does not contain.
  assert.equal(r.text, 'a picture');
  assert.equal(r.entities.urls.length, 0);
  assert.equal(r.entities.spans.length, 0);
});

await check('a link to a post\'s own photo page is kept when the text still shows it', () => {
  // Same shape as the one above and pointing at THIS record's own id, so the
  // only thing that can save it is the body test. The trim only ever touches
  // the END of a text; dropping this one on where it points alone would lose a
  // link from a body that plainly still contains it.
  const env = envelopeFor('1000');
  env.data.text = 'look https://t.co/SELF at this';
  env.data.entities = { urls: [ownPhoto('1000', 5, 22)], hashtags: [], mentions: [] };
  const r = toRecord(env);
  assert.equal(r.text, 'look https://t.co/SELF at this');
  assert.equal(r.entities.urls.length, 1);
  assert.equal(r.entities.spans.length, 1);
  assert.equal(r.text.slice(r.entities.spans[0].start, r.entities.spans[0].end), 'https://t.co/SELF');
});

/* ========================================================================== */
/* 4. the pass engine                                                         */
/* ========================================================================== */

console.log('\n== wayback: one pass, and what happens when it is interrupted ==');

const SNAPSHOTS = [
  row('20260101000000', '1'),
  row('20260201000000', '2'),
  row('20260301000000', '3')
];

/** A record shaped enough for the engine; toRecord is exercised elsewhere. */
function envelopeFor(id) {
  return {
    data: {
      id: id, text: 'post ' + id, lang: 'en',
      created_at: '2026-01-01T00:00:00.000Z', author_id: '9',
      conversation_id: id, edit_history_tweet_ids: [id],
      public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0, bookmark_count: 0, impression_count: 1 },
      entities: { urls: [], hashtags: [], mentions: [] }
    },
    // The name carries the post id so a test can tell WHICH payload's profile
    // card came out — they differ per crawl in the real thing, which is the
    // whole reason the card is not simply taken from the first one.
    includes: { users: [{ id: '9', username: 'fcjdfb', name: 'cjy ' + id, profile_image_url: null }], media: [], tweets: [] }
  };
}

/**
 * A fake world. `fetchJson` answers from `envelopes`, `records` is the store.
 * Everything the engine is allowed to touch goes through here.
 */
function world(options) {
  const opts = options || {};
  const state = {
    job: Object.assign(goodJob(), opts.job || {}),
    rows: opts.rows || SNAPSHOTS,
    records: new Map(opts.records || []),
    fetches: [],
    saved: 0,
    bumps: [],
    blocked: opts.blocked === undefined ? null : opts.blocked,
    profiles: opts.profiles || [],
    profileCalls: 0,
    profileThrows: opts.profileThrows === undefined ? null : opts.profileThrows,
    writeThrows: opts.writeThrows || null,
    killOnSave: opts.killOnSave === undefined ? null : opts.killOnSave,
    killAfterFetches: opts.killAfterFetches === undefined ? null : opts.killAfterFetches,
    writeCount: 0,
    persisted: null
  };

  const deps = {
    blockedReason: async () => state.blocked,
    readRecord: async (id) => (state.records.has(id) ? state.records.get(id) : null),
    saveProfile: async (card) => {
      state.profileCalls++;
      if (state.profileThrows !== null) throw new Error(state.profileThrows);
      state.profiles.push(card);
    },
    fetchJson: async (url) => {
      state.fetches.push(url);
      if (state.killAfterFetches !== null && state.fetches.length === state.killAfterFetches) {
        const err = new Error('__killed__');
        err.killed = true;
        throw err;
      }
      if (opts.fetchFails === true) return { ok: false, error: 'HTTP 404' };
      const id = /status\/(\d+)/.exec(url);
      if (id === null) return { ok: false, error: 'no id' };
      return { ok: true, value: envelopeFor(id[1]) };
    },
    writeRecord: async (record) => {
      state.writeCount++;
      if (state.writeThrows !== null && state.writeThrows === state.writeCount) {
        throw new Error('write failed');
      }
      const existed = state.records.has(record.id);
      state.records.set(record.id, record);
      return { existed: existed };
    },
    /* The kill lands here, not in writeRecord: the engine deliberately catches
       a write that fails and carries on, because one unwritable post must not
       cost the batch. A worker being torn down is not a caught error — it just
       stops happening — and the nearest honest simulation is for the position
       write to never complete. */
    save: async () => {
      state.saved++;
      if (state.killOnSave !== null && state.saved === state.killOnSave) {
        const err = new Error('__killed__');
        err.killed = true;
        throw err;
      }
      state.persisted = JSON.parse(JSON.stringify(state.job));
    },
    bump: (bumps, error) => { state.bumps.push({ bumps: bumps, error: error || null }); },
    sleep: async () => {}
  };

  return { state: state, deps: deps };
}

async function run(w, over) {
  const job = w.state.job;
  try {
    const result = await runImportPass({ job: job, rows: w.state.rows, deps: w.deps });
    return result;
  } catch (err) {
    if (err && err.killed === true) return { killed: true };
    throw err;
  }
}

await check('a pass with nothing in the way fetches every row and stops at the end', async () => {
  const w = world({});
  const r = await run(w);
  assert.equal(r.reason, IMPORT_STOP.DONE);
  assert.equal(r.imported, 3);
  assert.equal(w.state.fetches.length, 3);
  assert.equal(w.state.records.size, 3);
});

await check('a pass stops at the batch size and leaves the cursor where it got to', async () => {
  const w = world({ job: { batch: 2 } });
  const r = await run(w);
  assert.equal(r.reason, IMPORT_STOP.BATCH);
  assert.equal(r.cursor, 2, 'the cursor must survive for the next pass');
  assert.equal(w.state.fetches.length, 2);
});

await check('a second pass continues rather than starting over', async () => {
  const w = world({ job: { batch: 2 } });
  await run(w);
  // A NEW PRESS. This is the caller's job, not the engine's: the count of
  // fetches is per press so that a resume after a worker death still finishes
  // the batch the user asked for rather than starting a fresh one.
  w.state.job.fetched = 0;
  const r = await run(w);
  assert.equal(r.reason, IMPORT_STOP.DONE);
  assert.equal(w.state.records.size, 3, 'the last row was never reached');
  assert.equal(w.state.fetches.length, 3, 'a row was fetched twice');
});

await check('and the batch is counted per press, not per process life', async () => {
  const w = world({ job: { batch: 2 } });
  await run(w);
  // Without the reset the counter is still full and the second press does
  // nothing at all — the failure this test exists to make impossible.
  const stuck = await run(w);
  assert.equal(stuck.reason, IMPORT_STOP.BATCH);
  assert.equal(stuck.fetched, 2);
  assert.equal(w.state.fetches.length, 2, 'the second pass fetched anyway');
});

await check('fill-the-gaps does not fetch a post the archive already has', async () => {
  const w = world({ job: { mode: 'gaps' }, records: [['2', { id: '2' }]] });
  const r = await run(w);
  assert.equal(r.skipped, 1);
  assert.equal(r.imported, 2);
  assert.equal(w.state.fetches.length, 2, 'a stored post still cost a request');
  assert.ok(w.state.fetches.every((u) => u.indexOf('/status/2') === -1), 'it fetched the one it already had');
});

await check('verify-all DOES fetch a stored post, so the archive can enrich it', async () => {
  const w = world({ job: { mode: 'verify' }, records: [['2', { id: '2' }]] });
  const r = await run(w);
  assert.equal(r.enriched, 1);
  assert.equal(r.imported, 2);
  assert.equal(w.state.fetches.length, 3);
});

await check('...and what it merges is the protected copy', async () => {
  const w = world({ job: { mode: 'verify' }, records: [['2', { id: '2' }]] });
  await run(w);
  const written = w.state.records.get('2');
  assert.equal(written.metrics, null, 'the archived zeroes would have replaced a real count');
  assert.equal(written.source, null, 'the row would have been relabelled');
});

console.log('\n== wayback: killed mid-item, and what the resume does ==');

await check('a write that throws does not cost the rest of the batch', async () => {
  const w = world({ writeThrows: 1 });
  const r = await run(w);
  assert.equal(r.failed, 1);
  assert.equal(r.imported, 2, 'one bad post took the others with it');
  assert.equal(r.reason, IMPORT_STOP.DONE);
});

await check('killed mid-item, the resume repeats that item and skips nothing', async () => {
  // The worker dies before the second item's position is written down. The
  // cursor on disk therefore still says "one item done", so the resume starts
  // from the second row again. That is the whole contract: repeat, never skip.
  const first = world({ killOnSave: 2 });
  const outcome = await run(first);           // run() reports the kill rather than rethrowing it
  assert.equal(outcome.killed, true, 'the kill did not happen');
  assert.equal(first.state.persisted.cursor, 1, 'the saved cursor should be one behind');
  assert.equal(first.state.records.size, 2, 'the second item WAS written before the kill');

  // Resume with what was on disk. In fill-the-gaps the repeated item costs
  // nothing: its record was written before the kill, so the resume finds it and
  // skips without a request. The duplicate is paid for only in verify-all,
  // which is not allowed to skip anything.
  const second = world({
    job: first.state.persisted,
    records: Array.from(first.state.records.entries())
  });
  const r = await run(second);
  assert.equal(r.reason, IMPORT_STOP.DONE);
  assert.equal(second.state.records.size, 3, 'a post was skipped across the restart');
  assert.equal(second.state.fetches.length, 1, 'only row 3 still needed fetching');
  assert.equal(r.skipped, 1, 'row 2 should have been recognised, not re-requested');
});

await check('a request that came back but was never written is repeated, not skipped', async () => {
  // The one place an eagerly-advanced cursor would LOSE a post. The request
  // for row 2 came back; the process died before the record was written. If the
  // cursor had moved when the request was issued rather than when the item was
  // finished, the resume would start at row 3 and row 2 would be gone with
  // nothing to show it was ever there.
  const first = world({ killAfterFetches: 2 });
  assert.equal((await run(first)).killed, true);

  assert.equal(first.state.records.size, 1, 'row 1 written, row 2 not');
  assert.equal(first.state.persisted.cursor, 1, 'the position must not have moved past it');
  assert.ok(!first.state.records.has('2'), 'row 2 was written after all — the test proves nothing');

  const second = world({
    job: first.state.persisted,
    records: Array.from(first.state.records.entries())
  });
  const r = await run(second);
  assert.equal(r.reason, IMPORT_STOP.DONE);
  assert.equal(second.state.records.size, 3, 'row 2 was lost across the restart');
  assert.equal(second.state.fetches.length, 2, 'rows 2 and 3 still had to be fetched');
});

await check('verify-all pays one duplicate request to repeat the interrupted item', async () => {
  const first = world({ killOnSave: 2, job: { mode: 'verify' } });
  assert.equal((await run(first)).killed, true);

  const second = world({
    job: first.state.persisted,
    records: Array.from(first.state.records.entries())
  });
  const r = await run(second);
  assert.equal(r.reason, IMPORT_STOP.DONE);
  assert.equal(second.state.fetches.length, 2, 'rows 2 and 3');
  assert.equal(second.state.records.size, 3);
});

await check('every row lands even when the kill lands on the very first item', async () => {
  const first = world({ killOnSave: 1 });
  assert.equal((await run(first)).killed, true);
  assert.equal(first.state.persisted, null, 'nothing should have been written down');

  const second = world({
    job: Object.assign(goodJob(), { cursor: 0 }),
    records: Array.from(first.state.records.entries())
  });
  await run(second);
  for (const id of ['1', '2', '3']) {
    assert.ok(second.state.records.has(id), 'post ' + id + ' never made it');
  }
});

await check('a dead archive stops the run instead of being hammered', async () => {
  const many = [];
  for (let i = 1; i <= 6; i++) many.push(row('2026010100000' + i, String(i)));
  const w = world({ fetchFails: true, rows: many });
  const r = await run(w);
  assert.equal(r.reason, IMPORT_STOP.ARCHIVE_DOWN);
  assert.equal(r.failed, 5, 'five in a row should stop it');
  assert.equal(w.state.fetches.length, 5, 'a dead archive must not be hammered for the whole list');
  assert.equal(w.state.job.pauseReason, 'archive-down');
  assert.equal(w.state.job.cursor, 5, 'the position is kept so it can continue later');
});

await check('the failures that stop it are CONSECUTIVE, not cumulative', async () => {
  // Two stored posts in the middle mean two successes, which reset the count.
  const w = world({ job: { mode: 'gaps' }, records: [['1', { id: '1' }], ['3', { id: '3' }]] });
  const r = await run(w);
  assert.equal(r.reason, IMPORT_STOP.DONE);
  assert.equal(r.failed, 0);
});

console.log('\n== wayback: stopping on purpose ==');

await check('a cancel before the first fetch fetches nothing', async () => {
  const w = world({ job: { cancelRequested: true } });
  const r = await run(w);
  assert.equal(r.reason, IMPORT_STOP.CANCELLED);
  assert.equal(w.state.fetches.length, 0);
});

await check('a cancel that arrives during a fetch drops what came back', async () => {
  // Simulated by flipping the flag from inside the fetch, which is exactly
  // where a real cancel lands.
  const w = world({});
  const original = w.deps.fetchJson;
  w.deps.fetchJson = async (url) => {
    const result = await original(url);
    w.state.job.cancelRequested = true;
    return result;
  };
  const r = await run(w);
  assert.equal(r.reason, IMPORT_STOP.CANCELLED);
  assert.equal(w.state.fetches.length, 1);
  assert.equal(w.state.records.size, 0, 'a record was written after the user asked it to stop');
});

await check('losing the permission pauses without spending a request, and keeps the position', async () => {
  const w = world({ blocked: 'permission' });
  const r = await run(w);
  assert.equal(r.reason, IMPORT_STOP.BLOCKED);
  assert.equal(w.state.fetches.length, 0);
  assert.equal(w.state.job.pauseReason, 'permission');
  assert.equal(w.state.job.cursor, 0, 'the position is kept so re-granting resumes');
});

await check('the switch being off says so, separately from the permission', async () => {
  const w = world({ blocked: 'off' });
  const r = await run(w);
  assert.equal(r.reason, IMPORT_STOP.BLOCKED);
  assert.equal(w.state.job.pauseReason, 'off');
});

console.log('\n== wayback: the counters ==');

await check('each outcome bumps its own counter and no other', async () => {
  const w = world({ job: { mode: 'verify' }, records: [['1', { id: '1' }]] });
  await run(w);
  const keys = w.state.bumps.map((b) => Object.keys(b.bumps)[0]);
  assert.deepEqual(keys, ['waybackEnriched', 'waybackImported', 'waybackImported']);
});

await check('the card that ends up stored is the one from the newest crawl', async () => {
  // Three posts, three crawls, three different cards. The rows are ordered
  // oldest post first, so "the first card" would be the account on the day it
  // started posting — measured on a real one, 0 followers and 1 post.
  const w = world({});
  await run(w);
  assert.ok(w.state.profiles.length > 0, 'no card was stored at all');
  const last = w.state.profiles[w.state.profiles.length - 1];
  assert.equal(last.name, 'cjy 3', 'the newest crawl did not win');
  assert.equal(w.state.profileCalls, w.state.profiles.length);
});

await check('an older crawl never overwrites a newer one', async () => {
  // Deliberately out of order: oldest, NEWEST, then one in between. Written as
  // "newest first" this test passed against code that simply took the first
  // card it ever saw, because there the two rules agree — so the ordering is
  // the part that makes it a test.
  const w = world({ rows: [SNAPSHOTS[0], SNAPSHOTS[2], SNAPSHOTS[1]] });
  await run(w);
  assert.equal(w.state.profileCalls, 2, 'the older crawl that came last still wrote');
  assert.equal(w.state.profiles[1].name, 'cjy 3', 'the newest crawl did not end up as the card');
  assert.equal(w.state.profiles[1].name, w.state.profiles[w.state.profiles.length - 1].name);
});

await check('a card the source cannot supply costs nothing', async () => {
  // Every archived post carries its author, so this is the odd payload rather
  // than the normal one — but a run over posts that name nobody we asked about
  // must still import the posts.
  const w = world({ job: { handle: 'someone_else' } });
  await run(w);
  assert.equal(w.state.profileCalls, 0);
  assert.equal(w.state.records.size, SNAPSHOTS.length, 'the posts did not land');
});

await check('a card that cannot be stored is not retried on every post and does not cost one', async () => {
  const w = world({ profileThrows: 'the archived profile failed validation' });
  await run(w);
  assert.equal(w.state.profileCalls, 1, 'a rejected card was attempted once per post');
  assert.equal(w.state.profiles.length, 0);
  assert.equal(w.state.records.size, SNAPSHOTS.length, 'the posts were lost with it');
});

await check('a skip is counted as a skip', async () => {
  const w = world({ job: { mode: 'gaps' }, records: [['1', { id: '1' }]] });
  await run(w);
  assert.ok(w.state.bumps.some((b) => b.bumps.waybackSkipped === 1));
});

await check('a failure carries a reason with it', async () => {
  const w = world({ fetchFails: true });
  await run(w);
  const failed = w.state.bumps.filter((b) => b.bumps.waybackFailed === 1);
  assert.equal(failed.length, SNAPSHOTS.length, 'one failed bump per item that failed');
  assert.ok(failed[0].error, 'no error text was recorded');
});

await check('the position is written down after every item', async () => {
  const w = world({});
  await run(w);
  assert.equal(w.state.saved, 3, 'a worker killed between items would lose the position');
});

/* ========================================================================== */
/* 5. fetching                                                                */
/* ========================================================================== */

console.log('\n== wayback: the request itself ==');

const noWait = async () => {};

function responder(handler) {
  return async (url, init) => handler(url, init);
}

await check('a good response is parsed', async () => {
  const r = await getJson('u', {
    wait: noWait,
    fetch: responder(async () => ({ ok: true, status: 200, text: async () => '{"a":1}' }))
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.a, 1);
});

await check('the archive being offline is a failure, not a success', async () => {
  // Measured: with the Archive offline it answers 200 with an HTML page saying
  // so. `response.ok` is true; JSON.parse is what fails.
  let calls = 0;
  const r = await getJson('u', {
    wait: noWait,
    fetch: responder(async () => { calls++; return { ok: true, status: 200, text: async () => '<html>Internet Archive: Temporarily Offline</html>' }; })
  });
  assert.equal(r.ok, false);
  assert.equal(calls, 3, 'a parse failure should be retried like any other failure');
});

await check('a 404 is tried once, not three times', async () => {
  let calls = 0;
  const r = await getJson('u', {
    wait: noWait,
    fetch: responder(async () => { calls++; return { ok: false, status: 404, text: async () => '' }; })
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'HTTP 404');
  assert.equal(calls, 1, 'a 404 will still be a 404 in two seconds');
});

await check('a 503 is retried and can succeed', async () => {
  let calls = 0;
  const r = await getJson('u', {
    wait: noWait,
    fetch: responder(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503, text: async () => '' };
      return { ok: true, status: 200, text: async () => '{"a":2}' };
    })
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.a, 2);
  assert.equal(calls, 2);
});

await check('a request that throws every time gives up rather than looping', async () => {
  let calls = 0;
  const r = await getJson('u', {
    wait: noWait,
    fetch: responder(async () => { calls++; throw new Error('network down'); })
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'network down');
  assert.equal(calls, 3);
});

await check('a request that never answers is abandoned', async () => {
  let aborted = false;
  const r = await getJson('u', {
    wait: noWait,
    attempts: 1,
    timeoutMs: 20,
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    })
  });
  assert.equal(r.ok, false);
  assert.equal(aborted, true, 'the deadline never fired');
  assert.ok(FETCH_TIMEOUT_MS >= 10000, 'the real deadline should be generous');
});

/* ========================================================================== */

console.log('\n== wayback: small pieces ==');

await check('a handle is what X allows and nothing else', () => {
  assert.equal(isHandle('fcjdfb'), true);
  assert.equal(isHandle('a_b_123'), true);
  assert.equal(isHandle('a'.repeat(15)), true);
  assert.equal(isHandle('a'.repeat(16)), false);
  assert.equal(isHandle('has space'), false);
  assert.equal(isHandle('has-dash'), false);
  assert.equal(isHandle('@at'), false);
  assert.equal(isHandle(''), false);
  assert.equal(isHandle(null), false);
});

await check('the unit conversion is a no-op when there is nothing astral', () => {
  assert.equal(toJsOffset('abc', 2), 2);
  assert.equal(toJsOffset('', 5), 0);
  assert.equal(toJsOffset('abc', 0), 0);
});

await check('an emoji counts as one to X and two to a string', () => {
  const text = '😭'.repeat(3) + 'abc';
  assert.equal(text.length, 9);
  assert.equal(Array.from(text).length, 6);
  assert.equal(toJsOffset(text, 3), 6, 'three emoji in, six units in');
  assert.equal(toJsOffset(text, 6), 9);
});

/* ========================================================================== */

console.log('\n=========================================');
console.log('passed: ' + passed + '   failed: ' + failures.length);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
