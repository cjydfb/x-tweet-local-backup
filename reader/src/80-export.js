/* ---------------------------------------------------------------- export -- */

/**
 * Write the open archives out, ONE FILE PER ACCOUNT.
 *
 * Not one file holding everybody. A single account is the unit an archive has
 * always been: it is what a profile card describes, what a roster belongs to,
 * and what the extension exports. Merging two accounts into one file would mean
 * a file with no honest owner — and it would have to throw the follow lists away,
 * because there is no answer to "whose".
 *
 * So the open set is grouped by account first. Two exports of @fcjdfb are one
 * group and produce ONE file; @fcjdfb plus somebody else produces two. What is
 * merged is the duplicate records WITHIN a group, which is the whole reason two
 * exports of one account can be opened together in the first place.
 *
 * THE LAYOUT, and why each part of it is where it is:
 *
 *   schemaVersion, generator, generatorVersion, exportedAt, timezone
 *     BEFORE `tweets`. The reader finds the array by scanning the first few
 *     kilobytes for the key, and reads these five from the same probe. Put them
 *     after the array and a re-opened file says "schema ? / 导出 ?".
 *   tweets
 *     One compact JSON.stringify per line, exactly as the extension writes it.
 *   count
 *     Must equal the number of elements, or the integrity check reports the
 *     file as having lost records.
 *   profile
 *     This account's card, so the merged file opens with the header the
 *     originals had.
 *   deletions
 *     The union over the group. Dropping part of this list silently resurrects
 *     deleted posts for whatever reads the file next.
 *   connections
 *     The union over the group, LAST because it can be tens of megabytes and
 *     the reader only ever probes a bounded window from the end.
 */

/**
 * The reader's own version, and the reason it is its own line of versions.
 *
 * The extension has never stopped iterating; this file did not change at all
 * between its first release and the 我/检索/地址栏 rewrite. Stamping the
 * extension's number here would say a file written by a reader that could not
 * route to an address was written by one that can, and `generatorVersion` is
 * the field a future reader has to trust when it decides whether a file it was
 * handed is shaped the way it expects.
 *
 * Bump this when the FORMAT the reader writes changes, or when the code that
 * chooses what goes in it does. Not for a stylesheet.
 */
var READER_VERSION = '2.1.0';

/** A JSON string literal, escaped for embedding. */
function jsonString(value) {
  return JSON.stringify(String(value));
}

/* How far back to look for an envelope key, growing. The scalar section is a
   few hundred bytes from the end; the roster is the last thing in the file and
   can be megabytes, so a fixed 256 KB window finds its END but not its start. */
var ENVELOPE_TAIL_STEPS = [262144, 4 * 1024 * 1024, 32 * 1024 * 1024];

/**
 * The array written under `key` in one source's envelope, or null.
 *
 * Cut out with the same brace matcher the profile uses: a `[^\]]*` regex would
 * stop at the first `]` inside a string, and every one of these arrays holds
 * text somebody wrote.
 */
async function envelopeArrayOf(src, key) {
  for (var s = 0; s < ENVELOPE_TAIL_STEPS.length; s++) {
    var span = ENVELOPE_TAIL_STEPS[s];
    if (s > 0 && src.source.size <= ENVELOPE_TAIL_STEPS[s - 1]) return null;
    var start = Math.max(0, src.source.size - span);
    var text = await src.source.slice(start, src.source.size).text();
    var at = text.indexOf('"' + key + '"');
    if (at < 0) continue;                    /* look further back */
    var bracket = text.indexOf('[', at);
    if (bracket < 0) continue;
    var end = readJsonValueEnd(text, bracket);
    if (end < 0) continue;
    try {
      /* `end` is one PAST the closing bracket — readJsonValueEnd returns the
         index after it, which is what readEnvelopeProfile slices with too. The
         `+ 1` that used to be here took the character after the array with it,
         so every list written before `connections` arrived as `[...],` and
         JSON.parse threw into the catch below. `deletions` was silently an
         empty list in every merged export; `connections` parsed only because
         it is the last key and is followed by a newline. */
      var parsed = JSON.parse(text.slice(bracket, end));
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;                           /* found it, and it will not parse */
    }
  }
  return null;
}

