/* ============================================================================
 * test-reader.mjs — prove the reader's scanner does not lose records.
 *
 * The reader is one HTML file with no build step, so the tested part is
 * delimited by the CORE BEGIN / CORE END markers and pulled out here. That keeps
 * the deliverable a single double-clickable file while still letting the only
 * part that can silently lose data be covered by real assertions.
 *
 * The load-bearing test is `chunk boundaries do not change the result`: the
 * scanner runs over a stream, so a record split across two reads is the most
 * likely way to lose or corrupt one. It is checked by rescanning the same bytes
 * at every chunk size from 1 byte upward and requiring byte-identical output.
 *
 *   node tools/test-reader.mjs
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const READER = path.join(REPO, 'reader', 'reader.html');

/* ------------------------------------------------------------------ load -- */

const html = fs.readFileSync(READER, 'utf8');

/* The markers sit inside block comments, so the code is what lies between the
   comment that opens the block and the comment that closes it — not the text
   from the marker words themselves. */
const beginMarker = html.indexOf('CORE BEGIN');
const endMarker = html.indexOf('CORE END');
if (beginMarker < 0 || endMarker < 0 || endMarker < beginMarker) {
  console.error('could not find the CORE BEGIN / CORE END markers in reader/reader.html');
  process.exit(1);
}
const coreStart = html.indexOf('*/', beginMarker) + 2;
const coreEnd = html.lastIndexOf('/*', endMarker);
const core = html.slice(coreStart, coreEnd);
if (core.indexOf('findTweetsArray') < 0) {
  console.error('the CORE block came out empty — the markers probably moved');
  process.exit(1);
}

const M = new Function(core + `
  return { findTweetsArray, createArrayScanner, scanChunk, readRecordAt, crc32, utf8Length, safeExternalUrl, BYTE };
`)();

const { findTweetsArray } = M;

/* The other half of the reader — the arithmetic behind the variable-height
   scroller, the media join and the date jump. It sits BELOW the core block, in
   its own markers, so the slice above is unaffected by how large it grows. */
const pureBegin = html.indexOf('PURE BEGIN');
const pureEnd = html.indexOf('PURE END');
if (pureBegin < 0 || pureEnd < 0 || pureEnd < pureBegin) {
  console.error('could not find the PURE BEGIN / PURE END markers in reader/reader.html');
  process.exit(1);
}
const pure = html.slice(html.indexOf('*/', pureBegin) + 2, html.lastIndexOf('/*', pureEnd));

const P = new Function(pure + `
  return { estimateHeight, createHeightTable, buildHeightsFor, safeNamePart,
           mediaKeyFromEntryName, mediaKeyFor, dayStartMs, fmtCount, gridShape,
           resolveSpans, HT_BLOCK,
           readJsonValueEnd, readEnvelopeProfile, intersectAscending,
           envelopeHasList, remoteMediaUrl, sizedAvatarUrl, AVATAR_TIERS,
           safeDataImageUrl, REMOTE_MEDIA_HOSTS,
           sharedProfile, accountKey, profileForHandle,
           isAbsent, isPlainObject, mergeField, mergeCapture };
`)();

/* The merge rule is the one thing in the reader that exists TWICE — once here
   and once in db.js, because the reader is a single file with no imports and
   the extension is a module that cannot reach into it. Two copies of one rule
   drift, so the suite below feeds the same corpus to both and requires the same
   answer from each. Imported lazily and guarded: a reader must not fail to be
   tested because the extension's half moved. */
let dbMerge = null;
try {
  const db = await import(pathToFileURL(path.join(REPO, 'db.js')).href);
  dbMerge = { mergeCapture: db.mergeCapture, mergeField: db.mergeField, isAbsent: db.isAbsent };
} catch (err) {
  console.error('could not import db.js for the merge parity test: ' + err.message);
}

/* --------------------------------------------------------------- harness -- */

let passed = 0;
const failures = [];
const inFlight = [];

/**
 * Run one assertion.
 *
 * A check that returns a promise is awaited rather than counted immediately —
 * otherwise an async test would be marked passed the moment it started, and
 * every `readRecordAt` assertion below would be a no-op that always succeeds.
 */
function record(name, err) {
  if (err) {
    failures.push({ name, message: err && err.message ? err.message : String(err) });
    console.log('  FAIL  ' + name + '\n        ' + (err && err.message ? err.message : err));
  } else {
    passed++;
  }
}

function check(name, fn) {
  let r;
  try {
    r = fn();
  } catch (err) {
    record(name, err);
    return;
  }
  if (r && typeof r.then === 'function') {
    inFlight.push(r.then(() => record(name, null), (err) => record(name, err)));
    return;
  }
  record(name, r === false ? new Error('assertion returned false') : null);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '\n        got      ' + sa + '\n        expected ' + sb);
}

const enc = new TextEncoder();
const toBytes = (s) => enc.encode(s);

/** Run the scanner over a whole buffer with a given chunk size. */
function scanAll(bytes, chunkSize) {
  let arrayStart = M.findTweetsArray(bytes, 0, bytes.length);
  assert(arrayStart >= 0, 'findTweetsArray returned -1');
  const st = M.createArrayScanner(arrayStart);
  const size = chunkSize || bytes.length;
  for (let off = arrayStart; off < bytes.length && !st.closed; off += size) {
    const end = Math.min(off + size, bytes.length);
    M.scanChunk(st, bytes.subarray(off, end), off);
  }
  return st;
}

/* ----------------------------------------------------------- findTweets --- */

console.log('== findTweetsArray ==');

const SIMPLE = '{"a":1,"tweets":[{"id":"1"}],"count":1}';

check('finds the tweets array and returns the offset just past [', () => {
  const at = M.findTweetsArray(toBytes(SIMPLE), 0, toBytes(SIMPLE).length);
  assertEqual(SIMPLE.slice(at, at + 4), '{"id', 'wrong offset');
});

check('survives whitespace and newlines around the colon', () => {
  const s = '{\n  "tweets"  :\n  [1]\n}';
  const at = M.findTweetsArray(toBytes(s), 0, toBytes(s).length);
  assert(at > 0 && s[at] === '1', 'did not land on the array contents');
});

check('skips an escaped "tweets" that appears before the real key', () => {
  // The decoy comes FIRST, so a naive byte search would stop there and hand
  // back an offset inside a tweet's text. Inside a JSON string the quotes are
  // escaped, so the raw sequence `"tweets"` cannot occur there — this is the
  // property the search relies on, so it is worth pinning down.
  const s = '{"note":"he said \\"tweets\\": [9,9]","tweets":[{"id":"a"}],"count":1}';
  const bytes = toBytes(s);

  // Assert on what the scan actually produces, not on a hand-counted slice
  // length: the decoy's `[9,9]` would show up as two elements if the search
  // landed inside the string.
  const st = scanAll(bytes);
  assertEqual(st.elements.length, 1, 'scanned the decoy array instead of the real one');
  assertEqual(
    new TextDecoder().decode(bytes.subarray(st.elements[0].start, st.elements[0].end)),
    '{"id":"a"}'
  );
});

check('returns -1 when there is no tweets array', () => {
  const s = '{"count":0}';
  assertEqual(M.findTweetsArray(toBytes(s), 0, toBytes(s).length), -1);
});

/* -------------------------------------------------------------- scanning -- */

console.log('\n== array scanning ==');

const OBJECTS = [
  { id: '1', text: 'plain' },
  { id: '2', text: 'braces { } and [ ] inside a string' },
  { id: '3', text: 'escaped quote \\" and backslash \\\\ then } } }' },
  { id: '4', text: '中文与 emoji 😇 和 surrogate 代理对' },
  { id: '5', text: 'null-ish: \\u007d is a brace written as an escape' },
  { id: '6', media: [{ a: { b: [{ c: 1 }] } }], text: 'deep nesting' },
  { id: '7', text: '' }
];

function envelope(records, countOverride) {
  return JSON.stringify({
    schemaVersion: 3,
    generator: 'x-tweet-backup',
    generatorVersion: '2.1.0',
    exportedAt: '2026-09-23T00:00:00.000Z',
    timezone: { name: 'Asia/Shanghai', offsetMinutes: 480, note: 'x' },
    tweets: records,
    count: countOverride === undefined ? records.length : countOverride,
    deletions: []
  });
}

