/* ----------------------------------------------------------- one post --- */

/**
 * The dialog a card opens: the same card, plus everything the timeline has no
 * room for and the three things that are actually actionable.
 *
 * The card in the timeline is deliberately inert — its counts are a record of
 * what X reported, not buttons. Everything you can *do* is here, in one place,
 * and all of it is either copying something or opening it somewhere else.
 */
/** Open the dialog on a position in the list that is on screen. */
function openTweetPage(pos) {
  openTweetPageRecord(list.at(pos));
}

/**
 * Open the dialog on a record.
 *
 * Split from the above because the dialog can also be opened from inside
 * ITSELF — a reply card in the conversation is a link to that post — and there
 * is no list position for a record that is not in the current list.
 */
function openTweetPageRecord(recIdx) {
  if (recIdx < 0 || recIdx >= archive.ranges.length) return;
  tp.openRec = recIdx;
  el.postBody.textContent = '读取中…';
  showPostPage();
  renderPostWhenReady(recIdx);
}

/**
 * The chain of posts this one answers, oldest first, excluding it.
 *
 * A thread is read downwards, so what a post replies to belongs ABOVE it — the
 * page opens with the focal post at the top of the window and the rest of the
 * thread reachable by scrolling up, which is how X reads and the opposite of
 * putting the parent underneath.
 *
 * Bounded twice: twenty links deep, and a `seen` set. A hand-edited or merged
 * archive can contain a cycle — A replies to B replies to A — and an unbounded
 * walk up that would not terminate.
 */
function ancestorChain(recIdx) {
  var out = [];
  if (!filters.built || !filters.byId) return out;
  var seen = {};
  seen[recIdx] = true;
  var cur = recIdx;
  for (var guard = 0; guard < 20; guard++) {
    var e = cache.get(cur);
    var r = e && e.data;
    var parentId = r && r.replyTo && typeof r.replyTo.tweetId === 'string' ? r.replyTo.tweetId : null;
    if (parentId === null || parentId.length === 0) break;
    var pi = filters.byId.get(parentId);
    if (typeof pi !== 'number' || seen[pi] === true) break;
    seen[pi] = true;
    out.unshift(pi);
    cur = pi;
  }
  return out;
}

/**
 * Render the page once the focal post and everything above it are parsed.
 *
 * Wait for the whole chain rather than painting it in pieces. The ancestors are
 * records from anywhere in the archive and the cache holds a few dozen around
 * whatever the timeline shows, so on a real archive the first attempt finds the
 * post and none of its context — and a page that grew a thread above itself a
 * card at a time would drag the focal post down the window after it had been
 * scrolled into place.
 */
function renderPostWhenReady(recIdx) {
  var gen = archive.gen;
  var tries = 0;
  var go = function () {
    if (gen !== archive.gen || el.postPage.hidden || tp.openRec !== recIdx) return;
    var need = [recIdx].concat(ancestorChain(recIdx));
    var missing = [];
    for (var i = 0; i < need.length; i++) if (!cache.has(need[i])) missing.push(need[i]);

    if (missing.length && tries++ < 40) {
      for (var m = 0; m < missing.length; m++) ensureRecord(missing[m]);
      setTimeout(go, 80);
      return;
    }
    var e = cache.get(recIdx);
    fillTweetPage(recIdx, e || { error: '这一条读不出来' });
  };
  go();
}

/**
 * Hand the window to the post page, or give it back.
 *
 * The timeline is HIDDEN, not unmounted: it keeps its scroll position, its
 * height table and its rendered rows, so going back is instant and lands
 * exactly where the reader left — which is the whole reason a post is a page
 * here and not a dialog. A dialog would also have to be dismissed before the
 * list underneath could be used, and it puts the post in a box on top of the
 * column it came from.
 */
function showPostPage() {
  if (!el.postPage.hidden) return;
  el.postPage.hidden = false;
  document.body.classList.add('postOpen');
  el.ppScroll.scrollTop = 0;
}

function closePostPage() {
  if (el.postPage.hidden) return;
  el.postPage.hidden = true;
  document.body.classList.remove('postOpen');
  tp.openRec = -1;
  tp.openId = null;
  /* Emptied, so a reopen does not flash the previous post for a frame. */
  el.postBody.textContent = '';
  el.ppWhere.textContent = '';
}

/**
 * One record drawn as a card, inert, carrying the record it stands for.
 *
 * `__rec` is what the dialog's click handler reads to decide where a click
 * goes. EVERY card gets one, including the post the dialog is already showing:
 * its body click is suppressed by comparing against `tp.openRec` rather than by
 * leaving the index off, because the media cells inside it still have to work —
 * a picture you cannot open from the page you opened the post on is worse than
 * no picture at all.
 */
function recordCard(r, recIdx) {
  var c = document.createElement('article');
  c.className = 'card';
  c.style.position = 'static';
  c.style.cursor = 'pointer';
  c.__rec = recIdx;
  buildCard(c, 0, r);
  return c;
}

