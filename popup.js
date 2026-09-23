/* ============================================================================
 * popup.js  —  extension page (module).
 *
 * Two data paths, both on the EXTENSION's origin (never the x.com origin):
 *   - the list, the search and the JSON export read IndexedDB directly through
 *     db.js, which is what makes paging/export cheap and streamable;
 *   - counters, settings, deletion and permission state go through
 *     background.js so there is exactly one writer and one source of truth.
 *
 * Rendering rules: every piece of tweet text goes through textContent. No
 * innerHTML is ever used with archive data, and every media URL is re-checked
 * for protocol + host before it is handed to an <img>.
 * ========================================================================== */

import {
  openDB,
  queryTweets,
  forEachTweet,
  getMediaRecord,
  listAllMedia,
  listDeletions,
  SCHEMA_VERSION
} from './db.js';

import { DEFAULT_SETTINGS } from './settings.js';

import { requestMediaPermission, isAllowedMediaUrl } from './media-cache.js';

import { buildZip, describeMediaArchive, buildMediaIndexJson } from './zip.js';

/* -------------------------------------------------------------------------- */
/* Localisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Look up a message from _locales/<lang>/messages.json.
 *
 * Chrome falls back to `default_locale` (en) when the user's language is
 * missing, so a not-yet-translated string shows in English rather than as an
 * empty gap or a raw key. The key itself is the last resort and makes a missing
 * entry obvious instead of invisible.
 */
function t(key, subs) {
  try {
    const message = chrome.i18n.getMessage(key, subs);
    return message && message.length > 0 ? message : key;
  } catch (_) {
    return key;
  }
}

/**
 * Fill in the static parts of popup.html. Chrome only substitutes __MSG_…__
 * in the manifest and CSS, so HTML has to be done by hand.
 *
 * data-i18n-html is used for exactly two strings, both our own — the ones that
 * need <strong> inside them. Nothing derived from archived data ever goes
 * through it.
 */
function applyStaticText() {
  document.documentElement.lang = chrome.i18n.getUILanguage();

  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
  }
  for (const el of document.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.getAttribute('data-i18n-title'));
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  }
  for (const el of document.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  }
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

const state = {
  db: null,
  settings: Object.assign({}, DEFAULT_SETTINGS),
  stats: null,
  counts: { tweets: null, media: null },
  purgeCounts: { superseded: 0, deleted: 0 },
  mediaPermission: false,
  armedPurge: null,
  query: '',
  nextKey: null,
  hasMore: false,
  loading: false,
  exporting: false,
  exportingMedia: false,
  renderedIds: new Set(),
  objectUrls: [],
  expanded: new Set(),
  armedDeleteId: null,
  armedClear: false,
  armTimer: null,
  searchTimer: null
};

const els = {
  refresh: document.getElementById('btn-refresh'),
  statCount: document.getElementById('stat-count'),
  statUsage: document.getElementById('stat-usage'),
  statMedia: document.getElementById('stat-media'),
  statLast: document.getElementById('stat-last'),
  search: document.getElementById('search'),
  export: document.getElementById('btn-export'),
  notice: document.getElementById('notice'),
  list: document.getElementById('list'),
  more: document.getElementById('btn-more'),
  listHint: document.getElementById('list-hint'),
  diagnostics: document.getElementById('diagnostics'),
  diagnosticsGrid: document.getElementById('diagnostics-grid'),
  resetStats: document.getElementById('btn-reset-stats'),
  optDebug: document.getElementById('opt-debug'),
  optThumbs: document.getElementById('opt-thumbs'),
  optMedia: document.getElementById('opt-media'),
  cleanup: document.getElementById('cleanup'),
  purgeSuperseded: document.getElementById('btn-purge-superseded'),
  purgeDeleted: document.getElementById('btn-purge-deleted'),
  purgeSupersededCount: document.getElementById('cleanup-superseded-count'),
  purgeDeletedCount: document.getElementById('cleanup-deleted-count'),
  tab: document.getElementById('btn-tab'),
  media: document.getElementById('btn-media'),
  clear: document.getElementById('btn-clear')
};

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

function describe(err) {
  try {
    if (err && err.message) return String(err.message).slice(0, 200);
    return String(err).slice(0, 200);
  } catch (_) {
    return t('unknownError');
  }
}

function setNotice(text, kind) {
  els.notice.textContent = text || '';
  els.notice.className = 'notice' + (kind ? ' is-' + kind : '');
}

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        try {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
        } catch (_) { /* ignore */ }
        resolve(response || { ok: false, error: t('noResponse') });
      });
    } catch (err) {
      resolve({ ok: false, error: describe(err) });
    }
  });
}

function formatDateTime(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toLocaleString();
  }
}

function formatRelative(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return formatDateTime(iso);
  const minute = 60000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return t('justNow');
  if (diff < hour) return t('minutesAgo', [String(Math.floor(diff / minute))]);
  if (diff < day) return t('hoursAgo', [String(Math.floor(diff / hour))]);
  if (diff < 30 * day) return t('daysAgo', [String(Math.floor(diff / day))]);
  return formatDateTime(iso);
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  const kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(1) + ' KB';
  const mb = kb / 1024;
  if (mb < 1024) return mb.toFixed(1) + ' MB';
  return (mb / 1024).toFixed(2) + ' GB';
}

function todayStamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

/** Only https URLs on an allowed host may reach an href/src. */
function safeMediaUrl(url) {
  return isAllowedMediaUrl(url) ? url : null;
}

function safeTweetUrl(url, fallbackId) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') throw new Error('protocol');
    return parsed.href;
  } catch (_) {
    return 'https://x.com/i/web/status/' + String(fallbackId);
  }
}

function revokeObjectUrls() {
  for (const url of state.objectUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch (_) { /* ignore */ }
  }
  state.objectUrls = [];
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch (_) { /* ignore */ }
  }, 60000);
}

