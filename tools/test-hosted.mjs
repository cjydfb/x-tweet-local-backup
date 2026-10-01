/* The hosted layout — the bytes that go into a GitHub repository.
 *
 * What is worth asserting here and what is not: the layout is not interesting
 * for being correct-looking, it is interesting for being the thing a reader
 * slices by. Every size in index.json is an address. A number that is one byte
 * short truncates a file with no error anywhere, and the only place that shows
 * up is a reader that mysteriously cannot find the last few records.
 *
 *   node tools/test-hosted.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

const H = await import(pathToFileURL(path.join(REPO, 'hosted.js')).href);

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const r = await fn();
    if (r === false) throw new Error('assertion returned false');
    passed++;
  } catch (err) {
    failures.push({ name, message: err && err.message ? err.message : String(err) });
    console.log('  FAIL  ' + name + '\n        ' + (err && err.message ? err.message : err));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '\n        got      ' + sa + '\n        expected ' + sb);
}

/* --------------------------------------------------------------- fixtures -- */

/* A blob stand-in: hosted.js only ever reads `.size` off one and hands it back,
   so a real Blob would be a browser dependency in a node test for nothing. */
function fakeBlob(bytes) {
  return { size: bytes };
}

function mediaRow(tweetId, mediaId, cachedAt, bytes) {
  return {
    tweetId: tweetId,
    mediaId: mediaId,
    blob: fakeBlob(bytes),
    bytes: bytes,
    type: 'photo',
    contentType: 'image/jpeg',
    cachedAt: cachedAt,
    date: new Date(cachedAt)
  };
}

/** The smallest input buildHostedLayout accepts, with anything overridable. */
function makeInput(over) {
  const o = over || {};
  return Object.assign({
    shards: [{ text: '{"count":1}\n', count: 1 }],
    mediaRows: [],
    deletions: [],
    connections: null,
    profile: { userId: '1', screenName: 'a' },
    listing: false,
    meta: {
      generatedAt: '2026-10-02T00:00:00.000Z',
      generatorVersion: '3.2.0',
      schemaVersion: 5,
      timezone: { name: 'UTC', offsetMinutes: 0 },
      totalCount: 1,
      account: { userId: '1', screenName: 'a', name: 'A' }
    }
  }, o);
}

/* ------------------------------------------------------------- the point -- */

console.log('== hosted.js ==');

await check('two builds of one input produce byte-identical index.json', () => {
  // The whole reason this module exists. A folder export and an upload that
  // disagree by one byte re-upload everything and orphan the old tree.
  const input = makeInput({ mediaRows: [mediaRow('2', '9', '2019-07-04T00:00:00.000Z', 10)] });
  const a = H.buildHostedLayout(input);
  const b = H.buildHostedLayout(input);
  assertEqual(a.indexText, b.indexText);
  assertEqual(a.files.map((f) => f.path), b.files.map((f) => f.path));
});

await check('the order the database hands rows over in does not change the layout', () => {
  const rows = [
    mediaRow('2', 'b', '2020-01-02T00:00:00.000Z', 5),
    mediaRow('1', 'a', '2019-06-30T00:00:00.000Z', 7),
    mediaRow('3', 'c', '2020-01-02T00:00:00.000Z', 9)
  ];
  const forward = H.buildHostedLayout(makeInput({ mediaRows: rows }));
  const reversed = H.buildHostedLayout(makeInput({ mediaRows: rows.slice().reverse() }));
  assertEqual(forward.indexText, reversed.indexText);
});

/* ---------------------------------------------------------------- sizes -- */

await check('every byte count is the real byte count, not a character count', () => {
  // A record full of Chinese is three bytes per character. Sizing by .length
  // would understate a 100 MB archive by two thirds and every range the reader
  // computes afterwards would land in the wrong place.
  const text = '{"note":"中文中文中文"}\n';
  const built = H.buildHostedLayout(makeInput({ shards: [{ text: text, count: 1 }] }));
  const entry = built.index.files.tweets[0];
  assertEqual(entry.bytes, Buffer.byteLength(text, 'utf8'), 'shard size');
  assert(entry.bytes > text.length, 'the fixture must actually be multi-byte, or this proves nothing');

  const indexFile = built.files[0];
  assertEqual(indexFile.path, 'index.json');
  assertEqual(Buffer.byteLength(indexFile.text, 'utf8'), Buffer.byteLength(built.indexText, 'utf8'));
});

