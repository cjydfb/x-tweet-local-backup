/* ------------------------------------------------------------ progress --- */

/**
 * One progress bar for every long job in this file.
 *
 * The stop button is not decoration: a full-text search over a hundred thousand
 * posts takes seconds and a verify pass reads every byte. Both have to be
 * abandonable, and a job that is cancelled must leave the page usable, so the
 * cancel flag is checked by the job itself rather than by tearing anything down
 * from out here.
 */
var job = { active: false, cancelled: false, startedAt: 0 };

function progressStart(text) {
  job.active = true;
  job.cancelled = false;
  job.startedAt = performance.now();
  el.prog.classList.add('on');
  progressSet(text, 0);
}
function progressSet(text, frac) {
  el.progText.textContent = text;
  el.progFill.style.width = (frac <= 0 ? 0 : frac >= 1 ? 100 : frac * 100).toFixed(1) + '%';
}
function progressEnd() {
  job.active = false;
  el.prog.classList.remove('on');
}
el.progStop.addEventListener('click', function () {
  if (!job.active) return;
  job.cancelled = true;
  el.progText.textContent = '正在停止…';
});

/**
 * Supersede whatever list job is running.
 *
 * One function because three callers need the same three side effects, and each
 * of them was missing at least one. The generation stops a scan's VISITOR from
 * writing into a list it no longer owns; the cancel flag stops the scan LOOP;
 * progressEnd takes the bar down without waiting for a job that is about to
 * return early.
 *
 * `job.cancelled` is armed only when a job is actually running. Setting it
 * unconditionally is a trap: buildIndex's chunk loop stops on the same flag, so
 * an archive opened after a cancelled search would index nothing.
 */
function cancelScan() {
  search.gen++;
  if (job.active) job.cancelled = true;
  search.running = false;
  progressEnd();
}

/* --------------------------------------------------------------- reset --- */

function resetArchive() {
  /* Every one of these is derived from the file that was open and is meaningless
     for the next one. Clearing them in one place is what stops the previous
     archive's media map or search results from leaking into the next open. */
  /* Before anything else: stop whatever job is reading the file that is about to
     stop existing. */
  cancelScan();

  archive.sources = [];
  archive.file = null;
  archive.source = null;
  archive.kind = 'zip';
  archive.entries = null;
  archive.mediaMap = null;
  archive.mediaJoin = null;
  archive.mediaStats = null;
  archive.envelope = {};
  archive.profile = null;
  archive.accounts = [];
  archive.ranges = [];
  archive.headText = null;
  /* The file's own generation, bumped nowhere else. Record reads are keyed on
     this rather than on the list's generation, because a read that is in flight
     is stale only when the BYTES are gone — a tab click or a new search leaves
     the bytes exactly where they were. */
  archive.gen++;

  list.mode = 'timeline';
  list.tab = 'posts';
  list.scope = 'all';
  list.q = '';
  list.terms = [];
  search.running = false;
  search.scanned = 0;
  search.total = 0;
  search.hits = 0;

  clearIndexState();
  /* The roster belongs to the set of sources, and the set has just changed. */
  resetRoster();
  releaseAllUrls();
  el.win.textContent = '';
  el.spacer.style.height = '0px';
  el.scroller.scrollTop = 0;
  /* Both strips belong to the file that just closed. The report is rewritten by
     renderStats when the next one opens; the notice has nothing to say until
     something happens. */
  setReport('');
  reportSummary('');
  /* Reopened for the next file. A collapse chosen for one archive says nothing
     about the next one, and a reader staring at an empty bar wondering where
     the report went is worse than the prose they closed. */
  setReportClosed(false);
  say('');

  /* The header belongs to the file that just closed, and the collapsed chrome
     belongs to a scroll position in a list that no longer exists. Both start
     from their uncollapsed state for the next archive. */
  el.profile.hidden = true;
  el.profile.textContent = '';
  el.stickyBar.hidden = true;
  el.sbName.textContent = '';
  el.sbCount.textContent = '';
  el.tabs.hidden = true;
  paintTabs();
}

/* ------------------------------------------------------------- sources --- */

/**
 * One opened file, and everything derived from it.
 *
 * Before this was a value it was eight loose fields on `archive`, which is the
 * same thing while exactly one file is open and is not the same thing at all
 * once two are.
 */
function makeSource(file, kind, label) {
  return {
    file: file,
    kind: kind,
    label: label,
    source: null,            /* the tweets.json Blob — every offset is into THIS */
    entries: null,           /* the ZIP central directory, when there is one */
    mediaMap: null,          /* key -> index into the three typed arrays below */
    mediaJoin: null,
    mediaStats: null,
    mediaOffsets: null,
    mediaLengths: null,
    mediaMethods: null,
    ranges: [],              /* this file's records, in its own byte order */
    envelope: {},
    profile: null,
    arrayEnd: -1,
    headText: null,
    problems: [],
    indexMs: 0
  };
}

/**
 * Drop everything that is keyed by a record index.
 *
 * All of it is invalid the moment the merged array is rebuilt, and none of it
 * fails loudly when it is stale: a cached record under a recycled ordinal is
 * handed straight to a card with no read at all, so the screen shows one post
 * while the code believes it is looking at another. Called from the two places
 * that can renumber rows — a fresh open, and the source set changing.
 */
function clearIndexState() {
  cancelScan();
  list.hits = [];
  list.ids = null;
  /* Narrowing to an archive that has just been closed would leave the filter
     pointing at nothing. Every source-set change starts from "all" — and the
     address bar puts back whatever narrowing it asks for, from inside
     renderAccounts(), once the new source set exists. */
  accountIds = null;
  /* The three filter lists are a fact about the file that just closed. */
  invalidateFilters();
  heights = null;
  view.first = 0;
  view.last = 0;
  view.dirty = true;
  cache.clear();
  pending.clear();
  rendered.clear();
  jump.pending = null;
  jump.order = null;
  jump.orderChecked = false;
}