/**
 * Group the open archives by the account they belong to.
 *
 * By account, NOT by file. Two exports of one account have to land in the same
 * group, or the records folded out of the second one would be dropped from the
 * output — they survive in the merged list under the FIRST file's index, and a
 * grouping by file would leave them behind.
 */
function groupSourcesByAccount() {
  var order = [];
  var byKey = new Map();

  for (var i = 0; i < archive.sources.length; i++) {
    var src = archive.sources[i];
    var p = src.profile;
    var key = p && typeof p.userId === 'string' && p.userId.length > 0 ? 'id:' + p.userId
      : (p && typeof p.screenName === 'string' && p.screenName.length > 0 ? 'name:' + p.screenName.toLowerCase()
        : 'file:' + src.file.name);

    var group = byKey.get(key);
    if (group === undefined) {
      group = { key: key, sources: [], profile: null, profileFrom: i };
      byKey.set(key, group);
      order.push(group);
    }
    group.sources.push(i);
    /* The freshest card wins, and "freshest" is two things in order: when the
       browser last SAW the profile, and when the file was WRITTEN.
     *
     * The second one only decides ties, and ties are not rare: a profile's
     * `lastSeenAt` moves only when you visit your own profile, so two exports a
     * week apart of an account you never looked at in between carry the same
     * one. On a tie the old rule kept whichever file was opened LAST — open the
     * older archive second and it showed the older name. A tie is not a coin
     * toss: the later export is the one that knows more. */
    if (p && (group.profile === null ||
        profileFreshness(p, src) >= profileFreshness(group.profile, archive.sources[group.profileFrom]))) {
      group.profile = p;
      group.profileFrom = i;
    }
  }
  return order;
}

/**
 * Which of two cards is newer, as one comparable string.
 *
 * Both halves are ISO-8601, and for that format string order IS time order, so
 * concatenating them compares on the first and falls through to the second.
 * That is the whole trick, and it is why neither field is parsed into a number:
 * a missing one becomes '' and sorts first, which is what "unknown, so older"
 * should do.
 */
function profileFreshness(profile, src) {
  var seen = profile && typeof profile.lastSeenAt === 'string' ? profile.lastSeenAt : '';
  var made = src && src.envelope && typeof src.envelope.exportedAt === 'string' ? src.envelope.exportedAt : '';
  return seen + '|' + made;
}

function lastSeenMs(p) {
  var t = p && typeof p.lastSeenAt === 'string' ? Date.parse(p.lastSeenAt) : NaN;
  return isFinite(t) ? t : -Infinity;
}

/** What to call one group, for a file name and for saying what is happening. */
function groupLabel(group) {
  var p = group.profile;
  if (p && typeof p.screenName === 'string' && p.screenName.length > 0) return '@' + p.screenName;
  if (p && typeof p.name === 'string' && p.name.length > 0) return p.name;
  return archive.sources[group.sources[0]].file.name;
}

/** A file name that says whose archive this is and when it was written. */
function groupFileName(group, extension) {
  var handle = group.profile && typeof group.profile.screenName === 'string'
    ? group.profile.screenName : 'archive';
  var stamp = new Date().toISOString().slice(0, 10);
  return 'x-tweet-backup-' + handle.replace(/[^A-Za-z0-9_]/g, '_') + '-merged-' + stamp +
    '.' + (extension === 'zip' ? 'zip' : 'json');
}

/** The merged record indices belonging to one group, in the order on screen. */
function groupRecordIndices(group) {
  var inGroup = {};
  for (var i = 0; i < group.sources.length; i++) inGroup[group.sources[i]] = true;
  var out = [];
  for (var r = 0; r < archive.ranges.length; r++) {
    if (inGroup[archive.ranges[r].src] === true) out.push(r);
  }
  return out;
}

