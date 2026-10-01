/* -------------------------------------------------------------- report --- */

/**
 * The one line that stands in for the report when it is put away.
 *
 * Set even while the report is open, so the line is already correct at the
 * moment it is collapsed — computing it lazily would mean the control had to
 * know what it was summarising.
 *
 * An empty summary hides the whole bar, which is what happens on a file that
 * reported nothing and on the way back to the drop zone.
 */
function reportSummary(text) {
  el.reportSummary.textContent = text || '';
  el.reportBar.hidden = !text;
}

/** Fold the report's boxes away, or bring them back. The bar stays either way. */
function setReportClosed(closed) {
  document.body.classList.toggle('reportClosed', closed === true);
  el.btnReport.textContent = closed === true ? '展开' : '收起';
}

function statCell(label, value, cls) {
  return '<span' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(label) +
         '：<b>' + esc(value) + '</b></span>';
}

/**
 * The stat line above the timeline.
 *
 * Two memory figures, not one. `索引` is the offset index and the height table —
 * the part that grows with the archive and the whole argument for this design;
 * `已解析缓存` is the record bodies currently held. Reporting their sum would
 * overstate the number that matters and hide the number that moves. The cache
 * figure is refreshed on its own as records load; the index figure cannot change
 * until a different file is opened.
 */
function statsLine() {
  var env = archive.envelope;
  var n = archive.ranges.length;
  var mismatch = env.count !== null && env.count !== n;
  var sourceLabel = archive.sourceLabel || '';

  /* Escaped, like every other value on this line. It is safe today only
     because the one setter hands it string constants — an invariant three
     files away from here, and exactly the kind that stops being true quietly
     the day somebody puts a file name in it. */
  var html =
    '<span>来源：' + esc(sourceLabel) + '</span>' +
    statCell('记录', String(n)) +
    statCell('文件', fmtBytes(archive.file ? archive.file.size : 0)) +
    statCell('建索引', (archive.indexMs || 0).toFixed(0) + ' ms') +
    statCell('信封 count', env.count === null ? '未读到' : String(env.count),
             mismatch ? 'bad' : 'ok') +
    statCell('schema', env.schemaVersion === null ? '?' : String(env.schemaVersion)) +
    statCell('导出', env.exportedAt || '?') +
    statCell('生成版本', env.generatorVersion || '?') +
    statCell('索引内存', fmtBytes(estimateIndexBytes()), 'ok') +
    statCell('已解析缓存', fmtBytes(estimateCacheBytes()));

  /* The hits, not the displayed list: under a filter the two differ, and the
     number worth reporting is how many the query matched. */
  if (list.mode === 'search') {
    html += statCell('搜索命中', String(list.hits.length));
  }
  if (list.length() !== archive.ranges.length) {
    html += statCell('当前显示', String(list.length()));
  }
  if (archive.mediaStats) {
    html += statCell('媒体文件', String(archive.mediaStats.files)) +
      statCell('媒体索引', archive.mediaJoin === 'index' ? 'MEDIA-INDEX.json' : '按文件名');
  }
  if (display.offsetMinutes !== null) html += statCell('时区', tzLabel());

  el.stats.hidden = false;
  el.stats.innerHTML = html;
}

/**
 * The stat line plus whatever the integrity pass found.
 *
 * Everything that is only knowable at open time is settled here once; the parts
 * that move afterwards go through statsLine() directly so that re-drawing the
 * cache figure cannot re-show a wall of text the reader has already read.
 */
function renderStats(sourceLabel, elapsed, problems) {
  archive.sourceLabel = sourceLabel;
  archive.indexMs = elapsed;
  archive.problems = problems;
  statsLine();

  var env = archive.envelope;
  var n = archive.ranges.length;

  if (problems.length) {
    reportSummary('完整性检查发现问题（' + problems.length + '）');
    setReport('<div class="box error"><b>完整性检查发现问题（' + problems.length + '）：</b><ul><li>' +
      problems.map(function (p) {
        return '<b>' + esc(p.kind) + '</b>：' + esc(p.detail) + (p.at >= 0 ? '（偏移 ' + p.at + '）' : '');
      }).join('</li><li>') +
      '</li></ul>扫描是只读的，没有修改任何文件。请把上面的信息发出来。</div>', 'error');
    return;
  }

  var html = '<div class="box ok">索引建立完成：<b>' + n + ' 条</b>记录全部定位' +
    (env.count === null ? '（这份归档的信封里没有可读的 count，无法交叉核对）' :
      '，与信封计数一致') +
    '，没有发现截断或漏读。正文没有载入内存——滚动到哪一条才读哪一条。</div>';

  if (archive.kind === 'json' && archive.mediaStats === null) {
    html += '<div class="box"><b>这是直接导出的 JSON，媒体文件不在里面。</b>' +
      '卡片上会显示媒体的说明和占位，但没有图片可看。要看图请打开同一次的 ZIP 归档。</div>';
  } else if (archive.kind === 'zip' && archive.mediaStats && archive.mediaStats.keyed === 0) {
    html += '<div class="box warn">这个 ZIP 里有 ' + archive.mediaStats.files +
      ' 个媒体文件，但一个都没能对上推文。图片和视频会显示成占位。</div>';
  }

  /* There is no box for the roster any more, and it is worth saying why since
     one was written on purpose: it named the `connections` array, pointed at
     the two counts on the profile header, and explained CONNECTIONS.csv and the
     JSON field. Every one of those is a fact about the FILE — the format, the
     field names, what the other export form holds — which is what this reader
     was written BY, not what it is read BY. Deleted on request:
     「又不是面向 c 端的注释」.

     The summary line at the bottom still says 名册, so folding the report away
     cannot hide that the file carries one; where to look for it is the profile
     header's two counts, which is where X puts them and where they already
     carry the pointer and the underline. */

  if (env.hasDeletions) {
    /* Not joined, deliberately. Records carry their own `deletedAt`, which is
       right for anything this extension wrote; the separate array only adds
       information in a file that was hand-assembled or merged. Detecting it and
       saying so is the honest middle ground — the alternative is a badge that is
       correct for one file shape and quietly wrong for another. */
    html += '<div class="box warn">这个文件里还有一份 <code>deletions</code> 墓碑列表。' +
      '这个页面只按记录自己的 <code>deletedAt</code> 显示「已删除」徽章，没有去比对那份列表——' +
      '如果这个文件是合并或手工拼装出来的，可能有记录被删掉了却没标出来。</div>';
  }
  /* The summary names the sections too, so folding the report away cannot hide
     the fact that the file carries one — it only hides the prose about it. */
  var also = [];
  if (env.hasRoster) also.push('名册');
  if (env.hasDeletions) also.push('墓碑列表');
  reportSummary('文件检查通过：' + n + ' 条记录' + (also.length ? '，另有' + also.join('、') : ''));
  setReport(html);
}