/**
 * Rebuild the merged index over `archive.sources`.
 *
 * The only place `archive.ranges` is written, and it is written in one go: a
 * half-built index is worse than the one it replaced, so everything is computed
 * first and assigned last.
 *
 * Each record gets `src` and `local` stamped onto it. They ride ON the range
 * rather than being derived from its position, because position stops meaning
 * anything the moment the merged order stops being "all of file 0, then all of
 * file 1" — which it does as soon as the timeline is sorted by time.
 */
function materialize() {
  var merged = [];
  for (var s = 0; s < archive.sources.length; s++) {
    var src = archive.sources[s];
    for (var i = 0; i < src.ranges.length; i++) {
      if (src.ranges[i].dropped === true) continue;   /* folded into another copy */
      src.ranges[i].src = s;
      src.ranges[i].local = i;
      merged.push(src.ranges[i]);
    }
  }
  archive.ranges = merged;
  /* Every ordinal just changed meaning. A read in flight is answering a
     question about a row that may no longer be that row. */
  archive.gen++;
}

/**
 * A cheap fingerprint of a record, wide enough not to collide by accident.
 *
 * Two 32-bit hashes and the length, because one 32-bit hash over twenty
 * thousand records has about a one-in-twenty chance of a collision somewhere —
 * and a collision here means two different posts judged identical, which is a
 * wrong answer rather than a slow one.
 */
function digestOf(text) {
  var h1 = 2166136261, h2 = 5381;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = ((h2 * 33) ^ c) >>> 0;
  }
  return h1.toString(36) + '.' + h2.toString(36) + '.' + text.length;
}

/**
 * Fold records that appear in more than one file into a single row.
 *
 * Two exports of one account are mostly the same posts, and showing each of
 * them twice is not a cosmetic problem: `byId`, `repliesOf` and all three tab
 * lists are keyed on the record index, so every duplicated reply would be drawn
 * twice under its parent and the count beside it would double.
 *
 * What is kept is not "one of them". The two copies differ in the ways that
 * matter for an archive — one may carry the deletion mark the other predates,
 * one may hold a newer edit, counts move — so they are merged with the same
 * rule the database uses, and a deleted post stays deleted.
 *
 * The cost is bounded by ONE pass and a fingerprint per record. Only records
 * that actually differ get a merged copy held in memory; the rest keep their
 * byte range and are read on demand exactly as before, which is the whole
 * reason this is a scan over fingerprints rather than a scan that materialises
 * the archive.
 *
 * Runs only when more than one file is open. A single file is never deduped —
 * doing so would make `ranges.length` disagree with the envelope's `count`, and
 * the reader would report a perfectly good file as having lost records.
 */
async function dedupeMergedSources() {
  var fileGen = archive.gen;   /* the source set, which must not change under us */
  var byId = new Map();
  var drop = new Set();
  var folds = [];

  /* A previous run's merged copies belong to a source set that no longer
     exists. */
  for (var s = 0; s < archive.sources.length; s++) {
    for (var q = 0; q < archive.sources[s].ranges.length; q++) {
      archive.sources[s].ranges[q].merged = undefined;
      archive.sources[s].ranges[q].dropped = false;
    }
  }

  /* The scan's visitor is SYNCHRONOUS by contract — scanRecords hands it a
     record decoded from a batch and never awaits it. So the folding cannot
     happen here; what happens here is deciding which records need folding, and
     the folding itself is a second pass below where awaiting is allowed. */
  /* beginScan, not archive.gen. scanRecords compares the generation it is
     handed against the SEARCH generation, and handing it the file generation
     makes every scan look superseded on its first batch — which is what
     "returns cancelled without doing anything" looks like from out here. */
  var gen = beginScan();
  progressStart('合并重复记录…');
  var scanned = await scanRecords(function (recIdx, r) {
    var id = r && typeof r.id === 'string' && r.id.length > 0 ? r.id : null;
    if (id === null) return;                 /* no key to match on: left alone */
    var range = archive.ranges[recIdx];
    var digest = digestOf(JSON.stringify(r));
    var seen = byId.get(id);

    if (seen === undefined) {
      byId.set(id, { range: range, digest: digest });
      return;
    }

    /* The same post seen twice. */
    drop.add(range);
    if (seen.digest === digest) return;      /* identical: nothing to fold in */
    folds.push({ keep: seen.range, fold: range });
    seen.digest = digest;
  }, gen, '合并重复记录…');
  progressEnd();

  if (scanned === 'cancelled' || fileGen !== archive.gen) return false;

  /* Only the records that actually DIFFER get here, and only their two byte
     ranges are held — the records themselves are re-read one at a time, so the
     memory this costs is one record rather than the whole archive. */
  if (folds.length > 0) {
    progressStart('合并重复记录…');
    for (var f = 0; f < folds.length; f++) {
      if (job.cancelled) { progressEnd(); return false; }
      progressSet('合并重复记录 ' + (f + 1) + ' / ' + folds.length + '…',
                  folds.length ? (f + 1) / folds.length : 1);

      var keep = folds[f].keep;
      var older = keep.merged;
      if (older === undefined) {
        var back = await readRecordAt(sourceOfRange(keep).source, keep);
        older = back.ok ? back.value : null;
      }
      if (older !== null) {
        var other = await readRecordAt(sourceOfRange(folds[f].fold).source, folds[f].fold);
        if (other.ok) {
          /* "The newest answer wins, unless it is empty" — and which of the two
             is newer is decided by when each was CAPTURED, not by which file it
             came from or which was opened first. */
          var a = capturedMs(older) <= capturedMs(other.value) ? older : other.value;
          var b = a === older ? other.value : older;
          keep.merged = mergeCapture(a, b);
        }
      }
      await new Promise(function (res) { setTimeout(res, 0); });
    }
    progressEnd();
  }

  if (drop.size > 0) {
    var kept = [];
    for (var i = 0; i < archive.ranges.length; i++) {
      if (drop.has(archive.ranges[i])) archive.ranges[i].dropped = true;
      else kept.push(archive.ranges[i]);
    }
    archive.ranges = kept;
  }
  return true;
}

