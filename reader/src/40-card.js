/* ----------------------------------------------------------------- card --
 *
 * One card, built as DOM rather than as an HTML string.
 *
 * The reason is not purity. A card's text is untrusted, and the previous version
 * escaped it into a template; here every user-controlled value goes in through
 * textContent, so there is no escaping step that can be forgotten. The only
 * innerHTML in this file is for markup that is entirely ours.
 * ------------------------------------------------------------------------ */

/* X's own icons, copied out of the live page rather than redrawn.
 *
 * They are filled shapes, not strokes: each glyph is an outline drawn as a
 * closed path, so there is no stroke to set and no width to tune. The old set
 * here was hand-drawn with round caps at 1.8px, which read as "similar" beside
 * X's and as "off" once the row was compared with a screenshot side by side.
 *
 * viewBox 0 0 24 24 on every one of them, which is X's grid and the reason a
 * fixed 17px box renders them at the size X does. */
var ICONS = {
  reply: '<path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z"/>',
  repost: '<path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"/>',
  like: '<path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/>',
  views: '<path d="M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z"/>',
  bookmark: '<path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.276 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.224-.5-.5-.5h-11z"/>',
  share: '<path d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"/>'
};

function icon(name) {
  return '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" ' +
    'aria-hidden="true">' + ICONS[name] + '</svg>';
}

/**
 * X's verified badge — the scalloped disc with the tick knocked out of it.
 *
 * One path with two subpaths, and the second winds against the first, which is
 * what makes the tick a hole rather than a second filled shape. Filled, not
 * stroked; the colour is X's own blue and the box is 22x22 rather than the
 * 24x24 the action icons use, because that is the grid X draws it on.
 *
 * It replaces a text "✔", which was a different glyph in a different font on
 * every machine and never the same shape twice.
 */
var VERIFIED_PATH = 'M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z';

function verifiedIcon() {
  return '<svg viewBox="0 0 22 22" width="19" height="19" fill="currentColor" ' +
    'aria-hidden="true"><path d="' + VERIFIED_PATH + '"/></svg>';
}

function span(cls, text) {
  var s = document.createElement('span');
  s.className = cls;
  if (text !== undefined) s.textContent = text;
  return s;
}

/**
 * One card. Everything here is layout and text: no request is issued, and the
 * only asynchrony is the media blob, which fills a box whose size was already
 * decided by the grid's aspect-ratio.
 */
function buildCard(node, i, r) {
  var author = r.author && typeof r.author === 'object' ? r.author : {};
  var handle = typeof author.screenName === 'string' && author.screenName.length ? author.screenName : '';
  var name = typeof author.name === 'string' && author.name.length ? author.name : (handle || '（没有作者信息）');

  node.appendChild(avatarNode(author, 40));

  var body = document.createElement('div');
  body.className = 'card__body';

  /* ---- header ---- */
  var head = document.createElement('div');
  head.className = 'card__head';
  head.appendChild(span('card__name', name));
  if (handle) {
    head.appendChild(span('card__handle', '@' + handle));
    head.appendChild(span('card__dot', '·'));
  }
  var t = span('card__time', fmtRelative(r.createdAt));
  t.title = fmtClock(r.createdAt) + '（' + tzLabel() + '）';
  head.appendChild(t);
  body.appendChild(head);

  /* ---- text ---- */
  var text = document.createElement('p');
  text.className = 'card__text';
  if (typeof r.text === 'string' && r.text.length) {
    text.appendChild(renderText(r));
  } else {
    text.classList.add('void');
    text.textContent = '（无正文）';
  }
  body.appendChild(text);

  /* ---- badges ---- */
  var badges = badgesFor(r);
  if (badges) body.appendChild(badges);

  /* ---- media ---- */
  if (Array.isArray(r.media) && r.media.length) body.appendChild(buildGrid(r));

  /* ---- poll ---- */
  if (r.isPoll) body.appendChild(buildPoll(r));

  /* ---- counts ---- */
  var acts = buildActs(r);
  if (acts) body.appendChild(acts);

  node.appendChild(body);
}

/* -------------------------------------------------------------- badges --- */