function fillTweetPage(recIdx, entry) {
  el.postBody.textContent = '';
  var range = archive.ranges[recIdx];

  if (entry.error) {
    el.ppWhere.textContent = '';
    var bad = document.createElement('div');
    bad.className = 'box error';
    bad.textContent = '这一条读不出来：' + entry.error +
      '（字节范围 ' + range.start + ' – ' + range.end + '）';
    el.postBody.appendChild(bad);
    return;
  }

  var r = entry.data;

  /* Two columns. The post and the conversation around it are the reading
     column — a thread read top to bottom is the thing this page is for.
     Everything ABOUT the record (what it replies to, when it was captured, its
     byte range) is reference material, and putting it beside the post rather
     than between the post and its replies is the whole of this change. */
  var layout = document.createElement('div');
  layout.className = 'tp';

  var main = document.createElement('div');
  main.className = 'tp__main';

  /* The thread above, then the post, then the replies to it. Reading order is
     the point: a post you reached by clicking a reply is at the top of the
     window with its context above it, and everything it answers is one scroll
     up rather than somewhere below in a section of its own. */
  var chain = ancestorChain(recIdx);
  for (var ci = 0; ci < chain.length; ci++) {
    var ae = cache.get(chain[ci]);
    if (ae && ae.data) {
      var anc = recordCard(ae.data, chain[ci]);
      anc.classList.add('card--ancestor');
      main.appendChild(anc);
    }
  }
  /* Nothing of the chain made it into the archive: say who it was to, above
     the post, in the place the missing post would have been. */
  if (chain.length === 0) {
    var pid = r.replyTo && typeof r.replyTo.tweetId === 'string' ? r.replyTo.tweetId : null;
    if (pid !== null && pid.length > 0 && (!filters.byId || !filters.byId.has(pid))) {
      var to = r.replyTo.screenName ? '@' + r.replyTo.screenName : '一条不在归档里的帖子';
      var miss = document.createElement('p');
      miss.className = 'tp__note tp__note--above';
      miss.textContent = '它回复的是 ' + to + '（那条不在归档里，只有 ID ' + pid + '）。';
      main.appendChild(miss);
    }
  }

  var focal = recordCard(r, recIdx);
  focal.classList.add('card--focal');
  main.appendChild(focal);

  renderReplies(main, r);

  var side = document.createElement('aside');
  side.className = 'tp__side';

  var sect = document.createElement('div');
  sect.className = 'sect';
  var h = document.createElement('h3');
  h.textContent = '归档里关于这一条的记录';
  sect.appendChild(h);

  var dl = document.createElement('dl');
  dl.className = 'kv';
  var rows = [
    ['ID', r.id],
    ['发布时间', fmtClock(r.createdAt)],
    ['首次捕获', fmtClock(r.firstCapturedAt)],
    ['最近捕获', fmtClock(r.capturedAt)],
    ['语言', r.lang],
    ['会话 ID', r.conversationId],
    ['会话号为推断', r.conversationIdInferred ? '是' : null],
    ['回复给', r.replyTo && (r.replyTo.screenName || r.replyTo.tweetId)],
    ['引用帖子', r.quoteTweetId],
    ['编辑自', r.editedFrom],
    ['编辑链', Array.isArray(r.editTweetIds) && r.editTweetIds.length > 1 ? r.editTweetIds.join(' → ') : null],
    ['本轮编辑来源', r.editInitialTweetId],
    ['剩余编辑次数', typeof r.editsRemaining === 'number' ? String(r.editsRemaining) : null],
    ['作者 ID', r.author && r.author.id],
    ['删除于', r.deletedAt ? fmtClock(r.deletedAt) : null],
    ['被取代', r.supersededBy],
    ['捕获途径', r.source && (r.source.operationName + ' / ' + r.source.capturedVia)],
    ['记录版本', r.schemaVersion === undefined ? null : String(r.schemaVersion)],
    ['字节范围', range.start + ' – ' + range.end + '（' + (range.end - range.start) + ' 字节）'],
    ['时区', tzLabel()]
  ];
  for (var k = 0; k < rows.length; k++) {
    if (rows[k][1] === undefined || rows[k][1] === null || rows[k][1] === '') continue;
    var dt = document.createElement('dt');
    dt.textContent = rows[k][0];
    var dd = document.createElement('dd');
    dd.textContent = String(rows[k][1]);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  sect.appendChild(dl);

  if (Array.isArray(r.media) && r.media.length) {
    var mh = document.createElement('h3');
    mh.textContent = '媒体';
    sect.appendChild(mh);
    var ml = document.createElement('dl');
    ml.className = 'kv';
    for (var mi = 0; mi < r.media.length; mi++) {
      var m = r.media[mi] || {};
      var key = mediaKeyFor(r.id, m.id);
      var dt2 = document.createElement('dt');
      dt2.textContent = '#' + (mi + 1) + ' ' + (MEDIA_LABEL[m.type] || '媒体');
      var dd2 = document.createElement('dd');
      var bits = [String(m.id || '（无 id）')];
      if (m.width && m.height) bits.push(m.width + '×' + m.height);
      if (typeof m.durationMs === 'number' && m.durationMs > 0) bits.push(Math.round(m.durationMs / 1000) + ' 秒');
      bits.push(key && archive.mediaMap && archive.mediaMap.has(key) ? '文件在归档里' : '文件不在归档里');
      if (m.altText) bits.push('替代文字：' + m.altText);
      dd2.textContent = bits.join('　·　');
      ml.appendChild(dt2);
      ml.appendChild(dd2);
    }
    sect.appendChild(ml);
  }

  var acts = document.createElement('div');
  acts.className = 'sect';
  var ah = document.createElement('h3');
  ah.textContent = '这条帖子';
  acts.appendChild(ah);

  var url = tweetLinkOf(r);

  acts.appendChild(actionButton('复制链接', function () {
    return url ? copyText(url, '链接已复制') : copyText(String(r.id), '没有可用的链接，已复制 ID');
  }));
  acts.appendChild(actionButton('复制 ID', function () {
    return copyText(String(r.id), 'ID 已复制');
  }));
  acts.appendChild(actionButton('复制这条的 JSON', function () {
    return copyText(JSON.stringify(r, null, 2), '这条记录的原样 JSON 已复制');
  }));
  if (url) {
    var a = document.createElement('a');
    a.className = 'btn';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '在 X 上打开';
    acts.appendChild(a);
  }
  side.appendChild(sect);
  side.appendChild(acts);

  layout.appendChild(main);
  layout.appendChild(side);
  el.postBody.appendChild(layout);

  /* The bar's right-hand label: which post this is and when, so that walking a
     thread with the reply cards never leaves the reader without an anchor. */
  el.ppWhere.textContent = fmtClock(r.createdAt) + '（' + tzLabel() + '）';

  /* The address follows the post.
   *
   * Set HERE rather than where the click happened, for two reasons. This is the
   * first moment the record has actually been read, and so the first moment its
   * author and id are known; and a card INSIDE the post page — a reply clicked
   * to walk the thread — arrives through this same function with no click
   * handler of its own that could have written an address.
   *
   * `tp.openId` is assigned first, so the hashchange this causes finds the post
   * already on screen and does not go looking for it again — that lookup is a
   * pass over every record. */
  tp.openId = typeof r.id === 'string' && r.id.length > 0 ? r.id : null;
  var want = postAddressOf(r);
  if (want !== null && location.hash !== want) {
    /* There is now an entry of ours in the history, which is what makes the
       返回 button a back button — see backOutOfPost(). */
    router.postPushed = true;
    goHref(want);
  }

  /* Then put the focal post at the top of the window. Everything above it is
     the thread it belongs to — reachable by scrolling up, out of the way until
     then — and everything below is what answers it. Done synchronously because
     the ancestors are already in the DOM by this point, so there is nothing
     that could arrive later and shift it. Wrapped because a scroll that cannot
     be placed is not a reason to leave the page half-drawn. */
  try {
    var delta = focal.getBoundingClientRect().top - el.ppScroll.getBoundingClientRect().top;
    el.ppScroll.scrollTop = Math.max(0, el.ppScroll.scrollTop + delta);
  } catch (_) { /* the page is rendered; the scroll position is a nicety */ }
}

/**
 * The record the post page is currently showing.
 *
 * Both the index and the tweet id, because the two questions asked of it are
 * different: "is this the record I already have open" is about the BYTES and
 * is answered by the index, while "is this the address I am already at" is
 * about the address and is answered by the id. A rebuild renumbers the first
 * and leaves the second alone. -1 and null mean nothing is open.
 */
var tp = { openRec: -1, openId: null };

/* ------------------------------------------------------------- replies -- */

/**
 * The conversation around one post, as far as this archive can see it.
 *
 * Both directions are shown, and both come out of the maps the tab filter
 * builds in its one pass: `byId` finds the post this one answers, `repliesOf`
 * finds the posts that answer this one. Neither is answerable from the list on
 * screen — the other end of a conversation is usually in another tab, and often
 * not visible at all.
 *
 * What is NOT here, and cannot be: anybody else's posts. The archive holds only
 * what this browser watched its own account publish, so a thread shows the
 * reader's half of it. When the other side is missing the section says which
 * post is missing and who wrote it, rather than showing an empty box.
 *
 * Synchronous when the index is already built, which it is after any tab has
 * been visited. Otherwise the section says so and fills in when the pass ends —
 * and the pass can also be cancelled, which has to leave a sentence rather than
 * a permanent "正在建立索引…".
 */
function renderReplies(main, r) {
  var sect = document.createElement('div');
  sect.className = 'sect';
  var h = document.createElement('h3');
  h.textContent = '回复';
  sect.appendChild(h);
  var box = document.createElement('div');
  box.className = 'tp__replies';
  sect.appendChild(box);
  main.appendChild(sect);

  if (filters.built) { paintReplies(box, r, 0); return; }

  var wait = document.createElement('p');
  wait.className = 'tp__note';
  wait.textContent = '正在建立索引…';
  box.appendChild(wait);

  var gen = archive.gen;
  var at = tp.openRec;
  ensureFilters().then(function (ok) {
    if (gen !== archive.gen || !box.isConnected || tp.openRec !== at) return;
    if (!ok) {
      box.textContent = '';
      var bad = document.createElement('p');
      bad.className = 'tp__note';
      bad.textContent = '索引没有建完（被取消，或被别的操作取代），所以看不到回复。' +
        '把这条关掉再打开一次可以重来。';
      box.appendChild(bad);
      return;
    }
    /* The same pass that answers "what replies to this" also answers "what does
       this reply to" — and the thread above has already been drawn without it.
       Re-render the page rather than patch one section of it, because the two
       answers have to agree about what is above and what is below. */
    renderPostWhenReady(at);
  });
}

/**
 * Draw the conversation into `box`.
 *
 * Re-entrant, and it has to be: the replies are records from anywhere in the
 * archive, and the record cache holds a few dozen entries around whatever the
 * timeline is showing. On a large archive almost none of them are loaded when
 * this first runs, so the first paint is mostly "not there yet" — it asks for
 * each one and comes back. Bounded, because a record that will not load (a
 * truncated file, a byte range that no longer parses) must end as a sentence
 * rather than as a repaint every 100ms forever.
 */
function paintReplies(box, r, attempt) {
  box.textContent = '';
  var loading = false;

  /* Only the posts that answer this one. What it answers is the thread above,
     drawn by fillTweetPage — it is not a reply and does not belong under a
     heading that says 回复. */
  var selfId = typeof r.id === 'string' ? r.id : null;
  var kids = selfId !== null && filters.repliesOf ? filters.repliesOf.get(selfId) : null;
  var shown = 0;
  if (kids && kids.length) {
    var label = document.createElement('p');
    label.className = 'tp__label';
    label.textContent = '归档里回复它的 ' + kids.length + ' 条';
    box.appendChild(label);
    for (var i = 0; i < kids.length; i++) {
      var ke = cache.get(kids[i]);
      if (ke && ke.data) { box.appendChild(recordCard(ke.data, kids[i])); shown++; }
      else { ensureRecord(kids[i]); loading = true; }
    }
  }

  if (loading) {
    var wait = document.createElement('p');
    wait.className = 'tp__note';
    wait.textContent = '正在读取…';
    box.appendChild(wait);
  } else if (shown === 0 && box.querySelector('.card') === null && box.querySelector('.tp__note') === null) {
    /* Said plainly, because the empty case is the common one and a heading with
       nothing under it reads as a bug. */
    var none = document.createElement('p');
    none.className = 'tp__note';
    none.textContent = r.isReply
      ? '归档里没有它下面的回复。'
      : '归档里没有回复这一条的记录，它也没有回复谁。';
    box.appendChild(none);
  }

  if (loading && attempt < 30) {
    var gen = archive.gen;
    setTimeout(function () {
      if (gen !== archive.gen || !box.isConnected) return;
      paintReplies(box, r, attempt + 1);
    }, 100);
  }
}

function actionButton(label, run) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.style.marginRight = '8px';
  b.textContent = label;
  b.addEventListener('click', function () { run(); });
  return b;
}