/* The roster section 1.4.0 appends after `deletions`. It is last for a reason
   the scanner depends on: the tweet array is found by searching the raw bytes
   for the literal "tweets" key, so a section placed BEFORE it that grew large
   enough would push the key out of the probe window and the archive would stop
   opening. These two cases hold that arrangement still. */
function envelopeWithRoster(records, rosterRows) {
  return JSON.stringify({
    schemaVersion: 3,
    generator: 'x-tweet-backup',
    generatorVersion: '2.1.0',
    exportedAt: '2026-09-23T00:00:00.000Z',
    timezone: { name: 'Asia/Shanghai', offsetMinutes: 480, note: 'x' },
    tweets: records,
    count: records.length,
    deletions: [],
    connections: rosterRows
  });
}

function rosterRow(i) {
  return {
    list: 'following',
    userId: '2090325165590876' + String(100 + i),
    screenName: 'person_' + i,
    screenNameLower: 'person_' + i,
    name: 'Person ' + i,
    // A bio is free text and is where a stray `"tweets"` would come from if it
    // were going to come from anywhere.
    bio: 'a bio mentioning tweets and connections and "quotes"',
    bioUrls: [],
    firstSeenAt: '2026-09-20T10:00:00.000Z',
    lastSeenAt: '2026-09-21T10:00:00.000Z',
    ownerIds: ['2032037309219315712']
  };
}

check('finds exactly one range per record', () => {
  const st = scanAll(toBytes(envelope(OBJECTS)));
  assertEqual(st.elements.length, OBJECTS.length);
  assert(st.closed, 'array never closed');
});

check('a roster section after the tweets array leaves the scan alone', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(rosterRow(i));
  const bytes = toBytes(envelopeWithRoster(OBJECTS, rows));
  const st = scanAll(bytes);
  assertEqual(st.elements.length, OBJECTS.length);
  assert(st.closed, 'array never closed');
  const first = JSON.parse(new TextDecoder().decode(
    bytes.subarray(st.elements[0].start, st.elements[0].end)));
  assertEqual(first.id, '1');
});

check('the byte scan finds the tweets KEY, not the word in somebody\'s bio', () => {
  // Every roster row's bio contains the words "tweets" and "connections". If the
  // scan matched a bare word rather than the quoted key followed by an array,
  // the roster would be read as the tweet list and the archive would open empty.
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(rosterRow(i));
  const bytes = toBytes(envelopeWithRoster(OBJECTS, rows));
  const start = findTweetsArray(bytes, 0, bytes.length);
  assert(start >= 0, 'no array found at all');
  const after = new TextDecoder().decode(bytes.subarray(start, start + 64)).trimStart();
  assertEqual(after.charAt(0), '{');
});

check('every range parses back to the original object', () => {
  const bytes = toBytes(envelope(OBJECTS));
  const st = scanAll(bytes);
  for (let i = 0; i < OBJECTS.length; i++) {
    const slice = bytes.subarray(st.elements[i].start, st.elements[i].end);
    const got = JSON.parse(new TextDecoder().decode(slice));
    assertEqual(got, OBJECTS[i], 'record ' + i + ' did not round-trip');
  }
});

check('chunk boundaries do not change the result (1..64 bytes, and whole)', () => {
  const bytes = toBytes(envelope(OBJECTS));
  const reference = scanAll(bytes, bytes.length).elements;
  for (const size of [1, 2, 3, 5, 7, 13, 64, 1024]) {
    const got = scanAll(bytes, size).elements;
    assertEqual(got, reference, 'chunk size ' + size + ' produced different ranges');
  }
});

check('a record split across a chunk is still bounded correctly', () => {
  // Size 1 forces every possible split point, including mid-escape.
  const bytes = toBytes(envelope(OBJECTS));
  const one = scanAll(bytes, 1);
  const whole = scanAll(bytes, bytes.length);
  assertEqual(one.elements, whole.elements);
  assertEqual(one.closed, true, 'closed flag lost at size 1');
});

check('an empty tweets array yields zero elements and closes', () => {
  const st = scanAll(toBytes(envelope([])));
  assertEqual(st.elements.length, 0);
  assert(st.closed, 'empty array not marked closed');
});

check('a non-object element is captured rather than dropped', () => {
  const s = '{"tweets":[1,{"id":"a"},null],"count":3}';
  const bytes = toBytes(s);
  const st = scanAll(bytes);
  assertEqual(st.elements.length, 3, 'primitive elements were dropped');
  for (let i = 0; i < 3; i++) {
    const t = new TextDecoder().decode(bytes.subarray(st.elements[i].start, st.elements[i].end));
    assert(t.length > 0, 'element ' + i + ' has an empty range');
  }
});

check('a truncated file is reported, not silently accepted', () => {
  const full = envelope(OBJECTS);
  const cut = toBytes(full.slice(0, full.length - 40));
  const st = scanAll(cut);
  assertEqual(st.closed, false, 'a truncated array was reported as closed');
  assert(st.elements.length < OBJECTS.length, 'expected fewer complete records after truncation');
});

check('an unclosed string still terminates the scan instead of hanging', () => {
  const s = '{"tweets":[{"text":"never closed';
  const st = scanAll(toBytes(s));
  assertEqual(st.closed, false);
  assertEqual(st.elements.length, 0);
});

check('a bracket imbalance is reported rather than silently accepted', () => {
  // `[}]` is malformed: the } arrives while the array is still open. The scan
  // must stop and say so — treating it as a clean close would mean handing back
  // an index that quietly disagrees with the file.
  const s = '{"tweets":[}]}';
  const st = scanAll(toBytes(s));
  assertEqual(st.closed, false, 'a malformed array must not be reported as cleanly closed');
  assert(st.problems.length > 0, 'the imbalance was not reported at all');
  assertEqual(st.problems[0].kind, 'depth-underflow');
});

/* ------------------------------------------------------- reading records -- */

console.log('\n== readRecordAt ==');

check('reads one record out of a Blob by byte range', async () => {
  const bytes = toBytes(envelope(OBJECTS));
  const st = scanAll(bytes);
  const blob = new Blob([bytes]);
  // Async assertions run through the promise below; this check only sets it up.
  return (async () => {
    const res = await M.readRecordAt(blob, st.elements[3]);
    assert(res.ok, 'read failed: ' + res.error);
    assertEqual(res.value, OBJECTS[3]);
  })();
});

check('a bad range reports an error instead of throwing', async () => {
  const blob = new Blob([toBytes('not json at all')]);
  const res = await M.readRecordAt(blob, { start: 0, end: 16 });
  assertEqual(res.ok, false);
  assert(typeof res.error === 'string' && res.error.length > 0, 'no error message');
});

/* ------------------------------------------------------------- primitives -- */

console.log('\n== primitives ==');

check('utf8Length matches the real encoded length', () => {
  for (const ch of ['a', 'é', '中', '😇']) {
    assertEqual(M.utf8Length(toBytes(ch)[0]), toBytes(ch).length, 'utf8Length(' + ch + ')');
  }
});

check('crc32 matches the well-known value for "123456789"', () => {
  // The standard CRC32 check vector.
  assertEqual(M.crc32(toBytes('123456789')), 0xCBF43926);
});

check('crc32 of empty input is 0', () => {
  assertEqual(M.crc32(new Uint8Array(0)), 0);
});

/* ------------------------------------------------------------ link safety -- */

console.log('\n== safeExternalUrl ==');

check('http and https pass through', () => {
  assertEqual(M.safeExternalUrl('https://x.com/alice/status/1'), 'https://x.com/alice/status/1');
  assertEqual(M.safeExternalUrl('http://example.com/a'), 'http://example.com/a');
});

check('javascript: and data: never become a link', () => {
  // Escaping alone would not stop these: neither needs an HTML metacharacter.
  assertEqual(M.safeExternalUrl('javascript:alert(1)'), null);
  assertEqual(M.safeExternalUrl('data:text/html,<script>alert(1)</script>'), null);
  assertEqual(M.safeExternalUrl('vbscript:msgbox(1)'), null);
  assertEqual(M.safeExternalUrl('file:///C:/x.html'), null);
});