/**
 * Every roster row any archive in the group knows about, once each.
 *
 * Keyed by list and person, and the LATER sighting wins — a row carries when
 * that person was last seen and what their bio said then, so the newer one is
 * the better answer. Two exports of one account hold the same people, which is
 * why this is a union rather than a concatenation.
 */
async function groupConnections(group) {
  var byKey = new Map();
  var order = [];
  var unreachable = 0;

  for (var i = 0; i < group.sources.length; i++) {
    var src = archive.sources[group.sources[i]];
    if (src.envelope && src.envelope.hasRoster !== true) continue;
    var list = await envelopeArrayOf(src, 'connections');
    if (list === null) { unreachable++; continue; }
    for (var j = 0; j < list.length; j++) {
      var row = list[j];
      if (!row || typeof row !== 'object') continue;
      /* A space is a safe separator here and nowhere else: `list` is one of two
         known words and `userId` is digits, so neither can contain one. */
      var key = String(row.list) + ' ' + String(row.userId);
      var seen = byKey.get(key);
      if (seen === undefined) { byKey.set(key, row); order.push(row); continue; }
      if (lastSeenMs(row) >= lastSeenMs(seen)) {
        order[order.indexOf(seen)] = row;
        byKey.set(key, row);
      }
    }
  }
  return { rows: order, unreachable: unreachable };
}