await check('a media row\'s size comes from the blob when it has to', () => {
  const row = mediaRow('1', 'a', '2020-01-01T00:00:00.000Z', 0);
  delete row.bytes;
  const built = H.buildHostedLayout(makeInput({ mediaRows: [row] }));
  const file = built.files.find((f) => f.path.indexOf('media/') === 0);
  assert(file, 'the media file was not written');
  const mediaIndex = built.index.files.mediaIndexInline;
  assertEqual(mediaIndex[0].bytes, 0);
});

/* ---------------------------------------------------------------- paths -- */

await check('media lands under media/YYYY/MM/, in UTC', () => {
  const built = H.buildHostedLayout(makeInput({
    mediaRows: [mediaRow('100', '200', '2019-07-04T12:00:00.000Z', 3)]
  }));
  const paths = built.files.map((f) => f.path).filter((p) => p.indexOf('media/') === 0);
  assertEqual(paths, ['media/2019/07/100_200.jpg']);
});

await check('a media id with an underscore survives the round trip', () => {
  // X's own identifier for a media item can be `<a>_<b>`. The file name joins
  // tweetId and mediaId with an underscore too, which is why the reader never
  // parses the name back apart — it uses the index. This asserts the index is
  // what carries the answer.
  const built = H.buildHostedLayout(makeInput({
    mediaRows: [mediaRow('100', '200_300', '2020-01-01T00:00:00.000Z', 3)]
  }));
  const file = built.files.find((f) => f.path.indexOf('media/') === 0);
  assertEqual(file.path, 'media/2020/01/100_200_300.jpg');
  assertEqual(built.index.files.mediaIndexInline[0].mediaId, '200_300');
  assertEqual(H.hostedMediaKey('100', '200_300'), '100 200_300');
});

await check('an unparseable date does not silently become 1970', () => {
  const built = H.buildHostedLayout(makeInput({
    mediaRows: [mediaRow('1', 'a', 'not a date', 3)]
  }));
  const file = built.files.find((f) => f.path.indexOf('media/') === 0);
  assertEqual(file.path, 'media/unknown/1_a.jpg');
});

await check('a month holding more than the directory budget spills into 07-2', () => {
  const rows = [];
  const n = H.HOSTED_MEDIA_PER_DIR + 3;
  for (let i = 0; i < n; i++) {
    rows.push(mediaRow(String(1000 + i), 'm' + i, '2021-03-01T00:00:00.000Z', 1));
  }
  const built = H.buildHostedLayout(makeInput({ mediaRows: rows }));
  const dirs = {};
  for (const f of built.files) {
    if (f.path.indexOf('media/') !== 0) continue;
    const dir = f.path.split('/').slice(0, 3).join('/');
    dirs[dir] = (dirs[dir] || 0) + 1;
  }
  assertEqual(dirs, { 'media/2021/03': H.HOSTED_MEDIA_PER_DIR, 'media/2021/03-2': 3 });
});

await check('two rows claiming one path keep the first and say so', () => {
  // The media store is keyed on `<tweetId>:<mediaId>` and that key is unique, so
  // the same row cannot arrive twice. What CAN collide is two different ids
  // that sanitise to the same file name — `a.b` and `a b` both become `ab`. The
  // reader would then fetch one file and find the index naming it twice under
  // two different keys, which is worse than either file being missing.
  const a = mediaRow('1', 'a.b', '2020-01-01T00:00:00.000Z', 1);
  const b = mediaRow('1', 'a b', '2020-01-01T00:00:00.000Z', 2);
  const built = H.buildHostedLayout(makeInput({ mediaRows: [a, b] }));
  const paths = built.files.filter((f) => f.path.indexOf('media/') === 0);
  assertEqual(paths.length, 1);
  assertEqual(paths[0].path, 'media/2020/01/1_ab.jpg');
  assertEqual(built.problems.length, 1);
  assertEqual(built.problems[0].kind, 'media-path-collision');
});