/** When a record says it was captured, as a number. Missing sorts as oldest. */
function capturedMs(r) {
  var t = r && typeof r.capturedAt === 'string' ? Date.parse(r.capturedAt) : NaN;
  return isFinite(t) ? t : -Infinity;
}

/** The source a range object belongs to — used when only the range is in hand. */
function sourceOfRange(r) {
  return archive.sources[r.src];
}

/**
 * Put the merged list in time order.
 *
 * Without this a "merged" timeline is really two timelines end to end — every
 * post from the first file, then every post from the second — which is not what
 * looking at several accounts together means.
 *
 * One scan reads the timestamps. It parses each record, which is more than a
 * timestamp strictly needs, and it is the same cost as one search over the same
 * file: about a second for forty thousand records, with a progress bar and a
 * stop button, and it happens once per open.
 *
 * It also RESTORES an assumption the rest of the page depends on. The date jump
 * bisects the archive, and `detectOrder` decides which way it runs, both of
 * which assume the records are in time order. A merged list built by
 * concatenation is not — but a merged list that has been through here is, so
 * neither of those has to learn about sources at all.
 *
 * NEWEST FIRST, because that is the direction the extension writes and therefore
 * the direction a single file already reads in. This used to sort ascending, on
 * the reasoning that "in time order" was the whole requirement — and that was
 * wrong in a way only ever visible to someone holding two files: opening one
 * showed the newest post at the top, adding a second flipped the entire timeline
 * end for end. Two files and one file have to read the same way round. Nothing
 * downstream assumes a direction: `detectOrder` measures it.
 */
async function sortMergedByTime() {
  var fileGen = archive.gen;
  var times = new Map();          /* range object -> ms, dropped when this returns */
  var missing = 0;

  var gen = beginScan();
  progressStart('按时间排序…');
  var scanned = await scanRecords(function (recIdx, r) {
    var range = archive.ranges[recIdx];
    var t = r && typeof r.createdAt === 'string' ? Date.parse(r.createdAt) : NaN;
    if (!isFinite(t)) {
      /* A record with an unusable timestamp is not exiled to the end of the
         timeline: it falls back to when it was captured, and only then to the
         epoch. One broken field should not move a post a year away from its
         neighbours. */
      missing++;
      t = r && typeof r.capturedAt === 'string' ? Date.parse(r.capturedAt) : NaN;
      if (!isFinite(t)) t = 0;
    }
    times.set(range, t);
  }, gen, '按时间排序…');
  progressEnd();

  if (scanned === 'cancelled' || fileGen !== archive.gen) return false;

  var ordered = archive.ranges.slice();
  ordered.sort(function (a, b) {
    var ta = times.get(a), tb = times.get(b);
    if (ta !== tb) return tb - ta;          /* newest first — see above */
    /* Ties broken by source, so the order is the same on every open — a
       timeline that shuffles itself between two identical loads is impossible
       to reason about, and impossible to test. */
    return a.src - b.src;
  });
  archive.ranges = ordered;
  archive.gen++;
  return missing;
}

/**
 * Rebuild everything that depends on which files are open, in the right order.
 *
 * One entry point, because the order is not optional: the merged array has to
 * exist before duplicates can be folded into it, duplicates before it is sorted
 * (sorting first would only have to be redone), and all of it before anything
 * is drawn. `commitSources` is what finally publishes it.
 *
 * A single file is left exactly as it is: no folding, no sorting. Its own order
 * is the file's order, and that is worth preserving — an export is a record of
 * what the extension saw, and reordering one is not this page's business. What
 * the merge does have to match is the DIRECTION, which is why sortMergedByTime
 * sorts newest-first rather than merely "in order".
 */
async function rebuildFromSources() {
  materialize();
  if (archive.sources.length > 1) {
    if ((await dedupeMergedSources()) === false) return false;
    /* Folding renumbered every surviving row. */
    archive.gen++;
    if ((await sortMergedByTime()) === false) return false;
  }
  clearIndexState();
  commitSources();
  return true;
}

/* --------------------------------------------------------------- open ---- */

/** Total size of a list of files, for the "reading…" line. */
function totalSize(files) {
  var n = 0;
  for (var i = 0; i < files.length; i++) n += files[i].size;
  return n;
}

/**
 * Read one file and hand back a source, or the reason it could not be read.
 *
 * Reading and showing are two steps on purpose. This half fills a value and
 * cannot half-fill the page; nothing is published until every file asked for has
 * been read.
 */
async function readSource(file) {
  var head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  var isZip = head.length === 4 && head[0] === 0x50 && head[1] === 0x4B;
  var src = makeSource(file, isZip ? 'zip' : 'json', file.name);
  var read;
  if (isZip) {
    read = await openZipInto(src);
  } else {
    src.source = file;
    read = await indexSource(src, file, '（直接读取的 JSON）');
  }
  return read.ok === true ? { ok: true, src: src } : read;
}

/** Put the page into its "nothing is open yet" state. */
function armEmptyView() {
  el.drop.style.display = 'none';
  el.view.classList.remove('on');
  /* resetArchive has already hidden both. Repeated here because this block is
     where every visible thing is put into its starting state, and a header left
     over from the previous file is exactly the failure that guards against. */
  el.profile.hidden = true;
  el.tabs.hidden = true;
  el.stats.hidden = true;
  el.q.disabled = true;
  el.when.disabled = true;
  el.btnZone.disabled = true;
  el.btnAvatar.disabled = true;
  el.verify.disabled = true;
  /* A page showing one archive's roster cannot outlive that archive. */
  closeRoster();
  /* Repainted here rather than only after a rebuild. Closing the LAST archive
     goes through this function and not through commitSources, so without this
     the strip went on showing a chip for a file that is no longer open and the
     toolbar button went on saying 添加 when there is nothing to add to. */
  renderAccounts();
  if (el.exportBtn) el.exportBtn.disabled = true;
}

/**
 * Read several files and replace everything that is open with them.
 *
 * A file that cannot be read does not take the others down with it: a set the
 * user chose together is still worth opening minus one, and the report says
 * which one was left out. Only when NOTHING could be read does this fail
 * outright, because then there is no page left to put a warning on.
 */