function badgesFor(r) {
  var items = [];
  if (r.isReply) items.push(['reply', '回复']);
  if (r.quoteTweetId) items.push(['quote', '引用']);
  if (r.isPoll) items.push(['poll', '投票']);
  if (r.isEdit) items.push(['edit', '编辑过']);
  if (r.deletedAt) items.push(['dead', '已删除']);
  if (r.supersededBy) items.push(['edit', '已被新版取代']);
  if (r.conversationIdInferred) items.push(['', '会话号为推断']);

  if (!items.length) return null;
  var wrap = document.createElement('div');
  wrap.className = 'badges';
  for (var k = 0; k < items.length; k++) {
    var b = span('badge' + (items[k][0] ? ' ' + items[k][0] : ''), items[k][1]);
    if (items[k][0] === 'dead') b.title = '删除时间：' + fmtClock(r.deletedAt);
    wrap.appendChild(b);
  }
  return wrap;
}

/* ---------------------------------------------------------------- text --- */

/**
 * The post's text with its links, hashtags and mentions marked up.
 *
 * Every stored entity is used as a WHITELIST, and the positions are found by
 * scanning the text rather than read out of the record: `entities.urls` stores
 * url / expandedUrl / displayUrl and hashtags are bare strings, so each
 * candidate the scan finds is kept only if the entity list confirms it. A
 * hashtag in somebody's post text that X did not classify as a hashtag stays
 * plain text, which is the right way round.
 *
 * Records written since schema v5 also carry `entities.spans` — the offsets X
 * itself measured, which an archived record always has and a live capture
 * usually does not. This function does not read them yet, and that is a gap
 * rather than a decision: the scan below has to stay for every record written
 * before v5 anyway, so switching to the stored offsets is a change worth making
 * on its own, with its own test, and not as a side effect of something else.
 * Until then they are carried and unused.
 *
 * `resolveSpans` then drops anything that overlaps a longer span, because X's
 * entities genuinely do overlap — a t.co link whose display text contains a
 * hashtag is the common case — and nesting anchors produces broken markup.
 */
function renderText(r) {
  var text = String(r.text || '');
  var ents = r.entities && typeof r.entities === 'object' ? r.entities : {};
  var tags = Array.isArray(ents.hashtags) ? ents.hashtags : [];
  var mentions = Array.isArray(ents.mentions) ? ents.mentions : [];

  var spans = [];
  var occ;
  collectUrlSpans(spans, text, Array.isArray(ents.urls) ? ents.urls : []);

  var lowerTags = tags.map(function (s) { return String(s).toLowerCase(); });
  var re = /#([\p{L}\p{N}_]+)/gu;
  while ((occ = re.exec(text)) !== null) {
    if (lowerTags.indexOf(occ[1].toLowerCase()) !== -1) {
      spans.push({ start: occ.index, end: occ.index + occ[0].length, kind: 'tag', href: null, text: occ[1] });
    }
  }

  var lowerWho = mentions.map(function (m) {
    return m && typeof m.screenName === 'string' ? m.screenName.toLowerCase() : '';
  });
  var reWho = /@([A-Za-z0-9_]{1,15})/g;
  while ((occ = reWho.exec(text)) !== null) {
    if (lowerWho.indexOf(occ[1].toLowerCase()) !== -1) {
      spans.push({ start: occ.index, end: occ.index + occ[0].length, kind: 'who', href: null, text: occ[1] });
    }
  }

  return renderSpansInto(document.createDocumentFragment(), text, resolveSpans(spans));
}

/**
 * Find where each stored URL actually appears in the text, and mark it.
 *
 * The stored entity is a WHITELIST, so each candidate is looked for by its own
 * text and only the ones actually found in the post are marked. Both spellings
 * are tried, the
 * display text first and the t.co address second, and the first one that matches
 * ends the search for that URL: a link written twice would otherwise produce two
 * overlapping spans for one thing, and resolveSpans would then drop the shorter
 * by accident rather than by rule.
 *
 * Both `entities.urls` and a profile's `bioUrls` have this shape, which is why
 * the post and the bio share this one function.
 */