check('junk and missing values are refused rather than thrown on', () => {
  assertEqual(M.safeExternalUrl(undefined), null);
  assertEqual(M.safeExternalUrl(null), null);
  assertEqual(M.safeExternalUrl('not a url'), null);
  assertEqual(M.safeExternalUrl(''), null);
});

/* ------------------------------------------------------- height table --- */

console.log('\n== height table ==');

/** A height table built from a fixed list of heights, for exact comparisons. */
function tableOf(list) {
  const t = P.createHeightTable(list.length, (i) => list[i]);
  return t;
}

check('offsetOf is the running sum of the heights before i', () => {
  const list = [10, 20, 30, 40, 50];
  const t = tableOf(list);
  const expect = [0, 10, 30, 60, 100, 150];
  for (let i = 0; i <= list.length; i++) {
    assertEqual(t.offsetOf(i), expect[i], 'offsetOf(' + i + ')');
  }
});

check('offsetOf and indexAt are inverses at every row', () => {
  // This is the property the whole scroller rests on: the position it puts a
  // row at must be the position that scrolls back to that row. If it ever
  // fails, rows land under the wrong scroll offset and the timeline shows the
  // wrong posts — which is exactly the bug this table replaced a division with.
  const list = [];
  for (let i = 0; i < 1000; i++) list.push(20 + ((i * 37) % 300));
  const t = tableOf(list);
  for (let i = 0; i < list.length; i++) {
    const y = t.offsetOf(i);
    assertEqual(t.indexAt(y), i, 'round trip at row ' + i + ' (y=' + y + ')');
    assertEqual(t.indexAt(y + list[i] - 1), i, 'last pixel of row ' + i);
  }
});

check('block boundaries do not shift the sums', () => {
  // The table has two levels: per-row heights and a sum per 256-row block. An
  // off-by-one at a block edge is invisible in a small test and wrong at scale,
  // so it is checked on both sides of every boundary.
  const n = P.HT_BLOCK * 3 + 5;
  const list = [];
  for (let i = 0; i < n; i++) list.push(10 + (i % 7));
  const t = tableOf(list);
  let running = 0;
  for (let i = 0; i < n; i++) {
    assertEqual(t.offsetOf(i), running, 'offsetOf at ' + i);
    running += list[i];
  }
  assertEqual(t.total, running, 'total');
});

check('set moves the total by exactly the difference', () => {
  const t = tableOf([10, 20, 30]);
  const before = t.total;
  t.set(1, 50);
  assertEqual(t.total, before + 30);
  assertEqual(t.get(1), 50);
  t.set(1, 50);                    /* same value: no change at all */
  assertEqual(t.total, before + 30);
});

check('set ignores a non-positive height', () => {
  const t = tableOf([10, 20, 30]);
  const before = t.total;
  t.set(1, 0);
  t.set(1, -5);
  assertEqual(t.total, before, 'a zero or negative height was let through');
  assertEqual(t.get(1), 20);
});

check('an empty table is not a special case to the callers', () => {
  const t = P.createHeightTable(0, () => 0);
  assertEqual(t.total, 0);
  assertEqual(t.indexAt(0), 0);
  assertEqual(t.offsetOf(0), 0);
});

/* ------------------------------------------------ the list, not the file --- */

console.log('\n== height table is sized from the list ==');

/** Ranges shaped like the archive's: a byte length per record. */
function fakeRanges(count, sizeAt) {
  const out = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const size = sizeAt(i);
    out.push({ start: at, end: at + size });
    at += size + 1;
  }
  return out;
}

check('a filtered list gets a table for the list, not for the archive', () => {
  // The reported bug, exactly: 20 000 records, a search returning 592 of them,
  // and the table came back with 20 592 rows. The scroll area grew to 4 274 710
  // pixels, and every position past 592 asked for a record that did not exist —
  // the cards below the fold all read "这一条读不出来：Cannot read properties
  // of undefined (reading 'start')".
  const ranges = fakeRanges(20000, (i) => 400 + (i % 900));
  const ids = [];
  for (let i = 0; i < 592; i++) ids.push(i * 33);

  const t = P.buildHeightsFor(ranges, ids);
  assertEqual(t.n, 592, 'the table must have one row per DISPLAYED entry');

  let expected = 0;
  for (const idx of ids) expected += P.estimateHeight(ranges[idx].end - ranges[idx].start);
  assertEqual(t.total, expected, 'the total must be the sum over those 592 records');

  // and the rows are the right ones — not the first 592 of the archive
  assertEqual(t.get(10), P.estimateHeight(ranges[ids[10]].end - ranges[ids[10]].start),
    'row 10 must be sized from record ' + ids[10]);
});

check('a null list is the whole archive in its own order', () => {
  const ranges = fakeRanges(500, () => 700);
  const t = P.buildHeightsFor(ranges, null);
  assertEqual(t.n, 500);
  assertEqual(t.get(7), P.estimateHeight(700));
  assertEqual(P.buildHeightsFor(ranges, null).indexAt(t.offsetOf(400)), 400);
});

check('a filtered table stays consistent with its own lookup', () => {
  // indexAt(offsetOf(i)) === i has to hold for the filtered table too, or the
  // scroller lands on the wrong row for a given scroll position.
  const ranges = fakeRanges(3000, (i) => 300 + ((i * 137) % 1400));
  const ids = [];
  for (let i = 0; i < 3000; i += 7) ids.push(i);
  const t = P.buildHeightsFor(ranges, ids);
  assertEqual(t.n, ids.length);
  for (let i = 0; i < ids.length; i++) {
    assertEqual(t.indexAt(t.offsetOf(i)), i, 'round trip at position ' + i);
  }
});

check('an empty result set is a usable, empty list', () => {
  const ranges = fakeRanges(100, () => 500);
  const t = P.buildHeightsFor(ranges, []);
  assertEqual(t.n, 0);
  assertEqual(t.total, 0);
  assertEqual(t.indexAt(0), 0);
});

/* -------------------------------------------------------- height model --- */

console.log('\n== estimates ==');

check('estimateHeight is monotone and bounded', () => {
  let last = 0;
  for (let bytes = 1; bytes < 400000; bytes = Math.ceil(bytes * 1.7)) {
    const h = P.estimateHeight(bytes);
    assert(h >= last, 'estimate went down as the record grew, at ' + bytes);
    assert(h > 0 && h <= 2400, 'estimate out of range at ' + bytes);
    last = h;
  }
});

check('a missing or nonsense size still produces a usable height', () => {
  for (const v of [0, -1, undefined, null, NaN]) {
    const h = P.estimateHeight(v);
    assert(h > 0 && isFinite(h), 'estimateHeight(' + v + ') = ' + h);
  }
});

/* ----------------------------------------------------------- media join -- */

console.log('\n== media join ==');

check('the entry name splits at the FIRST underscore', () => {
  // The media id falls back to X's media_key, which looks like `3_1234567890`.
  // Splitting at the last underscore would read part of the media key as part
  // of the tweet id, and the join would find nothing — silently, as a blank
  // frame where a photo should be.
  assertEqual(P.mediaKeyFromEntryName('media/2102514377404694577_3_1800000000000000001.jpg'),
    '2102514377404694577 3_1800000000000000001');
});

check('an entry name without a usable id is refused, not guessed', () => {
  for (const name of ['media/_x.jpg', 'media/12_.jpg', 'media/12.jpg', 'media/abc_12.jpg',
                      'other/12_34.jpg', 'media/', '', null, undefined, 'media/12_34']) {
    const got = P.mediaKeyFromEntryName(name);
    if (got !== null && !/^\d+ \S+$/.test(got)) {
      throw new Error('accepted a bad name ' + JSON.stringify(name) + ' as ' + JSON.stringify(got));
    }
  }
  assertEqual(P.mediaKeyFromEntryName('media/12.jpg'), null, 'no underscore at all');
  assertEqual(P.mediaKeyFromEntryName('other/12_34.jpg'), null, 'not under media/');
});

check('a name with no extension still yields a key', () => {
  assertEqual(P.mediaKeyFromEntryName('media/12_34'), '12 34');
});