/* -------------------------------------------------------------------------- */
/* Background state                                                           */
/* -------------------------------------------------------------------------- */

async function refreshState() {
  const response = await send({ type: 'XTB_GET_STATE' });
  if (!response || response.ok !== true) {
    setNotice(t('errState', [(response && response.error) || t('unknownError')]), 'error');
    return;
  }
  state.settings = Object.assign({}, DEFAULT_SETTINGS, response.settings || {});
  state.stats = response.stats || null;
  state.counts = response.counts || { tweets: null, media: null };
  state.purgeCounts = Object.assign({ superseded: 0, deleted: 0 }, response.purgeCounts || {});
  state.mediaPermission = response.mediaPermission === true;
  renderCleanup();

  els.optDebug.checked = state.settings.debug === true;
  els.optThumbs.checked = state.settings.showRemoteThumbnails === true;
  els.optMedia.checked = state.settings.mediaCache === true;
  els.diagnostics.hidden = state.settings.debug !== true;

  renderSummary();
  renderDiagnostics();
  await renderUsage();
}

async function renderUsage() {
  els.statUsage.textContent = '—';
  try {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return;
    const estimate = await navigator.storage.estimate();
    if (estimate && typeof estimate.usage === 'number') {
      els.statUsage.textContent = formatBytes(estimate.usage);
    }
  } catch (_) { /* not supported here: leave the dash */ }
}

function renderSummary() {
  els.statCount.textContent = state.counts.tweets === null || state.counts.tweets === undefined
    ? '—'
    : String(state.counts.tweets);
  els.statMedia.textContent = state.counts.media === null || state.counts.media === undefined
    ? '—'
    : String(state.counts.media);
  els.statLast.textContent = state.stats && state.stats.lastCaptureAt
    ? formatRelative(state.stats.lastCaptureAt)
    : '—';
  if (state.stats && state.stats.lastCaptureAt) {
    els.statLast.title = formatDateTime(state.stats.lastCaptureAt);
  } else {
    els.statLast.title = '';
  }
}

/**
 * The two cleanup categories. The counts come from background.js so there is
 * exactly one definition of what each category means; an empty category shows a
 * disabled button rather than an armed one that would delete nothing.
 *
 * The summary line carries the total too, so a user who never opens the section
 * still finds out there is something to clean.
 */
function renderCleanup() {
  const superseded = Number.isFinite(state.purgeCounts.superseded) ? state.purgeCounts.superseded : 0;
  const deleted = Number.isFinite(state.purgeCounts.deleted) ? state.purgeCounts.deleted : 0;

  const pairs = [
    { filter: 'superseded', count: superseded, button: els.purgeSuperseded, label: els.purgeSupersededCount },
    { filter: 'deleted', count: deleted, button: els.purgeDeleted, label: els.purgeDeletedCount }
  ];

  for (const pair of pairs) {
    pair.label.textContent = t('itemCount', [String(pair.count)]);
    const armed = state.armedPurge === pair.filter;
    pair.button.disabled = pair.count === 0;
    pair.button.textContent = armed
      ? t('confirmPurge', [String(pair.count)])
      : t('delete');
    pair.button.classList.toggle('is-armed', armed);
  }

  const total = superseded + deleted;
  const summary = els.cleanup.querySelector('summary');
  if (summary) {
    summary.textContent = total > 0
      ? t('cleanupSummaryCount', [String(total)])
      : t('cleanupSummary');
  }
}

function diagRow(term, value, kind) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  if (kind) dd.className = kind;
  return [dt, dd];
}

function renderDiagnostics() {
  if (state.settings.debug !== true) return;

  const grid = els.diagnosticsGrid;
  while (grid.firstChild) grid.removeChild(grid.firstChild);

  const stats = state.stats;
  if (!stats) {
    const pair = diagRow(t('diagStatus'), t('diagNoData'), '');
    grid.appendChild(pair[0]);
    grid.appendChild(pair[1]);
    return;
  }

  const page = stats.page || {};
  const lifetime = stats.lifetime || {};

  // Status is derived per transport. hookOverwritten only records that
  // SOMETHING was replaced, so using it directly here would wrongly mark a
  // healthy transport as dead.
  const transportState = (alive) => {
    if (alive === true) return { text: t('diagInstalled'), kind: 'is-good' };
    return {
      text: page.hookOverwritten === true ? t('diagOverwritten') : t('diagMissing'),
      kind: 'is-bad'
    };
  };
  const fetchState = transportState(page.hookInstalled === true);
  const xhrState = transportState(page.xhrHookInstalled === true);

  const rows = [
    [t('diagFetchHook'), fetchState.text, fetchState.kind],
    [t('diagXhrHook'), xhrState.text, xhrState.kind],
    [t('diagSeen'), String(page.createTweetSeen || 0), ''],
    [t('diagParsed'), String(page.parsed || 0), ''],
    [t('diagParseFailed'), String(page.parseFailed || 0), page.parseFailed ? 'is-bad' : ''],
    [t('diagJsonFailed'), String(page.responseJsonFailed || 0), page.responseJsonFailed ? 'is-bad' : ''],
    [t('diagCloneFailed'), String(page.responseCloneFailed || 0), page.responseCloneFailed ? 'is-bad' : ''],
    [t('diagBodyFailed'), String(page.requestBodyFailed || 0), page.requestBodyFailed ? 'is-bad' : ''],
    [t('diagPosted'), String(page.posted || 0), ''],
    [t('diagDeleteSeen'), String(page.deleteSeen || 0), ''],
    [t('diagDeleteMarked'), String(page.deleted || 0), ''],
    [t('diagReceived'), String(lifetime.received || 0), ''],
    [t('diagMarkedDeleted'), String(lifetime.deletedMarked || 0), ''],
    [t('diagUnmatchedDelete'), String(lifetime.deletedUnmatched || 0), ''],
    [t('diagUpsertOk'), String(lifetime.upsertOk || 0), lifetime.upsertOk ? 'is-good' : ''],
    [t('diagUpsertFailed'), String(lifetime.upsertFailed || 0), lifetime.upsertFailed ? 'is-bad' : ''],
    [t('diagRejected'), String(lifetime.rejected || 0), lifetime.rejected ? 'is-bad' : ''],
    [t('diagMediaCached'), String(lifetime.mediaCached || 0), ''],
    [t('diagMediaFailed'), String(lifetime.mediaFailed || 0), lifetime.mediaFailed ? 'is-bad' : ''],
    [t('diagLastError'), stats.lastError || t('diagNone'), stats.lastError ? 'is-bad' : ''],
    [t('diagErrorAt'), stats.lastErrorAt ? formatDateTime(stats.lastErrorAt) : '—', ''],
    [t('diagReportedAt'), page.reportedAt ? formatDateTime(page.reportedAt) : '—', '']
  ];

  for (const row of rows) {
    const pair = diagRow(row[0], row[1], row[2]);
    grid.appendChild(pair[0]);
    grid.appendChild(pair[1]);
  }
}

