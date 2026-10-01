/* ------------------------------------------------------- virtual scroll --
 *
 * Cards are not all the same height, so "scrollTop divided by row height" — the
 * whole of the previous scheme — does not exist any more. What replaces it:
 *
 *   heights  a per-row height table with a two-level prefix sum, so
 *            "which row is at y" and "where does row i start" are both cheap
 *   estimate the first guess, from the record's byte length — the only size
 *            signal the index has
 *   measure  every card that gets rendered reports its real height back
 *
 * The estimate never reaches the screen. Cards are positioned from the table,
 * and the table is corrected from real measurements before the frame paints
 * (a ResizeObserver callback runs after layout and before paint), so a row is
 * only ever drawn after its height is known. A bad estimate shows up as a
 * scrollbar that is slightly out of scale, and nothing else.
 * ------------------------------------------------------------------------ */

var ro = null;
var pendingMeasures = new Map();
var measureQueue = [];
var measureFlushQueued = false;
var unstableRows = 0;
var readyRows = 0;
var HEIGHT_UNSTABLE_LIMIT = 0.3;
var HEIGHT_MIN_SAMPLES = 12;

/**
 * Size the height table to the list on screen.
 *
 * `list.length()` and `list.at()` rather than `archive.ranges.length` and `i`:
 * under a search or a filter those are different numbers, and using the archive
 * ones is the bug that put 20 592 rows under a 592-hit search.
 *
 * Must be called AFTER the list has been composed, never before — the table is
 * built from what the list says is there.
 */
function rebuildHeights() {
  heights = buildHeightsFor(archive.ranges, list.ids);
  unstableRows = 0;
  readyRows = 0;
  el.spacer.style.height = heights.total + 'px';
}

/**
 * The observer that catches a row changing size on its own — after a window
 * resize reflows the text, say.
 *
 * It is NOT what measures a card when its content arrives. It cannot be: a row
 * is observed while it is a skeleton, filled a moment later, and re-inserted by
 * the window sort in between, and none of that is guaranteed to produce a
 * notification whose size is the interesting one. Left to the observer alone, a
 * row that misses its notification keeps its estimated height for the rest of
 * the session — which is a card 44 pixels taller than its neighbours, forever.
 * scheduleMeasure() closes that window; this only has to catch the rest.
 */
function ensureObserver() {
  if (ro) return ro;
  ro = new ResizeObserver(function (entries) {
    if (!heights || heights.frozen) return;
    var any = false;
    for (var k = 0; k < entries.length; k++) {
      var node = entries[k].target;
      var i = node.__i;
      if (typeof i !== 'number') continue;
      /* Skeleton rows are deliberately not measured. A skeleton is already
         exactly as tall as the table says, so measuring one would report no
         change — but counting it as "settled" would let a real card's arrival
         look like a second correction. */
      if (node.dataset.ready !== '1') continue;
      if (node.__ready !== true) { node.__ready = true; readyRows++; }
      var box = entries[k].borderBoxSize;
      var h = box && box[0] ? box[0].blockSize : node.offsetHeight;
      if (!(h > 0)) continue;
      pendingMeasures.set(i, h);
      any = true;
    }
    if (any) flushMeasures();
  });
  return ro;
}

/**
 * Measure a row as soon as its content exists, batched into one layout.
 *
 * The read happens in a microtask, which still runs before the browser paints,
 * so the correction is never visible — the same guarantee the observer was
 * supposed to give, without depending on it to deliver.
 */
function scheduleMeasure(node, i) {
  if (!heights || heights.frozen) return;
  measureQueue.push({ node: node, i: i });
  if (measureFlushQueued) return;
  measureFlushQueued = true;
  Promise.resolve().then(function () {
    measureFlushQueued = false;
    var q = measureQueue;
    measureQueue = [];
    var any = false;
    for (var k = 0; k < q.length; k++) {
      var h = q[k].node.offsetHeight;
      if (h > 0) { pendingMeasures.set(q[k].i, h); any = true; }
    }
    if (any) flushMeasures();
  });
}