check('the record side of the join is sanitized the same way the file name was', () => {
  // A media id that is not purely [A-Za-z0-9_-] is stored verbatim in the record
  // but had its other characters dropped when the file was named. Keying the
  // lookup on the raw id would miss every such file.
  assertEqual(P.safeNamePart('abc.def/ghi'), 'abcdefghi');
  assertEqual(P.mediaKeyFor('12', '3_99'), '12 3_99');
  assertEqual(P.mediaKeyFor('12', 'a.b'), '12 ab');
  assertEqual(P.mediaKeyFor('12', '...'), null, 'a media id with nothing usable must not key');
  assertEqual(P.mediaKeyFor('12', null), null);
  assertEqual(P.mediaKeyFor('12', undefined), null);
});

check('the two sides of the join agree on a real name', () => {
  const name = 'media/1900000000000000000_1800000000000000001.png';
  const fromName = P.mediaKeyFromEntryName(name);
  const fromRecord = P.mediaKeyFor('1900000000000000000', '1800000000000000001');
  assertEqual(fromName, fromRecord);
});

/* -------------------------------------------------------------- dates --- */

console.log('\n== dates and counts ==');

check('dayStartMs converts a day in a fixed offset to a UTC instant', () => {
  // Midnight on 1 June in UTC+08:00 is 16:00 on 31 May in UTC.
  assertEqual(P.dayStartMs('2026-06-01', 480), Date.UTC(2026, 4, 31, 16, 0, 0));
  assertEqual(P.dayStartMs('2026-06-01', 0), Date.UTC(2026, 5, 1, 0, 0, 0));
  assertEqual(P.dayStartMs('2026-06-01', -300), Date.UTC(2026, 5, 1, 5, 0, 0));
});

check('dayStartMs accepts a partial date and refuses junk', () => {
  assertEqual(P.dayStartMs('2026', 0), Date.UTC(2026, 0, 1));
  assertEqual(P.dayStartMs('2026-06', 0), Date.UTC(2026, 5, 1));
  assertEqual(P.dayStartMs('nonsense', 0), null);
  assertEqual(P.dayStartMs('', 0), null);
});

check('consecutive days are exactly 86 400 000 ms apart in a fixed offset', () => {
  // The reader bisects on the END of the chosen day, which is only the right
  // boundary because a fixed offset has no daylight saving. This pins that down.
  const a = P.dayStartMs('2026-03-08', 480);
  const b = P.dayStartMs('2026-03-09', 480);
  assertEqual(b - a, 86400000);
  const c = P.dayStartMs('2026-11-01', -300);
  const d = P.dayStartMs('2026-11-02', -300);
  assertEqual(d - c, 86400000);
});

check('fmtCount matches what the counts row shows', () => {
  assertEqual(P.fmtCount(0), '0');
  assertEqual(P.fmtCount(999), '999');
  assertEqual(P.fmtCount(1000), '1.0K');
  assertEqual(P.fmtCount(1234), '1.2K');
  assertEqual(P.fmtCount(9999), '10.0K');
  assertEqual(P.fmtCount(12345), '12K');
  assertEqual(P.fmtCount(1000000), '1.0M');
  assertEqual(P.fmtCount(3400000), '3.4M');
  assertEqual(P.fmtCount(undefined), '');
  assertEqual(P.fmtCount(-1), '');
});

check('the grid shape caps at four', () => {
  assertEqual([1, 2, 3, 4, 5, 20].map(P.gridShape), [1, 2, 3, 4, 4, 4]);
});

/* ------------------------------------------------------------- spans --- */

console.log('\n== entity spans ==');

check('overlapping spans resolve to the longest, in order', () => {
  // X's entities genuinely overlap: a t.co link whose display text contains a
  // hashtag is the common case. Nesting anchors produces broken markup, so the
  // longer span wins and the shorter is dropped.
  const got = P.resolveSpans([
    { start: 0, end: 5, kind: 'tag' },
    { start: 0, end: 12, kind: 'url' },
    { start: 20, end: 25, kind: 'who' }
  ]);
  assertEqual(got.length, 2);
  assertEqual(got[0].kind, 'url');
  assertEqual(got[0].end, 12);
  assertEqual(got[1].kind, 'who');
});

check('touching spans are not overlaps', () => {
  const got = P.resolveSpans([
    { start: 0, end: 4, kind: 'url' },
    { start: 4, end: 9, kind: 'tag' }
  ]);
  assertEqual(got.length, 2, 'spans that merely touch must both survive');
});

check('empty and inverted spans are dropped rather than rendered', () => {
  const got = P.resolveSpans([
    { start: 5, end: 5, kind: 'tag' },
    { start: 9, end: 3, kind: 'url' },
    { start: -2, end: 4, kind: 'who' },
    null,
    { start: 1, end: 3, kind: 'tag' }
  ]);
  assertEqual(got.length, 1);
  assertEqual(got[0].start, 1);
});

/* -------------------------------------------------- json value walking --- */

console.log('\n== readJsonValueEnd ==');

check('finds the matching brace of a nested object', () => {
  const s = '{"a":{"b":{"c":1}},"d":2}';
  assertEqual(P.readJsonValueEnd(s, 0), s.length);
  assertEqual(s.slice(5, P.readJsonValueEnd(s, 5)), '{"b":{"c":1}}');
});

check('walks an array of objects, including a nested one', () => {
  const s = '[{"a":1},{"b":[2,3]}]';
  assertEqual(P.readJsonValueEnd(s, 0), s.length);
  const t = 'x[1,[2,[3]]]y';
  assertEqual(P.readJsonValueEnd(t, 1), t.length - 1);
  assertEqual(t.slice(1, P.readJsonValueEnd(t, 1)), '[1,[2,[3]]]');
});

check('a [ -rooted value stops at its own ]', () => {
  const s = 'k:[1,2]]';
  assertEqual(P.readJsonValueEnd(s, 2), 7);
  assertEqual(s.slice(2, 7), '[1,2]');
});

check('string contents are skipped, however they are written', () => {
  // A bio is free text. `{`, `}`, `"` and `\` in it are the normal case, not
  // the exotic one, and a walk that counted them would end the value inside
  // somebody's profile text.
  const inner = 'a bio with { } and {"a":1} and \\" and \\\\ and ] and }';
  const s = '{"bio":' + JSON.stringify(inner) + ',"n":1}';
  assertEqual(P.readJsonValueEnd(s, 0), s.length);
  assertEqual(JSON.parse(s.slice(0, P.readJsonValueEnd(s, 0))).bio, inner);
});

check('an escaped quote does not close the string', () => {
  // `"a\":b"` is one string; a walk that treated the \" as a terminator would
  // then read the real string's closing quote as an opener and never balance.
  const s = '{"a":"x\\":y","b":1}';
  assertEqual(P.readJsonValueEnd(s, 0), s.length);
});

check('an unterminated value is -1, not a guess', () => {
  assertEqual(P.readJsonValueEnd('{"a":1', 0), -1);
  assertEqual(P.readJsonValueEnd('[1,2', 0), -1);
  assertEqual(P.readJsonValueEnd('{"a":"never closed', 0), -1);
  assertEqual(P.readJsonValueEnd('{"a":"ends with a backslash \\', 0), -1);
});

check('a value that does not start with a bracket is refused', () => {
  assertEqual(P.readJsonValueEnd('"a string"', 0), -1);
  assertEqual(P.readJsonValueEnd('123', 0), -1);
  assertEqual(P.readJsonValueEnd('null', 0), -1);
  assertEqual(P.readJsonValueEnd('{"a":1}', 1), -1, 'an index inside the object is not its start');
});

check('a mismatched bracket is refused rather than sliced', () => {
  assertEqual(P.readJsonValueEnd('{"a":1]', 0), -1);
  assertEqual(P.readJsonValueEnd('[1,2}', 0), -1);
  assertEqual(P.readJsonValueEnd('}', 0), -1);
});

check('out-of-range and non-string input is -1 rather than a throw', () => {
  for (const v of [-1, 99, NaN, null, undefined, '']) {
    assertEqual(P.readJsonValueEnd('{"a":1}', v), -1, 'index ' + JSON.stringify(v));
  }
  assertEqual(P.readJsonValueEnd(null, 0), -1);
  assertEqual(P.readJsonValueEnd({}, 0), -1);
});