/* -------------------------------------------------------------------------- */
/* List rendering                                                             */
/* -------------------------------------------------------------------------- */

function listIsEmpty() {
  return els.list.querySelector('.card') === null;
}

function showEmptyState() {
  if (!listIsEmpty()) return;
  while (els.list.firstChild) els.list.removeChild(els.list.firstChild);
  const div = document.createElement('div');
  div.className = 'empty';
  if (state.query.length > 0) {
    div.textContent = t('emptyNoMatch', [state.query]);
  } else {
    div.textContent = t('emptyNone');
  }
  els.list.appendChild(div);
}

function clearEmptyState() {
  const empty = els.list.querySelector('.empty');
  if (empty) empty.remove();
}

/** Find the cached blob for one media item, or null. */
async function findCachedBlob(record, media, index) {
  const candidates = [];
  if (typeof media.id === 'string' && media.id.length > 0) {
    candidates.push(record.id + ':' + media.id);
  }
  candidates.push(record.id + ':' + String(index));

  for (const key of candidates) {
    try {
      const cached = await getMediaRecord(state.db, key);
      if (cached && cached.blob instanceof Blob) return cached.blob;
    } catch (_) { /* treat a read failure as "not cached" */ }
  }
  return null;
}

function mediaLabel(media) {
  return typeof media.type === 'string' ? media.type : t('mediaFallback');
}

function buildMediaThumb(record, media, index) {
  const box = document.createElement('div');
  box.className = 'card__thumb';

  const isMotion = media.type === 'video' || media.type === 'animated_gif';
  const remote = safeMediaUrl(media.thumbnailUrl) || safeMediaUrl(media.url);

  const showPlaceholder = () => {
    box.classList.add('card__thumb--empty');
    box.textContent = mediaLabel(media);
  };

  /** Remote poster frame, used whenever there is no usable cached file. */
  const useRemoteThumbnail = () => {
    if (remote === null || state.settings.showRemoteThumbnails !== true) {
      showPlaceholder();
      return;
    }
    const img = document.createElement('img');
    img.alt = typeof media.altText === 'string' && media.altText.length > 0 ? media.altText : '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      img.remove();
      showPlaceholder();
    });
    img.src = remote;
    box.appendChild(img);
    box.classList.add('is-remote');
    if (isMotion) box.classList.add('is-motion');
    box.title = isMotion ? t('thumbRemoteMotion') : t('thumbRemote');
  };

  if (remote === null && !isMotion) {
    showPlaceholder();
    return box;
  }

  void (async () => {
    const blob = await findCachedBlob(record, media, index);

    if (blob === null) {
      useRemoteThumbnail();
      return;
    }

    if (isMotion) {
      // The cached file for a video or GIF is an MP4 — and an <img> cannot
      // decode one. Pointing img.src at it failed silently and left an empty
      // box, which is why motion previews never appeared. A <video> element
      // renders the first frame and can actually be played.
      const objectUrl = URL.createObjectURL(blob);
      state.objectUrls.push(objectUrl);

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = objectUrl;
      video.addEventListener('loadedmetadata', () => {
        // Seeking a hair past zero forces the first frame to paint; some
        // encodes otherwise stay black until played.
        try { video.currentTime = 0.001; } catch (_) { /* ignore */ }
      }, { once: true });
      video.addEventListener('error', () => {
        video.remove();
        box.classList.remove('is-cached');
        useRemoteThumbnail();
      }, { once: true });
      // Click to play/pause in place; the thumbnail is small, so native
      // controls would be more chrome than picture.
      video.addEventListener('click', () => {
        if (video.paused) {
          const p = video.play();
          if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
        } else {
          video.pause();
        }
      });

      box.appendChild(video);
      box.classList.add('is-cached', 'is-motion');
      box.title = media.type === 'animated_gif'
        ? t('thumbCachedMotionGif')
        : t('thumbCachedMotion');
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    state.objectUrls.push(objectUrl);

    const img = document.createElement('img');
    img.alt = typeof media.altText === 'string' && media.altText.length > 0 ? media.altText : '';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      img.remove();
      box.classList.remove('is-cached');
      useRemoteThumbnail();
    });
    img.src = objectUrl;
    box.appendChild(img);
    box.classList.add('is-cached');
    box.title = t('thumbCached');
  })();

  return box;
}