/**
 * Fold the pending measurements into the table and keep the reading position.
 *
 * The re-anchor is the part that is easy to leave out and painful to miss: if a
 * row above the viewport turns out taller than estimated, everything below it
 * slides down, and the line the reader was looking at jumps. Adding the total
 * change of the rows strictly above the viewport back onto scrollTop cancels
 * exactly that.
 */
function flushMeasures() {
  if (!heights || heights.frozen || !heights.n) { pendingMeasures.clear(); return; }

  var scroll = el.scroller.scrollTop;
  /* Into ROW coordinates: `y` below is an offset in the height table, and the
     table starts after the header. `scroll` itself stays raw, because it is
     written back to scrollTop further down. */
  var top = scroll - headSpace();
  var y = heights.offsetOf(view.first);
  var delta = 0;
  var changed = 0;

  for (var i = view.first; i < view.last; i++) {
    var oldH = heights.get(i);
    var newH = pendingMeasures.has(i) ? pendingMeasures.get(i) : oldH;
    if (Math.abs(newH - oldH) > 0.5) {
      if (y < top) delta += newH - oldH;      /* strictly above the viewport */
      if (heights.bump(i) > 1) unstableRows++; /* already measured once before */
      heights.set(i, newH);
      changed++;
      oldH = newH;
    }
    y += oldH;
  }
  pendingMeasures.clear();

  if (delta) el.scroller.scrollTop = scroll + delta;
  if (changed) el.spacer.style.height = heights.total + 'px';
  positionWindow();

  /* The escape hatch. If rows keep changing size after they have already been
     measured once — which the explicit aspect-ratios on media cells are there to
     prevent — then chasing them would go on forever, each correction scheduling
     the next. Freeze at the current numbers and say so, rather than oscillating
     under the reader's eyes. */
  if (!heights.frozen && readyRows >= HEIGHT_MIN_SAMPLES &&
      unstableRows / readyRows > HEIGHT_UNSTABLE_LIMIT) {
    heights.frozen = true;
    // addNotice, not say: this is a fact about THIS ARCHIVE, and it is fired
    // from a measurement callback rather than by anything the reader did — so it
    // must not be replaced by the next search, and it must not replace the
    // integrity report either.
    addNotice('<b>高度测量在这个归档上不稳定，已停止继续修正。</b><br>' +
        '卡片位置改用估算高度，滚动时可能偶有跳动。这通常意味着有内容在渲染后还在改变尺寸。' +
        '把这条信息发出来即可。', 'warn');
  }
}

/**
 * Place every rendered card from the height table.
 *
 * One prefix-sum walk for the whole window: recomputing each card's offset
 * individually would be a fresh walk per card, and the walk is the expensive
 * half of the lookup.
 */
function positionWindow() {
  if (!heights) return;
  var y = heights.offsetOf(view.first);
  var nodes = el.win.children;
  for (var k = 0; k < nodes.length; k++) {
    var node = nodes[k];
    node.style.transform = 'translateY(' + y + 'px)';
    y += heights.get(node.__i);
  }
}

function clearWindow() {
  if (ro) ro.disconnect();
  el.win.textContent = '';
  rendered.clear();
  pendingMeasures.clear();
  view.first = 0;
  view.last = 0;
}