function collectUrlSpans(spans, text, urls) {
  for (var k = 0; k < urls.length; k++) {
    var u = urls[k];
    if (!u || typeof u !== 'object') continue;
    var href = safeExternalUrl(u.expandedUrl) || safeExternalUrl(u.url);
    if (!href) continue;
    var needles = [];
    if (typeof u.displayUrl === 'string' && u.displayUrl) needles.push(u.displayUrl);
    if (typeof u.url === 'string' && u.url && needles.indexOf(u.url) === -1) needles.push(u.url);
    /* Per URL, not over the whole span list: with the global count, a second URL
       was skipped entirely whenever the first one had matched, because the
       check saw the first URL's spans and stopped before trying its own t.co
       address. */
    var before = spans.length;
    for (var n = 0; n < needles.length; n++) {
      var at = 0, occ;
      while ((occ = text.indexOf(needles[n], at)) !== -1) {
        spans.push({ start: occ, end: occ + needles[n].length, kind: 'url', href: href });
        at = occ + needles[n].length;
      }
      if (spans.length > before) break;   /* the first needle that matches wins */
    }
  }
}

/**
 * Emit a text with its resolved spans: the literal text between them, an anchor
 * for a URL, a styled span for a hashtag or a mention.
 *
 * Shared by the post text and the profile's bio. A hashtag and a mention are
 * deliberately NOT links: they point at a site that may no longer have the
 * account, which is precisely why the archive exists. They are marked up so the
 * text reads the way it was written, and following one would leave the archive
 * to land nowhere.
 */
function renderSpansInto(frag, text, spans) {
  var cursor = 0;
  for (var k = 0; k < spans.length; k++) {
    var s = spans[k];
    if (s.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, s.start)));
    if (s.kind === 'url') {
      var a = document.createElement('a');
      a.href = s.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = text.slice(s.start, s.end);
      frag.appendChild(a);
    } else {
      var spanEl = document.createElement('span');
      spanEl.className = s.kind === 'tag' ? 'tag' : 'who';
      spanEl.textContent = text.slice(s.start, s.end);
      frag.appendChild(spanEl);
    }
    cursor = s.end;
  }
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
  return frag;
}

/**
 * The profile's bio, with its links, as a fragment — or null when there is none.
 *
 * Only URLs are marked up. A post's hashtags and mentions are confirmed against
 * the record's own entity lists, and a profile has no entity list to confirm
 * them with: a `profile.bioUrls` array is all the envelope carries. Guessing
 * that `#tag` is a hashtag because it looks like one is the opposite of the rule
 * the cards follow, so anything that is not a stored URL stays plain text.
 */
function renderBio(p) {
  var bio = typeof p.bio === 'string' ? p.bio : '';
  if (!bio) return null;
  var spans = [];
  collectUrlSpans(spans, bio, Array.isArray(p.bioUrls) ? p.bioUrls : []);
  return renderSpansInto(document.createDocumentFragment(), bio, resolveSpans(spans));
}

/* --------------------------------------------------------------- media --- */

/**
 * The media grid. Its height is decided here, before any file is read: the
 * aspect-ratio comes from the media metadata, so a late-arriving image cannot
 * change the card's height and the scroller never has to correct itself.
 */
function buildGrid(r) {
  var media = r.media;
  var shown = Math.min(media.length, 4);
  var shape = gridShape(media.length);

  var grid = document.createElement('div');
  grid.className = 'grid n' + shape;
  grid.dataset.count = String(media.length);

  grid.style.aspectRatio = aspectFor(media[0], shape);

  for (var k = 0; k < shown; k++) {
    var cell = buildCell(r.id, media[k], k);
    if (k === 3 && media.length > 4) {
      var more = document.createElement('div');
      more.className = 'more';
      more.textContent = '+' + (media.length - 3);
      cell.appendChild(more);
    }
    grid.appendChild(cell);
  }
  return grid;
}

/**
 * Width/height for the whole grid.
 *
 * A single item uses its own ratio so the picture is not cropped; anything
 * multi-item uses a fixed shape, because a grid of tiles has no single ratio to
 * inherit. The clamp is what keeps a 1:4 panorama or a 9:1 strip from making one
 * card several screens tall — X crops those too.
 */
function aspectFor(m, shape) {
  if (shape >= 4) return '1 / 1';
  var pair = m && Array.isArray(m.aspectRatio) ? m.aspectRatio : null;
  if (!pair) return '16 / 9';
  var w = Number(pair[0]), h = Number(pair[1]);
  if (!(w > 0) || !(h > 0)) return '16 / 9';
  var ratio = w / h;
  if (ratio < 0.65) return '0.65 / 1';
  if (ratio > 2.4) return '2.4 / 1';
  return w + ' / ' + h;
}