/**
 * Clipboard, with the fallback that is still needed on a page opened from a
 * file:// URL — where the async clipboard API is not available at all.
 */
function copyText(text, okMessage) {
  var done = function () { say('<div class="box ok">' + esc(okMessage) + '</div>', 'ok'); };
  var failed = function () { say('<div class="box error">复制失败，浏览器拒绝了剪贴板访问。</div>', 'error'); };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text) ? done() : failed(); });
    return;
  }
  legacyCopy(text) ? done() : failed();
}

function legacyCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  ta.remove();
  return ok;
}

/* --------------------------------------------------------------- verify -- */

/**
 * Re-read every record and check that it parses.
 *
 * This is the expensive path by design: it touches every byte, which is exactly
 * what the index deliberately avoids. It exists so that "no data was lost" can
 * be demonstrated on demand instead of assumed.
 */
/**
 * Where in which file a record's bytes are.
 *
 * A bare offset is only an address while exactly one file is open — with two,
 * "偏移 412345" is a number that belongs to somebody else's file, which reads as
 * a fact and is not one.
 */
function whereOf(recIdx) {
  var r = archive.ranges[recIdx];
  if (!r) return '偏移 ?';
  var prefix = '';
  if (archive.sources.length > 1) {
    var owner = sourceOf(recIdx);
    if (owner) prefix = esc(owner.file.name) + ' ';
  }
  return prefix + '偏移 ' + r.start;
}