function renderCard(record) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = record.id;

  /* ---- header: author + created time ---- */
  const head = document.createElement('div');
  head.className = 'card__head';

  const authorEl = document.createElement('div');
  authorEl.className = 'card__author';
  const screenName = record.author && typeof record.author.screenName === 'string'
    ? record.author.screenName
    : null;
  const displayName = record.author && typeof record.author.name === 'string'
    ? record.author.name
    : null;

  authorEl.textContent = displayName || (screenName !== null ? '@' + screenName : t('unknownAuthor'));
  if (displayName !== null && screenName !== null) {
    const handle = document.createElement('span');
    handle.textContent = '@' + screenName;
    authorEl.appendChild(handle);
  }

  const timeEl = document.createElement('div');
  timeEl.className = 'card__time';
  timeEl.textContent = formatDateTime(record.createdAt);
  timeEl.title = t('postedAt');

  head.appendChild(authorEl);
  head.appendChild(timeEl);
  card.appendChild(head);

  /* ---- body ---- */
  const text = typeof record.text === 'string' ? record.text : '';
  const textEl = document.createElement('p');
  textEl.className = 'card__text';
  // A retweet legitimately has no text of its own; saying "probably a
  // media-only post" there would be wrong.
  if (record.isRetweet === true && text.length === 0) {
    textEl.classList.add('card__text--retweet');
  }
  textEl.textContent = text; // never innerHTML
  card.appendChild(textEl);

  // The expand control exists on every card but is only revealed once the card
  // is in the DOM and we can measure it.
  //
  // Gating it on a character count was wrong: the clamp is six LINES, so a
  // 279-character post (<= 280) was visibly cut off with no way to reveal the
  // rest, while the same post in a wide tab needs no expander at all. Measuring
  // is the only rule that holds at every width.
  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'card__expand';
  expand.hidden = true;
  const startExpanded = state.expanded.has(record.id);
  if (startExpanded) textEl.classList.add('is-expanded');
  expand.textContent = startExpanded ? t('collapse') : t('expand');
  expand.addEventListener('click', () => {
    if (state.expanded.has(record.id)) {
      state.expanded.delete(record.id);
      textEl.classList.remove('is-expanded');
      expand.textContent = t('expand');
    } else {
      state.expanded.add(record.id);
      textEl.classList.add('is-expanded');
      expand.textContent = t('collapse');
    }
    syncExpandVisibility(card);
  });
  card.appendChild(expand);

  /* ---- poll ---- */
  const poll = record.poll !== null && typeof record.poll === 'object' ? record.poll : null;
  if (record.isPoll === true && poll !== null) {
    const pollEl = document.createElement('div');
    pollEl.className = 'card__poll';

    const choices = Array.isArray(poll.choices) ? poll.choices : [];
    const usable = choices.filter((c) => typeof c === 'string' && c.length > 0);

    if (usable.length > 0) {
      const list = document.createElement('ol');
      list.className = 'card__poll-choices';
      for (const choice of usable) {
        const item = document.createElement('li');
        item.textContent = choice; // never innerHTML
        list.appendChild(item);
      }
      pollEl.appendChild(list);

      if (typeof poll.endDatetimeUtc === 'string' && poll.endDatetimeUtc.length > 0) {
        const note = document.createElement('p');
        note.className = 'card__poll-note';
        note.textContent = (poll.countsAreFinal === true ? t('pollClosed') : t('pollCloses')) +
          formatDateTime(poll.endDatetimeUtc);
        pollEl.appendChild(note);
      }
    } else {
      // X did not inline the poll card in the create response. Saying so beats
      // drawing an empty box that reads like a rendering bug.
      const note = document.createElement('p');
      note.className = 'card__poll-note';
      note.textContent = t('pollNoChoices');
      if (typeof poll.cardUri === 'string' && poll.cardUri.length > 0) {
        note.title = t('badgeCardUri', [poll.cardUri]);
      }
      pollEl.appendChild(note);
    }

    card.appendChild(pollEl);
  }

  /* ---- media ---- */
  const media = Array.isArray(record.media) ? record.media : [];
  if (media.length > 0) {
    const mediaRow = document.createElement('div');
    mediaRow.className = 'card__media';
    const shown = Math.min(media.length, 4);
    for (let i = 0; i < shown; i++) {
      mediaRow.appendChild(buildMediaThumb(record, media[i], i));
    }
    if (media.length > shown) {
      const more = document.createElement('span');
      more.className = 'card__more-media';
      more.textContent = '+' + (media.length - shown);
      mediaRow.appendChild(more);
    }
    card.appendChild(mediaRow);
  }

  /* ---- badges ---- */
  const badges = document.createElement('div');
  badges.className = 'card__badges';

  if (record.isRetweet === true) {
    const badge = document.createElement('span');
    badge.className = 'badge badge--retweet';
    badge.textContent = record.retweetedTweetId
      ? t('badgeRetweetWith', [record.retweetedTweetId])
      : t('badgeRetweet');
    badges.appendChild(badge);
  }
  if (record.isReply === true || (record.replyTo && record.replyTo.tweetId)) {
    const badge = document.createElement('span');
    badge.className = 'badge badge--reply';
    const target = record.replyTo && typeof record.replyTo.screenName === 'string'
      ? '@' + record.replyTo.screenName
      : (record.replyTo && record.replyTo.tweetId ? record.replyTo.tweetId : '');
    badge.textContent = target ? t('badgeReplyTo', [target]) : t('badgeReply');
    badges.appendChild(badge);
  }
  if (record.quoteTweetId) {
    const badge = document.createElement('span');
    badge.className = 'badge badge--quote';
    badge.textContent = t('badgeQuote', [record.quoteTweetId]);
    badges.appendChild(badge);
  }
  if (record.isPoll === true) {
    const badge = document.createElement('span');
    badge.className = 'badge badge--poll';
    const count = record.poll && Array.isArray(record.poll.choices) ? record.poll.choices.length : 0;
    badge.textContent = count > 0 ? t('badgePollCount', [String(count)]) : t('badgePoll');
    badges.appendChild(badge);
  } else if (poll !== null && typeof poll.cardUri === 'string' && poll.cardUri.length > 0) {
    // A card was attached but it is not a poll (link preview, player, product
    // card). Recorded without claiming a type.
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = t('badgeCard');
    badge.title = poll.cardName
      ? t('badgeCardType', [poll.cardName])
      : t('badgeCardUri', [poll.cardUri]);
    badges.appendChild(badge);
  }
  if (record.isEdit === true) {
    const badge = document.createElement('span');
    badge.className = 'badge badge--edit';
    badge.textContent = record.editedFrom
      ? t('badgeEditFrom', [record.editedFrom])
      : t('badgeEditVersion');
    badges.appendChild(badge);
  }
  // Written by background.js when the user deletes the post on X. The record
  // is deliberately kept — the archive exists to answer "what did I publish?",
  // and a deletion is part of that answer.
  if (typeof record.deletedAt === 'string' && record.deletedAt.length > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge badge--deleted';
    badge.textContent = t('badgeDeleted');
    badge.title = t('badgeDeletedTitle', [formatDateTime(record.deletedAt)]);
    badges.appendChild(badge);
  }
  // Written by background.js when a later edit of this same tweet was archived.
  // The new id is shown, not just put in a tooltip: this row is one half of a
  // pair, and which pair is the whole question when deciding to keep it.
  if (typeof record.supersededBy === 'string' && record.supersededBy.length > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge badge--stale';
    badge.textContent = t('badgeSuperseded', [record.supersededBy]);
    badge.title = t('badgeSupersededTitle', [record.supersededBy]);
    badges.appendChild(badge);
  }
  if (media.length > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = t('badgeMedia', [String(media.length)]);
    badges.appendChild(badge);
  }
  if (record.source && typeof record.source.operationName === 'string' &&
      record.source.operationName.toLowerCase() !== 'createtweet') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = record.source.operationName;
    badges.appendChild(badge);
  }
  if (badges.childNodes.length > 0) card.appendChild(badges);

  /* ---- meta + actions ---- */
  const meta = document.createElement('div');
  meta.className = 'card__meta';

  const idEl = document.createElement('div');
  idEl.className = 'card__id';
  idEl.textContent = t('cardId', [record.id, formatDateTime(record.capturedAt)]);
  idEl.title = t('cardIdTitle', [record.id, formatDateTime(record.capturedAt)]) +
    (record.updatedAt ? t('cardIdTitleUpdated', [formatDateTime(record.updatedAt)]) : '');
  meta.appendChild(idEl);

  const actions = document.createElement('div');
  actions.className = 'card__actions';

  // Editing produces a new tweet id per version, so this record and its
  // predecessor are two rows. The id is what links them, and the search box
  // already matches ids — so "which one is the original?" is answered by
  // jumping to it rather than by naming it and leaving you to hunt.
  if (typeof record.editedFrom === 'string' && record.editedFrom.length > 0) {
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.className = 'link-button';
    previous.textContent = t('findPrevious');
    previous.title = t('findPreviousTitle', [record.editedFrom]);
    previous.addEventListener('click', () => searchFor(record.editedFrom));
    actions.appendChild(previous);
  }

  if (typeof record.supersededBy === 'string' && record.supersededBy.length > 0) {
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'link-button';
    next.textContent = t('findNext');
    next.title = t('findNextTitle', [record.supersededBy]);
    next.addEventListener('click', () => searchFor(record.supersededBy));
    actions.appendChild(next);
  }

  const openLink = document.createElement('a');
  openLink.className = 'link-button';
  openLink.textContent = t('openPost');
  openLink.href = safeTweetUrl(record.tweetUrl, record.id);
  openLink.target = '_blank';
  openLink.rel = 'noopener noreferrer';
  actions.appendChild(openLink);

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'link-button';
  copyButton.textContent = t('copyLink');
  copyButton.addEventListener('click', () => {
    const url = safeTweetUrl(record.tweetUrl, record.id);
    void (async () => {
      try {
        await navigator.clipboard.writeText(url);
        copyButton.textContent = t('copied');
      } catch (_) {
        copyButton.textContent = t('copyFailed');
      }
      setTimeout(() => { copyButton.textContent = t('copyLink'); }, 1500);
    })();
  });
  actions.appendChild(copyButton);

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'link-button is-danger';
  deleteButton.textContent = state.armedDeleteId === record.id ? t('confirmDelete') : t('delete');
  if (state.armedDeleteId === record.id) deleteButton.classList.add('is-armed');
  deleteButton.addEventListener('click', () => {
    if (state.armedDeleteId !== record.id) {
      armDelete(record.id);
      deleteButton.textContent = t('confirmDelete');
      return;
    }
    disarmDelete();
    void deleteOne(record.id);
  });
  actions.appendChild(deleteButton);

  meta.appendChild(actions);
  card.appendChild(meta);

  return card;
}