var MEDIA_LABEL = { photo: '图片', video: '视频', animated_gif: '动图' };

function buildCell(tweetId, m, k) {
  var cell = document.createElement('div');
  cell.className = 'cell';
  if (!m || typeof m !== 'object') {
    cell.appendChild(placeholder('（这一项媒体信息不完整）'));
    return cell;
  }

  var key = mediaKeyFor(tweetId, m.id);
  var isVideo = m.type === 'video' || m.type === 'animated_gif';
  var inArchive = !!(key && archive.mediaMap && archive.mediaMap.has(key));

  if (isVideo) {
    /* A video cell does NOT load its file. It used to — an <img> pointed at the
       media key, which for a video resolves to an MP4, and an image element
       cannot decode one: every video in the grid fell through to the error
       branch and announced that its file was unreadable, whether it was or not.
       A real still would mean running a decoder per cell behind a scrolling
       timeline. So the cell says "video, this long" and nothing more, and the
       file itself is read only when the lightbox opens. */
    if (!inArchive) cell.appendChild(placeholder('视频文件不在这个归档里'));
    var play = document.createElement('div');
    play.className = 'play';
    play.textContent = '▶';
    cell.appendChild(play);
    if (typeof m.durationMs === 'number' && m.durationMs > 0) {
      var dur = document.createElement('div');
      dur.className = 'dur';
      dur.textContent = fmtDuration(m.durationMs);
      cell.appendChild(dur);
    }
  } else if (key && inArchive) {
    var img = document.createElement('img');
    img.alt = typeof m.altText === 'string' ? m.altText : '';
    img.loading = 'lazy';
    img.decoding = 'async';
    cell.appendChild(img);
    attachMedia(cell, img, key, m);
  } else {
    cell.appendChild(placeholder(
      (MEDIA_LABEL[m.type] || '媒体') +
      (key ? '文件不在这个归档里' : '（没有可用的媒体 id）')));
  }

  cell.__mi = k;
  cell.__media = m;
  cell.__key = key;
  cell.style.cursor = 'pointer';
  return cell;
}