async function openFiles(files) {
  var chosen = Array.prototype.slice.call(files || []).filter(function (f) {
    return f && typeof f.size === 'number' && f.size > 0;
  });
  if (chosen.length === 0) return;

  resetArchive();
  armEmptyView();
  say('正在读取 <b>' + esc(chosen[0].name) + '</b>' +
      (chosen.length > 1 ? ' 等 ' + chosen.length + ' 个文件' : '') +
      '（' + fmtBytes(totalSize(chosen)) + '）…');

  try {
    var sources = [];
    var refused = [];
    for (var i = 0; i < chosen.length; i++) {
      var got = await readSource(chosen[i]);
      if (got.ok === true) sources.push(got.src);
      else refused.push({ name: chosen[i].name, html: got.html });
    }
    if (sources.length === 0) {
      fail(refused.length ? refused[0].html : '这些文件都读不了。');
      return;
    }
    archive.sources = sources;
    if ((await rebuildFromSources()) === false) return;
    for (var j = 0; j < refused.length; j++) {
      addNotice('<b>' + esc(refused[j].name) + ' 没能打开</b>，其余 ' + sources.length +
        ' 个已经打开。' + refused[j].html, 'warn');
    }
  } catch (err) {
    fail('打开失败：' + esc(err && err.message ? err.message : err));
  }
}

/** Read more files and ADD them to what is already open. */
async function addFiles(files) {
  var chosen = Array.prototype.slice.call(files || []).filter(function (f) {
    return f && typeof f.size === 'number' && f.size > 0;
  });
  if (chosen.length === 0) return;

  var added = [];
  var refused = [];
  progressStart('正在读取…');
  try {
    for (var i = 0; i < chosen.length; i++) {
      var got = await readSource(chosen[i]);
      if (got.ok === true) added.push(got.src);
      else refused.push({ name: chosen[i].name, html: got.html });
    }
  } finally {
    progressEnd();
  }
  if (added.length === 0) {
    if (refused.length) addNotice('<b>' + esc(refused[0].name) + ' 没能打开。</b>' + refused[0].html, 'warn');
    return;
  }

  archive.sources = archive.sources.concat(added);
  if ((await rebuildFromSources()) === false) {
    /* The rebuild was cancelled. Take the new files back out rather than leaving
       the page describing a set the screen is not showing. */
    archive.sources = archive.sources.slice(0, archive.sources.length - added.length);
    await rebuildFromSources();
    return;
  }
  for (var j = 0; j < refused.length; j++) {
    addNotice('<b>' + esc(refused[j].name) + ' 没能打开。</b>' + refused[j].html, 'warn');
  }
}

/** Drop one source and rebuild without it. */
async function removeSourceAt(index) {
  if (index < 0 || index >= archive.sources.length) return;
  if (archive.sources.length === 1) { resetArchive(); armEmptyView(); el.drop.style.display = ''; return; }
  archive.sources.splice(index, 1);
  await rebuildFromSources();
}

/**
 * The file could not be opened, which is a verdict about the file — so it goes
 * in the report, not the transient strip, and the reader can come back to it.
 */
function fail(html) {
  reportSummary('这个文件打不开');
  setReport('<div class="box error">' + html + '</div>');
  say('');
  el.drop.style.display = '';
  el.view.classList.remove('on');
  progressEnd();
}

/**
 * Find the end-of-central-directory record and report where the directory is.
 *
 * The signature scan walks backwards from the end, so the first hit is the last
 * record in the file — which is the real one, since the directory sits before
 * it. Returns null when there is no EOCD in the bytes given.
 */
function readEocd(bytes, base) {
  if (bytes.length < 22) return null;
  var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (var i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054B50) {
      return {
        cdOffset: view.getUint32(i + 16, true),
        cdSize: view.getUint32(i + 12, true),
        count: view.getUint16(i + 10, true)
      };
    }
  }
  return null;
}

/* A media archive's central directory is not small. Each entry costs about
   ninety bytes — a name like `media/1900000000000000000_1800000000000000000.png`
   is most of it — so a few thousand images put the directory well past the 64 KB
   a naive tail read covers, and the archive refuses to open with "the directory
   is not in the bytes we read". Nine megabytes of directory for a hundred
   thousand files is the case this bound has to survive; beyond that something is
   wrong with the file, and saying so beats allocating. */
var MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;

