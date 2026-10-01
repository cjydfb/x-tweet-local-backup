/* --------------------------------------------------------------- blobs --
 *
 * Media lives inside the ZIP, so showing one is: read the entry's byte range out
 * of the archive file, wrap it, hand the browser a blob: URL. Three rules make
 * that survive a long session.
 *
 *   1. An object URL is never revoked while something is still showing it. The
 *      thumbnail and the lightbox share one URL per file, so revoking "the
 *      lightbox's" URL would blank the thumbnail behind it.
 *   2. A playing video is never revoked. Chrome does not error when this
 *      happens — it simply stops, mid-frame.
 *   3. The archive can be moved or deleted after the page loads. Every blob read
 *      then fails asynchronously, and every consumer of these URLs has to have an
 *      error path, because a dead <img> renders as nothing at all.
 * ------------------------------------------------------------------------ */

var urlCache = new Map();      /* key -> { url, bytes, pins, used } */
var urlBytes = 0;
var urlClock = 0;
var URL_MAX_COUNT = 80;
var URL_MAX_BYTES = 256 * 1024 * 1024;

/** The MIME type to declare, from what the record says the media is. */
function mimeFor(m, index) {
  if (m && Array.isArray(m.variants) && m.variants.length) {
    var v = m.variants[Math.min(index || 0, m.variants.length - 1)];
    if (v && typeof v.contentType === 'string' && v.contentType) return v.contentType;
  }
  if (m && Array.isArray(m.variants) && m.variants[0] && m.variants[0].contentType) {
    return m.variants[0].contentType;
  }
  if (m && m.type === 'photo') return 'image/jpeg';
  if (m && (m.type === 'video' || m.type === 'animated_gif')) return 'video/mp4';
  return '';
}

/**
 * A blob: URL for one media file, created on first use and shared afterwards.
 *
 * The MIME type is declared rather than left empty, because a ZIP entry carries
 * no type and a `<video>` given a typeless blob is at the mercy of sniffing.
 * `File` is used instead of `Blob` for one reason: it accepts a type without
 * copying the bytes. The data stays in the archive file on disk and the URL is a
 * view onto it, which is what keeps a 40 MB video from becoming 40 MB of heap.
 */
async function getMediaUrl(key, mime) {
  var hit = urlCache.get(key);
  if (hit) { hit.used = ++urlClock; return hit.url; }

  var range = await mediaRange(key);
  if (!range) return null;

  /* Which open file this media's bytes are in. The key is `<tweetId> <mediaId>`
     and tweet ids do not repeat, so a media key names exactly one file even when
     several archives are open — but it still has to be looked up rather than
     assumed, because `archive.file` is only "the one file" while there is one. */
  var owner = archive.sources[range.src];
  if (!owner) return null;
  var slice = owner.file.slice(range.start, range.end);
  if (slice.size === 0) return null;
  if (range.method === ZIP_METHOD.DEFLATE) {
    slice = new Blob([await inflateRaw(slice)]);
  } else if (range.method !== ZIP_METHOD.STORE) {
    return null;   /* method 12 (bzip2) and friends were never written by us */
  }
  if (mime) {
    try { slice = new File([slice], 'media', { type: mime }); } catch (_) { /* keep the typeless blob */ }
  }

  var url = URL.createObjectURL(slice);
  urlCache.set(key, { url: url, bytes: slice.size, pins: 0, used: ++urlClock });
  urlBytes += slice.size;
  evictUrls();
  return url;
}

function pinUrl(key) {
  var e = urlCache.get(key);
  if (e) e.pins++;
}
function unpinUrl(key) {
  var e = urlCache.get(key);
  if (e && e.pins > 0) e.pins--;
}

/**
 * Drop least-recently-used entries, never a pinned one.
 *
 * The loop is a `while` and the iteration order is sorted, not Map order,
 * because Map order is insertion order and the entry that needs to go is the one
 * that was *used* longest ago — which after a scroll back up is not the one that
 * was created first.
 */
function evictUrls() {
  if (urlCache.size <= URL_MAX_COUNT && urlBytes <= URL_MAX_BYTES) return;
  var entries = [];
  urlCache.forEach(function (v, k) { entries.push([k, v]); });
  entries.sort(function (a, b) { return a[1].used - b[1].used; });

  for (var i = 0; i < entries.length; i++) {
    if (urlCache.size <= URL_MAX_COUNT && urlBytes <= URL_MAX_BYTES) break;
    if (entries[i][1].pins > 0) continue;
    URL.revokeObjectURL(entries[i][1].url);
    urlBytes -= entries[i][1].bytes;
    urlCache.delete(entries[i][0]);
  }
}

function releaseAllUrls() {
  urlCache.forEach(function (v) { URL.revokeObjectURL(v.url); });
  urlCache.clear();
  urlBytes = 0;
  mediaLocations.clear();
}

/* ------------------------------------------------------------ lightbox --- */

var lb = { items: [], at: 0, tweetId: null, last: null, gen: 0 };