/** Reveal the expand control only when the text is actually clipped. */
function syncExpandVisibility(card) {
  try {
    const textEl = card.querySelector('.card__text');
    const button = card.querySelector('.card__expand');
    if (!textEl || !button) return;
    const expanded = textEl.classList.contains('is-expanded');
    const clipped = textEl.scrollHeight > textEl.clientHeight + 1;
    button.hidden = !(clipped || expanded);
  } catch (_) { /* ignore */ }
}

function appendItems(items) {
  let appended = 0;
  for (const record of items) {
    if (!record || typeof record.id !== 'string') continue;
    if (state.renderedIds.has(record.id)) continue;
    state.renderedIds.add(record.id);

    const card = renderCard(record);
    els.list.appendChild(card);
    // Reading scrollHeight forces layout, so the measurement is valid here.
    syncExpandVisibility(card);
    appended++;
  }
  if (appended > 0) clearEmptyState();
  return appended;
}

function updateListFooter() {
  els.more.hidden = state.hasMore !== true;
  els.more.disabled = state.loading === true;
  els.more.textContent = state.loading ? t('loading') : t('loadMore');

  const rendered = state.renderedIds.size;
  if (rendered === 0) {
    els.listHint.textContent = '';
    return;
  }
  // "已到底部" used to be appended whenever everything was loaded — which is
  // almost always, since a normal archive fits in the first page — so the hint
  // permanently claimed something the user could already see for themselves
  // (the 加载更多 button is absent). Only the useful half is kept.
  els.listHint.textContent = state.hasMore
    ? t('listShownMore', [String(rendered)])
    : t('listShown', [String(rendered)]);
}