/** Every deletion event any archive in the group knows about, once each. */
async function groupDeletions(group) {
  var seen = new Set();
  var out = [];
  var unreachable = 0;
  for (var i = 0; i < group.sources.length; i++) {
    var src = archive.sources[group.sources[i]];
    if (src.envelope && src.envelope.hasDeletions !== true) continue;
    var list = await envelopeArrayOf(src, 'deletions');
    if (list === null) { unreachable++; continue; }
    for (var j = 0; j < list.length; j++) {
      var key = JSON.stringify(list[j]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(list[j]);
    }
  }
  return { list: out, unreachable: unreachable };
}

/**
 * The envelope for one account, as an array of chunks.
 *
 * Chunks rather than one string: a hundred thousand records is tens of
 * megabytes, and `join` would hold two copies of that at once. The Blob
 * constructor takes the array directly.
 */
function envelopeChunks(records, options) {
  var parts = [];
  parts.push('{\n');
  parts.push('  "schemaVersion": ' + options.schemaVersion + ',\n');
  parts.push('  "generator": ' + jsonString(options.generator) + ',\n');
  parts.push('  "generatorVersion": ' + jsonString(options.generatorVersion) + ',\n');
  parts.push('  "exportedAt": ' + jsonString(options.exportedAt) + ',\n');
  parts.push('  "timezone": ' + JSON.stringify(options.timezone) + ',\n');
  parts.push('  "tweets": [');

  for (var i = 0; i < records.length; i++) {
    parts.push(i === 0 ? '\n    ' : ',\n    ');
    parts.push(JSON.stringify(records[i]));
  }
  if (records.length > 0) parts.push('\n  ');
  parts.push('],\n');

  parts.push('  "count": ' + records.length + ',\n');
  if (options.profile !== null) {
    parts.push('  "profile": ' + JSON.stringify(options.profile) + ',\n');
  }
  parts.push('  "deletions": ' + (JSON.stringify(options.deletions) || '[]'));
  /* Last, and only when there is something in it — the same rule the extension
     follows, so an archive from someone who never switched the roster on comes
     out byte-for-byte as it went in. */
  if (options.connections !== null && options.connections.length > 0) {
    parts.push(',\n  "connections": ' + JSON.stringify(options.connections, null, 2));
  }
  parts.push('\n}\n');
  return parts;
}

/**
 * Read the records of one group in display order.
 *
 * A record that appears in more than one archive is taken from its merged copy
 * — the same object the card renders — so what is written is what was on
 * screen. Reading one at a time keeps the memory down to a single record on top
 * of the result, and the result has to be held whole anyway: it is the file
 * about to be written.
 */
async function collectGroupRecords(indices, label) {
  var out = [];
  for (var k = 0; k < indices.length; k++) {
    var range = archive.ranges[indices[k]];
    var record = range.merged;
    if (record === undefined) {
      var res = await readRecordAt(sourceOf(indices[k]).source, range);
      record = res.ok ? res.value : null;
    }
    if (record !== null && record !== undefined) out.push(record);

    if ((k & 255) === 0) {
      progressSet(label + ' ' + k + ' / ' + indices.length + '…', indices.length ? k / indices.length : 1);
      await new Promise(function (r) { setTimeout(r, 0); });
      if (job.cancelled) return null;
    }
  }
  return out;
}

/* ------------------------------------------------------------ media, out -- */

/**
 * One media file's bytes, straight out of whichever archive holds them.
 *
 * A sibling of getMediaUrl rather than a use of it: that one wraps the bytes in
 * an object URL, tracks them in an LRU and pins what is on screen. None of that
 * helps here — this wants the Blob itself, once, and handing the whole archive
 * through a URL cache on the way to a file would be a detour with a leak at the
 * end of it.
 */
async function mediaBlobFor(key) {
  var range = await mediaRange(key);
  if (!range) return null;
  var owner = archive.sources[range.src];
  if (!owner) return null;
  var slice = owner.file.slice(range.start, range.end);
  if (slice.size === 0) return null;
  if (range.method === ZIP_METHOD.DEFLATE) return new Blob([await inflateRaw(slice)]);
  if (range.method !== ZIP_METHOD.STORE) return null;
  return slice;
}

/**
 * The file extension, read off the bytes.
 *
 * Sniffed rather than derived, because nothing else in the reader knows what a
 * media file IS: the ZIP records an entry's bytes and its method, and the type
 * was dropped when the archive was indexed. It is only a name — the index below
 * is what joins a file back to its post, so a wrong extension could not break a
 * re-open — but it is the name a person sees in their file manager, and a
 * photograph called `.bin` is a small daily annoyance that costs four lines to
 * avoid.
 */
function extensionFromBytes(bytes) {
  var b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return '.png';
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return '.jpg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return '.webp';
  if (b.length >= 4 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return '.webm';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return '.mp4';
  return '.bin';
}

/**
 * Every media file the records in one group point at, read out of the archives.
 *
 * Returns `{ entries, index }`, or null if the user stopped the job part way.
 *
 * A record naming a picture the archive never had is skipped rather than
 * failing: an export normally merges archives of which only some were captured
 * with media caching on, and refusing to write the file because one photograph
 * out of two hundred is missing would be the wrong trade. The count is reported.
 */
async function collectGroupMedia(indices, label) {
  var entries = [];
  var index = [];
  var seen = {};
  var missing = 0;

  for (var k = 0; k < indices.length; k++) {
    var range = archive.ranges[indices[k]];
    var record = range.merged;
    if (record === undefined) {
      var res = await readRecordAt(sourceOf(indices[k]).source, range);
      record = res.ok ? res.value : null;
    }
    if (record !== null && record !== undefined) {
      var list = Array.isArray(record.media) ? record.media : [];
      for (var m = 0; m < list.length; m++) {
        var mediaId = list[m] && list[m].id !== undefined && list[m].id !== null
          ? String(list[m].id) : String(m);
        var key = mediaKeyFor(record.id, mediaId);
        if (!key || seen[key] === true) continue;
        seen[key] = true;
        var blob = await mediaBlobFor(key);
        if (blob === null) { missing++; continue; }
        var head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
        var file = 'media/' + key.replace(' ', '_') + extensionFromBytes(head);
        entries.push({ name: file, blob: blob, date: new Date() });
        index.push({ file: file, tweetId: String(record.id), mediaId: mediaId, bytes: blob.size });
      }
    }

    if ((k & 127) === 0) {
      progressSet(label + ' ' + k + ' / ' + indices.length + '…', indices.length ? k / indices.length : 1);
      await new Promise(function (r) { setTimeout(r, 0); });
      if (job.cancelled) return null;
    }
  }
  return { entries: entries, index: index, missing: missing };
}

/* ---------------------------------------------------------------- zip out -- */

/** MS-DOS packed date and time, which is the only stamp a ZIP entry carries. */
function dosDateTime(date) {
  var d = date instanceof Date ? date : new Date();
  var year = d.getFullYear();
  if (!isFinite(year)) year = 1980;
  var day = ((year < 1980 ? 1980 : year) - 1980) << 9;
  day |= (d.getMonth() + 1) << 5;
  day |= d.getDate();
  var time = d.getHours() << 11;
  time |= d.getMinutes() << 5;
  time |= Math.floor(d.getSeconds() / 2);
  return { date: day & 0xFFFF, time: time & 0xFFFF };
}

/**
 * Build a ZIP, stored and not deflated.
 *
 * Stored because every file in it is a JPEG, a PNG or an MP4 — already
 * compressed — so deflating would cost processor time to make the file very
 * slightly larger. It also keeps this function from needing a compressor, which
 * the reader does not have and should not grow.
 *
 * One entry's bytes are held at a time, for its CRC, and then released: the
 * archive is assembled from the original Blobs, so peak memory is one file
 * rather than the whole download.
 *
 * The offsets are 32-bit, so this is valid up to 4 GB — past that a ZIP needs
 * ZIP64, and an archive that large is a different problem for a different day.
 */
async function buildZipStore(entries) {
  var encoder = new TextEncoder();
  var parts = [];
  var central = [];
  var offset = 0;

  for (var i = 0; i < entries.length; i++) {
    var name = encoder.encode(entries[i].name);
    var bytes = new Uint8Array(await entries[i].blob.arrayBuffer());
    var crc = crc32(bytes);
    var size = bytes.length;
    var stamp = dosDateTime(entries[i].date);

    var local = new Uint8Array(30 + name.length);
    var lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          /* version needed to extract */
    lv.setUint16(6, 0x0800, true);      /* the name below is UTF-8 */
    lv.setUint16(8, 0, true);           /* stored */
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);          /* no extra field */
    local.set(name, 30);

    /* The Blob goes into the output untouched; `bytes` existed only for the CRC
       and is dropped here rather than kept alive for the whole build. */
    parts.push(local, entries[i].blob);
    central.push({ name: name, crc: crc, size: size, offset: offset, stamp: stamp });
    offset += local.length + size;
  }

  var centralSize = 0;
  var centralParts = [];
  for (var c = 0; c < central.length; c++) {
    var e = central[c];
    var rec = new Uint8Array(46 + e.name.length);
    var rv = new DataView(rec.buffer);
    rv.setUint32(0, 0x02014b50, true);
    rv.setUint16(4, 20, true);          /* version made by */
    rv.setUint16(6, 20, true);          /* version needed */
    rv.setUint16(8, 0x0800, true);
    rv.setUint16(10, 0, true);
    rv.setUint16(12, e.stamp.time, true);
    rv.setUint16(14, e.stamp.date, true);
    rv.setUint32(16, e.crc, true);
    rv.setUint32(20, e.size, true);
    rv.setUint32(24, e.size, true);
    rv.setUint16(28, e.name.length, true);
    rv.setUint32(42, e.offset, true);
    rec.set(e.name, 46);
    centralParts.push(rec);
    centralSize += rec.length;
  }

  var end = new Uint8Array(22);
  var ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob(parts.concat(centralParts, [end]), { type: 'application/zip' });
}

/** Save a Blob, using the picker when there is one and only one file. */
async function saveBlob(blob, suggested, usePicker) {
  if (usePicker && typeof window.showSaveFilePicker === 'function') {
    /* The declared type follows the BYTES, and it used to be hardcoded to JSON.
     *
     * An archive with pictures in it is written as a ZIP — the container is the
     * reason those pictures travel at all — and it was being handed to the save
     * dialog as `application/json` under a `.zip` name. So the dialog's type box
     * said JSON, Windows filed the result as a JSON file, and the only thing
     * zip about the whole thing was the four letters at the end of the name.
     * Reported as 「合并导出仅仅名字是给了 zip，文件类型确实还不是」, and correct.
     *
     * The picker is also allowed to APPEND the extension of the accepted type
     * when the suggested name does not already end in one, which is how a
     * `.zip` name can come back as `.zip.json` — the same bug wearing a
     * different hat. Both are fixed by declaring what the file actually is. */
    var isZip = blob.type === 'application/zip';
    try {
      var handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [isZip
          ? { description: 'ZIP', accept: { 'application/zip': ['.zip'] } }
          : { description: 'JSON', accept: { 'application/json': ['.json'] } }]
      });
      var stream = await handle.createWritable();
      await stream.write(blob);
      await stream.close();
      return true;
    } catch (err) {
      /* Backing out of the picker means "do not save this", so nothing else is
         tried. Anything ELSE — and the likeliest other thing is the picker
         refusing because the click's activation was spent — must fall through
         to the download, or a file that was built is thrown away in silence. */
      if (err && err.name === 'AbortError') return false;
    }
  }
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = suggested;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
  return true;
}