/** X writes durations as m:ss. */
function fmtDuration(ms) {
  var total = Math.round(ms / 1000);
  var m = Math.floor(total / 60);
  var s = total % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/**
 * Resolve the file and put it in the cell.
 *
 * Nothing is assumed about the archive still being there: the file may have been
 * moved or deleted since the page loaded, and a blob: read then fails
 * asynchronously. The cell says which of the two happened, because a silent
 * blank is indistinguishable from "this archive never had the file".
 */
function attachMedia(cell, img, key, m) {
  getMediaUrl(key, mimeFor(m, 0)).then(function (url) {
    if (!url) {
      cell.textContent = '';
      cell.appendChild(placeholder(
        (MEDIA_LABEL[m.type] || '媒体') + '文件不在这个归档里' +
        (m.altText ? '：' + m.altText : '')));
      return;
    }
    img.addEventListener('error', function () {
      cell.textContent = '';
      cell.appendChild(placeholder('这个媒体文件读不出来（归档可能被移动过）'));
    });
    img.src = url;
  }).catch(function () {
    cell.textContent = '';
    cell.appendChild(placeholder('媒体文件读取失败'));
  });
}

function placeholder(text) {
  var d = document.createElement('div');
  d.className = 'ph';
  d.textContent = text;
  return d;
}

/* ---------------------------------------------------------------- poll --- */

function buildPoll(r) {
  var p = r.poll && typeof r.poll === 'object' ? r.poll : {};
  var box = document.createElement('div');
  box.className = 'poll';

  var choices = Array.isArray(p.choices) ? p.choices : [];
  if (choices.length) {
    var ol = document.createElement('ol');
    for (var k = 0; k < choices.length; k++) {
      var li = document.createElement('li');
      li.textContent = choices[k];
      ol.appendChild(li);
    }
    box.appendChild(ol);
  } else {
    var none = document.createElement('div');
    none.className = 'ph';
    none.textContent = '投票选项没有随发帖响应一起返回，所以归档里没有选项文字。';
    box.appendChild(none);
  }

  var note = document.createElement('p');
  note.className = 'note';
  var bits = [];
  if (p.endDatetimeUtc) bits.push('结束于 ' + fmtClock(p.endDatetimeUtc));
  if (p.cardName) bits.push('卡片类型 ' + p.cardName);
  bits.push(p.choicesFromResponse === false ? '选项来源：不在响应里' : '选项来源：发帖响应');
  note.textContent = bits.join(' · ');
  box.appendChild(note);
  return box;
}

/* --------------------------------------------------------------- counts -- */

/**
 * The counts row.
 *
 * No hover state and a single grey for every icon: these are numbers X reported
 * when the post was captured, and this archive holds no record of whether *you*
 * liked or reposted anything, so a coloured heart or green arrows would be an
 * invention. The row carries no handler of its own — a click on it bubbles to
 * the card and opens the post, like any other part of the card.
 */
/**
 * The link to one record.
 *
 * `tweetUrl` is what the extension wrote and is preferred. It can be missing in
 * a record that was merged or hand-assembled, and then the id and the handle are
 * enough to rebuild it. Null when neither is available — every caller has
 * something to say about that, and one definition of "this record's URL" is what
 * keeps the card's share control and the post page's 复制链接 from drifting.
 */
function tweetLinkOf(r) {
  var stored = r && safeExternalUrl(r.tweetUrl);
  if (stored) return stored;
  if (r && r.author && r.author.screenName && /^[0-9]+$/.test(String(r.id))) {
    return 'https://x.com/' + r.author.screenName + '/status/' + r.id;
  }
  return null;
}

function buildActs(r) {
  var m = r.metrics && typeof r.metrics === 'object' ? r.metrics : {};
  /* The four figures X reports, then the two that close its row.
   *
   * The last two never carry a number and that is not missing data: a bookmark
   * count is not public on X, and there is nothing to count about a share. They
   * are here for the shape of the row, which is what the reader is reproducing.
   * The fourth slot says exactly that, because it has to be told apart from the
   * `.none` case — an entry with no number because the capture did not carry
   * one is HIDDEN but keeps its space, so the icons line up across every card.
   * A bookmark drawn that way would vanish. */
  var defs = [
    ['reply', m.replyCount, '回复', false],
    ['repost', m.retweetCount, '转发', false],
    ['like', m.likeCount, '喜欢', false],
    ['views', m.viewCount, '查看', false],
    ['bookmark', null, '收藏', true],
    ['share', null, '分享', true]
  ];
  var any = defs.some(function (d) { return typeof d[1] === 'number'; });
  if (!any) return null;

  var wrap = document.createElement('div');
  wrap.className = 'acts';
  wrap.title = '这一行是捕获时 X 报出的样子：数字是当时的，不是实时的。' +
    '只有分享能点——复制这条的链接。';

  for (var k = 0; k < defs.length; k++) {
    var d = defs[k];
    var counted = typeof d[1] === 'number';
    var numberless = d[3] === true;
    /* 分享 is the one control in this row that does anything, so it is a real
       button — reachable by keyboard and announced as one — while still wearing
       the row's own look. See the .act[type=button] rule. */
    var isShare = d[0] === 'share';
    var item = document.createElement(isShare ? 'button' : 'span');
    if (isShare) item.type = 'button';
    item.className = 'act ' + d[0] + (counted || numberless ? '' : ' none');

    var iconBox = document.createElement('i');
    iconBox.innerHTML = icon(d[0]);
    item.appendChild(iconBox);

    /* Only the counted four get a figure. A 0 beside the bookmark would be
       inventing a number the archive does not hold. */
    if (counted) {
      var num = document.createElement('span');
      num.textContent = fmtCount(d[1]);
      item.appendChild(num);
    } else if (numberless) {
      item.title = d[2];
    }

    if (isShare) {
      /* stopPropagation, not preventDefault: the whole card is a click target
         that opens the post, and without this a reader trying to copy a link
         would get the post page instead. */
      item.title = '复制这条的链接';
      item.setAttribute('aria-label', '复制这条的链接');
      item.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var link = tweetLinkOf(r);
        if (link) copyText(link, '链接已复制');
        else copyText(String(r.id), '没有可用的链接，已复制 ID');
      });
    }

    wrap.appendChild(item);
  }
  return wrap;
}