await check('the same media in two different months is two paths, and that is fine', () => {
  // Not the collision case: two rows that differ only in date get two paths, so
  // nothing is lost. Asserted so that the guard above cannot be "fixed" later
  // into something that silently drops one of them.
  const a = mediaRow('1', 'x', '2020-01-01T00:00:00.000Z', 1);
  const b = mediaRow('1', 'x', '2020-02-01T00:00:00.000Z', 2);
  const built = H.buildHostedLayout(makeInput({ mediaRows: [a, b] }));
  const paths = built.files.filter((f) => f.path.indexOf('media/') === 0).map((f) => f.path);
  assertEqual(paths, ['media/2020/01/1_x.jpg', 'media/2020/02/1_x.jpg']);
  assertEqual(built.problems.length, 0);
});

await check('a media row with no usable id is reported, not written', () => {
  const bad = mediaRow('', 'x', '2020-01-01T00:00:00.000Z', 1);
  const built = H.buildHostedLayout(makeInput({ mediaRows: [bad] }));
  assertEqual(built.files.filter((f) => f.path.indexOf('media/') === 0).length, 0);
  assertEqual(built.problems.length, 1);
});

/* ----------------------------------------------------------- the roster -- */

await check('the roster goes in its own file and never into the envelope', () => {
  // A roster is tens of megabytes. Inlined it would be most of a single file's
  // GitHub budget, and the reader would have to range-read a huge tail to get
  // it — which is exactly what the envelope's own layout was arranged to avoid.
  const built = H.buildHostedLayout(makeInput({
    connections: [{ userId: '9', screenName: 'z' }]
  }));
  assertEqual(built.index.files.connections.path, 'connections.json');
  assertEqual(built.index.files.connections.count, 1);
  const file = built.files.find((f) => f.path === 'connections.json');
  assert(file, 'connections.json was not written');
  assert(built.indexText.indexOf('"screenName": "z"') === -1, 'the roster leaked into index.json');
});

await check('no roster means no connections.json and no dangling pointer', () => {
  const built = H.buildHostedLayout(makeInput({ connections: [] }));
  assertEqual(built.index.files.connections, undefined);
  assertEqual(built.files.filter((f) => f.path === 'connections.json').length, 0);
});

/* --------------------------------------------------------- media index -- */

await check('a big media list moves out of index.json into its own file', () => {
  const rows = [];
  const n = H.HOSTED_MEDIA_INDEX_INLINE_MAX + 1;
  for (let i = 0; i < n; i++) rows.push(mediaRow('1', 'm' + i, '2020-01-01T00:00:00.000Z', 4));
  const built = H.buildHostedLayout(makeInput({ mediaRows: rows }));
  assertEqual(built.index.files.mediaIndex.path, 'media-index.json');
  assertEqual(built.index.files.mediaIndexInline, undefined, 'the inline copy is still there');
  assertEqual(built.index.files.mediaIndex.count, n);
  assertEqual(built.index.files.mediaIndex.bytesTotal, n * 4);
  assert(built.indexText.length < 4096, 'index.json grew with the media list');
});

await check('a small media list stays inline so a plain archive is two requests', () => {
  const built = H.buildHostedLayout(makeInput({
    mediaRows: [mediaRow('1', 'a', '2020-01-01T00:00:00.000Z', 4)]
  }));
  assertEqual(built.index.files.mediaIndex, undefined);
  assertEqual(built.index.files.mediaIndexInline.length, 1);
});

/* ------------------------------------------------------------ ordering -- */

await check('index.json is first in the list, because it is written last', () => {
  // A reader that opens an archive while its index names files that have not
  // arrived yet finds half an archive. Files without an index are merely not
  // published yet, which is the failure that costs nothing.
  const built = H.buildHostedLayout(makeInput({
    mediaRows: [mediaRow('1', 'a', '2020-01-01T00:00:00.000Z', 4)],
    connections: [{ userId: '9' }]
  }));
  assertEqual(built.files[0].path, 'index.json');
  assert(built.files.length >= 4);
});