el.verify.addEventListener('click', async function () {
  /* "Is anything open", not "is there a single Blob" — the two were the same
     question until a page could hold more than one file, and asking the second
     one would silently disable the trust check for every merged view. */
  if (archive.sources.length === 0 || job.active) return;
  el.verify.disabled = true;
  job.cancelled = false;
  var bad = [];
  var n = archive.ranges.length;
  var decoder = new TextDecoder();
  progressStart('正在逐条复读…');

  var i = 0;
  while (i < n) {
    if (job.cancelled) break;
    /* Same batch rule as scanRecords, and for the same reason: a batch that
       straddles two files reads the wrong bytes for half of it. Here the
       consequence is worse than a dropped search hit — this is the feature whose
       whole job is to be trusted, and it would report those records as real data
       loss, with offsets that are offsets into a different file. */
    var owner = sourceOf(i);
    if (owner === null) break;
    var j = i + 1;
    while (j < n && j < i + 400 && archive.ranges[j].src === archive.ranges[i].src) j++;
    var from = archive.ranges[i].start;
    var to = archive.ranges[j - 1].end;
    var buf = new Uint8Array(await owner.source.slice(from, to).arrayBuffer());
    for (var k = i; k < j; k++) {
      var r0 = archive.ranges[k];
      try {
        JSON.parse(decoder.decode(buf.subarray(r0.start - from, r0.end - from)));
      } catch (err) {
        bad.push({ i: k, error: err && err.message ? err.message : String(err) });
      }
    }
    i = j;
    progressSet('正在逐条复读 ' + i + ' / ' + n + '…', n ? i / n : 1);
    await new Promise(function (res) { setTimeout(res, 0); });
  }

  progressEnd();
  el.verify.disabled = false;
  var dt = (performance.now() - job.startedAt).toFixed(0);

  if (job.cancelled) {
    say('<div class="box warn">完整性检查已停止（读到第 ' + i + ' 条）。' +
        (bad.length ? '在已读的部分里发现 <b>' + bad.length + '</b> 条读不出来。' : '已读的部分全部正常。') +
        '剩下的没有检查。</div>', 'warn');
    return;
  }
  if (bad.length === 0) {
    say('<div class="box ok"><b>完整性检查通过。</b>' + n +
        ' 条记录逐条重新读取并解析，全部成功，用时 ' + dt + ' ms。没有任何一条丢失或损坏。</div>', 'ok');
  } else {
    say('<div class="box error"><b>有 ' + bad.length + ' 条记录读不出来：</b><ul>' +
        bad.slice(0, 20).map(function (b) {
          return '<li>第 ' + (b.i + 1) + ' 条（' + whereOf(b.i) + '）：' + esc(b.error) + '</li>';
        }).join('') +
        '</ul>' + (bad.length > 20 ? '<p>只列出前 20 条。</p>' : '') +
        '<p>这些是真实的数据缺口，不要基于这份文件做合并。</p></div>', 'error');
  }
});

/* ------------------------------------------------------- preferences --- */

var PREFS_KEY = 'xtb-reader-prefs';

function loadPrefs() {
  try {
    var raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    var o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return;
    prefs.remoteAvatars = o.remoteAvatars === true;
    prefs.tz = o.tz === 'local' ? 'local' : 'archive';
    prefs.theme = THEMES.has(o.theme) ? o.theme : 'system';
  } catch (_) { /* a corrupt preference is not worth failing the page over */ }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      remoteAvatars: prefs.remoteAvatars === true,
      tz: prefs.tz === 'local' ? 'local' : 'archive',
      theme: THEMES.has(prefs.theme) ? prefs.theme : 'system'
    }));
  } catch (_) { /* private mode; the page still works, it just will not remember */ }
}

/* ------------------------------------------------------------------ theme -- */

var THEMES = new Set(['system', 'light', 'dark']);
var THEME_ORDER = ['system', 'light', 'dark'];
var systemDark = window.matchMedia('(prefers-color-scheme: dark)');

/**
 * Paint the page in the chosen theme.
 *
 * `data-theme` is always WRITTEN, never removed, and 'system' is resolved here
 * rather than left to the stylesheet's media query. Not laziness: the media
 * query is only what covers the instant before this script runs — after that
 * the attribute would shadow it anyway — so resolving once, in one place, is
 * what stops the button and the stylesheet from ever disagreeing about which
 * theme is on.
 *
 * Setting the attribute is also what tells the browser to draw its own controls
 * for that scheme, which is the whole reason the date field's calendar button
 * is visible now. See the note at the top of the stylesheet.
 */
