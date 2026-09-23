/* ============================================================================
 * make-zip.mjs — build the store package.
 *
 * Written by hand for one reason: PowerShell 5.1's Compress-Archive stores path
 * separators as BACKSLASHES. The ZIP spec (APPNOTE 4.4.17.1) says "All slashes
 * MUST be forward slashes '/'", and while Windows' own extractor is forgiving,
 * server-side unzippers are not — which is exactly what the store upload runs.
 * A package with backslash paths can be rejected outright, or worse, unpack
 * with every subdirectory flattened.
 *
 * So this writes the archive itself: forward slashes, deflate, no dependency
 * beyond Node's zlib. `tools/` and other development-only files are excluded
 * from the package by construction rather than by remembering to.
 *
 *   node tools/make-zip.mjs [output.zip]
 *
 * Default output is <repo>/../x-tweet-backup-<version>.zip, version read from
 * manifest.json, so the filename cannot drift from what the browser reports.
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ---------------------------------------------------------------- CRC32 ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------ what goes in */

// Development-only. `tools/` holds this file, the icon generator and the
// reader's tests; `reader/` is the standalone archive reader, a separate product
// that ships as a single HTML file and must never end up inside the extension
// package. `.git*` and archives are repository furniture.
const SKIP_DIRS = new Set(['.git', 'tools', 'reader', 'node_modules']);
const SKIP_FILES = new Set(['.gitignore', '.gitattributes', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
const SKIP_EXT = new Set(['.zip', '.crx', '.log']);

// What the extension actually is. The package is built from this list rather
// than from "everything not obviously development-only", because a blocklist
// ships a directory nobody meant to include and an allowlist cannot. Both times
// this has gone wrong were blocklist failures, and neither name looked wrong:
// a literal `%TEMP%` directory left by an unexpanded shell variable rode along
// in a real package, and `extracted/` — the scratch directory tools/test-zip.mjs
// creates when it is pointed at the repository root — was picked up on the way
// into 1.3.6, with a test export's media files inside it.
const SHIPPED_TOP = new Set([
  '_locales',
  'icons',
  'manifest.json',
  'background.js',
  'content.js',
  'db.js',
  'inject.js',
  'media-cache.js',
  'settings.js',
  'zip.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'privacy-policy.md',
  'README.md'
]);

/**
 * Refuse to build rather than guess.
 *
 * Skipping an entry that was added to the repository but not to either list
 * would ship an extension missing a file it refers to — a package that installs
 * and then breaks. Stopping with the name of the offender costs one command.
 */
function unknownTopLevel(name) {
  return new Error(
    'unrecognised entry at the repository root: "' + name + '"\n' +
    '  If it belongs in the package, add it to SHIPPED_TOP in tools/make-zip.mjs.\n' +
    '  If it does not, delete it, or add it to SKIP_DIRS / SKIP_FILES.'
  );
}

function collect(dir, prefix, out, topLevel) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (topLevel && !SHIPPED_TOP.has(entry.name)) throw unknownTopLevel(entry.name);
      collect(abs, rel, out, false);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      if (topLevel && !SHIPPED_TOP.has(entry.name)) throw unknownTopLevel(entry.name);
      out.push({ abs, rel, mtime: fs.statSync(abs).mtime });
    }
  }
}

/* --------------------------------------------------------------- writing --- */

/** MS-DOS packed date/time, which is what a ZIP stores (2-second resolution). */
function dosStamp(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2))) & 0xFFFF;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF;
  return { time, day };
}

