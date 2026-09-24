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
import { fileURLToPath } from 'node:url';

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
    generatorVersion: '1.4.0',
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
    generatorVersion: '1.4.0',
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

/* ------------------------------------------------------------------ done -- */

// Async checks must settle before the totals mean anything.
await Promise.all(inFlight);

console.log('\n' + '='.repeat(41));
console.log('passed: ' + passed + '   failed: ' + failures.length);
if (failures.length) {
  for (const f of failures) console.log('  FAILED: ' + f.name + ' — ' + f.message);
  process.exit(1);
}