function renderWindow(force) {
  if (!heights || !heights.n) return;
  var n = heights.n;
  /* Row coordinates, not scroller coordinates: the header is part of the
     scrolled content, so the row at the top of the window is the one at
     scrollTop minus the header. indexAt clamps a negative to row 0, which is
     the right answer while the header is still on screen. */
  var top = el.scroller.scrollTop - headSpace();
  var vh = el.scroller.clientHeight || 600;

  var first = Math.max(0, heights.indexAt(top) - OVERSCAN);
  var last = Math.min(n, heights.indexAt(top + vh) + 1 + OVERSCAN);
  if (last <= first) last = Math.min(n, first + 1);

  if (force || first !== view.first || last !== view.last) {
    var obs = ensureObserver();

    /* Removals and additions are diffed rather than rebuilt. The previous
       version assigned innerHTML on every scroll frame, which with cards in it
       would destroy and recreate every <img> and every <video> continuously:
       images would re-decode and a playing video would restart from zero. */
    var drop = [];
    rendered.forEach(function (node, i) {
      if (i < first || i >= last) drop.push(i);
    });
    for (var d = 0; d < drop.length; d++) {
      var dead = rendered.get(drop[d]);
      obs.unobserve(dead);
      dead.remove();
      rendered.delete(drop[d]);
    }

    /* Appended in ascending index order, and the DOM order is what
       positionWindow walks, so the two never disagree. */
    for (var i = first; i < last; i++) {
      if (rendered.has(i)) continue;
      var node = buildRow(i);
      rendered.set(i, node);
      el.win.appendChild(node);
      obs.observe(node);
    }

    view.first = first;
    view.last = last;

    /* Re-append in index order.
     *
     * This is not tidiness. `appendChild` on a node already in the tree MOVES
     * it, so this pass sorts the children — and the children were not sorted:
     * scrolling from rows 93-107 up to rows 0-7 removes 8-107 and appends 0-7,
     * leaving the DOM as 93 94 95 96 97 0 1 2 3 4 5 6 7. Positions come from a
     * walk over the children, so that run would be laid out in that order: the
     * cards would tile the viewport without a gap and show the wrong posts.
     *
     * Paint order, tab order and the order a screen reader reads all follow the
     * DOM too, so getting this right fixes three things at once. It costs one
     * pass over the dozen or so nodes in the window. */
    for (var q = first; q < last; q++) el.win.appendChild(rendered.get(q));

    positionWindow();
  }
}

/**
 * One row: either a placeholder exactly as tall as the table says, or the real
 * card when its record is already parsed.
 *
 * The placeholder carries the height explicitly, which is what stops a row that
 * has not loaded yet from being measured as a few pixels tall and dragging
 * everything below it upward for a frame.
 */
function buildRow(i) {
  var node = document.createElement('article');
  node.className = 'card';
  node.__i = i;

  var recIdx = list.at(i);
  var range = archive.ranges[recIdx];
  /* A record that appears in more than one open file carries the folded-together
     version on its range, built once by the merge pass — so it needs no read,
     and asking for one would put "读取中…" on screen for a record that is
     already in hand. */
  var cached = cache.get(recIdx) ||
    (range && range.merged !== undefined ? { data: range.merged } : null);
  if (cached) {
    fillCard(node, i, cached);
  } else {
    node.classList.add('loading');
    node.dataset.ready = '0';
    node.style.height = heights.get(i) + 'px';
    node.innerHTML = '<div class="card__avatar" style="background:var(--bg-soft)"></div>' +
      '<div class="card__body"><div class="card__text">读取中…</div></div>';
    ensureRecord(recIdx);
  }
  return node;
}

/**
 * Swap a row's contents for the real card.
 *
 * `ready` becomes 1 before the children are replaced, so the observer callback
 * that follows the size change sees a settled row and measures it. Doing it the
 * other way round would throw away the first real measurement and leave the row
 * on its estimate until something else happened to resize it.
 */
function fillRow(i) {
  var node = rendered.get(i);
  if (node) fillCard(node, i, cache.get(list.at(i)));
}

function fillCard(node, i, entry) {
  node.__ready = false;
  node.classList.remove('loading', 'failed');
  node.style.height = '';
  node.textContent = '';

  if (!entry) {
    node.classList.add('loading');
    node.dataset.ready = '0';
    node.style.height = heights.get(i) + 'px';
    node.textContent = '读取中…';
    return;
  }
  node.dataset.ready = '1';
  if (entry.error) {
    node.classList.add('failed');
    var p = document.createElement('div');
    p.className = 'card__text';
    p.textContent = '这一条读不出来：' + entry.error;
    node.appendChild(p);
  } else {
    buildCard(node, i, entry.data);
  }
  node.__ready = true;
  scheduleMeasure(node, i);
}