function applyTheme() {
  var dark = prefs.theme === 'dark' || (prefs.theme === 'system' && systemDark.matches === true);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** The button says which of the three it is on, the way 头像 does for its two. */
function paintThemeButton() {
  if (!el.btnTheme) return;
  el.btnTheme.textContent = prefs.theme === 'light' ? '主题：浅色'
    : (prefs.theme === 'dark' ? '主题：深色' : '主题');
  el.btnTheme.classList.toggle('primary', prefs.theme !== 'system');
}

function setTheme(next) {
  prefs.theme = THEMES.has(next) ? next : 'system';
  savePrefs();
  applyTheme();
  paintThemeButton();
}

/* The system can change while the page is open. Only 'system' listens: a theme
   that was chosen is a decision, and following the system afterwards would be
   the page overruling it — and it would do so silently, at some arbitrary
   moment, which is the worst way to lose a setting. */
if (typeof systemDark.addEventListener === 'function') {
  systemDark.addEventListener('change', function () {
    if (prefs.theme === 'system') applyTheme();
  });
}

if (el.btnTheme) {
  el.btnTheme.addEventListener('click', function () {
    setTheme(THEME_ORDER[(THEME_ORDER.indexOf(prefs.theme) + 1) % THEME_ORDER.length]);
  });
}

/** Everything on screen depends on the timezone, so a change redraws the lot. */
function reRenderAll() {
  if (!heights) return;
  cache.clear();
  pending.clear();
  clearWindow();
  /* The profile is rebuilt before the window, because its height is part of
     the offset renderWindow subtracts — laying out the rows against the height
     of the previous file's header puts every card in the wrong place for a
     frame. */
  /* The same two calls commitSources makes, in the same order. Drawing only
     the profile left the account-list header — the one for several different
     accounts open at once — off the page for good: it is authored by
     renderAccountList alone, so switching 他人头像 or 时区 with two accounts
     open wiped the header and the sticky bar until every file was closed and
     reopened. */
  if (!renderProfile(archive.profile)) renderAccountList(archive.accounts);
  paintStickyBar();
  renderWindow(true);
  statsLine();
}

function setAvatarMode(on) {
  prefs.remoteAvatars = on === true;
  savePrefs();
  el.btnAvatar.textContent = prefs.remoteAvatars ? '他人头像：联网' : '他人头像';
  el.btnAvatar.classList.toggle('primary', prefs.remoteAvatars);
  reRenderAll();
}

el.btnAvatar.addEventListener('click', function () {
  if (prefs.remoteAvatars) { setAvatarMode(false); return; }
  el.askRemote.showModal();
});
el.askYes.addEventListener('click', function () {
  el.askRemote.close();
  setAvatarMode(true);
});

el.btnReport.addEventListener('click', function () {
  setReportClosed(!document.body.classList.contains('reportClosed'));
});

el.btnZone.addEventListener('click', function () {
  prefs.tz = prefs.tz === 'local' ? 'archive' : 'local';
  savePrefs();
  applyZone();
  reRenderAll();
});

/* --------------------------------------------------- 视图与地址栏 -------
 *
 * Three views — 全部时间线 / 检索 / 我 — and one place that decides which of
 * them is on screen: the address bar.
 *
 * Why the address and not a variable:
 *   - 「别人也能打开看」 needs one address per account and per post. A view
 *     switched by a variable is a view with nothing to paste into a message.
 *   - The browser's back button only moves when the address moves. There is no
 *     second way to make it work, and a reader that ignores the back button is
 *     broken in a way that is hard to name.
 *
 * The HASH and not the path, because this file is opened from a file:// URL
 * where there is no server to route anything: `#/` works there and `/me` does
 * not.
 *
 *   #/                        全部时间线
 *   #/search?q=…              检索
 *   #/me                      我
 *   #/@handle                 一个账号
 *   #/@handle/status/<id>     一篇帖子
 *
 * Nothing outside this section sets a view or writes an address. The one
 * exception is documented where it happens: fillTweetPage(), which knows the
 * post's author and id before this section does.
 * ------------------------------------------------------------------------ */

var router = {
  /* The last address that was actually applied. A hashchange that lands on the
     same route again — and the ones this page causes itself — must not redo
     the work: an account route would re-narrow the timeline, and a post route
     would go looking for a record it already has. */
  key: null,
  /* Set when this page put the post it is showing into the history itself.
     It is what lets 返回 be a real back button without ever walking the reader
     out of the reader — see backOutOfPost(). */
  postPushed: false
};

/** One path segment, decoded, and never a throw on a hand-typed address. */
function decodePart(s) {
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

/** The value of one query parameter, or '' — `+` is a space, as in a form. */
function queryValue(query, key) {
  if (query.length === 0) return '';
  var pairs = query.split('&');
  for (var i = 0; i < pairs.length; i++) {
    var eq = pairs[i].indexOf('=');
    var rawKey = decodePart((eq < 0 ? pairs[i] : pairs[i].slice(0, eq)).replace(/\+/g, ' '));
    if (rawKey !== key) continue;
    return decodePart((eq < 0 ? '' : pairs[i].slice(eq + 1)).replace(/\+/g, ' '));
  }
  return '';
}

/**
 * What the address bar is asking for.
 *
 * Always returns something. An address that names nothing this reader knows
 * comes back as `unknown` rather than as null, because "there is no such page"
 * still has to be shown as a sentence somewhere — see routeMissing().
 */
function parseHash() {
  var raw = location.hash;
  if (raw.charAt(0) === '#') raw = raw.slice(1);
  if (raw.charAt(0) === '/') raw = raw.slice(1);

  var at = raw.indexOf('?');
  var query = at >= 0 ? raw.slice(at + 1) : '';
  var path = at >= 0 ? raw.slice(0, at) : raw;
  var parts = path.split('/').filter(function (s) { return s.length > 0; });

  if (parts.length === 0) return { name: 'timeline' };
  if (parts.length === 1 && parts[0] === 'me') return { name: 'me' };
  if (parts.length === 1 && parts[0] === 'search') {
    return { name: 'search', q: queryValue(query, 'q') };
  }
  if (parts[0].charAt(0) === '@') {
    var handle = decodePart(parts[0].slice(1));
    if (parts.length === 3 && parts[1] === 'status' && parts[2].length > 0) {
      return { name: 'post', handle: handle, id: decodePart(parts[2]) };
    }
    if (parts.length === 1 && handle.length > 0) return { name: 'account', handle: handle };
  }
  return { name: 'unknown' };
}

/** The address of a route. The one place the five shapes are spelled out. */
function hrefOf(route) {
  if (!route) return '#/';
  if (route.name === 'me') return '#/me';
  if (route.name === 'search') {
    var q = route.q === undefined || route.q === null ? '' : String(route.q);
    return q.length > 0 ? '#/search?q=' + encodeURIComponent(q) : '#/search';
  }
  if (route.name === 'account') return '#/@' + encodeURIComponent(String(route.handle));
  if (route.name === 'post') {
    return '#/@' + encodeURIComponent(String(route.handle)) +
      '/status/' + encodeURIComponent(String(route.id));
  }
  return '#/';
}

/**
 * The address of one post.
 *
 * The AUTHOR's handle, from the record, and not the account the timeline
 * happens to be narrowed to: a reply by somebody else, opened from a thread, is
 * still that person's post and its address should say so. Null when the record
 * carries neither, which leaves the post page open with no address rather than
 * writing a made-up one.
 */
function postAddressOf(r) {
  var h = r && r.author && typeof r.author.screenName === 'string' ? r.author.screenName : '';
  var id = r && typeof r.id === 'string' ? r.id : '';
  if (h.length === 0 || id.length === 0) return null;
  return hrefOf({ name: 'post', handle: h, id: id });
}

/**
 * Go somewhere, by way of the address bar.
 *
 * Never applied directly: setting the hash is what makes the back button work,
 * and applying here as well would run everything twice — once for the caller
 * and once for the hashchange. An address that is already current is left
 * alone, because no event would fire and there would be nothing to do.
 */
function goHref(href) {
  if (location.hash !== href) location.hash = href;
}
function go(route) { goHref(hrefOf(route)); }

/**
 * The same, without leaving a history entry.
 *
 * For the places where the address is being CORRECTED rather than navigated to
 * — the account that was just removed, a post whose account is not here — where
 * a back button returning to the dead address would be a loop.
 */
function replaceRoute(route) {
  var href = hrefOf(route);
  if (location.hash === href) return;
  location.replace(href);
}

/**
 * Which view belongs on screen, from the address and from what is open.
 *
 * An empty reader has no timeline to show and nothing to search: the only page
 * with anything to press on it is 我, so an address naming a post, an account or
 * the timeline lands there. That is also what keeps a pasted link from opening
 * on a blank column — the failure this whole section exists to avoid.
 */
function viewFor(route) {
  if (archive.sources.length === 0) return 'me';
  if (route.name === 'me') return 'me';
  if (route.name === 'search') return 'search';
  return 'timeline';
}

/** The three navigation links, in both rows, said to agree with each other. */
function paintNav(here) {
  var rows = [[el.navTimeline, el.tabTimeline, 'timeline'],
              [el.navSearch, el.tabSearch, 'search'],
              [el.navMe, el.tabMe, 'me']];
  for (var i = 0; i < rows.length; i++) {
    for (var j = 0; j < 2; j++) {
      if (rows[i][j]) rows[i][j].classList.toggle('on', rows[i][2] === here);
    }
  }
}

/** Put the right view on screen and light the right link. Nothing else. */
function syncView(route) {
  var view = viewFor(route);
  document.body.classList.toggle('view-timeline', view === 'timeline');
  document.body.classList.toggle('view-search', view === 'search');
  document.body.classList.toggle('view-me', view === 'me');
  paintNav(view);
}

/** The account a `#/@handle` names, or null. */
function groupForHandle(handle) {
  if (typeof handle !== 'string' || handle.length === 0) return null;
  var want = handle.toLowerCase();
  var groups = groupSourcesByAccount();
  for (var i = 0; i < groups.length; i++) {
    var h = groupHandle(groups[i]);
    if (h !== null && h.toLowerCase() === want) return groups[i];
  }
  return null;
}

/**
 * An address that names something this reader does not have.
 *
 * A sentence, not a blank column and not a silent jump home — both of those
 * look like the reader worked and found nothing, which is a different statement
 * from "there is no such account in these files".
 */
function routeMissing(route) {
  var what = route.name === 'account' ? '@' + esc(route.handle)
    : route.name === 'post' ? '帖子 ' + esc(String(route.id))
      : esc(String(location.hash));
  say('<div class="box warn"><b>这个地址指向的东西不在现在打开的归档里：</b>' + what +
      '。下面显示的是全部记录。</div>', 'warn');
}

/**
 * Apply what an address asks for, beyond which view it selects.
 *
 * Only reached when the address actually changed, or when the set of open
 * files did — never on a redraw.
 */
async function applyRouteEffects(route) {
  try {
    await routeEffects(route);
  } catch (err) {
    /* Detached on purpose — nobody awaits this — so without a catch here an
       exception inside it would end as an unhandled rejection in a console
       nobody has open, over a page that silently did not move. */
    say('<div class="box error">这个地址处理不了：' +
        esc(err && err.message ? err.message : String(err)) + '</div>', 'error');
  } finally {
    /* The sidebar highlights the account the address names, and only this pass
       knows which one that turned out to be — `applyRouteEffects` is where
       `activeAccount` is written. In a `finally` so that a route which opens a
       post still lights the account the post came from, even though the lookup
       it does on the way can fail. */
    paintAccounts();
  }
}

/** The body of applyRouteEffects, split off so it has one exit that repaints. */
async function routeEffects(route) {
  var view = viewFor(route);

  /* The post page is a layer over whichever view is under it, so the two are
     decided separately: `#/@a/status/1` is a timeline with a post open on it,
     and coming back does not rebuild the timeline. Same for 我 — there is
     nothing under it to open a post onto. */
  if (route.name === 'post' && view !== 'me') { await openPostRoute(route); return; }
  closePostPage();

  /* Whatever the page being left had to say was about the page being left.
     Every branch below that has something to say says it AFTER this — the
     search with a hit count, routeMissing with a sentence — so nothing spoken
     here is lost, and a warning about an address the reader has since
     navigated away from does not sit over the one they are on. */
  say('');

  if (view === 'me') {
    activeAccount = null;
    if (archive.sources.length > 0) setAccountFilter(null);
    return;
  }

  if (route.name === 'account') {
    var g = groupForHandle(route.handle);
    activeAccount = g === null ? null : g.key;
    /* Out of search mode first, and this is not the same decision the old 只看
       dropdown made. A dropdown was a FILTER, and intersecting it with a query
       was the whole point; `#/@handle` is a destination — 这个账号的时间线 —
       and arriving at it with a query still narrowing the list would show four
       of the six hundred posts under a heading that says the account's name. */
    if (list.mode === 'search') {
      el.q.value = '';
      timelineMode();
    }
    setAccountFilter(g === null ? null : g.sources);
    /* Said LAST, and the order is load-bearing: timelineMode() writes to
       #notice on its way past, so a sentence spoken before it is a sentence
       the reader never sees. An address that names nobody still has to come
       out as words rather than as a timeline that quietly shows everybody. */
    if (g === null) routeMissing(route);
    return;
  }

  if (route.name === 'search') {
    activeAccount = null;
    setAccountFilter(null);
    var q = route.q || '';
    if (el.q.value !== q) el.q.value = q;
    clearTimeout(searchTimer);
    /* 检索 with an empty box is not an empty page. The list stays the whole
       archive — which is what somebody who just clicked the tab is looking at
       while they decide what to type — and only a real query replaces it. */
    if (q.trim().length > 0) void runSearch(q);
    else timelineMode();
    return;
  }

  /* `#/` — everything, in time order. */
  activeAccount = null;
  if (list.mode === 'search') { el.q.value = ''; timelineMode(); }
  else if (el.q.value.length > 0) el.q.value = '';
  setAccountFilter(null);
  /* Last, for the same reason as the account branch above. */
  if (route.name === 'unknown') routeMissing(route);
}

/**
 * Open the post an address names.
 *
 * The record is found by tweet id, and the only map that answers that is
 * `filters.byId` — which is a pass over every record to build. That is what
 * somebody who pasted a link pays, and it is exactly what somebody who clicked
 * a card must not pay, which is why the post page writes its own address as
 * soon as it opens: by the time the hashchange arrives here, the post is
 * usually already on screen and this returns having read nothing.
 */
async function openPostRoute(route) {
  if (tp.openId !== null && tp.openId === route.id) return;

  var g = groupForHandle(route.handle);
  var was = activeAccount;
  activeAccount = g === null ? null : g.key;
  /* Only when it changed, which for a post opened from inside an account's own
     timeline is never — the timeline underneath keeps both its scroll position
     and its filter. */
  if (activeAccount !== was) setAccountFilter(g === null ? null : g.sources);

  var ok = await ensureFilters();
  if (!ok || !filters.byId) { routeMissing(route); return; }
  var idx = filters.byId.get(route.id);
  if (typeof idx !== 'number') { routeMissing(route); return; }
  openTweetPageRecord(idx);
}

/**
 * 返回, and Escape: the reader is asking to go back out of a post.
 *
 * Through the history when this page put the post there — that IS what a back
 * button does, and it is the only way to walk a thread backwards — and to the
 * account's own address when the page was OPENED at this address, where going
 * back would take the reader out of the reader entirely.
 */
function backOutOfPost() {
  var route = parseHash();
  var ours = router.postPushed && route.name === 'post';
  router.postPushed = false;
  if (ours) { history.back(); return; }
  if (route.name === 'post') {
    closePostPage();
    replaceRoute(groupForHandle(route.handle) === null
      ? { name: 'timeline' }
      : { name: 'account', handle: route.handle });
    return;
  }
  closePostPage();
}

/**
 * Read the address and put the page into the state it asks for.
 *
 * `force` is for the callers that know the answer has changed even though the
 * address has not — the set of open files, above all. Every route here is
 * written in terms of what is open, so opening a file can turn `#/@me` from
 * "no such account" into the account's timeline without the address moving.
 */
function applyAddress(force) {
  var route = parseHash();
  syncView(route);
  var key = hrefOf(route);
  if (!force && key === router.key) return;
  router.key = key;
  /* A bare address is the same route as `#/`, and writing it out is what makes
     "which page is this" answerable from the address bar alone — which is the
     whole point of the address being the state. Not while 我 is standing in for
     an empty reader, though: `#/` there would claim a timeline with nothing in
     it. `key` is already recorded, so the hashchange this causes knows the
     address has not actually moved. */
  if (location.hash.length === 0 && viewFor(route) !== 'me') replaceRoute(route);
  void applyRouteEffects(route);
}

/* ------------------------------------------------------------ wiring ---- */

el.win.addEventListener('click', function (ev) {
  var card = ev.target.closest('.card');
  if (!card) return;
  /* A link inside the text is a link; everything else on a card opens the post,
     including the counts row. The counts themselves still do nothing — they are
     not buttons and are not styled as buttons — but they are not a hole in the
     card either. Clicking an icon and having nothing happen at all reads as a
     broken card, not as an honest one. */
  if (ev.target.closest('a')) return;
  var cell = ev.target.closest('.cell');
  if (cell) { openLightbox(list.at(card.__i), cell.__mi); return; }
  openTweetPage(card.__i);
});

el.btnPostBack.addEventListener('click', backOutOfPost);

el.postPage.addEventListener('click', function (ev) {
  /* Cards on the page are links into the conversation: clicking one loads that
     post, so a thread can be walked in either direction without going back to
     the timeline and finding it again. */
  if (ev.target.closest('a')) return;
  var card = ev.target.closest('.card');
  if (!card || typeof card.__rec !== 'number') return;
  var cell = ev.target.closest('.cell');
  /* Media first, on every card including the one already on screen. */
  if (cell) { openLightbox(card.__rec, cell.__mi); return; }
  /* The body walks the conversation — except on the post already shown, where
     it would only reload the same thing and throw away the scroll position. */
  if (card.__rec !== tp.openRec) openTweetPageRecord(card.__rec);
});
el.askRemote.addEventListener('click', function (ev) {
  if (ev.target.closest('[data-close]')) el.askRemote.close();
  else if (ev.target === el.askRemote) el.askRemote.close();
});

document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape') {
    /* The dialogs close themselves — the platform does it for a <dialog>. The
       post page is not one, so it has to be told; and while the lightbox is up
       Escape belongs to it, not to the page underneath. */
    if (el.lightbox.open || el.askRemote.open) return;
    /* The roster first: it is opened from the profile header, so it is on top
       of the timeline, and the post page cannot be open under it. */
    if (el.rosterPage.hidden === false) { closeRoster(); return; }
    /* Escape out of a post is the same request as 返回, so it goes through the
       same door — including the history walk, which is what makes Escape in a
       thread land on the post you came from. */
    backOutOfPost();
    return;
  }
  if (ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
  /* `/` is how every one of these pages is searched, and the box lives on 检索
     now. So it is a navigation as much as a focus: pressing it from the
     timeline goes to the box rather than focusing something off screen. */
  if (ev.key === '/') {
    ev.preventDefault();
    if (el.q.disabled) return;
    go({ name: 'search', q: el.q.value });
    /* After the view has switched, and that is the whole trick: the box is
       display:none while the timeline is up, and an element that is not
       rendered cannot take focus. Setting the hash queues the hashchange task;
       this queues behind it. */
    setTimeout(function () { if (!el.q.disabled) el.q.focus(); }, 0);
  }
});