function buildLbNav() {
  if (el.lightbox.querySelector('.nav.prev')) return;
  var prev = document.createElement('button');
  prev.className = 'nav prev';
  prev.type = 'button';
  prev.textContent = '‹';
  prev.setAttribute('aria-label', '上一个');
  var next = document.createElement('button');
  next.className = 'nav next';
  next.type = 'button';
  next.textContent = '›';
  next.setAttribute('aria-label', '下一个');
  var close = document.createElement('button');
  close.className = 'btn close';
  close.type = 'button';
  close.textContent = '关闭';
  prev.addEventListener('click', function (e) { e.stopPropagation(); step(-1); });
  next.addEventListener('click', function (e) { e.stopPropagation(); step(1); });
  close.addEventListener('click', function () { el.lightbox.close(); });
  el.lbStage.appendChild(prev);
  el.lbStage.appendChild(next);
  /* Inside the stage, not the dialog: `.close` is absolutely positioned, and the
     stage is the positioned ancestor. */
  el.lbStage.appendChild(close);
}

/**
 * Open the viewer at one item of one post's media.
 *
 * The list is the post's own media, in order, so ‹ and › walk exactly the
 * pictures that were posted together — which is what "gallery" means here.
 */
function openLightbox(recIdx, mediaIndex) {
  /* A RECORD index, not a position in the list. It used to take a position,
     which the timeline could supply and the post dialog could not — the dialog
     draws records that may not be in the current list at all — so opening a
     picture from inside the dialog silently did nothing. */
  var entry = cache.get(recIdx);
  if (!entry || !entry.data) return;
  var r = entry.data;
  if (!Array.isArray(r.media) || !r.media.length) return;

  lb.tweetId = r.id;
  lb.items = r.media;
  lb.at = Math.max(0, Math.min(mediaIndex, r.media.length - 1));
  buildLbNav();
  el.lightbox.showModal();
  showLbItem();
}

function step(d) {
  if (lb.items.length < 2) return;
  lb.at = (lb.at + d + lb.items.length) % lb.items.length;
  showLbItem();
}

function showLbItem() {
  if (lb.last) { unpinUrl(lb.last); lb.last = null; }
  el.lbStage.querySelectorAll('img, video').forEach(function (n) { n.remove(); });

  var m = lb.items[lb.at];
  var key = mediaKeyFor(lb.tweetId, m && m.id);
  var isVideo = m && (m.type === 'video' || m.type === 'animated_gif');

  el.lbCap.textContent = (lb.at + 1) + ' / ' + lb.items.length +
    '　' + (MEDIA_LABEL[m.type] || '媒体') +
    (typeof m.durationMs === 'number' && m.durationMs > 0
      ? '　' + Math.round(m.durationMs / 1000) + ' 秒' : '');
  el.lbAlt.textContent = m && m.altText ? m.altText : '';

  var prev = el.lbStage.querySelector('.nav.prev');
  var next = el.lbStage.querySelector('.nav.next');
  var multi = lb.items.length > 1;
  prev.style.display = multi ? '' : 'none';
  next.style.display = multi ? '' : 'none';

  if (!key) {
    el.lbAlt.textContent = '这一项媒体没有可用的 id，找不到对应文件。';
    return;
  }
  if (key) pinUrl(key);

  var gen = ++lb.gen;
  getMediaUrl(key, mimeFor(m, 0)).then(function (url) {
    /* Reading a file out of the archive is asynchronous, and the viewer can be
       closed while it is in flight. Without this the element would be inserted
       into a closed dialog and left there — which is exactly what an unclosed
       blob URL looks like. */
    if (gen !== lb.gen || !el.lightbox.open) { unpinUrl(key); return; }
    if (!url) {
      el.lbAlt.textContent = (m.altText ? m.altText + '　——　' : '') +
        '这个媒体文件不在归档里。只有 ZIP 归档带媒体文件；直接导出的 JSON 没有。';
      return;
    }
    var node;
    if (isVideo) {
      node = document.createElement('video');
      node.controls = true;
      node.autoplay = true;
      node.playsInline = true;
      /* A playing video is pinned for as long as it is on screen, so the LRU
         cannot revoke the URL out from under the decoder. */
      node.addEventListener('play', function () { pinUrl(key); });
      node.addEventListener('ended', function () { unpinUrl(key); });
      node.addEventListener('error', function () {
        el.lbAlt.textContent = '这个视频播不了——浏览器不认识它的编码，或者归档被移动过。';
      });
    } else {
      node = document.createElement('img');
      node.alt = m.altText || '';
      node.addEventListener('error', function () {
        el.lbAlt.textContent = '这张图读不出来——归档可能被移动过或删掉了。';
      });
    }
    el.lbStage.insertBefore(node, el.lbStage.firstChild);
    node.src = url;
    lb.last = key;
  }).catch(function () {
    el.lbAlt.textContent = '媒体文件读取失败。';
  });
}

el.lightbox.addEventListener('close', function () {
  lb.gen++;
  if (lb.last) { unpinUrl(lb.last); lb.last = null; }
  /* Emptying the stage is not tidiness: an <img> left in the DOM keeps its blob
     URL alive, and a <video> left in the DOM keeps decoding. */
  var media = el.lbStage.querySelectorAll('img, video');
  for (var i = 0; i < media.length; i++) {
    if (media[i].tagName === 'VIDEO') { media[i].pause(); media[i].removeAttribute('src'); }
    media[i].remove();
  }
  el.lbAlt.textContent = '';
  el.lbCap.textContent = '';
});

el.lightbox.addEventListener('click', function (ev) {
  /* Clicking the backdrop closes; clicking the picture does not. */
  if (ev.target === el.lightbox) el.lightbox.close();
});

document.addEventListener('keydown', function (ev) {
  if (!el.lightbox.open) return;
  if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
});