async function openZipInto(src) {
  var file = src.file;
  var probeLen = Math.min(65536, file.size);
  var probeOffset = file.size - probeLen;
  var tail = new Uint8Array(await file.slice(probeOffset, file.size).arrayBuffer());
  var tailOffset = probeOffset;

  var eocd = readEocd(tail, probeOffset);
  if (eocd && eocd.cdOffset < probeOffset) {
    if (file.size - eocd.cdOffset > MAX_CENTRAL_DIRECTORY) {
      return { ok: false, html: '这个 ZIP 的中央目录有 ' + fmtBytes(file.size - eocd.cdOffset) +
        '，超过这个页面愿意一次读入的上限（' + fmtBytes(MAX_CENTRAL_DIRECTORY) + '）。' +
        '归档可能有问题，或者条目实在太多。' };
    }
    tailOffset = eocd.cdOffset;
    tail = new Uint8Array(await file.slice(tailOffset, file.size).arrayBuffer());
  }

  var dir = parseZipDirectory(tail, tailOffset, file.size);
  if (!dir.ok) {
    if (dir.zip64) {
      return { ok: false, html: '这个 ZIP 读不了：' + esc(dir.error) +
        '<br><br><b>这是 ZIP64 归档。</b>媒体多、归档超过 4 GB 时会触发。' +
        '目前还没实现 ZIP64 解析——这是已知缺口，不是文件损坏。<br>' +
        '临时办法：直接打开配套的 <code>x-tweet-backup-日期.json</code>，推文数据是一样的。' };
    }
    return { ok: false, html: '这个 ZIP 读不了：' + esc(dir.error) };
  }
  src.entries = dir.entries;

  var entry = null;
  for (var i = 0; i < dir.entries.length; i++) {
    if (dir.entries[i].name === 'tweets.json') { entry = dir.entries[i]; break; }
  }
  if (!entry) {
    var names = dir.entries.slice(0, 20).map(function (e) { return e.name; }).join('、');
    return { ok: false, html: '这个 ZIP 里没有 <code>tweets.json</code>。包内条目：' + esc(names) };
  }

  /* The media map is built from the directory alone — no entry data is read.
     Doing it before the index means the timeline can render media on the very
     first frame instead of filling in afterwards. */
  progressStart('正在读取 ZIP 目录…');
  await collectMedia(src, dir.entries);
  progressEnd();

  var range = await locateEntryData(file, entry);
  var raw = file.slice(range.start, range.end);

  if (entry.method === ZIP_METHOD.STORE) {
    /* Stored uncompressed: the bytes in the ZIP ARE the JSON, so byte offsets
       into this slice are stable and records can be re-read at will. */
    src.source = raw;
    return indexSource(src, raw, 'ZIP 内 <code>tweets.json</code>（未压缩存储，可随机读取）');
  }
  if (entry.method === ZIP_METHOD.DEFLATE) {
    say('<div class="box warn"><b>归档里的 tweets.json 是压缩存储的。</b><br>' +
        '压缩流无法随机定位——要读第 5000 条就必须从头解压一遍。当前版本会把它整个解压进内存，' +
        '推文多时会很吃内存。<br>正在解压…</div>', 'warn');
    var inflated = await inflateRaw(raw);
    /* CRC is the proof that what came out is exactly what went in. */
    var actual = crc32(inflated);
    if (actual !== entry.crc) {
      return { ok: false, html: '<b>解压校验失败：CRC 不匹配。</b><br>' +
        '期望 ' + entry.crc.toString(16) + '，实际 ' + actual.toString(16) +
        '。归档可能已损坏——<b>不要</b>基于这份数据做合并，先换一份文件。' };
    }
    src.source = new Blob([inflated]);
    return indexSource(src, src.source, 'ZIP 内 <code>tweets.json</code>（已解压，CRC 校验通过）');
  }
  return { ok: false, html: '归档里的 tweets.json 用了不支持的压缩方式（method=' + entry.method + '）' };
}

/** Inflate a whole deflate-raw stream. Used only when an entry is compressed. */
async function inflateRaw(blob) {
  var stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* --------------------------------------------------------------- media --- */

/**
 * Index every media file in the ZIP by `<tweetId> <mediaId>`.
 *
 * What is kept per file is three numbers — where its data starts, how long it
 * is, and how it is compressed. Nothing else, and deliberately: this archive
 * shape can hold a hundred thousand files, and keeping the directory entries
 * themselves (each with a name string and an object) would cost twenty to
 * twenty-five megabytes for data this page can regenerate from three numbers.
 *
 * The names are used once, here, and then dropped.
 *
 * There are two ways to build the key, and which one is in use is recorded
 * rather than guessed at:
 *   - `MEDIA-INDEX.json`, when the ZIP has it, states tweetId and mediaId per
 *     file outright. That is the extension's own mapping and it is authoritative.
 *   - otherwise the key comes from the file name. It works, but it is a rule
 *     re-derived from a convention, and it is the reason the name parser splits
 *     at the first underscore instead of the last.
 */
async function collectMedia(src, entries) {
  var file = src.file;
  var names = [];
  var byName = new Map();
  var indexEntry = null;

  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e || typeof e.name !== 'string') continue;
    if (e.name === 'MEDIA-INDEX.json') indexEntry = e;
    if (e.name.lastIndexOf('media/', 0) !== 0) continue;
    if (e.name.charAt(e.name.length - 1) === '/') continue;   /* a directory row */
    if (byName.has(e.name)) continue;
    byName.set(e.name, e);
    names.push(e.name);
  }

  if (names.length === 0) {
    src.mediaMap = null;
    src.mediaJoin = null;
    src.mediaStats = null;
    return;
  }

  /* A guard against a pathological index, not against a big one: a megabyte of
     JSON covers several thousand files, and past a few megabytes the parse is
     slower than the fallback it would replace. */
  var pairs = null;
  if (indexEntry && indexEntry.size > 0 && indexEntry.size <= 8 * 1024 * 1024) {
    try {
      var ir = await locateEntryData(file, indexEntry);
      var rawBlob = file.slice(ir.start, ir.end);
      var text = indexEntry.method === ZIP_METHOD.DEFLATE
        ? new TextDecoder().decode(await inflateRaw(rawBlob))
        : await rawBlob.text();
      var parsed = JSON.parse(text);
      if (parsed && Array.isArray(parsed.files)) pairs = parsed.files;
    } catch (_) {
      pairs = null;   /* a damaged index must fall back, not abort the open */
    }
  }

  var map = new Map();
  var offs = [], lens = [], meths = [];
  var skipped = 0;

  function add(key, entry) {
    if (!key || map.has(key)) return;
    map.set(key, offs.length);
    offs.push(entry.localOffset);
    lens.push(entry.compSize);
    meths.push(entry.method);
  }

  if (pairs) {
    for (var p = 0; p < pairs.length; p++) {
      var row = pairs[p];
      if (!row || typeof row.file !== 'string') continue;
      var target = byName.get(row.file);
      if (!target) { skipped++; continue; }
      var key = mediaKeyFor(row.tweetId, row.mediaId);
      if (key) add(key, target);
    }
    src.mediaJoin = 'index';
  } else {
    for (var n = 0; n < names.length; n++) {
      var k = mediaKeyFromEntryName(names[n]);
      if (k) add(k, byName.get(names[n]));
    }
    src.mediaJoin = 'names';
  }

  /* Files the index does not mention still get a key from their name. Without
     this, an index written by an older version — or one that lists only what it
     happened to emit — would make present files unreadable. */
  for (var m = 0; m < names.length; m++) {
    var k2 = mediaKeyFromEntryName(names[m]);
    if (k2) add(k2, byName.get(names[m]));
  }

  src.mediaMap = map;
  src.mediaOffsets = Float64Array.from(offs);
  src.mediaLengths = Uint32Array.from(lens);
  src.mediaMethods = Uint8Array.from(meths);
  src.mediaStats = { files: names.length, keyed: map.size, skipped: skipped };
}