/* -------------------------------------------------------------------------- */
/* Paging + search                                                            */
/* -------------------------------------------------------------------------- */

async function fetchBatch(targetCount) {
  const collected = [];
  let rounds = 0;

  while (collected.length < targetCount && rounds < 8) {
    rounds++;
    const remaining = targetCount - collected.length;
    const previousKey = state.nextKey;

    const page = await queryTweets(state.db, {
      query: state.query,
      pageSize: remaining,
      afterKey: state.nextKey,
      scanBudget: 20000
    });

    for (const record of page.items) collected.push(record);
    state.nextKey = page.nextKey;
    state.hasMore = page.hasMore;

    if (!page.hasMore) break;
    if (page.nextKey === null) break;
    // Guard against a resume key that does not advance, which would spin.
    if (page.nextKey === previousKey && page.items.length === 0) {
      state.hasMore = false;
      break;
    }
  }

  return collected;
}

async function reload() {
  if (state.db === null) return;
  state.loading = true;
  setNotice('');
  try {
    while (els.list.firstChild) els.list.removeChild(els.list.firstChild);
    revokeObjectUrls();
    state.renderedIds = new Set();
    state.nextKey = null;
    state.hasMore = false;

    const batch = await fetchBatch(state.settings.pageSize);
    appendItems(batch);
    showEmptyState();
  } catch (err) {
    setNotice(t('errReadDb', [describe(err)]), 'error');
  } finally {
    state.loading = false;
    updateListFooter();
  }
}

