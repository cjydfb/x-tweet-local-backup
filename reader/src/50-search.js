/* -------------------------------------------------------------- search --
 *
 * Full-text search that does not undo the memory design.
 *
 * The whole point of the byte-offset index is that a hundred thousand posts cost
 * a few megabytes of heap. Parsing every record to search would throw that away
 * in one go, so the scan reads the file in batches, parses each record out of the
 * batch buffer, tests it, and then lets it go: only the *positions* of the
 * matches are kept.
 *
 * The index already holds exact byte ranges, so the scan walks those rather than
 * re-scanning the byte stream. That is both faster and, more importantly, it
 * stops at the end of the tweets array by construction — the `connections` roster
 * that follows it is never read, and on a large archive that section alone is
 * tens of megabytes.
 * ------------------------------------------------------------------------ */

var SEARCH_BATCH = 400;
var SEARCH_MIN_CHARS = 1;

/**
 * Back to the timeline, with no query.
 *
 * `cancelScan()` comes first and is the part that is easy to leave out. Without
 * it an in-flight search keeps running: its visitor's `search.gen !== gen` guard
 * still passes, so it goes on appending to the list that was just emptied, and
 * when it finishes it takes the progress bar down, re-renders the timeline and
 * prints a search result message over it. Nothing about that is visible until
 * the scan lands, several hundred milliseconds later.
 */
function timelineMode() {
  cancelScan();
  list.mode = 'timeline';
  list.q = '';
  list.terms = [];
  list.hits = [];
  search.hits = 0;
  composeList();
  applyList(true);
  say('');
}

/**
 * Everything that has to happen after the displayed list changes shape.
 *
 * One function because these steps are one operation: the height table is sized
 * from `list.length()`, which only reads correctly once `list.ids` has been
 * composed, and the window can only be placed once the table exists. Splitting
 * them is exactly how the search path came to append rows to a table that had
 * been built for the whole archive.
 *
 * The record cache is deliberately NOT cleared: it is keyed by record index, and
 * the same record is the same record whichever list is showing it.
 */
function applyList(resetScroll) {
  if (resetScroll) el.scroller.scrollTop = 0;
  clearWindow();
  rebuildHeights();
  paintStickyBar();
  renderWindow(true);
  statsLine();
}

/**
 * Everything about a record that is worth searching, as one lowercased string.
 *
 * Concatenated rather than tested field by field so that every term has to be
 * present somewhere in the record: "alice photo" finds a post by @alice that has
 * a photo, which is the behaviour a search box implies. The expanded URL is
 * included because it is the only real address the archive holds — the t.co link
 * in the text is a redirect that will stop resolving long before the archive
 * does.
 */
function searchHaystack(r) {
  var parts = [];
  if (typeof r.text === 'string') parts.push(r.text);
  parts.push(String(r.id || ''));
  var a = r.author && typeof r.author === 'object' ? r.author : {};
  if (a.name) parts.push(String(a.name));
  if (a.screenName) parts.push(String(a.screenName));

  var ents = r.entities && typeof r.entities === 'object' ? r.entities : {};
  if (Array.isArray(ents.hashtags)) parts.push(ents.hashtags.join(' '));
  if (Array.isArray(ents.mentions)) {
    for (var i = 0; i < ents.mentions.length; i++) {
      var m = ents.mentions[i];
      if (m && m.screenName) parts.push(String(m.screenName));
      if (m && m.name) parts.push(String(m.name));
    }
  }
  if (Array.isArray(ents.urls)) {
    for (var u = 0; u < ents.urls.length; u++) {
      var e = ents.urls[u];
      if (!e) continue;
      if (e.expandedUrl) parts.push(String(e.expandedUrl));
      if (e.displayUrl) parts.push(String(e.displayUrl));
    }
  }
  if (Array.isArray(r.media)) {
    for (var k = 0; k < r.media.length; k++) {
      var md = r.media[k];
      if (md && md.altText) parts.push(String(md.altText));
    }
  }
  if (r.poll && Array.isArray(r.poll.choices)) parts.push(r.poll.choices.join(' '));
  if (r.replyTo && r.replyTo.screenName) parts.push(String(r.replyTo.screenName));
  if (r.tweetUrl) parts.push(String(r.tweetUrl));

  return parts.join('\n').toLowerCase();
}

function haystackMatches(hay, terms) {
  for (var i = 0; i < terms.length; i++) {
    if (hay.indexOf(terms[i]) === -1) return false;
  }
  return true;
}