/**
 * Where a media file's bytes are, resolved on first use.
 *
 * `locateEntryData` reads thirty bytes of local header per call, which is why
 * this is lazy: doing it for every file at open would be a multi-second stall on
 * a large archive, and most of those files will never be looked at.
 */
var mediaLocations = new Map();

/**
 * Which open file holds a media key, and where in it.
 *
 * A UNION over the open archives rather than any one file's map, and it also
 * answers "is this media present at all" — which is the question the cards and
 * the post page actually ask. Left pointing at one file, every image in the
 * other archives would be reported as "文件不在这个归档里": a wrong answer that
 * looks exactly like a right one.
 *
 * Entries are `{src, idx}` and the key is `<tweetId> <mediaId>`, so two exports
 * of the SAME account collide here — and that is harmless, because both byte
 * ranges hold the same picture. The first wins.
 */
function rebuildMediaUnion() {
  var map = new Map();
  for (var s = 0; s < archive.sources.length; s++) {
    var src = archive.sources[s];
    if (!src.mediaMap) continue;
    src.mediaMap.forEach(function (idx, key) {
      if (!map.has(key)) map.set(key, { src: s, idx: idx });
    });
  }
  archive.mediaMap = map.size > 0 ? map : null;
}

/** The union entry for a media key, or null. */
function mediaEntryFor(key) {
  if (!archive.mediaMap) return null;
  var hit = archive.mediaMap.get(key);
  return hit === undefined ? null : hit;
}

async function mediaRange(key) {
  var hit = mediaLocations.get(key);
  if (hit) return hit;
  var found = mediaEntryFor(key);
  if (found === null) return null;
  var src = archive.sources[found.src];
  if (!src) return null;
  var entry = {
    localOffset: src.mediaOffsets[found.idx],
    compSize: src.mediaLengths[found.idx],
    method: src.mediaMethods[found.idx]
  };
  var r = await locateEntryData(src.file, entry);
  var out = { start: r.start, end: r.end, method: entry.method, src: found.src };
  /* Bounded: this is a cache of thirty-byte header reads, and an archive can
     hold a hundred thousand files. Anything evicted here is one re-read away. */
  if (mediaLocations.size > 4000) mediaLocations.clear();
  mediaLocations.set(key, out);
  return out;
}

/* ------------------------------------------------------------- indexing -- */

/**
 * One pass over the file with no parsing: record the byte range of every element
 * of the top-level tweets array and nothing else.
 *
 * The result is what makes the rest of this file possible. It costs about a
 * hundred bytes per record and it is the only thing that grows with the archive;
 * the record bodies stay on disk until a card is about to be shown.
 */