/* ------------------------------------------------- the profile in a file --- */

console.log('\n== the profile in an envelope ==');

/** A profile with every awkward character in it: the bio is the field the
    extension caps at 2000 characters and the one that holds free text. */
function profileFixture() {
  return {
    userId: '2032037309219315712',
    screenName: 'fcjdfb',
    screenNameLower: 'fcjdfb',
    name: 'cjy',
    accountCreatedAt: '2026-03-12T10:13:51.000Z',
    bio: '中文简介 {"a":1} 反斜杠 \\ 引号 " 括号 } ] 和 emoji 😇 结尾',
    bioUrls: [
      { url: 'https://t.co/aaaa', expandedUrl: 'https://example.com/a?b=1&c=2', displayUrl: 'example.com' },
      { url: 'https://t.co/bbbb', expandedUrl: 'https://例子.测试/路径', displayUrl: '例子.测试' }
    ],
    location: '上海',
    websiteUrl: 'https://example.com/~me',
    lang: 'zh',
    blueVerified: true,
    verified: false,
    followersCount: 86,
    followingCount: 64,
    tweetCount: 1280,
    avatarUrl: 'https://pbs.twimg.com/profile_images/1/x.jpg',
    bannerUrl: 'https://pbs.twimg.com/profile_banners/1/x.jpg',
    firstSeenAt: '2026-09-20T10:00:00.000Z',
    lastSeenAt: '2026-09-21T10:00:00.000Z',
    source: { operationName: 'UserByScreenName', capturedVia: 'xhr' },
    schemaVersion: 4
  };
}

/* The profile sits after the tweets and after `count`, which is where the
   extension writes the envelope's scalar section — and it is why the reader
   probes forward from the end of the array. */
function envelopeWithProfile(records, profile) {
  return JSON.stringify({
    schemaVersion: 4,
    generator: 'x-tweet-backup',
    generatorVersion: '2.2.0',
    exportedAt: '2026-09-23T00:00:00.000Z',
    timezone: { name: 'Asia/Shanghai', offsetMinutes: 480, note: 'x' },
    tweets: records,
    count: records.length,
    profile: profile,
    deletions: []
  });
}