/**
 * Walk the archived records once, in batches, calling `visit(recordIndex, r)`.
 *
 * The batch is one Blob read and one decode per record. Decoding per record
 * rather than slicing a decoded string is deliberate: offsets in the index are
 * BYTES, and a JavaScript string index is UTF-16 code units, so the two diverge
 * the moment a post contains a non-ASCII character — which, in this archive, is
 * immediately.
 *
 * `label` replaces the progress text for a caller that is not a search — the tab
 * filter reads the same bytes for a different reason, and a progress bar that
 * says 搜索中 while no search is running is a lie about what the machine is
 * doing.
 */
async function scanRecords(visit, gen, label) {
  var ranges = archive.ranges;
  var n = ranges.length;
  var decoder = new TextDecoder();
  var i = 0;

  while (i < n) {
    if (job.cancelled) return 'cancelled';

    /* A superseded scan must STOP, not merely stop producing output.
     *
     * Without this the old loop runs the file to the end regardless: `job.
     * cancelled` cannot catch it, because the job that replaced it cleared that
     * flag the moment it started. What the user sees is the new job's progress
     * text being overwritten by the old job's, several times a second, until the
     * whole file has been read a second time for nothing. */
    if (gen !== undefined && gen !== search.gen) return 'cancelled';

    /* One batch — but never across a file boundary. The slice below assumes
       every range in it lives in the same Blob AND that `start` does not
       decrease. With two files open both are false, and the failure is silent:
       the decode reads the wrong bytes, JSON.parse throws, and `continue` drops
       the record as merely unreadable. The search then reports a confident
       count with rows missing from it. */
    var owner = sourceOf(i);
    if (owner === null) return 'cancelled';
    var j = i + 1;
    while (j < n && j < i + SEARCH_BATCH && ranges[j].src === ranges[i].src) j++;

    var from = ranges[i].start;
    var to = ranges[j - 1].end;
    var buf = new Uint8Array(await owner.source.slice(from, to).arrayBuffer());

    for (var k = i; k < j; k++) {
      var text = decoder.decode(buf.subarray(ranges[k].start - from, ranges[k].end - from));
      var r;
      try {
        r = JSON.parse(text);
      } catch (_) {
        continue;   /* an unreadable record is skipped, not counted as a match */
      }
      visit(k, r);
    }

    i = j;
    search.scanned = i;
    /* Only the job that owns the bar may write to it. */
    if (gen === undefined || gen === search.gen) {
      progressSet(label
        ? label + i + ' / ' + n
        : '搜索中…' + i + ' / ' + n + '　命中 ' + search.hits, n ? i / n : 1);
    }
    await new Promise(function (res) { setTimeout(res, 0); });
  }
  return 'done';
}

var searchTimer = null;

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function () { runSearch(el.q.value); }, 250);
}

/**
 * Start a list job: supersede whatever ran before, and claim the next
 * generation.
 *
 * One place, so that a scan's own generation can only ever be compared against
 * a counter that every starter shares.
 */
function beginScan() {
  search.gen++;
  job.cancelled = false;
  return search.gen;
}

async function runSearch(query) {
  var q = String(query === undefined ? el.q.value : query);

  /* Checked before a generation is taken, because timelineMode() is itself an
     invalidator — bumping here and again inside it would leave the two
     disagreeing about which generation is current. */
  if (q.trim().length < SEARCH_MIN_CHARS) {
    timelineMode();
    return;
  }

  var gen = beginScan();

  list.mode = 'search';
  list.q = q.trim();
  list.terms = list.q.toLowerCase().split(/\s+/).filter(function (s) { return s.length > 0; });
  list.hits = [];
  /* Deliberately NOT composeList() yet. `ids` keeps pointing at the list that is
     still on screen, so the timeline stays visible — and, more importantly,
     stays consistent with the height table that is still built for it. Deriving
     `ids` from an empty hits array here would leave every rendered row asking
     for a record that does not exist, which is the very failure this file was
     just fixed for. */
  search.running = true;
  search.scanned = 0;
  search.total = archive.ranges.length;
  search.hits = 0;

  progressStart('搜索中…');
  say('');

  var outcome = await scanRecords(function (idx, r) {
    if (search.gen !== gen) return;
    if (haystackMatches(searchHaystack(r), list.terms)) {
      list.hits.push(idx);
      search.hits++;
    }
  }, gen);

  if (gen !== search.gen) return;   /* a newer search or a new file took over */
  progressEnd();
  search.running = false;

  /* The table is rebuilt once, at the end, from the finished list. Building it
     during the scan would mean growing and re-rendering on every batch while
     the user is only waiting; the progress bar is the feedback for that. */
  composeList();
  applyList(true);

  var hits = list.hits.length;
  if (outcome === 'cancelled') {
    say('<div class="box warn">搜索已停止。已经扫过的部分里找到 <b>' + hits + '</b> 条，' +
        '下面只显示这些——<b>没扫到的部分不算数</b>。</div>', 'warn');
  } else if (hits === 0) {
    say('<div class="box">「' + esc(list.q) + '」没有找到任何记录。' +
        '搜索范围是正文、ID、作者昵称与用户名、话题标签、@提及、链接的展开地址、媒体的替代文字和投票选项。</div>');
  } else {
    say('<div class="box ok">「' + esc(list.q) + '」找到 <b>' + hits + '</b> 条，' +
        '用时 ' + ((performance.now() - job.startedAt) / 1000).toFixed(1) + ' 秒。' +
        '结果按归档顺序排列。</div>', 'ok');
  }
}