async function indexSource(src, source, sourceLabel) {
  var started = performance.now();
  var scanner = createArrayScanner(0);
  src.headText = null;   /* the envelope probe is per-file */
  src.label = sourceLabel;

  /* The last 256 KB, decoded at most once. Two checks below want it — the
     roster, and the profile when the forward probe did not reach it — and on an
     archive without a roster, which is most of them, both would otherwise read
     and decode the same window. */
  var fileTailText = null;
  async function tailOfFile() {
    if (fileTailText === null) {
      fileTailText = new TextDecoder().decode(new Uint8Array(
        await source.slice(Math.max(0, source.size - 262144), source.size).arrayBuffer()));
    }
    return fileTailText;
  }

  var probeSize = Math.min(4096, source.size);
  var headerProbe = new Uint8Array(await source.slice(0, probeSize).arrayBuffer());
  var arrayStart = findTweetsArray(headerProbe, 0, headerProbe.length);

  if (arrayStart < 0) {
    /* The key may sit past the first 4 KB — a large envelope, or a roster
       section placed before the tweets. Widen the probe, and keep the wider
       buffer, because the envelope fields are read out of it afterwards. */
    probeSize = Math.min(262144, source.size);
    headerProbe = new Uint8Array(await source.slice(0, probeSize).arrayBuffer());
    arrayStart = findTweetsArray(headerProbe, 0, headerProbe.length);
  }
  if (arrayStart < 0) {
    return { ok: false, html: '这个文件里找不到顶层的 <code>"tweets"</code> 数组——它可能不是本扩展导出的 JSON。' };
  }

  scanner.pos = arrayStart;
  say('正在建立索引（只读一遍，不加载正文）…');
  progressStart('建立索引…');

  await eachChunk(
    source,
    SCAN_CHUNK,
    function (bytes, offset) {
      if (!scanner.closed) {
        /* Only the part that overlaps the array matters. */
        var from = Math.max(0, arrayStart - offset);
        if (from < bytes.length) scanChunk(scanner, bytes.subarray(from), offset + from);
      }
      progressSet('建立索引…已读 ' + fmtBytes(Math.min(offset + bytes.length, source.size)),
                  source.size ? Math.min(offset + bytes.length, source.size) / source.size : 1);
    },
    function () { return scanner.closed || job.cancelled; }
  );

  var elapsed = performance.now() - started;
  progressEnd();

  if (job.cancelled && !scanner.closed) {
    return { ok: false, html: '索引建立已取消。文件没有被修改，重新打开即可。' };
  }

  /* ---------------------------------------------------------------------
   * Integrity: the whole point. Every check below either passes or is
   * reported. Nothing is silently dropped.
   * ------------------------------------------------------------------- */
  var problems = scanner.problems.slice();
  var expectedCount = readEnvelopeNumber(src, headerProbe, 'count');

  /* Everything the envelope says AFTER the tweets array — `count`, `deletions`,
     `connections` — is twenty megabytes past where a head probe looks on a real
     archive, because the array comes first and is most of the file. Probing
     forward from the array's closing bracket is one small read and lands exactly
     where those keys are.
     Getting this wrong is not cosmetic: it is the difference between the
     integrity check running and never running, and between telling someone
     their follow lists are in the file and staying silent about it. */
  var tailKeys = '';
  if (scanner.closed) {
    var afterFrom = scanner.endOffset;
    tailKeys = new TextDecoder().decode(new Uint8Array(
      await source.slice(afterFrom, Math.min(afterFrom + 262144, source.size)).arrayBuffer()));

    if (expectedCount === null) {
      var cm = tailKeys.match(/"count"\s*:\s*(\d+)/);
      if (cm) expectedCount = Number(cm[1]);
    }
  }

  if (!scanner.closed) {
    problems.push({
      at: scanner.pos, kind: 'array-not-closed',
      detail: '扫到文件末尾也没等到 tweets 数组的收尾括号——文件可能被截断，最后一条记录可能不完整'
    });
  }
  if (expectedCount !== null && expectedCount !== scanner.elements.length) {
    problems.push({
      at: -1, kind: 'count-mismatch',
      detail: '信封里写着 count=' + expectedCount + '，实际扫到 ' + scanner.elements.length +
              ' 条。差额 ' + Math.abs(expectedCount - scanner.elements.length) + ' 条——这是数据丢失，必须查清'
    });
  }

  src.ranges = scanner.elements;
  src.arrayEnd = scanner.closed ? scanner.endOffset : -1;

  /* The follow roster rides AFTER the tweets array, which puts it outside
     everything this page displays. Saying so is not a nicety: this file is
     opened by someone whose account is gone, and a reader that showed only posts
     would leave them believing the file never had their follow lists. Presence
     is all that is reported — counting the rows would mean scanning them, and
     the useful message is "it is in here, another tool reads it".
     The roster's own contents can run to megabytes, so when the forward probe
     does not reach the key the end of the file is checked as well: the key is
     the first thing after the section starts, but the section can start a long
     way in.

     envelopeHasList, not a bare key scan: an EMPTY array is not a list, and
     `deletions` is written on every export whether or not anything was deleted.
     See that function for what the bare scan got wrong. */
  var hasRoster = envelopeHasList(tailKeys, 'connections');
  if (!hasRoster && source.size > 0) {
    hasRoster = envelopeHasList(await tailOfFile(), 'connections');
  }
  var hasDeletions = envelopeHasList(tailKeys, 'deletions');

  src.envelope = {
    count: expectedCount,
    schemaVersion: readEnvelopeNumber(src, headerProbe, 'schemaVersion'),
    generatorVersion: readEnvelopeString(src, headerProbe, 'generatorVersion'),
    exportedAt: readEnvelopeString(src, headerProbe, 'exportedAt'),
    timezone: readEnvelopeTimeZone(src, headerProbe),
    hasRoster: hasRoster,
    hasDeletions: hasDeletions
  };

  /* ---------------------------------------------------------------------
   * The account's own profile: one object in the envelope, not a record.
   *
   * Looked for in the forward probe first, because that is where the writer
   * puts the envelope's scalar section (it is where `count` was found). The head
   * probe is the fallback for a file that was assembled by hand with the profile
   * near the top — and it is the same probe the tweets array itself was found
   * with, so anything placed before the array is inside it by construction.
   *
   * The last resort is the end of the file, the same probe the roster check
   * makes and for the same reason: the scalar section is the first thing after
   * the array, but a section that grows (a roster of megabytes) pushes what
   * follows it out of a fixed window. Without this, an archive whose profile
   * sits past the window would be reported as an archive that has no profile —
   * a wrong answer rather than an absent one.
   * ------------------------------------------------------------------- */
  src.profile = readEnvelopeProfile(tailKeys);
  if (!src.profile) src.profile = readEnvelopeProfile(decodeHead(src, headerProbe));
  if (!src.profile && scanner.closed && source.size > scanner.endOffset + 262144) {
    src.profile = readEnvelopeProfile(await tailOfFile());
  }

  src.problems = problems;
  src.indexMs = elapsed;
  return { ok: true };
}

/* ------------------------------------------------------------- the merge -- */

/**
 * The envelope as seen by the page, over however many sources are open.
 *
 * With one source it is that source's own object, handed back untouched — which
 * is what keeps a single-file open exactly as it was, down to `count` being
 * null when the key could not be read, since the integrity report is a
 * statement about that file.
 *
 * With several, `count` becomes the merged record count and the version fields
 * take the OLDEST of the sources: stamping the newest would claim records
 * written by an older schema are newer than they are.
 */
/**
 * Every open source's profile, in the order the files were opened.
 *
 * A source with no profile is skipped rather than represented by a hole: an
 * archive too old to carry one is not an account, it is a file that says
 * nothing about which account it is.
 */
function accountProfiles() {
  var out = [];
  for (var i = 0; i < archive.sources.length; i++) {
    var p = archive.sources[i].profile;
    if (p && typeof p === 'object') out.push(p);
  }
  return out;
}

function mergedEnvelope() {
  if (archive.sources.length === 1) return archive.sources[0].envelope;
  var out = {
    count: archive.ranges.length,
    schemaVersion: null,
    generatorVersion: null,
    exportedAt: null,
    timezone: null,
    hasRoster: false,
    hasDeletions: false
  };
  for (var i = 0; i < archive.sources.length; i++) {
    var e = archive.sources[i].envelope || {};
    if (typeof e.schemaVersion === 'number' &&
        (out.schemaVersion === null || e.schemaVersion < out.schemaVersion)) {
      out.schemaVersion = e.schemaVersion;
    }
    if (out.generatorVersion === null) out.generatorVersion = e.generatorVersion;
    if (out.exportedAt === null) out.exportedAt = e.exportedAt;
    if (out.timezone === null) out.timezone = e.timezone;
    out.hasRoster = out.hasRoster || e.hasRoster === true;
    out.hasDeletions = out.hasDeletions || e.hasDeletions === true;
  }
  return out;
}

/**
 * Point the page at what is open, and repaint everything that depends on it.
 *
 * The UI half of opening, split from the reading half so that opening a second
 * file does not have to re-run — and cannot accidentally re-run — the parts
 * that only make sense for the whole set.
 */