await check('every file the index names is in the file list, and vice versa', () => {
  const built = H.buildHostedLayout(makeInput({
    mediaRows: [mediaRow('1', 'a', '2020-01-01T00:00:00.000Z', 4)],
    connections: [{ userId: '9' }]
  }));
  const listed = built.files.map((f) => f.path).sort();
  const named = ['index.json']
    .concat(built.index.files.tweets.map((t) => t.path))
    .concat(built.index.files.connections ? [built.index.files.connections.path] : [])
    .concat(built.index.files.mediaIndex ? [built.index.files.mediaIndex.path] : [])
    .concat(built.index.files.mediaIndexInline.map((m) => m.path))
    .sort();
  assertEqual(listed, named);
});

/* ------------------------------------------------------------- shards -- */

await check('shards are numbered, and the first one is just tweets.json', () => {
  const built = H.buildHostedLayout(makeInput({
    shards: [{ text: '{"count":1}\n', count: 1 }, { text: '{"count":2}\n', count: 2 }]
  }));
  assertEqual(built.index.files.tweets.map((t) => t.path), ['tweets.json', 'tweets.1.json']);
  assertEqual(built.index.files.tweets.map((t) => t.count), [1, 2]);
});

await check('an envelope over the per-file cap throws rather than being written', () => {
  // GitHub rejects the file outright. Writing it anyway means the upload fails
  // after every media blob has already been pushed.
  const huge = 'x'.repeat(H.HOSTED_MAX_FILE_BYTES + 1);
  let threw = null;
  try {
    H.buildHostedLayout(makeInput({ shards: [{ text: huge, count: 1 }] }));
  } catch (err) { threw = err; }
  assert(threw, 'no error was thrown');
  assert(String(threw.message).indexOf('per-file limit') !== -1, 'the message does not say why');
});

/* ---------------------------------------------------------- validation -- */

await check('a well-formed index passes', () => {
  const built = H.buildHostedLayout(makeInput());
  assertEqual(H.validateHostedIndex(built.index), { ok: true, reason: null });
});

await check('anything that is not this format is refused', () => {
  assertEqual(H.validateHostedIndex(null).ok, false);
  assertEqual(H.validateHostedIndex([]).ok, false);
  assertEqual(H.validateHostedIndex({}).ok, false);
  assertEqual(H.validateHostedIndex({ format: 'something-else' }).ok, false);
});

await check('an index from a newer reader is refused with a sentence', () => {
  const built = H.buildHostedLayout(makeInput());
  const future = JSON.parse(JSON.stringify(built.index));
  future.formatVersion = H.HOSTED_FORMAT_VERSION + 1;
  const v = H.validateHostedIndex(future);
  assertEqual(v.ok, false);
  assert(v.reason.indexOf('更新的格式') !== -1, 'the reason does not explain itself: ' + v.reason);
});

await check('a path that climbs out of the archive is refused', () => {
  // The reader is handed a URL by somebody else, fetches a JSON file that
  // somebody else wrote, and then fetches everything that file names. These
  // are the rules that have to hold before the first of those requests.
  for (const bad of ['../secret', 'a/../../b', '/etc/passwd', 'https://evil.example.com/x',
                     'a b.json', 'a\\b.json', '', 'a//b']) {
    assertEqual(H.isSafeHostedPath(bad), false, 'this must not be fetchable: ' + bad);
  }
  for (const good of ['index.json', 'media/2019/07/1_2.jpg', 'media/unknown/1_a.png', 'tweets.1.json']) {
    assertEqual(H.isSafeHostedPath(good), true, 'this should be fine: ' + good);
  }
});