/* ---------------------------------------------------------- jump to day -- */

/**
 * The archive's time order, measured rather than assumed.
 *
 * The extension writes newest first, so index 0 is the newest post — but that is
 * a property of the writer, not of the format, and a merged or hand-edited file
 * can be either way round. Nine spread-out probes are enough to tell, and being
 * wrong here would send every date jump to the wrong place.
 */
async function detectOrder() {
  if (jump.orderChecked) return jump.order;
  jump.orderChecked = true;
  var n = archive.ranges.length;
  if (n < 3) { jump.order = 'asc'; return jump.order; }

  var probes = Math.min(9, n);
  var times = [];
  for (var k = 0; k < probes; k++) {
    var i = Math.floor(k * (n - 1) / (probes - 1));
    times.push(await readCreatedAt(i));
  }

  var up = 0, down = 0;
  for (var j = 1; j < times.length; j++) {
    if (!isFinite(times[j]) || !isFinite(times[j - 1])) continue;
    if (times[j] > times[j - 1]) up++;
    else if (times[j] < times[j - 1]) down++;
  }
  var total = up + down;
  if (total === 0) jump.order = 'asc';
  else if (down / total >= 0.9) jump.order = 'desc';
  else if (up / total >= 0.9) jump.order = 'asc';
  else jump.order = 'mixed';
  return jump.order;
}

/** One record's timestamp, from a short head read when the field is near the front. */
async function readCreatedAt(i) {
  var r = archive.ranges[i];
  if (!r) return NaN;
  var owner = sourceOf(i);
  if (owner === null) return NaN;
  var head = await owner.source.slice(r.start, Math.min(r.end, r.start + 512)).text();
  var m = head.match(/"createdAt"\s*:\s*"([^"]+)"/);
  if (m) return Date.parse(m[1]);
  /* `text` sits before `createdAt` in the record, and it is capped at the
     extension's text limit — so for a long post the field is further in.
     Falling back to a full read is rare and correct. */
  var res = await readRecordAt(owner.source, r);
  return res.ok ? Date.parse(res.value.createdAt) : NaN;
}

/**
 * Run `fn` once the rows on screen have all been read and measured.
 *
 * Used after a jump, which needs two attempts to be exact — see jumpToDay.
 * Bounded, because a record that never loads must not leave the caller hanging.
 */
function whenSettled(fn, maxMs) {
  var t0 = performance.now();
  var step = function () {
    var settled = pending.size === 0 && pendingMeasures.size === 0 && !measureFlushQueued;
    if (settled || performance.now() - t0 > (maxMs || 1500)) { fn(); return; }
    window.requestAnimationFrame(step);
  };
  window.requestAnimationFrame(step);
}

/**
 * Scroll so that one row sits at the top of the viewport.
 *
 * Twice, and the second pass is the one that matters. The rows above the target
 * have never been rendered, so their heights are estimates — the estimate is
 * only ever a guess from a record's byte length, and a few thousand of them
 * accumulate into a landing point that is tens of rows off. Once the target is
 * on screen the rows around it are measured, and re-applying the same offset
 * against the corrected table puts the row exactly at the top.
 */