/** Write the open archives out, one file per account. */
async function exportMerged() {
  if (archive.ranges.length === 0 || job.active) return;

  var groups = groupSourcesByAccount();
  var names = [];
  for (var g = 0; g < groups.length; g++) names.push(groupLabel(groups[g]));

  var question = groups.length === 1
    ? '把 ' + names[0] + ' 的归档写成一个文件？\n\n共 ' + groupRecordIndices(groups[0]).length +
      ' 条记录，按现在显示的顺序写入。\n有图片就写成 zip（连图片一起），没有就写成 json'
    : '把现在开着的归档按账号写成 ' + groups.length + ' 个文件？\n\n' + names.join('、') +
      '\n\n每个文件只装它自己那个账号的记录、资料和关注/粉丝名单。\n有图片的写成 zip，没有的写成 json';
  if (!window.confirm(question + '。\n\n浏览器可能会问一次"是否允许下载多个文件"。')) return;

  var written = [];
  var notes = [];
  var cancelled = false;

  for (var i = 0; i < groups.length; i++) {
    var group = groups[i];
    var label = groupLabel(group);
    var indices = groupRecordIndices(group);

    progressStart('正在写出…');
    progressSet('正在写出 ' + label + '…', 0);
    var records = await collectGroupRecords(indices, '正在写出 ' + label);
    if (records === null) { progressEnd(); cancelled = true; break; }

    progressSet('正在收集 ' + label + ' 的名单…', 0.9);
    var connections = await groupConnections(group);
    var deletions = await groupDeletions(group);
    progressEnd();

    var src0 = archive.sources[group.sources[0]];
    var chunks = envelopeChunks(records, {
      /* The OLDEST schema in the group. Stamping the newest would claim records
         written by an older version are newer than they are. */
      schemaVersion: groupSchemaVersion(group),
      generator: 'x-tweet-backup-reader',
      generatorVersion: READER_VERSION,
      exportedAt: new Date().toISOString(),
      timezone: src0.envelope.timezone || null,
      profile: group.profile,
      deletions: deletions.list,
      connections: connections.rows
    });

    /* The pictures, and the reason this writes a ZIP at all.
     *
     * This used to write JSON whatever it had been handed, which meant merging
     * two archives full of photographs and getting a text file back — the
     * records, and none of the pictures they name. Reported as "合并导出出来
     * 的是 json，我要的不是 zip 吗", and correct.
     *
     * A ZIP only when there is something to put in it. An archive with no media
     * is a text file, and a text file you can open and read is worth more than
     * a container holding the same text. */
    progressStart('正在打包媒体…');
    progressSet('正在从归档里取出 ' + label + ' 的媒体…', 0);
    var packed = await collectGroupMedia(indices, '正在取出 ' + label + ' 的媒体');
    progressEnd();
    if (packed === null) { cancelled = true; break; }

    var blob, fileName;
    if (packed.entries.length > 0) {
      var parts = [{ name: 'tweets.json',
                     blob: new Blob(chunks, { type: 'application/json' }),
                     date: new Date() }];
      for (var q = 0; q < packed.entries.length; q++) parts.push(packed.entries[q]);
      /* Written so a reader joins a file to its post by the index rather than by
         re-deriving the naming rule — the same reason the extension writes one. */
      parts.push({
        name: 'MEDIA-INDEX.json',
        blob: new Blob([JSON.stringify({
          generator: 'x-tweet-backup-reader',
          generatorVersion: READER_VERSION,
          generatedAt: new Date().toISOString(),
          note: 'Join against tweets.json: files[].tweetId === tweet.id and files[].mediaId === tweet.media[].id',
          fileCount: packed.index.length,
          files: packed.index
        }, null, 2) + '\n'], { type: 'application/json' }),
        date: new Date()
      });
      blob = await buildZipStore(parts);
      fileName = groupFileName(group, 'zip');
    } else {
      blob = new Blob(chunks, { type: 'application/json' });
      fileName = groupFileName(group, 'json');
    }

    /* The picker only when there is one file to place: three save dialogs in a
       row is not a question, it is an obstacle course. */
    var saved = await saveBlob(blob, fileName, groups.length === 1);
    if (!saved) { cancelled = true; break; }

    written.push({ label: label, records: records.length, size: blob.size,
                   rows: connections.rows.length, media: packed.entries.length });
    if (connections.unreachable) {
      notes.push(label + ' 有 ' + connections.unreachable + ' 个来源的名单不在可读范围内，没写进去');
    }
    if (deletions.unreachable) {
      notes.push(label + ' 有 ' + deletions.unreachable + ' 个来源的删除事件不在可读范围内，没写进去');
    }
    if (packed.missing > 0) {
      notes.push(label + ' 有 ' + packed.missing + ' 张图归档里本来就没有，跳过了');
    }
    /* Somebody has to yield, or the second download is blocked as a popup. */
    await new Promise(function (r) { setTimeout(r, 250); });
  }

  if (written.length === 0) {
    if (!cancelled) addNotice('没有写出任何文件。', 'warn');
    return;
  }
  var bits = [];
  for (var w = 0; w < written.length; w++) {
    bits.push('<b>' + esc(written[w].label) + '</b> ' + fmtCount(written[w].records) + ' 条' +
      (written[w].rows ? '、名单 ' + fmtCount(written[w].rows) + ' 人' : '') +
      (written[w].media ? '、图片 ' + fmtCount(written[w].media) + ' 张' : '') +
      '（' + fmtBytes(written[w].size) + '）');
  }
  addNotice('已写出 ' + written.length + ' 个文件：' + bits.join('；') +
    (cancelled ? '。<b>剩下的没有写。</b>' : '') +
    (notes.length ? '<br>' + esc(notes.join('；')) : ''), cancelled ? 'warn' : 'ok');
}

/** The oldest schema version among a group's sources. */
function groupSchemaVersion(group) {
  var oldest = null;
  for (var i = 0; i < group.sources.length; i++) {
    var v = archive.sources[group.sources[i]].envelope.schemaVersion;
    if (typeof v !== 'number') continue;
    if (oldest === null || v < oldest) oldest = v;
  }
  return oldest === null ? 1 : oldest;
}

el.exportBtn.addEventListener('click', function () { void exportMerged(); });