async function loadMore() {
  if (state.db === null || state.loading || state.hasMore !== true) return;
  state.loading = true;
  updateListFooter();
  try {
    const batch = await fetchBatch(state.settings.pageSize);
    const appended = appendItems(batch);
    if (appended === 0 && state.hasMore === false) {
      showEmptyState();
    }
  } catch (err) {
    setNotice(t('errLoadMore', [describe(err)]), 'error');
  } finally {
    state.loading = false;
    updateListFooter();
  }
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* -------------------------------------------------------------------------- */

function armDelete(id) {
  state.armedDeleteId = id;
  if (state.armTimer !== null) clearTimeout(state.armTimer);
  state.armTimer = setTimeout(() => {
    state.armedDeleteId = null;
    state.armTimer = null;
    // Reset just that button rather than re-rendering the list, which would
    // throw away the user's scroll position.
    const card = els.list.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
    if (card) {
      const button = card.querySelector('.card__actions .is-danger');
      if (button) {
        button.textContent = t('delete');
        button.classList.remove('is-armed');
      }
    }
  }, 4000);
}

function disarmDelete() {
  state.armedDeleteId = null;
  if (state.armTimer !== null) {
    clearTimeout(state.armTimer);
    state.armTimer = null;
  }
}

async function deleteOne(id) {
  const response = await send({ type: 'XTB_DELETE_TWEET', id: id });
  if (!response || response.ok !== true) {
    setNotice(t('errDelete', [(response && response.error) || t('unknownError')]), 'error');
    return;
  }
  const card = els.list.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
  if (card) card.remove();
  state.renderedIds.delete(id);
  if (state.counts.tweets !== null && state.counts.tweets > 0) state.counts.tweets--;
  renderSummary();
  showEmptyState();
  updateListFooter();
  setNotice(t('okDeletedOne'), 'ok');
}

async function clearAllRecords() {
  const response = await send({ type: 'XTB_CLEAR_ALL' });
  if (!response || response.ok !== true) {
    setNotice(t('errClear', [(response && response.error) || t('unknownError')]), 'error');
    return;
  }
  state.counts.tweets = 0;
  state.counts.media = 0;
  disarmClear();
  renderSummary();
  await renderUsage();
  await reload();
  setNotice(t('okClearedAll'), 'ok');
}

/* ------------------------------------------------------------------ search */

/**
 * Jump to a specific record by id. search matches ids as well as text, so
 * putting the id in the box is the whole implementation — and the user can see
 * what happened rather than the list silently changing under them.
 */
function searchFor(id) {
  els.search.value = id;
  state.query = id;
  try {
    els.list.scrollTop = 0;
  } catch (_) { /* ignore */ }
  void reload();
}

/* ---------------------------------------------------------------- cleanup */

function armPurge(filter) {
  state.armedPurge = filter;
  renderCleanup();
  setTimeout(() => {
    if (state.armedPurge === filter) {
      state.armedPurge = null;
      renderCleanup();
    }
  }, 5000);
}

async function runPurge(filter) {
  state.armedPurge = null;
  renderCleanup();

  const count = state.purgeCounts[filter] || 0;
  setNotice(t('busyDeleting', [String(count)]));

  const response = await send({ type: 'XTB_PURGE', filter: filter });
  if (!response || response.ok !== true) {
    setNotice(t('errPurge', [(response && response.error) || t('unknownError')]), 'error');
    await refreshState();
    return;
  }

  setNotice(t('okPurged', [String(response.removed)]), 'ok');
  await refreshState();
  await reload();
}

function onPurgeClick(filter) {
  if (state.armedPurge !== filter) {
    armPurge(filter);
    return;
  }
  void runPurge(filter);
}

function armClear() {
  state.armedClear = true;
  els.clear.classList.add('is-armed');
  els.clear.textContent = t('confirmClearAll');
  setTimeout(() => {
    if (state.armedClear) disarmClear();
  }, 5000);
}

function disarmClear() {
  state.armedClear = false;
  els.clear.classList.remove('is-armed');
  els.clear.textContent = t('clearAll');
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build the tweets JSON as a string. Shared by both exports so the standalone
 * file and the copy inside the archive can never drift apart.
 *
 * Records are already credential-free by construction (background.js rebuilds
 * every one from a known-field whitelist) and media blobs live in a separate
 * store, so this stays a metadata document.
 */
/**
 * Every timestamp in this file is UTC. Rather than repeat a converted local
 * time next to each one (which would be wrong the moment you change timezone),
 * the file states once which zone it was written from, and any reader can
 * convert: local = UTC + offsetMinutes.
 */
function timezoneBlock() {
  let name = null;
  let offsetMinutes = null;
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch (_) { /* not available: the offset alone is still enough */ }
  try {
    offsetMinutes = -new Date().getTimezoneOffset();
  } catch (_) { /* ignore */ }
  return {
    name: name,
    offsetMinutes: offsetMinutes,
    note: t('tzNote')
  };
}

async function buildTweetsJson() {
  const chunks = [];
  chunks.push('{\n  "schemaVersion": ' + JSON.stringify(SCHEMA_VERSION) + ',\n');
  chunks.push('  "generator": "x-tweet-backup",\n');
  chunks.push('  "exportedAt": ' + JSON.stringify(new Date().toISOString()) + ',\n');
  chunks.push('  "timezone": ' + JSON.stringify(timezoneBlock()) + ',\n');
  chunks.push('  "tweets": [');

  let count = 0;
  await forEachTweet(state.db, (record) => {
    chunks.push((count === 0 ? '\n    ' : ',\n    ') + JSON.stringify(record));
    count++;
  });

  chunks.push(count === 0 ? ']' : '\n  ]');
  chunks.push(',\n  "count": ' + count + ',\n');

  // Deletion events live beside the tweets, not inside them. A deletion has to
  // travel even when this machine never archived the tweet — that is what
  // carries it across a merge — and a record with no text, author or media
  // does not belong in the tweet list.
  let deletions = [];
  try {
    deletions = await listDeletions(state.db);
  } catch (_) { /* an unreadable store must not sink the whole export */ }
  chunks.push('  "deletions": ' + JSON.stringify(deletions) + '\n}\n');

  return { text: chunks.join(''), count: count, deletions: deletions.length };
}

async function exportAll() {
  if (state.exporting || state.db === null) return;
  state.exporting = true;
  els.export.disabled = true;
  els.export.textContent = t('busyExportingShort');
  setNotice(t('busyExporting'));

  try {
    const built = await buildTweetsJson();
    const blob = new Blob([built.text], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, 'x-tweet-backup-' + todayStamp() + '.json');
    let message = t('okExported', [String(built.count), todayStamp()]);
    if (built.deletions > 0) message += t('okExportedDeletions', [String(built.deletions)]);
    setNotice(message, 'ok');
  } catch (err) {
    setNotice(t('errExport', [describe(err)]), 'error');
  } finally {
    state.exporting = false;
    els.export.disabled = false;
    els.export.textContent = t('exportJson');
  }
}

function safeNamePart(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[^A-Za-z0-9_-]/g, '');
}

function extensionFor(contentType, mediaType) {
  const ct = typeof contentType === 'string' ? contentType.toLowerCase() : '';
  if (ct.indexOf('jpeg') !== -1 || ct.indexOf('jpg') !== -1) return '.jpg';
  if (ct.indexOf('png') !== -1) return '.png';
  if (ct.indexOf('webp') !== -1) return '.webp';
  if (ct.indexOf('gif') !== -1) return '.gif';
  if (ct.indexOf('mp4') !== -1) return '.mp4';
  if (ct.indexOf('webm') !== -1) return '.webm';
  if (mediaType === 'photo') return '.jpg';
  if (mediaType === 'video' || mediaType === 'animated_gif') return '.mp4';
  return '.bin';
}

function parseDateOrNow(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms) : new Date();
}

/**
 * Export ONE self-contained archive: tweets.json + every cached media file +
 * a machine-readable index, all inside a single ZIP.
 *
 * This is the portable "everything" copy. The plain JSON export stays separate
 * because it is small, greppable and safe to take often — and because folding
 * binaries into it would mean base64, which inflates them ~33% and forces a
 * full load just to read one line of text.
 */
async function exportArchive() {
  if (state.exportingMedia || state.db === null) return;
  state.exportingMedia = true;
  els.media.disabled = true;
  els.media.textContent = t('busyPackingShort');
  setNotice(t('busyReading'));

  try {
    const built = await buildTweetsJson();

    const records = await listAllMedia(state.db);
    const rows = [];
    let skipped = 0;

    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      if (!(record.blob instanceof Blob)) { skipped++; continue; }

      const tweetId = safeNamePart(record.tweetId);
      const mediaId = safeNamePart(record.mediaId);
      if (tweetId.length === 0 || mediaId.length === 0) { skipped++; continue; }

      rows.push({
        fileName: 'media/' + tweetId + '_' + mediaId + extensionFor(record.contentType, record.type),
        tweetId: tweetId,
        mediaId: mediaId,
        type: typeof record.type === 'string' ? record.type : null,
        contentType: typeof record.contentType === 'string' ? record.contentType : null,
        bytes: record.blob.size,
        blob: record.blob,
        date: parseDateOrNow(record.cachedAt)
      });
    }

    const generatedAt = new Date().toISOString();
    setNotice(t('busyPacking', [String(built.count), String(rows.length)]));

    const zip = await buildZip(
      rows.map((row) => ({ name: row.fileName, blob: row.blob, date: row.date })),
      {
        extraFiles: [
          { name: 'tweets.json', text: built.text, date: new Date() },
          { name: 'MEDIA-INDEX.txt', text: describeMediaArchive(rows, { generatedAt: generatedAt, skipped: skipped }), date: new Date() },
          { name: 'MEDIA-INDEX.json', text: buildMediaIndexJson(rows, { generatedAt: generatedAt, skipped: skipped, schemaVersion: SCHEMA_VERSION }), date: new Date() }
        ]
      }
    );

    downloadBlob(zip, 'x-tweet-backup-archive-' + todayStamp() + '.zip');

    let message = t('okArchiveExported', [
      String(built.count), String(rows.length), formatBytes(zip.size)
    ]);
    if (skipped > 0) message += t('okArchiveSkipped', [String(skipped)]);
    setNotice(message, skipped > 0 ? '' : 'ok');
  } catch (err) {
    setNotice(t('errExportArchive', [describe(err)]), 'error');
  } finally {
    state.exportingMedia = false;
    els.media.disabled = false;
    els.media.textContent = t('exportArchive');
  }
}