function commitSources() {
  var only = archive.sources.length === 1 ? archive.sources[0] : null;

  /* With more than one source open the media path has not been taught about
     sources yet, so these stay null rather than pointing at whichever file
     happened to be first — a wrong answer that would look like a right one.
     `archive.profile` is deliberately null for a merged multi-account file:
     there is no honest single account to put in that header. */
  archive.file = only ? only.file : null;
  archive.source = only ? only.source : null;
  archive.kind = only ? only.kind : 'zip';
  archive.entries = only ? only.entries : null;
  archive.mediaJoin = only ? only.mediaJoin : null;
  archive.mediaOffsets = only ? only.mediaOffsets : null;
  archive.mediaLengths = only ? only.mediaLengths : null;
  archive.mediaMethods = only ? only.mediaMethods : null;
  /* Always the union, even for one file — one shape instead of two, so nothing
     downstream has to ask how many are open before it can read a media entry. */
  rebuildMediaUnion();
  archive.mediaStats = mergedMediaStats();
  archive.arrayEnd = only ? only.arrayEnd : -1;
  archive.envelope = mergedEnvelope();
  /* The account(s) behind what is open.
     Not `only ? only.profile : null` any more: that hid the header as soon as a
     second file was opened, which is the ordinary way these are read — two
     exports of the same account are two files. `archive.accounts` is what to
     draw when they really are different accounts and no single card is true. */
  archive.accounts = accountProfiles();
  archive.profile = sharedProfile(archive.accounts);

  /* The job is over, so the transient strip has nothing left to say. Without
     this, "正在读取 xxx…" sits under the report until something else happens. */
  say('');
  renderStats(only ? only.label : mergedLabel(), only ? only.indexMs : 0, allProblems());
  el.view.classList.add('on');
  el.q.disabled = false;
  el.when.disabled = false;
  el.btnAvatar.disabled = false;
  el.verify.disabled = false;
  if (el.exportBtn) el.exportBtn.disabled = false;
  applyZone();

  renderAccounts();

  /* After applyZone: the header's join date is rendered in the display zone. */
  /* The chrome follows the address, not the file set — see paintHeader. This
     runs after `renderAccounts()` has already applied the address once, so it
     is deliberately painting the same answer a second time rather than asking
     anything new; paintHeader is written to be safe to repeat. */
  el.tabs.hidden = false;
  paintHeader(parseHash());

  /* Compose before sizing: the height table is built from the list, so the list
     has to be settled first. clearIndexState left `ids` null, which is the whole
     archive in its own order — but going through the same two calls the search
     and the tabs use is what keeps there being only one way to change the list. */
  composeList();
  applyList(false);
}

/**
 * Media totals over every open archive.
 *
 * With one file this is that file's own numbers, handed back unchanged — the
 * stats line is a statement about the file that was opened, and it reads the
 * same as it always did.
 */
function mergedMediaStats() {
  if (archive.sources.length === 1) return archive.sources[0].mediaStats;
  var files = 0, keyed = 0, skipped = 0, any = false;
  for (var i = 0; i < archive.sources.length; i++) {
    var s = archive.sources[i].mediaStats;
    if (!s) continue;
    any = true;
    files += s.files; keyed += s.keyed; skipped += s.skipped;
  }
  return any ? { files: files, keyed: keyed, skipped: skipped } : null;
}

/** What the stats line calls the merged archive. */
function mergedLabel() {
  var parts = [];
  for (var i = 0; i < archive.sources.length; i++) {
    var h = handleOf(archive.sources[i]);
    parts.push(esc(h === null ? archive.sources[i].file.name : '@' + h));
  }
  return (archive.sources.length === 0 ? '' : parts.join(' + '));
}

/** The handle a source's own profile claims, or null. */
function handleOf(src) {
  var p = src && src.profile;
  var h = p && typeof p.screenName === 'string' ? p.screenName : '';
  return h.length > 0 ? h : null;
}

/** Every problem any source reported, labelled with which file it came from. */
function allProblems() {
  if (archive.sources.length === 1) return archive.sources[0].problems;
  var out = [];
  for (var i = 0; i < archive.sources.length; i++) {
    var who = archive.sources.length > 1 ? (archive.sources[i].file.name + '：') : '';
    for (var j = 0; j < archive.sources[i].problems.length; j++) {
      var p = archive.sources[i].problems[j];
      out.push({ at: p.at, kind: p.kind, detail: who + p.detail });
    }
  }
  return out;
}

/**
 * Read a scalar out of the envelope without parsing the whole document.
 * The head is decoded once and matched; numbers and short strings only, so a
 * few KB is always enough — and if it is not, the value comes back null and is
 * displayed as unknown rather than as a wrong number.
 *
 * KNOWN LIMIT: past 256 KB of envelope the probe stops growing and these return
 * null. That is the honest failure — an absent `count` is reported as "未读到"
 * and the integrity check is skipped, rather than comparing against a number
 * scraped out of the middle of somebody's post text.
 */
function readEnvelopeNumber(src, head, key) {
  var m = decodeHead(src, head).match(new RegExp('"' + key + '"\\s*:\\s*(-?\\d+)'));
  return m ? Number(m[1]) : null;
}
function readEnvelopeString(src, head, key) {
  var m = decodeHead(src, head).match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
  return m ? m[1] : null;
}
/** The export's own timezone block: a fixed offset plus the name it came from. */
function readEnvelopeTimeZone(src, head) {
  var text = decodeHead(src, head);
  var block = text.match(/"timezone"\s*:\s*\{([^}]*)\}/);
  if (!block) return null;
  var inner = block[1];
  var off = inner.match(/"offsetMinutes"\s*:\s*(-?\d+)/);
  if (!off) return null;
  var name = inner.match(/"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return { offsetMinutes: Number(off[1]), name: name ? name[1] : null };
}
/** The head probe's decoded text, cached per source rather than per page. */
function decodeHead(src, head) {
  if (src.headText === null) src.headText = new TextDecoder().decode(head);
  return src.headText;
}