check('the profile survives the envelope round trip', () => {
  // The load-bearing one. A profile is the only object in the envelope whose
  // fields are free text, so it is the only one where cutting the value out by
  // brace counting can go wrong — and the failure would be a header that is
  // silently missing or, worse, half-right.
  const env = envelopeWithProfile(OBJECTS, profileFixture());
  const at = env.indexOf('"profile"');
  assert(at > 0, 'the fixture envelope has no profile key');

  const m = env.slice(at).match(/^"profile"\s*:\s*\{/);
  assert(m, 'the key is not followed by an object');
  const open = at + m[0].length - 1;
  const end = P.readJsonValueEnd(env, open);
  assert(end > 0, 'readJsonValueEnd lost the value');

  assertEqual(env.charAt(end - 1), '}', 'the slice must end on the closing brace');
  assertEqual(JSON.parse(env.slice(open, end)), profileFixture(), 'the cut-out slice is not the profile');
  assertEqual(P.readEnvelopeProfile(env), profileFixture(), 'readEnvelopeProfile disagrees');
});

check('the same envelope still scans as a clean tweets array', () => {
  // The profile is a large object full of braces sitting after the records; the
  // byte scanner must not care about it at all.
  const bytes = toBytes(envelopeWithProfile(OBJECTS, profileFixture()));
  const st = scanAll(bytes);
  assertEqual(st.elements.length, OBJECTS.length);
  assertEqual(st.closed, true, 'the array did not close');
  for (let i = 0; i < OBJECTS.length; i++) {
    const got = JSON.parse(new TextDecoder().decode(
      bytes.subarray(st.elements[i].start, st.elements[i].end)));
    assertEqual(got, OBJECTS[i], 'record ' + i + ' did not round-trip');
  }
});

check('a chunk boundary anywhere in the profile changes nothing', () => {
  const bytes = toBytes(envelopeWithProfile(OBJECTS, profileFixture()));
  const reference = scanAll(bytes, bytes.length).elements;
  const tail = new TextDecoder().decode(bytes.subarray(reference[reference.length - 1].end));
  assert(P.readEnvelopeProfile(tail) !== null, 'the profile is not in the tail after the array');
  for (const size of [1, 3, 17, 64]) {
    assertEqual(scanAll(bytes, size).elements, reference, 'chunk size ' + size);
  }
});

check('a post that talks about "profile" cannot be mistaken for the key', () => {
  // The same property findTweetsArray relies on: inside a JSON string the
  // quotes are escaped, so the raw sequence `"profile"` can only occur at a
  // real key. The decoy comes FIRST here, so the first match is what is read.
  const decoy = { id: '1', text: 'my "profile": {"fake": 1} is in this post' };
  const real = profileFixture();
  const env = JSON.stringify({
    tweets: [decoy], count: 1, profile: real
  });
  assert(env.indexOf('"profile"') < env.indexOf(JSON.stringify(real)), 'the decoy is not first');
  assertEqual(P.readEnvelopeProfile(env), real);
});

check('a file with no profile yields null, not an error', () => {
  assertEqual(P.readEnvelopeProfile(envelope(OBJECTS)), null);
  assertEqual(P.readEnvelopeProfile('{"profile":null,"count":1}'), null);
  assertEqual(P.readEnvelopeProfile('{"count":1}'), null);
  assertEqual(P.readEnvelopeProfile(''), null);
  assertEqual(P.readEnvelopeProfile(null), null);
});

check('a profile cut in half is refused, a complete one in a cut file is not', () => {
  // The profile is a self-contained object, so a file truncated AFTER it still
  // has a usable header — worth showing. A file truncated INSIDE it does not,
  // and a half-parsed profile would be worse than none.
  assertEqual(P.readEnvelopeProfile('{"profile":{"name":"a"}'), { name: 'a' });
  assertEqual(P.readEnvelopeProfile('{"profile":{"name":"a'), null);
  assertEqual(P.readEnvelopeProfile('{"profile":{"name":'), null);

  const env = envelopeWithProfile(OBJECTS, profileFixture());
  const cutInside = env.slice(0, env.indexOf('"profile"') + 40);
  assertEqual(P.readEnvelopeProfile(cutInside), null, 'a cut-off profile must not parse');

  assertEqual(P.readEnvelopeProfile('{"profile":["not","an","object"]}'), null);
  assertEqual(P.readEnvelopeProfile('{"profile":"a string"}'), null);
  assertEqual(P.readEnvelopeProfile('{"profile":42}'), null);
});

/* ------------------------------------------- which account is open --- */

console.log('\n== the header above several open archives ==');

const acct = (userId, screenName) => ({ userId: userId, screenName: screenName });

check('one archive gets its own card, unchanged', () => {
  const only = acct('1', 'me');
  assertEqual(P.sharedProfile([only]), only);
});

check('two exports of the SAME account still get that account\'s card', () => {
  // The case this exists for. Opening a second export of the same account used
  // to blank the header, and that is the ordinary way these are read — an
  // earlier export and a later one are two files.
  const a = acct('1', 'me');
  const b = acct('1', 'me');
  assertEqual(P.sharedProfile([a, b]), a);
  // And the handle's case is whatever the export happened to carry.
  assertEqual(P.sharedProfile([acct('1', 'Me'), acct('1', 'me')]).userId, '1');
});

check('two DIFFERENT accounts have no shared card', () => {
  assertEqual(P.sharedProfile([acct('1', 'me'), acct('2', 'you')]), null);
});

check('an archive too old to have a profile is not a disagreement', () => {
  // A file written before the header existed says nothing about which account
  // it is; it must not be read as a second, nameless one.
  const a = acct('1', 'me');
  assertEqual(P.sharedProfile([null, a, undefined]), a);
  assertEqual(P.sharedProfile([a, null]), a);
});

check('nothing open has no shared card', () => {
  assertEqual(P.sharedProfile([]), null);
  assertEqual(P.sharedProfile([null, null]), null);
  assertEqual(P.sharedProfile(null), null);
});

check('the header for an account page is THAT account, not whichever came first', () => {
  // The bug this exists for: with two accounts open, #/@bob drew a summary of
  // the whole file set over a timeline that was entirely bob's.
  const a = acct('1', 'alice');
  const b = acct('2', 'bob');
  assertEqual(P.profileForHandle([a, b], 'bob'), b);
  assertEqual(P.profileForHandle([a, b], 'alice'), a);
  // The address is whatever the user pasted; a stored handle's case is whatever
  // the export carried.
  assertEqual(P.profileForHandle([a, b], 'BOB'), b);
  assertEqual(P.profileForHandle([{ userId: '2', screenName: 'Bob' }], 'bob').userId, '2');
  // screenNameLower wins when the envelope has it — it is what the exporter
  // normalises, and the two can disagree in a hand-edited file.
  assertEqual(P.profileForHandle([{ userId: '2', screenName: 'BOB', screenNameLower: 'bob' }], 'bob').userId, '2');
});

check('an account page for somebody we do not have gets no card', () => {
  const a = acct('1', 'alice');
  assertEqual(P.profileForHandle([a], 'nobody'), null);
  assertEqual(P.profileForHandle([a], ''), null);
  assertEqual(P.profileForHandle([a], null), null);
  assertEqual(P.profileForHandle([], 'alice'), null);
  assertEqual(P.profileForHandle(null, 'alice'), null);
  // A profile with no handle at all must not match the empty address.
  assertEqual(P.profileForHandle([{ userId: '3' }], ''), null);
  assertEqual(P.profileForHandle([null, undefined, 'x', a], 'alice'), a);
});

check('the id decides, and the handle only when there is no id', () => {
  // Two files whose profiles both lost their id must not be called the same
  // account just because both ids are absent.
  assertEqual(P.sharedProfile([acct(null, 'me'), acct(null, 'you')]), null);
  assertEqual(P.sharedProfile([acct(null, 'me'), acct(null, 'ME')]).screenName, 'me');
  // An id settles it even when the handles look alike, and when they differ.
  assertEqual(P.sharedProfile([acct('1', 'old'), acct('1', 'new')]).userId, '1');
  assertEqual(P.sharedProfile([acct('1', 'same'), acct('2', 'same')]), null);
  // A number and the same number as a string are one person; JSON ids arrive
  // as strings, a hand-edited file may carry the other.
  assertEqual(P.sharedProfile([acct(1, 'me'), acct('1', 'me')]).screenName, 'me');
});

/* ----------------------------------------------------- fetchable URLs --- */

console.log('\n== remoteMediaUrl ==');

check('the two X image hosts are fetchable', () => {
  assertEqual(P.remoteMediaUrl('https://pbs.twimg.com/media/a.jpg'),
    'https://pbs.twimg.com/media/a.jpg');
  assertEqual(P.remoteMediaUrl('https://video.twimg.com/x/y.mp4'),
    'https://video.twimg.com/x/y.mp4');
  // Case is not part of a hostname.
  assertEqual(P.remoteMediaUrl('https://PBS.Twimg.COM/a.jpg'), 'https://pbs.twimg.com/a.jpg');
});

check('NO other host is fetchable, however ordinary it looks', () => {
  // The bug this exists for. safeExternalUrl only insists on http(s), so before
  // this every one of these was loaded once the reader turned 头像：联网 on —
  // and the dialog they consented to says in writing that the request goes to
  // pbs.twimg.com and nowhere else.
  for (const url of [
    'https://evil.example.com/a.jpg',
    'https://example.com/a.jpg',
    'http://localhost:8080/a.jpg',
    'https://pbs.twimg.com.evil.example.com/a.jpg',
    'https://notpbs.twimg.com/a.jpg',
    'https://twimg.com/a.jpg',
    'https://xpbs.twimg.com/a.jpg'
  ]) {
    assertEqual(P.remoteMediaUrl(url), null, 'this must not be fetched: ' + url);
  }
});

check('a non-http scheme is refused before the host is even considered', () => {
  assertEqual(P.remoteMediaUrl('javascript:alert(1)'), null);
  assertEqual(P.remoteMediaUrl('data:image/png;base64,AAAA'), null);
  assertEqual(P.remoteMediaUrl('file:///C:/a.jpg'), null);
  assertEqual(P.remoteMediaUrl('blob:https://pbs.twimg.com/x'), null);
});

check('a missing or unusable value is null, never a throw', () => {
  assertEqual(P.remoteMediaUrl(''), null);
  assertEqual(P.remoteMediaUrl(null), null);
  assertEqual(P.remoteMediaUrl(undefined), null);
  assertEqual(P.remoteMediaUrl(42), null);
  assertEqual(P.remoteMediaUrl({}), null);
  assertEqual(P.remoteMediaUrl('not a url'), null);
  assertEqual(P.remoteMediaUrl('pbs.twimg.com/a.jpg'), null, 'no scheme');
});

check('credentials and ports do not smuggle a different host through', () => {
  // `https://pbs.twimg.com@evil.example.com/a.jpg` parses with hostname
  // evil.example.com — the thing before the @ is a username, not the host.
  assertEqual(P.remoteMediaUrl('https://pbs.twimg.com@evil.example.com/a.jpg'), null);
  assertEqual(P.remoteMediaUrl('https://user:pass@pbs.twimg.com/a.jpg'),
    'https://user:pass@pbs.twimg.com/a.jpg');
});

/* ------------------------------------------------------ avatar sizes --- */

console.log('\n== sizedAvatarUrl ==');

const NORMAL = 'https://pbs.twimg.com/profile_images/2100687239407947776/rskeY8JE_normal.jpg';

check('the header asks for the 400px render, not the 48px one', () => {
  // The bug this exists for. The archive stores the `_normal` address — 48
  // pixels — and the profile header draws it at 142 CSS px, which on a 2x
  // screen is 284 real ones. Measured before the fix: 48x48 in, 142px out.
  assertEqual(P.sizedAvatarUrl(NORMAL, 142),
    'https://pbs.twimg.com/profile_images/2100687239407947776/rskeY8JE_400x400.jpg');
});

check('a 40px timeline bubble is left at the size X itself uses there', () => {
  // NOT a mistake and not a missing case: `_400x400` on every face in a list is
  // 28 KB against 2.5 KB for a difference nobody can see at 40px. The rule is
  // the smallest render at least as big as the slot, and for this slot that is
  // the one already in the address.
  assertEqual(P.sizedAvatarUrl(NORMAL, 40), NORMAL);
  assertEqual(P.sizedAvatarUrl(NORMAL, 48), NORMAL);
});

check('a bigger render is never traded down for a smaller one', () => {
  // An archive that names `_400x400` was written by something that chose it.
  // Saving bytes by pointing it at a smaller file is the same silent loss this
  // project exists to avoid, so the rule only ever moves one way.
  const big = NORMAL.replace('_normal', '_400x400');
  assertEqual(P.sizedAvatarUrl(big, 40), big);
  assertEqual(P.sizedAvatarUrl(big, 142), big);
  assertEqual(P.sizedAvatarUrl(NORMAL.replace('_normal', '_bigger'), 40),
    NORMAL.replace('_normal', '_bigger'));
});

check('every render X makes is recognised, and only those', () => {
  const at = (tier) => NORMAL.replace('_normal', tier);
  assertEqual(P.sizedAvatarUrl(at('_mini'), 142), at('_400x400'));
  assertEqual(P.sizedAvatarUrl(at('_bigger'), 142), at('_400x400'));
  assertEqual(P.sizedAvatarUrl(at('_400x400'), 142), at('_400x400'));
  // A tier this reader does not know is handed back untouched rather than
  // guessed at.
  assertEqual(P.sizedAvatarUrl(at('_reasonably_small'), 142), at('_reasonably_small'));
  assertEqual(P.sizedAvatarUrl('https://pbs.twimg.com/a/b.jpg', 142), 'https://pbs.twimg.com/a/b.jpg');
});

check('the extension is not changed, only the name', () => {
  // .png and .gif avatars exist, and the extension is the one that must survive
  // — a rewrite that ate the extension would turn a working URL into a 404.
  assertEqual(P.sizedAvatarUrl('https://pbs.twimg.com/profile_images/1/a_normal.png', 142),
    'https://pbs.twimg.com/profile_images/1/a_400x400.png');
  assertEqual(P.sizedAvatarUrl('https://pbs.twimg.com/profile_images/1/a_normal.GIF', 142),
    'https://pbs.twimg.com/profile_images/1/a_400x400.GIF');
  // A query string hanging off the end means the name is not the last thing in
  // the address, so the tier cannot be read and the URL goes through untouched.
  // Nothing in the wild looks like this, and guessing at one would be an
  // address this function made up.
  assertEqual(P.sizedAvatarUrl('https://pbs.twimg.com/profile_images/1/a_normal.jpg?x=1', 142),
    'https://pbs.twimg.com/profile_images/1/a_normal.jpg?x=1');
});

check('nonsense in, the same nonsense out — never a throw', () => {
  assertEqual(P.sizedAvatarUrl('', 142), '');
  assertEqual(P.sizedAvatarUrl(null, 142), null);
  assertEqual(P.sizedAvatarUrl(undefined, 142), undefined);
  assertEqual(P.sizedAvatarUrl(42, 142), 42);
  assertEqual(P.sizedAvatarUrl(NORMAL, 0), NORMAL);
  assertEqual(P.sizedAvatarUrl(NORMAL, NaN), NORMAL);
  assertEqual(P.sizedAvatarUrl(NORMAL, undefined), NORMAL);
  assertEqual(P.sizedAvatarUrl(NORMAL, '142'), NORMAL);
});

/* -------------------------------------------------- envelope list keys --- */

console.log('\n== envelopeHasList ==');

check('a key holding records counts as a list', () => {
  assertEqual(P.envelopeHasList('{"connections":[{"userId":"1"}]}', 'connections'), true);
  assertEqual(P.envelopeHasList('{"deletions":[{"id":"1"}]}', 'deletions'), true);
  // Whitespace between the bracket and the first record is legal JSON.
  assertEqual(P.envelopeHasList('{"deletions":[ \n {"id":"1"}]}', 'deletions'), true);
  assertEqual(P.envelopeHasList('{"deletions":[1,2]}', 'deletions'), true);
});

check('an EMPTY array is not a list', () => {
  // The bug this exists for. The exporter writes `deletions` on every export
  // whether or not anything was deleted, so a bare key scan told a brand-new
  // archive it carried a tombstone list — a warning about data the file does
  // not have, fired on every file.
  assertEqual(P.envelopeHasList('{"deletions":[]}', 'deletions'), false);
  assertEqual(P.envelopeHasList('{"deletions":[ ]}', 'deletions'), false);
  assertEqual(P.envelopeHasList('{"deletions":[\n\t]}', 'deletions'), false);
  assertEqual(P.envelopeHasList('{"connections":[]}', 'connections'), false);
  // The real envelope shape: an empty deletions list right before the roster.
  assertEqual(P.envelopeHasList('{"count":30,"deletions":[],"connections":[{"a":1}]}', 'deletions'), false);
  assertEqual(P.envelopeHasList('{"count":30,"deletions":[],"connections":[{"a":1}]}', 'connections'), true);
});

check('the key must be the key, not a substring of one', () => {
  // `"xdeletions"` and a value mentioning the word must not count. The scan is
  // over raw bytes of a file whose CONTENT is arbitrary user text, so a tweet
  // containing the literal characters is entirely possible.
  assertEqual(P.envelopeHasList('{"xdeletions":[1]}', 'deletions'), false);
  assertEqual(P.envelopeHasList('{"note":"see \\"deletions\\": [1]"}', 'deletions'), false);
  // ...and a decode of the whole tail is what the caller passes, so a key that
  // appears as a tweet's words without the colon is not a key either.
  assertEqual(P.envelopeHasList('{"text":"my deletions [] are gone"}', 'deletions'), false);
});

check('a malformed or absent key is false, never a throw', () => {
  assertEqual(P.envelopeHasList('{"deletions":null}', 'deletions'), false);
  assertEqual(P.envelopeHasList('{"deletions":{}}', 'deletions'), false);
  assertEqual(P.envelopeHasList('{"deletions":', 'deletions'), false);
  assertEqual(P.envelopeHasList('{}', 'deletions'), false);
  assertEqual(P.envelopeHasList('', 'deletions'), false);
  assertEqual(P.envelopeHasList(null, 'deletions'), false);
  assertEqual(P.envelopeHasList('{"deletions":[1]}', ''), false);
  assertEqual(P.envelopeHasList('{"deletions":[1]}', null), false);
});

/* ------------------------------------------------------------- merge --- */

console.log('\n== intersectAscending ==');

check('the intersection keeps only what both lists hold', () => {
  assertEqual(P.intersectAscending([1, 3, 5, 7], [3, 4, 5, 9]), [3, 5]);
  assertEqual(P.intersectAscending([1, 2, 3], [4, 5, 6]), [], 'disjoint');
  assertEqual(P.intersectAscending([1, 2, 3], [1, 2, 3]), [1, 2, 3], 'identical');
  assertEqual(P.intersectAscending([2, 4, 6, 8], [4, 8]), [4, 8], 'one inside the other');
  assertEqual(P.intersectAscending([], [1, 2]), []);
  assertEqual(P.intersectAscending([1, 2], []), []);
  assertEqual(P.intersectAscending([], []), []);
});

check('the result is ascending, with no duplicates', () => {
  // The property the height table and positionOf both rest on: `ids` is
  // ascending by construction, which is what makes positionOf a binary search
  // and the row order the same as the record order.
  const a = [], b = [];
  for (let i = 0; i < 4000; i++) {
    if (i % 3 !== 0) a.push(i);
    if (i % 5 !== 0) b.push(i);
  }
  const got = P.intersectAscending(a, b);
  for (let i = 1; i < got.length; i++) {
    assert(got[i] > got[i - 1], 'not strictly ascending at ' + i);
  }
  const setB = new Set(b);
  const expected = a.filter((x) => setB.has(x));
  assertEqual(got, expected, 'the merge disagrees with a Set intersection');
});

check('duplicates in either input are emitted once', () => {
  // Neither list is promised to be duplicate-free, and a duplicated position
  // would render the same post twice in the same column.
  assertEqual(P.intersectAscending([1, 1, 1], [1]), [1]);
  assertEqual(P.intersectAscending([1, 1], [1, 1]), [1]);
  assertEqual(P.intersectAscending([2, 2, 5], [2, 5, 5]), [2, 5]);
});

check('a non-array is an empty list, not a throw', () => {
  for (const v of [null, undefined, 7, 'x', {}]) {
    assertEqual(P.intersectAscending([1, 2], v), []);
    assertEqual(P.intersectAscending(v, [1, 2]), []);
  }
});

/* --------------------------------------------------------- whole script --- */

console.log('\n== reader.html ==');

check('the whole <script> block parses', () => {
  // The UI half of the file has no other coverage. A typo there would only show
  // up as a blank page in the browser, which is the least useful way to find it.
  const open = html.indexOf('<script>');
  const close = html.indexOf('</script>', open);
  assert(open > 0 && close > open, 'no script block found');
  const script = html.slice(open + '<script>'.length, close);
  // Parsing only — new Function compiles the body without running it.
  new Function(script);
});

check('the tab row offers exactly the tabs an archive can fill', () => {
  // 转帖 and 文章 are deliberately absent: the extension never matches
  // CreateRetweet, so no record is a retweet, and a long-form post is stored as
  // an ordinary record. A tab that can never be filled would be a claim about
  // the file that is not true, and this is what stops one being added back.
  const tabs = html.match(/data-tab="[a-z]+"/g) || [];
  assertEqual(tabs, ['data-tab="posts"', 'data-tab="replies"', 'data-tab="media"']);
});

check('the header and the tab row hide themselves when empty', () => {
  // An author `display` rule beats the user agent's [hidden] rule whatever the
  // specificity, so the rule has to be written out — the same trap `#view` and
  // `.card` are written around.
  assert(/#profile\[hidden\]\s*\{\s*display:\s*none/.test(html), '#profile[hidden] is missing');
  assert(/#tabs\[hidden\]\s*\{\s*display:\s*none/.test(html), '#tabs[hidden] is missing');
  assert(/#scope\[hidden\]\s*\{\s*display:\s*none/.test(html), '#scope[hidden] is missing');
});

console.log('\n== the picture carried inside the archive ==');

check('an inlined image is let through', () => {
  const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==';
  assertEqual(P.safeDataImageUrl(jpeg), jpeg);
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assertEqual(P.safeDataImageUrl(png), png);
});

check('anything that is not a base64 image is refused', () => {
  // The one that matters: a data: URL carrying markup, which would be a script
  // tag the moment any caller stops putting it in an <img>.
  assertEqual(P.safeDataImageUrl('data:text/html;base64,PHNjcmlwdD4='), null);
  assertEqual(P.safeDataImageUrl('data:image/svg+xml;base64,PHN2Zz4='), null);
  assertEqual(P.safeDataImageUrl('data:image/jpeg,notbase64'), null);
  assertEqual(P.safeDataImageUrl('javascript:alert(1)'), null);
  assertEqual(P.safeDataImageUrl('https://pbs.twimg.com/a.jpg'), null);
  assertEqual(P.safeDataImageUrl(''), null);
  assertEqual(P.safeDataImageUrl(null), null);
  assertEqual(P.safeDataImageUrl(undefined), null);
  assertEqual(P.safeDataImageUrl({}), null);
});

check('an absurdly long one is refused before it is walked', () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024 + 4);
  assertEqual(P.safeDataImageUrl(huge), null);
});

check('a real avatar-sized one is accepted', () => {
  // 28 KB of JPEG is what the extension caches, base64'd to about 38 KB.
  const sized = 'data:image/jpeg;base64,' + 'A'.repeat(38000);
  assertEqual(P.safeDataImageUrl(sized), sized);
});

check('the roster page exists, with both lists and the way back out', () => {
  // The roster is data the archive has always carried and this page never read.
  // A whole-file check because the page is markup plus one module, and losing
  // either half is silent: the counts would still render, and clicking one would
  // do nothing at all.
  assert(/id="rosterPage"/.test(html), '#rosterPage is missing');
  assert(/id="rosterList"/.test(html), '#rosterList is missing');
  assert(/id="btnRosterBack"/.test(html), 'the way back out is missing');
  const lists = html.match(/data-list="[a-z]+"/g) || [];
  assertEqual(lists, ['data-list="following"', 'data-list="followers"']);
  // And the page hides the timeline exactly as the post page does: a sibling
  // that takes the column, not a sheet over it.
  assert(/body\.rosterOpen\s+#view\s*\{\s*display:\s*none/.test(html),
    'body.rosterOpen does not hide the timeline');
  assert(/#rosterPage\[hidden\]\s*\{\s*display:\s*none/.test(html),
    '#rosterPage[hidden] is missing');
});

check('the page does not load anything from the network', () => {
  // The reader must stay a single local file: no CDN, no fonts, no analytics.
  // A stray external reference would also break it offline and leak the fact
  // that the archive was opened.
  const externals = html.match(/(?:src|href)\s*=\s*["']https?:[^"']+/gi) || [];
  assertEqual(externals, [], 'external references found: ' + externals.join(', '));
});

/* ------------------------------------------------------------ real file --- */

console.log('\n== a real export, if one is present ==');

const realCandidates = [
  path.join(REPO, '..', 'x-tweet-backup-2026-09-23-local.json'),
  path.join(REPO, '..', 'x-tweet-backup-2026-09-23.json')
];
const real = realCandidates.find((p) => fs.existsSync(p));

if (real) {
  check('scans ' + path.basename(real) + ' and matches its own count field', () => {
    const bytes = new Uint8Array(fs.readFileSync(real));
    const st = scanAll(bytes);
    assert(st.closed, 'the real file\'s array did not close');
    const head = new TextDecoder().decode(bytes.subarray(0, 4096));
    const m = head.match(/"count"\s*:\s*(\d+)/);
    assert(m, 'no count field in the envelope');
    assertEqual(st.elements.length, Number(m[1]), 'scanned record count disagrees with the envelope');
  });
} else {
  console.log('  (no real export on disk — skipping)');
}

/* ------------------------------------------------- the merge rule, twice -- */

/* The reader carries its own copy of db.js's merge rule, because a single-file
   HTML page cannot import one. This is what stops the two drifting: the same
   corpus goes through both and the answers have to be identical.
   Without it, the day one of them changes is the day merging two exports and
   merging two captures start producing different archives. */

console.log('\n== the merge rule (reader copy vs db.js) ==');

const MERGE_CORPUS = [
  /* [older, newer] — the shapes the rule exists for. */
  [{ id: '1', text: 'hello', metrics: { likeCount: 3, retweetCount: null }, media: [{ id: 'a' }] },
   { id: '1', text: '', metrics: { likeCount: null, retweetCount: 2 }, media: [] }],
  [{ id: '2', text: 'x', deletedAt: '2026-01-01T00:00:00.000Z', supersededBy: '9' },
   { id: '2', text: 'x', author: { name: 'cjy' } }],
  [{ id: '3', poll: { isPoll: true, choices: ['a'] }, likeCountZero: 0 },
   { id: '3', poll: null, isPoll: false, likeCountZero: 0 }],
  [{ id: '4', nested: { a: 1, b: { c: 2, d: 3 } } },
   { id: '4', nested: { a: null, b: { c: 9 } } }],
  [{ id: '5', list: ['a', 'b'], empty: [], flag: true },
   { id: '5', list: [], empty: ['z'], flag: false }],
  [{ id: '6' }, { id: '6', text: 'only the new one has this' }],
  [{ id: '7', onlyOld: 'kept', text: 'old' }, { id: '7' }]
];

await check('isAbsent agrees on every shape that matters', () => {
  const cases = [null, undefined, '', [], 0, false, 'x', [1], {}, NaN];
  for (const v of cases) {
    assertEqual(P.isAbsent(v), dbMerge.isAbsent(v), 'isAbsent disagreed on ' + JSON.stringify(v));
  }
});

await check('mergeCapture gives the same record in both implementations', () => {
  for (const [older, newer] of MERGE_CORPUS) {
    const a = P.mergeCapture(older, newer);
    const b = dbMerge.mergeCapture(older, newer);
    assertEqual(a, b, 'the two merge rules disagree on ' + JSON.stringify(newer));
  }
});

await check('the reader keeps a deleted post deleted', () => {
  const [older, newer] = MERGE_CORPUS[1];
  const merged = P.mergeCapture(older, newer);
  assertEqual(merged.deletedAt, older.deletedAt, 'a tombstone was erased by a later capture');
  assertEqual(merged.supersededBy, older.supersededBy, 'the edit chain was erased');
});

await check('an empty newer value never beats a real older one', () => {
  const [older, newer] = MERGE_CORPUS[0];
  const merged = P.mergeCapture(older, newer);
  assertEqual(merged.text, 'hello', 'an empty text won over a real one');
  assertEqual(merged.metrics.likeCount, 3, 'a missing count won over a real one');
  assertEqual(merged.metrics.retweetCount, 2, 'a real count did not win over a missing one');
});

await check('but zero and false are answers, and they do win', () => {
  const merged = P.mergeCapture({ id: '8', liked: true, count: 5 }, { id: '8', liked: false, count: 0 });
  assertEqual(merged.liked, false, 'un-liking was treated as "nothing was said"');
  assertEqual(merged.count, 0, 'a real zero was treated as "nothing was said"');
});

await check('an empty array is "nothing was said", not "there is none"', () => {
  const merged = P.mergeCapture({ id: '9', media: [{ id: 'p1' }] }, { id: '9', media: [] });
  assertEqual(merged.media, [{ id: 'p1' }], 'an archive that found no media deleted the ones we had');
});

/* ------------------------------------------------------------------ done -- */

// Async checks must settle before the totals mean anything.
await Promise.all(inFlight);

console.log('\n' + '='.repeat(41));
console.log('passed: ' + passed + '   failed: ' + failures.length);
if (failures.length) {
  for (const f of failures) console.log('  FAILED: ' + f.name + ' — ' + f.message);
  process.exit(1);
}
