/* ============================================================================
 * zip.js — minimal ZIP writer, STORE method (no compression), no dependencies.
 *
 * Why STORE: the payload is JPEG / PNG / MP4, which are already compressed.
 * Deflating them again would cost CPU and save almost nothing.
 *
 * Runs in the popup and in Node (uses only Blob, Uint8Array, DataView,
 * TextEncoder, all of which exist in both), which is what makes it testable
 * outside the browser.
 * ========================================================================== */

/* CRC-32 (IEEE 802.3), the checksum every ZIP entry must carry. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP stores timestamps in MS-DOS format: 2-second resolution, from 1980. */
function dosDateTime(date) {
  const year = date.getFullYear();
  const safeYear = year < 1980 ? 1980 : (year > 2107 ? 2107 : year);
  const time = ((date.getHours() & 0x1f) << 11) |
               ((date.getMinutes() & 0x3f) << 5) |
               ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = (((safeYear - 1980) & 0x7f) << 9) |
              (((date.getMonth() + 1) & 0x0f) << 5) |
              (date.getDate() & 0x1f);
  return { time: time, day: day };
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build a ZIP archive.
 *
 * entries: [{ name: 'media/x.jpg', blob: Blob, date?: Date }]
 * options: { extraFiles?: [{ name, text, date? }] }  -> additional text entries
 *
 * Each entry's bytes are read one at a time to compute its CRC, then released;
 * the archive is assembled from the original Blobs, so peak memory stays around
 * one file rather than the whole archive.
 */
export async function buildZip(entries, options) {
  const opts = options || {};
  const encoder = new TextEncoder();

  const localParts = [];
  const centralRecords = [];
  let offset = 0;

  const all = entries.slice();
  if (Array.isArray(opts.extraFiles)) {
    for (const extra of opts.extraFiles) {
      if (!extra || typeof extra.name !== 'string' || !extra.name) continue;
      if (typeof extra.text !== 'string') continue;
      all.push({
        name: extra.name,
        blob: new Blob([extra.text], { type: 'text/plain;charset=utf-8' }),
        date: extra.date instanceof Date ? extra.date : new Date()
      });
    }
  }

  for (const entry of all) {
    if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
    if (!entry.blob || typeof entry.blob.arrayBuffer !== 'function') continue;

    const nameBytes = encoder.encode(entry.name);
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    const crc = crc32(bytes);
    const size = bytes.length;
    const stamp = dosDateTime(entry.date instanceof Date ? entry.date : new Date());

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // local file header signature
    lv.setUint16(4, 20, true);           // version needed to extract
    lv.setUint16(6, 0x0800, true);       // flags: file name is UTF-8
    lv.setUint16(8, 0, true);            // method: 0 = STORE
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);        // compressed size
    lv.setUint32(22, size, true);        // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // extra field length
    local.set(nameBytes, 30);

    // Push the original Blob rather than the bytes we just read: the Blob may be
    // disk-backed, and holding every file's bytes would blow up memory.
    localParts.push(local, entry.blob);

    centralRecords.push({
      nameBytes: nameBytes,
      crc: crc,
      size: size,
      offset: offset,
      time: stamp.time,
      day: stamp.day
    });

    offset += local.length + size;
  }

  const centralParts = [];
  let centralSize = 0;

  for (const record of centralRecords) {
    const rec = new Uint8Array(46 + record.nameBytes.length);
    const dv = new DataView(rec.buffer);
    dv.setUint32(0, 0x02014b50, true);   // central directory header signature
    dv.setUint16(4, 20, true);           // version made by
    dv.setUint16(6, 20, true);           // version needed
    dv.setUint16(8, 0x0800, true);       // flags
    dv.setUint16(10, 0, true);           // method: STORE
    dv.setUint16(12, record.time, true);
    dv.setUint16(14, record.day, true);
    dv.setUint32(16, record.crc, true);
    dv.setUint32(20, record.size, true);
    dv.setUint32(24, record.size, true);
    dv.setUint16(28, record.nameBytes.length, true);
    dv.setUint16(30, 0, true);           // extra length
    dv.setUint16(32, 0, true);           // comment length
    dv.setUint16(34, 0, true);           // disk number start
    dv.setUint16(36, 0, true);           // internal attributes
    dv.setUint32(38, 0, true);           // external attributes
    dv.setUint32(42, record.offset, true);
    rec.set(record.nameBytes, 46);
    centralParts.push(rec);
    centralSize += rec.length;
  }

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);     // end of central directory signature
  ev.setUint16(4, 0, true);              // this disk
  ev.setUint16(6, 0, true);              // disk with central directory
  ev.setUint16(8, centralRecords.length, true);
  ev.setUint16(10, centralRecords.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);             // comment length

  return new Blob(localParts.concat(centralParts, [end]), { type: 'application/zip' });
}

/** Build the human-readable index that ships inside a media archive. */
export function describeMediaArchive(rows, meta) {
  const lines = [];
  lines.push('X Tweet Backup — archive index');
  lines.push('Generated: ' + (meta && meta.generatedAt ? meta.generatedAt : new Date().toISOString()));
  lines.push('Files: ' + rows.length);
  lines.push('');
  lines.push('Contents:');
  lines.push('  tweets.json        every archived post (text, timestamps, author,');
  lines.push('                     reply/quote links, media metadata)');
  lines.push('  media/             the media files themselves, as ordinary files');
  lines.push('  MEDIA-INDEX.json   the same mapping as this file, machine-readable');
  lines.push('');
  lines.push('File names are <tweetId>_<mediaId>.<ext>. Join them to tweets.json:');
  lines.push('the leading number is tweet.id, the second is tweet.media[].id.');
  lines.push('');
  lines.push('tweetId            mediaId            file                                        type');
  lines.push('------------------ ------------------ ------------------------------------------- --------');
  for (const row of rows) {
    lines.push(
      String(row.tweetId).padEnd(18) + ' ' +
      String(row.mediaId).padEnd(18) + ' ' +
      String(row.fileName).padEnd(43) + ' ' +
      String(row.type || '?')
    );
  }
  if (meta && meta.skipped > 0) {
    lines.push('');
    lines.push(meta.skipped + ' media record(s) had no cached blob and were skipped.');
  }
  return lines.join('\n') + '\n';
}

/**
 * Machine-readable companion to the human table: lets any future reader join
 * the archive's files back to tweets.json without re-deriving the naming rule.
 */
export function buildMediaIndexJson(rows, meta) {
  const info = meta || {};
  return JSON.stringify({
    generator: 'x-tweet-backup',
    generatorVersion: typeof info.version === 'string' && info.version.length > 0 ? info.version : 'unknown',
    schemaVersion: info.schemaVersion === undefined ? 1 : info.schemaVersion,
    generatedAt: info.generatedAt || new Date().toISOString(),
    note: 'Join against tweets.json: files[].tweetId === tweet.id and files[].mediaId === tweet.media[].id',
    fileCount: rows.length,
    skipped: typeof info.skipped === 'number' ? info.skipped : 0,
    files: rows.map((row) => ({
      file: row.fileName,
      tweetId: row.tweetId,
      mediaId: row.mediaId,
      type: row.type || null,
      contentType: row.contentType || null,
      bytes: typeof row.bytes === 'number' ? row.bytes : null
    }))
  }, null, 2) + '\n';
}

/* Kept for callers that want to sanity-check a name before using it. */
export function isSafeArchiveName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.indexOf('..') !== -1) return false;
  if (name.charAt(0) === '/') return false;
  return /^[A-Za-z0-9._\-\/]+$/.test(name);
}

export { escapeXml };