await check('a hostile size is refused before anything is fetched', () => {
  const built = H.buildHostedLayout(makeInput());
  for (const bad of [-1, 1.5, '100', null, H.HOSTED_MAX_FILE_BYTES + 1]) {
    const copy = JSON.parse(JSON.stringify(built.index));
    copy.files.tweets[0].bytes = bad;
    assertEqual(H.validateHostedIndex(copy).ok, false, 'this size must be refused: ' + String(bad));
  }
});

await check('an index with no envelope to read is refused', () => {
  const built = H.buildHostedLayout(makeInput());
  const copy = JSON.parse(JSON.stringify(built.index));
  copy.files.tweets = [];
  assertEqual(H.validateHostedIndex(copy).ok, false);
});

/* ------------------------------------------------- the reader can read -- */

/**
 * The reader's own scanner, sliced out of reader/reader.html exactly as
 * tools/test-reader.mjs slices it.
 *
 * The point of the hosted layout is that the reader opens it, so "the reader
 * can open it" is the assertion that matters — and it has to be the REAL
 * scanner, not a re-implementation, or this test would pass while the reader
 * failed. readSource() is never called: the layout is handed to the scanner the
 * way the reader hands it over, one byte range at a time.
 */
const READER = path.join(REPO, 'reader', 'reader.html');
const readerHtml = fs.existsSync(READER) ? fs.readFileSync(READER, 'utf8') : '';
if (readerHtml.length === 0) throw new Error('reader/reader.html is missing — run node reader/src/assemble.mjs');

const coreBegin = readerHtml.indexOf('CORE BEGIN');
const coreEnd = readerHtml.lastIndexOf('/*', readerHtml.indexOf('CORE END'));
const CORE = new Function(
  readerHtml.slice(readerHtml.indexOf('*/', coreBegin) + 2, coreEnd) +
  '\nreturn { findTweetsArray, createArrayScanner, scanChunk, readRecordAt };'
)();

function scanWhole(bytes) {
  const at = CORE.findTweetsArray(bytes, 0, bytes.length);
  assert(at >= 0, 'the reader could not find the tweets array at all');
  const st = CORE.createArrayScanner(at);
  const STEP = 4096;   // deliberately smaller than the file, to cross chunk seams
  for (let off = at; off < bytes.length && !st.closed; off += STEP) {
    CORE.scanChunk(st, bytes.subarray(off, Math.min(off + STEP, bytes.length)), off);
  }
  return st;
}

/** An envelope with the same shape the extension writes. */
function envelopeOf(records) {
  const body = records.map((r, i) => (i === 0 ? '\n    ' : ',\n    ') + JSON.stringify(r)).join('');
  return '{\n  "schemaVersion": 5,\n  "generator": "x-tweet-backup",\n' +
    '  "tweets": [' + body + '\n  ],\n  "count": ' + records.length + ',\n' +
    '  "deletions": []\n}\n';
}

await check('the reader\'s own scanner reads every record out of a hosted tweets.json', async () => {
  const records = [];
  for (let i = 0; i < 40; i++) {
    records.push({
      id: String(1800000000000000000 + i),
      createdAt: '2026-01-0' + ((i % 9) + 1) + 'T00:00:00.000Z',
      text: '中文正文 ' + i + ' 😇 with a "quote" and a \\ backslash',
      author: { id: '1', screenName: 'a', name: 'A' },
      media: []
    });
  }
  const text = envelopeOf(records);
  const built = H.buildHostedLayout(makeInput({ shards: [{ text: text, count: records.length }] }));
  const file = built.files.find((f) => f.path === 'tweets.json');

  const st = scanWhole(new TextEncoder().encode(file.text));
  assertEqual(st.elements.length, records.length, 'the scanner found a different number of records');
  assert(st.closed, 'the scanner never saw the array close');

  // And every range actually parses back to the record that was written,
  // through the reader's own readRecordAt. A scanner that found the right
  // NUMBER of elements while pointing them at the wrong bytes would pass
  // everything above.
  const blob = new Blob([file.text]);
  for (let i = 0; i < st.elements.length; i++) {
    const got = await CORE.readRecordAt(blob, st.elements[i]);
    assert(got.ok, 'record ' + i + ' did not parse: ' + got.error);
    assertEqual(got.value.id, records[i].id, 'record ' + i + ' came back as somebody else');
    assertEqual(got.value.text, records[i].text, 'record ' + i + ' came back with different text');
  }
});