/* --------------------------------------------------------------- cache --- */

/**
 * Load one record's bytes and parse them, if not already cached.
 *
 * This is the only place a record body enters memory. Reading a record does not
 * touch any other record, so the cost of scrolling is bounded by what is on
 * screen — which is the whole reason the index stores offsets instead of text.
 */
function ensureRecord(recIdx) {
  if (recIdx < 0 || recIdx >= archive.ranges.length) return;
  var own = archive.ranges[recIdx];
  if (own && own.merged !== undefined) { cache.set(recIdx, { data: own.merged }); return; }
  if (cache.has(recIdx)) { touch(recIdx); return; }
  if (pending.has(recIdx)) return;

  pending.add(recIdx);
  /* The FILE's generation, not the list's. A read in flight is stale only when
     the bytes it is reading have gone away; changing the search or the filter
     leaves them exactly where they were, and keying on the list generation threw
     away perfectly good reads and left the visible cards as skeletons. */
  var gen = archive.gen;
  /* Which of the open files this record's bytes are in. The range itself carries
     the answer — see materialize(). */
  var owner = sourceOf(recIdx);
  if (owner === null) { pending.delete(recIdx); return; }

  readRecordAt(owner.source, archive.ranges[recIdx]).then(function (res) {
    pending.delete(recIdx);
    if (gen !== archive.gen) return;   /* a different file is open now */
    cache.set(recIdx, res.ok ? { data: res.value } : { error: res.error });
    evictIfNeeded();
    rendered.forEach(function (node, pos) {
      if (list.at(pos) === recIdx) fillRow(pos);
    });
    refreshCacheStat();
  });
}

function touch(recIdx) {
  var v = cache.get(recIdx);
  cache.delete(recIdx);
  cache.set(recIdx, v);
}

/**
 * Drop the least recently used records once the cache is over its limit.
 *
 * Rows currently rendered are skipped: evicting one would blank a card that is
 * on screen right now, and it would immediately be re-read — a thrash loop.
 * There are only ever a few dozen of them, so skipping costs nothing.
 */
function evictIfNeeded() {
  if (cache.size <= CACHE_LIMIT) return;
  var visible = new Set();
  rendered.forEach(function (node, pos) { visible.add(list.at(pos)); });

  var it = cache.keys();
  var next;
  while (cache.size > CACHE_LIMIT) {
    next = it.next();
    if (next.done) break;
    if (visible.has(next.value)) continue;
    cache.delete(next.value);
  }
}

var cacheStatBucket = -1;
function refreshCacheStat() {
  /* Only when the number actually moved by a visible amount: rewriting the stat
     line on every record load would thrash the DOM while scrolling. */
  var bucket = Math.floor(cache.size / 25);
  if (bucket === cacheStatBucket || el.stats.hidden) return;
  cacheStatBucket = bucket;
  statsLine();
}

/* -------------------------------------------------------------- chrome --- */

/* ---------------------------------------------------------- scroll-away --
 *
 * The profile header scrolls away as the reader scrolls, the way X's does, and
 * a bar with the name and the post count takes its place at the top.
 *
 * What was here before was a collapse: `body.compact` flipped at 140px of
 * scroll and the whole header snapped to a 52px row, with a second threshold at
 * 60px so that a reader resting on the boundary would not make the page
 * oscillate. It worked, and it was not what the page should do — the jump reads
 * as a glitch rather than as scrolling, and the row it collapsed into showed
 * the avatar and the handle rather than the two things X keeps.
 *
 * The arithmetic, and the property that makes it safe: the header's height and
 * the sticky bar's height always sum to a constant, so nothing below them ever
 * jumps. Let H be the header's natural height and S the sticky bar's:
 *
 *     header  = max(0, H - scrollTop)
 *     sticky  = min(S, max(0, scrollTop - (H - S)))
 *
 * For scrollTop below H-S that is H-scrollTop + 0; above it, 0 + S. In between
 * the two add to exactly S. The bar therefore rises into the space the header
 * is leaving rather than appearing in it.
 *
 * The header's CONTENTS are translated up by scrollTop at the same time, which
 * is the half that makes it read as scrolling rather than as a box being
 * squashed: what is visible is the slice [scrollTop, H] of the header, and the
 * cards in the scroller are rising by the same number of pixels at the same
 * moment.
 *
 * Only renderWindow has to re-run afterwards. `heights` is a table of CONTENT
 * heights and knows nothing about the viewport; `first`/`last` are recomputed
 * inside it from clientHeight, which is the number that changed. Nothing inside
 * the list moves: the pixels come off chrome ABOVE the scroller, so they are
 * added at the bottom of the list and every card on screen keeps its position.
 * There is nothing to anchor, which is why this needs no re-anchoring the way
 * flushMeasures does.
 *
 * The stat line deliberately does NOT scroll away. It is the reader's own
 * summary of the file — and unlike the header it is not tall enough to be worth
 * the jump of hiding it partway down. */