/* The address follows the query, so a search is a thing that can be sent to
   somebody. `replaceRoute` and not `go`: typing is one decision, and a history
   entry per debounce tick would make the back button walk the query backwards
   one keystroke at a time. */
function searchAddress() {
  replaceRoute({ name: 'search', q: el.q.value });
}

el.q.addEventListener('input', function () { searchAddress(); scheduleSearch(); });
el.q.addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    clearTimeout(searchTimer);
    searchAddress();
    runSearch(el.q.value);
  }
  if (ev.key === 'Escape') {
    el.q.value = '';
    clearTimeout(searchTimer);
    searchAddress();
    timelineMode();
  }
});

el.when.addEventListener('change', function () {
  if (el.when.value) jumpToDay(el.when.value);
});

/* Anywhere in the field opens the calendar, not just the button at its right
   end. Chrome puts a text caret in whichever of the three numbers was clicked
   and shows the picker only for the icon — so the middle of a control that
   looks like one thing behaves like three, and the report was that the calendar
   would not open. Asking for it explicitly makes the whole field one target.
 *
 * Guarded because showPicker() throws when the call has no user activation, and
 * this handler can be reached by a synthetic click. A failed show leaves the
 * native behaviour exactly as it was. */
el.when.addEventListener('click', function () {
  if (typeof el.when.showPicker !== 'function') return;
  try {
    el.when.showPicker();
  } catch (_) { /* no activation, or already showing: the native path still works */ }
});