function aimAt(found) {
  /* `offsetOf` is a row offset; scrollTop is a position in content that begins
     with the header. The two differ by exactly headSpace(). */
  var y = function () { return heights.offsetOf(found) + headSpace(); };
  el.scroller.scrollTop = y();
  renderWindow(true);
  whenSettled(function () {
    el.scroller.scrollTop = y();
    renderWindow(true);
  }, 2000);
}

async function jumpToDay(ymd) {
  if (!archive.ranges.length) return;
  var offset = display.offsetMinutes === null ? 0 : display.offsetMinutes;
  var dayStart = dayStartMs(ymd, offset);
  if (dayStart === null) return;
  /* A fixed offset has no daylight saving, so the next midnight is exactly one
     day later. That is the whole reason the display zone is an offset and never
     an IANA name. */
  var dayEnd = dayStart + 86400000;

  progressStart('正在定位 ' + ymd + '…');
  job.cancelled = false;
  var order = await detectOrder();
  var n = archive.ranges.length;
  var found = -1;

  if (order === 'mixed') {
    /* Nothing better is available: with no consistent order there is no
       monotone function to bisect. A strided sweep finds the neighbourhood, and
       the result is reported as approximate rather than presented as exact. */
    var best = -1, bestDelta = Infinity;
    for (var s = 0; s < n; s += 200) {
      if (job.cancelled) break;
      var t = await readCreatedAt(s);
      if (!isFinite(t)) continue;
      var d = Math.abs(t - dayStart);
      if (d < bestDelta) { bestDelta = d; best = s; }
      if (s % 4000 === 0) progressSet('正在扫描 ' + s + ' / ' + n + '…', n ? s / n : 1);
    }
    found = best < 0 ? -1 : best;
  } else {
    /* Bisect for the FIRST record of the day, not the last record before it.
       Because the timeline reads newest first, the first index of the day is
       what belongs at the top of the viewport, with the rest of the day running
       down from it. Bisecting on the day's *end* is what finds that index; on
       its start it would find the last post of the previous day, which is a
       whole day's worth of scrolling in the wrong direction.
       ~17 record reads for a hundred thousand posts. */
    var lo = 0, hi = n - 1, ans = -1;
    var guard = 0;
    while (lo <= hi && guard++ < 64) {
      if (job.cancelled) break;
      var mid = (lo + hi) >> 1;
      var tm = await readCreatedAt(mid);
      if (!isFinite(tm)) { lo = mid + 1; continue; }
      var past = order === 'desc' ? (tm < dayEnd) : (tm >= dayStart);
      if (past) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    found = ans;
  }

  progressEnd();
  if (job.cancelled) return;

  if (found < 0) {
    /* No index satisfied the predicate, which means every record is newer than
       the end of that day — the date is older than anything in the archive. */
    say('<div class="box warn">归档里没有 ' + esc(ymd) +
      ' 这么早的记录——它比归档里最早的一条还早。</div>', 'warn');
    return;
  }

  /* The bisection searched the ARCHIVE and produced a record index; the scroller
     works in positions, and the two are the same number only while nothing is
     filtered. Under a search or a tab they are not, so the index is translated
     — and when the record is not in the list at all, that is said rather than
     scrolled to somewhere arbitrary. */
  var pos = list.positionOf(found);
  if (pos < 0) {
    say('<div class="box warn">第 ' + (found + 1) + ' 条就在归档里，但它不在当前的' +
      (list.mode === 'search' ? '搜索结果' : '筛选') +
      '里。清空搜索或切到「所有」就能看到它。</div>', 'warn');
    return;
  }
  aimAt(pos);
  var landed = await readCreatedAt(found);
  var sameDay = isFinite(landed) && landed >= dayStart && landed < dayEnd;

  if (!sameDay) {
    say('<div class="box warn"><b>' + esc(ymd) + ' 这天没有记录。</b>最近的记录是第 ' +
      (found + 1) + ' 条（' +
      esc(isFinite(landed) ? fmtClock(new Date(landed).toISOString()) : '时间读不出来') +
      '），已经跳到它。</div>', 'warn');
    return;
  }
  say('<div class="box">已跳到 <b>' + esc(ymd) + '</b>：从第 ' + (found + 1) + ' 条开始，' +
      esc(fmtClock(new Date(landed).toISOString())) + '。' +
      (order === 'mixed'
        ? '<b>这个归档的记录不是按时间排好序的</b>，所以这是最接近的一条，不保证正好是那天的第一条。'
        : '') + '</div>', order === 'mixed' ? 'warn' : '');
}