await check('the byte count in index.json is the file, to the byte', () => {
  // index.json's numbers are ADDRESSES. The reader slices by them, so a count
  // one byte short is a file it never finishes receiving — and it finds out by
  // reporting fewer records, saying nothing about the byte.
  const text = envelopeOf([{ id: '1', text: '中文', author: { id: '1' } }]);
  const built = H.buildHostedLayout(makeInput({ shards: [{ text: text, count: 1 }] }));
  const entry = built.index.files.tweets[0];
  assertEqual(entry.bytes, new TextEncoder().encode(text).length);
  assertEqual(entry.bytes, Buffer.byteLength(text, 'utf8'));
});

await check('a file cut short loses its last record, which is what makes the count matter', () => {
  // The other half of the assertion above, said as behaviour rather than as
  // arithmetic: hand the reader five bytes less than the file and the last
  // record does not come back. If this ever passed, the sizes in index.json
  // would be decoration.
  const records = [{ id: '1', text: 'first', author: { id: '1' } }, { id: '2', text: 'second', author: { id: '1' } }];
  const text = envelopeOf(records);
  const whole = new TextEncoder().encode(text);

  const full = scanWhole(whole);
  assertEqual(full.elements.length, records.length);

  const st = scanWhole(whole.subarray(0, full.elements[1].end - 5));
  assertEqual(st.elements.length, 1, 'the truncated file still produced two records');
  assertEqual(st.closed, false, 'the truncated file claimed its array was closed');
});

/* --------------------------------------------------------- golden file -- */

await check('the index SHAPE is pinned by a golden file', () => {
  // Not the values — the shape. A field added or renamed here changes what a
  // reader years from now can rely on, and it should cost a deliberate edit to
  // this fixture rather than passing unnoticed.
  const goldenPath = path.join(HERE, 'fixtures', 'hosted-index.golden.json');
  const built = H.buildHostedLayout(makeInput({
    shards: [{ text: '{"count":1}\n', count: 1 }],
    mediaRows: [mediaRow('100', '200', '2019-07-04T12:00:00.000Z', 1234)],
    connections: [{ userId: '9', screenName: 'z' }],
    profile: { userId: '100', screenName: 'tester', name: 'T' },
    meta: {
      generatedAt: '2026-10-02T00:00:00.000Z',
      generatorVersion: '3.2.0',
      schemaVersion: 5,
      timezone: { name: 'UTC', offsetMinutes: 0 },
      totalCount: 1,
      account: { userId: '100', screenName: 'tester', name: 'T' }
    }
  }));
  const shape = JSON.stringify(shapeOf(built.index), null, 2) + '\n';
  if (!fs.existsSync(goldenPath)) {
    fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
    fs.writeFileSync(goldenPath, shape, 'utf8');
    console.log('        (wrote a new golden file: ' + goldenPath + ')');
    return true;
  }
  assertEqual(shape, fs.readFileSync(goldenPath, 'utf8'),
    'the shape of index.json changed — if that was deliberate, delete the golden file and re-run');
});

/** Every field path in an object, with its type, and nothing else. */
function shapeOf(value, prefix) {
  const at = prefix || '';
  if (Array.isArray(value)) return value.length === 0 ? [at + '[]'] : [at + '[]', shapeOf(value[0], at + '[]')];
  if (value !== null && typeof value === 'object') {
    const out = [];
    for (const key of Object.keys(value).sort()) out.push(shapeOf(value[key], at + '.' + key));
    return out.flat();
  }
  return [at + ':' + (value === null ? 'null' : typeof value)];
}

/* --------------------------------------------------------------- report -- */

console.log('\n=========================================');
console.log('passed: ' + passed + '   failed: ' + failures.length);
if (failures.length > 0) {
  for (const f of failures) console.log('  FAILED: ' + f.name + ' — ' + f.message);
  process.exit(1);
}