/* Delegated, so that the buttons can be re-rendered or added to without this
   being rewired — and so there is one listener rather than one per tab. */
el.tabs.addEventListener('click', function (ev) {
  var btn = ev.target.closest ? ev.target.closest('.tab') : null;
  if (!btn || !el.tabs.contains(btn)) return;
  /* Clicking the tab that is already showing does nothing. It is the same list,
     and re-applying it would throw away the reader's scroll position and any
     search they had typed to get here. */
  if (btn.dataset.tab === list.tab) return;
  selectTab(btn.dataset.tab);
});

el.scope.addEventListener('change', function () {
  selectTab('posts', el.scope.value);
});

/* ---------------------------------------------------------------- open --- */

/* Opening a file when one is ALREADY open means adding it, not replacing it.
 *
 * This used to replace, and the report that came back was that importing a
 * second zip "just shoves the previous one aside". Adding was implemented — in
 * a button that only appeared once two archives were open, which is a state you
 * could only reach by adding, so the whole feature was unreachable by the one
 * route anybody takes. Same rule as the drop handler below, for the same reason. */
el.pick.addEventListener('change', function () {
  var f = el.pick.files;
  if (f && f.length) {
    if (archive.sources.length > 0) addFiles(f);
    else openFiles(f);
  }
  el.pick.value = '';   /* so picking the same file twice still fires */
});