/* -------------------------------------------------------------------------- */
/* Settings wiring                                                            */
/* -------------------------------------------------------------------------- */

async function applySettings(patch) {
  const response = await send({ type: 'XTB_SET_SETTINGS', patch: patch });
  if (!response || response.ok !== true) {
    setNotice(t('errSettings', [(response && response.error) || t('unknownError')]), 'error');
    return false;
  }
  state.settings = Object.assign({}, DEFAULT_SETTINGS, response.settings || {});
  els.diagnostics.hidden = state.settings.debug !== true;
  if (state.settings.debug === true) renderDiagnostics();
  return true;
}

async function onMediaToggle() {
  if (els.optMedia.checked !== true) {
    await applySettings({ mediaCache: false });
    setNotice(t('okMediaOff'), 'ok');
    return;
  }

  // chrome.permissions.request must run from this user gesture in an extension
  // page — never from the service worker.
  let granted = false;
  try {
    granted = await requestMediaPermission();
  } catch (err) {
    granted = false;
  }

  if (granted !== true) {
    els.optMedia.checked = false;
    await applySettings({ mediaCache: false });
    setNotice(t('errMediaPermission'), 'error');
    return;
  }

  state.mediaPermission = true;
  await applySettings({ mediaCache: true });
  setNotice(t('okMediaOn'), 'ok');
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  els.refresh.addEventListener('click', () => {
    els.refresh.classList.add('is-busy');
    setTimeout(() => els.refresh.classList.remove('is-busy'), 220);
    void (async () => {
      await refreshState();
      await reload();
    })();
  });

  els.search.addEventListener('input', () => {
    if (state.searchTimer !== null) clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.searchTimer = null;
      state.query = els.search.value.trim();
      void reload();
    }, 250);
  });

  els.search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      els.search.value = '';
      state.query = '';
      void reload();
    }
  });

  els.export.addEventListener('click', () => {
    void exportAll();
  });

  els.media.addEventListener('click', () => {
    void exportArchive();
  });

  els.more.addEventListener('click', () => {
    void loadMore();
  });

  els.optDebug.addEventListener('change', () => {
    void (async () => {
      const ok = await applySettings({ debug: els.optDebug.checked });
      if (ok) setNotice(els.optDebug.checked ? t('okDebugOn') : t('okDebugOff'));
    })();
  });

  els.optThumbs.addEventListener('change', () => {
    void (async () => {
      const ok = await applySettings({ showRemoteThumbnails: els.optThumbs.checked });
      if (ok) await reload();
    })();
  });

  els.optMedia.addEventListener('change', () => {
    void onMediaToggle();
  });

  els.purgeSuperseded.addEventListener('click', () => onPurgeClick('superseded'));
  els.purgeDeleted.addEventListener('click', () => onPurgeClick('deleted'));

  els.clear.addEventListener('click', () => {
    if (!state.armedClear) {
      armClear();
      return;
    }
    void clearAllRecords();
  });

  // Reopen this same page as a full tab. No "tabs" permission is needed to
  // create a tab; that permission only gates reading tab properties.
  els.tab.addEventListener('click', () => {
    try {
      if (!chrome.tabs || typeof chrome.tabs.create !== 'function') {
        setNotice(t('errNoTabs'), 'error');
        return;
      }
      void chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
      window.close();
    } catch (err) {
      setNotice(t('errOpenTab', [describe(err)]), 'error');
    }
  });

  // Line count depends on width, so re-evaluate when the window changes size
  // (relevant when the same page is open as a full tab).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      for (const card of els.list.querySelectorAll('.card')) syncExpandVisibility(card);
    }, 150);
  });

  els.resetStats.addEventListener('click', () => {
    void (async () => {
      const response = await send({ type: 'XTB_RESET_STATS' });
      if (response && response.ok === true) {
        await refreshState();
        setNotice(t('okCountersReset'), 'ok');
      }
    })();
  });
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function init() {
  // Before anything else: the popup must never be briefly shown in the wrong
  // language, and every label below depends on it.
  applyStaticText();
  bindEvents();

  // Already a full-width tab rather than the toolbar popup: the button would
  // just open a duplicate.
  if (window.innerWidth >= 700) els.tab.hidden = true;

  try {
    state.db = await openDB();
  } catch (err) {
    setNotice(t('errOpenDb', [describe(err)]), 'error');
    state.db = null;
    return;
  }

  await refreshState();

  // If the user revoked the media host permission from chrome://extensions,
  // reflect that instead of pretending the cache is still active.
  if (state.settings.mediaCache === true && state.mediaPermission !== true) {
    const sync = await send({ type: 'XTB_SYNC_MEDIA_PERMISSION' });
    if (sync && sync.ok === true && sync.mediaPermission !== true) {
      state.settings.mediaCache = false;
      els.optMedia.checked = false;
      setNotice(t('errMediaRevoked'), 'error');
    }
  }

  await reload();
}

void init();