function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.abs);
    const crc = crc32(data);

    // Deflate only when it actually shrinks the file. Already-compressed media
    // would otherwise grow, and PNGs inside the package are common enough that
    // the store's own size limits make this worth checking.
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    // Every name in this package is ASCII; non-ASCII would need the UTF-8 flag.
    const name = Buffer.from(file.rel, 'ascii');
    const { time, day } = dosStamp(file.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed to extract
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014B50, 0);     // central directory signature
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0, 8);              // flags
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);             // extra
    dir.writeUInt16LE(0, 32);             // comment
    dir.writeUInt16LE(0, 34);             // disk number start
    dir.writeUInt16LE(0, 36);             // internal attributes
    dir.writeUInt32LE(0x20, 38);          // external attributes: MS-DOS archive bit
    dir.writeUInt32LE(offset, 42);        // offset of local header

    parts.push(local, name, body);
    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);       // end of central directory signature
  end.writeUInt16LE(0, 4);                // this disk
  end.writeUInt16LE(0, 6);                // disk with central directory
  end.writeUInt16LE(files.length, 8);     // entries on this disk
  end.writeUInt16LE(files.length, 10);    // entries total
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);          // central directory offset
  end.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...parts, directory, end]);
}

/* --------------------------------------------------------------- reading --- */

/** Minimal reader, used only to verify what was just written. */
function readZip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xFFFF);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014B50) throw new Error('bad central directory entry at ' + p);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('ascii', p + 46, p + 46 + nameLen);

    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + localNameLen + localExtraLen;
    const body = buf.subarray(start, start + compSize);

    out.push({
      name,
      size,
      crc,
      data: method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body)
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}

/* ------------------------------------------------------------------ main --- */

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
const version = manifest.version;
if (typeof version !== 'string' || version.length === 0) {
  console.error('manifest.json has no usable "version"');
  process.exit(1);
}

const outPath = process.argv[2] || path.join(REPO, '..', 'x-tweet-backup-' + version + '.zip');

const files = [];
try {
  collect(REPO, '', files, true);
} catch (err) {
  console.error('FAILED: ' + err.message);
  process.exit(1);
}
if (files.length === 0) {
  console.error('nothing to package');
  process.exit(1);
}

const zip = buildZip(files);
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, zip);

/* Verify by reading the bytes back rather than trusting the writer. A ZIP that
   only its own author can parse is how the backslash bug survived this long. */

const read = readZip(fs.readFileSync(outPath));
let failures = 0;

if (read.length !== files.length) {
  console.error('FAILED: wrote ' + files.length + ' entries, read back ' + read.length);
  failures++;
}

const byName = new Map(read.map((e) => [e.name, e]));
for (const file of files) {
  const entry = byName.get(file.rel);
  if (!entry) { console.error('FAILED: missing from archive: ' + file.rel); failures++; continue; }
  const original = fs.readFileSync(file.abs);
  if (!entry.data.equals(original)) { console.error('FAILED: content mismatch: ' + file.rel); failures++; continue; }
  if (entry.crc !== crc32(original)) { console.error('FAILED: bad CRC: ' + file.rel); failures++; }
}

for (const entry of read) {
  if (entry.name.includes('\\')) {
    console.error('FAILED: backslash in stored path: ' + entry.name);
    failures++;
  }
  // Anything in the repository gets packed, so a stray file ships. A literal
  // `%TEMP%` directory — created when a shell failed to expand the variable in
  // a test command, and left behind — rode along in a real package that way.
  // Extension files are ASCII names and directories; anything else is a
  // mistake by construction, and it is cheaper to fail the build than to
  // notice junk on the store listing.
  if (!/^[A-Za-z0-9._/-]+$/.test(entry.name)) {
    console.error('FAILED: entry name has characters no extension file should have: ' + entry.name);
    failures++;
  }
}

if (failures > 0) {
  console.error('\n' + failures + ' problem(s) — the archive is not usable.');
  process.exit(1);
}

const hasManifest = read.some((e) => e.name === 'manifest.json');
if (!hasManifest) {
  console.error('FAILED: manifest.json is not at the archive root — the store will not accept it.');
  process.exit(1);
}

console.log('packed  : ' + read.length + ' entries');
for (const entry of read) {
  console.log('          ' + entry.name + '  (' + entry.size + ' B)');
}
console.log('written : ' + path.resolve(outPath) + '  (' + (zip.length / 1024).toFixed(1) + ' KB)');
console.log('checked : every entry inflates back to its file, CRCs match, no backslash paths, manifest at root');