/* The drop target is the whole window once an archive is open, because by then
   the drop zone is hidden and there is nowhere left to aim at. Counting
   enter/leave pairs is what stops the highlight from flickering as the pointer
   crosses child elements. */
var dragDepth = 0;
window.addEventListener('dragenter', function (ev) {
  if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') === -1) return;
  ev.preventDefault();
  dragDepth++;
  el.drop.classList.add('over');
  if (archive.sources.length > 0) el.drop.style.display = '';
});
window.addEventListener('dragover', function (ev) {
  if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') === -1) return;
  ev.preventDefault();
});
window.addEventListener('dragleave', function () {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    el.drop.classList.remove('over');
    if (archive.sources.length > 0) el.drop.style.display = 'none';
  }
});
window.addEventListener('drop', function (ev) {
  if (!ev.dataTransfer || !ev.dataTransfer.files || !ev.dataTransfer.files.length) return;
  ev.preventDefault();
  dragDepth = 0;
  el.drop.classList.remove('over');
  /* Nothing open yet: this is "open these". Something already open: the drop
     zone only appears as an overlay at that point, so the intent is to add. */
  if (archive.sources.length > 0) addFiles(ev.dataTransfer.files);
  else openFiles(ev.dataTransfer.files);
});

/* The empty state is one big click target for the file picker — except on the
   two things inside it that are already a target of their own. The label opens
   the picker through its own `for`, so letting the click bubble would open the
   dialog twice, and the GitHub button must do nothing at all rather than
   quietly open a file picker instead. */
el.drop.addEventListener('click', function (ev) {
  if (ev.target.closest && ev.target.closest('button, label')) return;
  el.pick.click();
});

/* ---------------------------------------------------------------- boot --- */

loadPrefs();
/* Before anything is drawn, and before the first row is measured: the theme
   decides the fonts' colours and the scrollbar's width, and `heights` is built
   from measurements taken after this. */
applyTheme();
paintThemeButton();
el.btnAvatar.textContent = prefs.remoteAvatars ? '他人头像：联网' : '他人头像';
if (prefs.remoteAvatars) el.btnAvatar.classList.add('primary');
el.q.disabled = true;
el.when.disabled = true;
el.btnZone.disabled = true;
el.btnAvatar.disabled = true;
el.verify.disabled = true;
/* The markup starts on 帖子/所有; painted from `list` so the two cannot drift. */
paintTabs();

/* The address, read once here and every change after that through the one
   listener. Nothing else sets a view. `force` on the first read because there
   is no previous route to compare against — and with nothing open it lands on
   我, which is the only page at that point with anything on it. */
window.addEventListener('hashchange', function () { applyAddress(false); });
/* Painted before the first address is read, because the two halves of 我 — the
   empty state and the list — are switched from here and nowhere else has run
   yet. With nothing open this is the empty state, which is what the markup
   already says; the point is that the two agree from the first frame. */
refreshMe();
applyAddress(true);