var STICKY_H = 53;       /* the bar's height, and the tabs' sticky offset */

/**
 * How much of the scrolled content sits above the first card.
 *
 * The profile and the tabs are inside the scroller — that is what makes the
 * header and the timeline one plane, so that scrolling pushes the banner and
 * the avatar up exactly as it pushes the cards. The cost is that `scrollTop` is
 * no longer a position in the row table: it is a position in a document that
 * starts with the header. Everything that indexes rows has to subtract this.
 *
 * Read from the DOM rather than accumulated in a variable, because it is not
 * one number: the header's height depends on how many lines the bio wraps to
 * and whether the archive has a profile at all, and the tabs are hidden for an
 * archive that has none. `offsetTop` is measured from the scroller's border box
 * because #scroller is positioned, which is the answer wanted and cannot drift
 * from the layout the way a cached sum can.
 */
function headSpace() {
  return el.spacer ? el.spacer.offsetTop : 0;
}

/**
 * Fade the bar's two layers in as the profile leaves.
 *
 * Opacity only — no height, no transform, nothing that can move anything else.
 * A first attempt at this drove the header's height and its content's transform
 * from scrollTop, which meant every scroll frame wrote layout, which changed
 * the scroller's own clientHeight, which could feed back into the next frame.
 * A layer that only changes its alpha cannot do that.
 *
 * The name comes in within the first ~90px, because it is what tells the reader
 * where they are; the background waits until the profile is nearly gone, so
 * that over the banner it is text on the picture rather than a slab across it.
 */
function paintStickyBar() {
  if (!el.stickyBar || el.stickyBar.hidden) return;
  var s = el.scroller.scrollTop;
  var head = headSpace();
  var text = Math.min(1, s / 90);
  /* `head - STICKY_H` is where the profile has scrolled exactly under the bar;
     the background starts 60px before that and takes 60px to arrive. */
  var bg = head <= 0 ? 1 : Math.min(1, Math.max(0, (s - (head - STICKY_H - 60)) / 60));
  el.stickyBar.style.setProperty('--sb-text', String(Math.round(text * 100) / 100));
  el.stickyBar.style.setProperty('--sb-bg', String(Math.round(bg * 100) / 100));
  el.stickyBar.classList.toggle('on', bg >= 1);
}

/* -------------------------------------------------------------- events --- */

var scrollScheduled = false;
el.scroller.addEventListener('scroll', function () {
  if (scrollScheduled) return;
  scrollScheduled = true;
  window.requestAnimationFrame(function () {
    scrollScheduled = false;
    paintStickyBar();
    renderWindow(false);
  });
}, { passive: true });

var resizeTimer = null;
window.addEventListener('resize', function () {
  if (!el.view.classList.contains('on')) return;
  paintStickyBar();
  renderWindow(true);
  /* A width change reflows every card, so heights are stale for everything not
     on screen. The visible rows re-measure themselves through the observer; the
     rest are corrected as they come into view. Debounced because dragging a
     window edge fires this continuously. */
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () { renderWindow(true); }, 120);
});
