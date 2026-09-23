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
  sameKey,
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
  savingChoices: false,
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
  optBackfillMedia: document.getElementById('opt-backfill-media'),
  fillMedia: document.getElementById('btn-fill-media'),
  optCaptureReplies: document.getElementById('opt-capture-replies'),
  cleanup: document.getElementById('cleanup'),
  purgeSuperseded: document.getElementById('btn-purge-superseded'),
  purgeDeleted: document.getElementById('btn-purge-deleted'),
  purgeSupersededCount: document.getElementById('cleanup-superseded-count'),
  purgeDeletedCount: document.getElementById('cleanup-deleted-count'),
  tab: document.getElementById('btn-tab'),
  media: document.getElementById('btn-media'),
  clear: document.getElementById('btn-clear'),
  choice: document.getElementById('choice'),
  choiceMedia: document.getElementById('choice-media'),
  choiceBackfill: document.getElementById('choice-backfill'),
  choiceReplies: document.getElementById('choice-replies'),
  choiceThumbs: document.getElementById('choice-thumbs'),
  choiceConfirm: document.getElementById('btn-choice-confirm'),
  choiceShow: document.getElementById('btn-choice-show')
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

/**
 * A link the user typed can point anywhere, so only the scheme is constrained —
 * the same rule background.js applies before storing it.
 */
function safeExternalUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.href;
  } catch (_) {
    return null;
  }
}

/**
 * The hosts background.js accepts before it will even store a tweetUrl.
 * Duplicated rather than imported: background.js is a service worker module and
 * importing it here would start a second copy of it.
 */
const ALLOWED_TWEET_HOSTS = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.x.com'];

/**
 * Only an https URL on an x.com/twitter.com host may reach this href — the same
 * check background.js applies before storing one.
 *
 * Checking the scheme alone was weaker than the writer's rule, and the result of
 * this function goes straight into an <a href>: anything the archive was
 * tampered into holding (or a future writer bug) would have been clickable.
 */
function safeTweetUrl(url, fallbackId) {
  const fallback = 'https://x.com/i/web/status/' + String(fallbackId);
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') return fallback;
    if (ALLOWED_TWEET_HOSTS.indexOf(parsed.hostname.toLowerCase()) === -1) return fallback;
    return parsed.href;
  } catch (_) {
    return fallback;
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

/**
 * Hand a file to the browser's download machinery.
 *
 * This is the FALLBACK, used only where `showSaveFilePicker` does not exist. It
 * cannot report anything: `click()` on an anchor returns nothing, and the
 * download it starts can be blocked by policy, by a setting or by the popup
 * closing before the bytes are written, with no error surfacing here at all.
 * The caller must therefore NOT claim the file exists after calling this — see
 * the notice each export prints on this path.
 */
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

/** Whether this browser can hand back a real file handle. */
function hasSaveFilePicker() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

/**
 * Whether this page is the toolbar popup rather than a page of its own.
 *
 * A Chromium popup is capped at 800x600, so a viewport taller than that is not
 * one — that holds on a phone exactly as it does on a desktop. The old test here
 * asked only for `innerWidth >= 700` to mean "already a tab", and a phone's tab
 * is around 400px wide, so the "open in a tab" button stayed on screen and could
 * not do anything useful: it opened a second copy of a page that was already a
 * tab, and `window.close()` — refused for a window this script did not open —
 * left the first copy sitting there.
 *
 * The numbers match the media queries in popup.css, and they have to: the layout
 * and this button are answering the same question, and a window where they
 * disagree is a window showing the page layout with a button offering to open
 * the page it is already on.
 */
function isToolbarPopup() {
  return window.innerWidth < 700 && window.innerHeight < 610;
}

/**
 * Ask the user where the export should go.
 *
 * MUST run before anything is built. Chrome only honours the picker while the
 * click's user activation is still live, and building a large JSON document
 * spends it — a picker opened after the build would be refused outright.
 * Asking first also means a cancelled export costs nothing.
 *
 * Resolves with one of:
 *   { handle }             a destination was chosen; nothing is written yet
 *   { cancelled: true }    the user dismissed the picker
 *   { unavailable: true }  no picker in this browser — the caller falls back
 *   { error: '…' }         the picker failed for any other reason
 */
async function chooseSaveFile(suggestedName) {
  if (!hasSaveFilePicker()) return { unavailable: true };
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: suggestedName });
    return { handle: handle };
  } catch (err) {
    // AbortError is the user pressing Cancel. It is neither success nor
    // failure, and printing either one would be a lie about what is on disk.
    if (err && err.name === 'AbortError') return { cancelled: true };
    // Anything else (including NotAllowedError, which means the gesture was
    // already spent) left no file behind, so it must not read as success.
    return { error: describe(err) };
  }
}

/**
 * Write the blob through a real handle and wait for the close.
 *
 * `close()` is what commits the file, and it is awaited: when this resolves the
 * bytes are on disk, which is the only condition under which the caller may say
 * the export succeeded.
 *
 * A failed write aborts the stream rather than closing it — closing after a
 * partial write would commit exactly the truncated file this is meant to
 * prevent.
 */
async function writeBlobToHandle(handle, blob) {
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } catch (err) {
    try {
      await writable.abort();
    } catch (_) { /* ignore */ }
    throw err;
  }
  await writable.close();
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
  els.optBackfillMedia.checked = state.settings.backfillMedia === true;
  els.optCaptureReplies.checked = state.settings.captureReplies === true;
  // Meaningless without the master switch, so it says so rather than looking
  // like a setting that does nothing.
  els.optBackfillMedia.disabled = state.settings.mediaCache !== true;
  // Same reasoning: with media caching off there is nothing to fill.
  els.fillMedia.disabled = state.settings.mediaCache !== true;
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
    // A record the page parsed but could not hand over. Without this row the
    // only sign of it was that the count of kept posts quietly disagreed with
    // the count of saved ones.
    [t('diagPostFailed'), String(page.postFailed || 0), page.postFailed ? 'is-bad' : ''],
    [t('diagDeleteSeen'), String(page.deleteSeen || 0), ''],
    [t('diagDeleteMarked'), String(page.deleted || 0), ''],
    [t('diagTimelineSeen'), String(page.timelineSeen || 0), ''],
    [t('diagTimelineKept'), String(page.timelineKept || 0), ''],
    // The same idea one post at a time: a swept record's timeline response
    // often carries no link targets, and opening the post itself is what fills
    // them back in.
    [t('diagDetailSeen'), String(page.detailSeen || 0), ''],
    [t('diagDetailKept'), String(page.detailKept || 0), ''],
    [t('diagReceived'), String(lifetime.received || 0), ''],
    [t('diagMarkedDeleted'), String(lifetime.deletedMarked || 0), ''],
    [t('diagUnmatchedDelete'), String(lifetime.deletedUnmatched || 0), ''],
    [t('diagBackfilled'), String(lifetime.backfilled || 0), lifetime.backfilled ? 'is-good' : ''],
    [t('diagBackfillSkipped'), String(lifetime.backfillSkipped || 0), ''],
    [t('diagLinksFilled'), String(lifetime.linksFilled || 0), lifetime.linksFilled ? 'is-good' : ''],
    [t('diagLinksUnmatched'), String(lifetime.linksUnmatched || 0), ''],
    [t('diagUpsertOk'), String(lifetime.upsertOk || 0), lifetime.upsertOk ? 'is-good' : ''],
    [t('diagUpsertFailed'), String(lifetime.upsertFailed || 0), lifetime.upsertFailed ? 'is-bad' : ''],
    [t('diagRejected'), String(lifetime.rejected || 0), lifetime.rejected ? 'is-bad' : ''],
    [t('diagMediaCached'), String(lifetime.mediaCached || 0), ''],
    [t('diagMediaFailed'), String(lifetime.mediaFailed || 0), lifetime.mediaFailed ? 'is-bad' : ''],
    // Not the same failure as mediaFailed: nothing was requested at all. A post
    // whose download was dropped looks exactly like a post that had no media,
    // so without this row there is nothing to tell the two apart.
    [t('diagMediaDropped'), String(lifetime.mediaDropped || 0), lifetime.mediaDropped ? 'is-bad' : ''],
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

  // Clicking the author filters the list down to that account.
  //
  // Once more than one account is archived the rows are interleaved and nothing
  // in the list separates them — the search box is the only thing that can, and
  // retyping a handle to use it is exactly the friction that stops people
  // bothering. The name is already on screen and already identifies the
  // account, so it becomes the control.
  if (screenName !== null) {
    authorEl.classList.add('card__author--filterable');
    authorEl.title = t('filterByAuthor', [screenName]);
    authorEl.addEventListener('click', (ev) => {
      // The card itself may have its own click behaviour; filtering is a
      // different intent and must not also trigger it.
      ev.stopPropagation();
      els.search.value = screenName;
      // Re-dispatch rather than calling the search routine by name: the input
      // already has a handler, and going through it keeps debounce, paging and
      // the empty-state text on exactly one code path.
      els.search.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
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
  // An empty body is rendered as a note, and the wording has to come from here
  // rather than from CSS: a CSS string cannot be localised, so the two literal
  // Chinese strings that used to sit in .card__text::after were shown to every
  // user, English included. data-empty-text is what the rule renders.
  if (text.length === 0) {
    // A retweet legitimately has no text of its own; saying "probably a
    // media-only post" there would be wrong.
    if (record.isRetweet === true) {
      textEl.classList.add('card__text--retweet');
      textEl.dataset.emptyText = t('emptyRetweet');
    } else {
      textEl.dataset.emptyText = t('emptyMediaOnly');
    }
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

  /* ---- where the links actually point ---- */
  //
  // The text above keeps the t.co shortlink exactly as it was published, so on
  // its own it never says where a link goes — and following a t.co link would
  // tell X that this archive was opened. The real destination is stored
  // separately, and this is the only place it is safe to click.
  const linkEntities = record.entities && Array.isArray(record.entities.urls)
    ? record.entities.urls
    : [];

  // Built as pairs rather than by filtering twice: an entity whose expansion
  // was rejected would otherwise shift every later entry's label onto the
  // wrong link.
  const resolvableLinks = [];
  for (const item of linkEntities) {
    if (!item) continue;
    const href = safeExternalUrl(item.expandedUrl);
    if (href === null) continue;
    resolvableLinks.push({ href: href, display: item.displayUrl });
  }

  if (resolvableLinks.length > 0) {
    const linksEl = document.createElement('div');
    linksEl.className = 'card__links';

    const label = document.createElement('span');
    label.className = 'card__links-label';
    label.textContent = t('linksLabel');
    linksEl.appendChild(label);

    const shown = Math.min(resolvableLinks.length, 5);
    for (let i = 0; i < shown; i++) {
      const link = resolvableLinks[i];
      const anchor = document.createElement('a');
      anchor.className = 'card__link';
      anchor.href = link.href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.title = t('linkTargetTitle', [link.href]);
      // The full destination, not X's display form.
      //
      // The display form is truncated with an ellipsis — `github.com/cjydfb/x-tweet…`
      // — which hides exactly the part this line exists to preserve. The whole
      // reason the resolved address is stored separately is that the t.co
      // shortlink in the body stops working once the post ages; printing a
      // shortened version of the real address puts the unreadable part back.
      // `.card__link` already wraps anywhere, so a long URL makes the card
      // taller rather than widening it.
      anchor.textContent = link.href;
      linksEl.appendChild(anchor);
    }
    if (resolvableLinks.length > shown) {
      const more = document.createElement('span');
      more.className = 'card__links-more';
      more.textContent = '+' + (resolvableLinks.length - shown);
      linksEl.appendChild(more);
    }

    card.appendChild(linksEl);
  }

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
  // Recovered by a profile-timeline sweep rather than witnessed when it was
  // published. Worth saying out loud: its backup timestamp is the sweep time,
  // not the publish time, and it may be missing fields only the publish path
  // can see (poll choices, the edit chain, the full media entities).
  if (record.source && record.source.backfilled === true) {
    const badge = document.createElement('span');
    badge.className = 'badge badge--backfilled';
    badge.textContent = t('badgeBackfilled');
    badge.title = t('badgeBackfilledTitle');
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
    // sameKey comes from db.js — the same rule queryTweets itself applies, so
    // the two cannot drift apart.
    if (page.items.length === 0 && sameKey(page.nextKey, previousKey)) {
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
 * The version of the extension doing the exporting.
 *
 * Stamped into every export so a file can say which build produced it. Two
 * archives taken a year apart should not be indistinguishable: if the record
 * schema ever changes, the older file has to be able to explain itself, and
 * `schemaVersion` alone cannot say whether a bug was fixed on the way.
 *
 * Falls back to a literal rather than throwing — not knowing the version must
 * never be the reason an export fails.
 */
function extensionVersion() {
  try {
    const manifest = chrome.runtime.getManifest();
    const version = manifest ? manifest.version : null;
    return typeof version === 'string' && version.length > 0 ? version : 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

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
  chunks.push('  "generatorVersion": ' + JSON.stringify(extensionVersion()) + ',\n');
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
  //
  // A failed read here STOPS the export. Writing an empty array instead — which
  // this used to do — produced a file that looks complete and is missing every
  // tombstone this machine ever recorded, and a merge against it would apply
  // the deletions it does know about and silently resurrect everything else.
  // A missing backup is recoverable; a plausible-looking wrong one is not.
  let deletions;
  try {
    deletions = await listDeletions(state.db);
  } catch (err) {
    throw new Error(t('errDeletionsUnreadable', [describe(err)]));
  }
  chunks.push('  "deletions": ' + JSON.stringify(deletions) + '\n}\n');

  return { text: chunks.join(''), count: count, deletions: deletions.length };
}

async function exportAll() {
  if (state.exporting || state.db === null) return;
  state.exporting = true;
  els.export.disabled = true;
  els.export.textContent = t('busyExportingShort');

  try {
    const filename = 'x-tweet-backup-' + todayStamp() + '.json';
    // The destination is chosen before the document is built: the picker needs
    // the click's user activation and building spends it. See chooseSaveFile.
    const target = await chooseSaveFile(filename);
    if (target.cancelled) {
      setNotice(t('exportCancelled'), '');
      return;
    }
    if (target.error) {
      setNotice(t('errExport', [target.error]), 'error');
      return;
    }

    setNotice(t('busyExporting'));
    const built = await buildTweetsJson();
    const blob = new Blob([built.text], { type: 'application/json;charset=utf-8' });

    let message;
    if (target.handle) {
      const name = typeof target.handle.name === 'string' && target.handle.name.length > 0
        ? target.handle.name
        : filename;
      // Awaited, and only this path may claim the file exists: the write and
      // its close have both returned, so the bytes are on disk.
      await writeBlobToHandle(target.handle, blob);
      message = t('okExported', [String(built.count), name]);
    } else {
      // No picker in this browser, so nothing can be confirmed — not by the
      // click, not afterwards. The notice says a download was STARTED and the
      // user should check that the file arrived.
      downloadBlob(blob, filename);
      message = t('okExportStarted', [String(built.count), filename]);
    }
    if (built.deletions > 0) message += t('okExportedDeletions', [String(built.deletions)]);
    setNotice(message, target.handle ? 'ok' : '');
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
    const filename = 'x-tweet-backup-archive-' + todayStamp() + '.zip';
    // Destination first, for the same reason as exportAll: the picker needs the
    // click's user activation, and packing the ZIP would spend it.
    const target = await chooseSaveFile(filename);
    if (target.cancelled) {
      setNotice(t('exportCancelled'), '');
      return;
    }
    if (target.error) {
      setNotice(t('errExportArchive', [target.error]), 'error');
      return;
    }

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
          { name: 'MEDIA-INDEX.json', text: buildMediaIndexJson(rows, { generatedAt: generatedAt, skipped: skipped, schemaVersion: SCHEMA_VERSION, version: extensionVersion() }), date: new Date() }
        ]
      }
    );

    let message;
    if (target.handle) {
      // Awaited, and only this path may claim the file exists: the write and
      // its close have both returned, so the bytes are on disk.
      await writeBlobToHandle(target.handle, zip);
      message = t('okArchiveExported', [
        String(built.count), String(rows.length), formatBytes(zip.size)
      ]);
    } else {
      // No picker in this browser, so the download cannot be confirmed. The
      // notice says one was STARTED and the user should check that the archive
      // arrived; the byte count is what it will have if it did.
      downloadBlob(zip, filename);
      message = t('okArchiveStarted', [
        String(built.count), String(rows.length), formatBytes(zip.size)
      ]);
    }
    if (skipped > 0) message += t('okArchiveSkipped', [String(skipped)]);
    setNotice(message, target.handle && skipped === 0 ? 'ok' : '');
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

/**
 * Switch local media caching on, host permission included.
 *
 * MUST be entered from a user gesture: chrome.permissions.request is only
 * honoured while the click's activation is still live, so this has to run before
 * any other await inside its handler, and it can never move into the service
 * worker. A refusal and a thrown error are deliberately the same answer — there
 * is no permission either way.
 *
 * Returns whether caching actually ended up ON. That return value is the point:
 * the setting is a claim about the archive, so a refused grant has to leave it
 * false and say why, rather than storing a wish. Every caller shows the answer
 * this returns instead of the checkbox the user just clicked.
 */
async function enableMediaCache() {
  let granted = false;
  try {
    granted = await requestMediaPermission();
  } catch (err) {
    granted = false;
  }

  if (granted !== true) {
    await applySettings({ mediaCache: false });
    setNotice(t('errMediaPermission'), 'error');
    return false;
  }

  state.mediaPermission = true;
  await applySettings({ mediaCache: true });
  setNotice(t('okMediaOn'), 'ok');
  return true;
}

async function onMediaToggle() {
  if (els.optMedia.checked !== true) {
    await applySettings({ mediaCache: false });
    setNotice(t('okMediaOff'), 'ok');
    return;
  }
  // The checkbox shows intent; enableMediaCache reports what happened, so a
  // refused grant puts the switch back to off instead of leaving it claiming
  // caching that does not exist.
  if ((await enableMediaCache()) !== true) els.optMedia.checked = false;
}

/* -------------------------------------------------------------------------- */
/* First-run choices                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The four questions the panel asks, each bound to the settings key it writes.
 *
 * A table rather than four copies of the same three lines: a box added to the
 * markup but forgotten here — or wired to a key that settings.js does not know —
 * would be a behaviour the user can see and cannot set, and it would look like a
 * checkbox that simply does nothing.
 */
const CHOICE_QUESTIONS = [
  { box: els.choiceMedia, key: 'mediaCache' },
  { box: els.choiceBackfill, key: 'backfillMedia' },
  { box: els.choiceReplies, key: 'captureReplies' },
  { box: els.choiceThumbs, key: 'showRemoteThumbnails' }
];

/**
 * Show the panel, with every box on the value that is actually in force.
 *
 * Reading the boxes from the settings rather than from the defaults is what
 * makes re-opening it a review instead of a reset. On the first run the two are
 * the same thing; afterwards they are not, and a panel that silently reset four
 * behaviours to their defaults would be worse than no panel.
 */
function openChoicePanel() {
  for (const question of CHOICE_QUESTIONS) {
    question.box.checked = state.settings[question.key] === true;
  }
  els.choice.hidden = false;
  // Confirm takes focus so the panel can be answered from the keyboard without
  // tabbing through the page behind it first.
  try {
    els.choiceConfirm.focus();
  } catch (_) { /* ignore */ }
}

function closeChoicePanel() {
  els.choice.hidden = true;
}

/**
 * Write every answer at once, and only then mark the panel answered.
 *
 * One patch, not five. A flag stored while a choice was not — the popup closed
 * mid-sequence, a write that failed between two of them — would hide the
 * question forever and leave that setting at whatever it happened to be, which
 * is the one failure this panel exists to prevent.
 *
 * The permission request goes FIRST, before anything else is awaited: the
 * click's activation is what makes it legal, and every await spends part of the
 * window it has to run in. A refused or unavailable grant leaves media caching
 * off and leaves the refusal on screen, through the same function the settings
 * toggle uses, so the two can never report different outcomes.
 */
async function confirmChoices() {
  if (state.savingChoices === true) return;
  state.savingChoices = true;
  els.choiceConfirm.disabled = true;

  try {
    const wanted = {};
    for (const question of CHOICE_QUESTIONS) {
      wanted[question.key] = question.box.checked === true;
    }

    let mediaOn = state.settings.mediaCache === true && wanted.mediaCache === true;
    if (wanted.mediaCache === true && state.settings.mediaCache !== true) {
      mediaOn = await enableMediaCache();
      // The box shows intent; a refused grant must not leave it showing caching
      // that is not there.
      els.choiceMedia.checked = mediaOn === true;
    }

    const saved = await applySettings({
      mediaCache: mediaOn,
      backfillMedia: wanted.backfillMedia,
      captureReplies: wanted.captureReplies,
      showRemoteThumbnails: wanted.showRemoteThumbnails,
      choicePanelAnswered: true
    });
    // applySettings has already said what went wrong; the panel stays open so
    // the answers are not closed away along with the message.
    if (saved !== true) return;

    // A refused permission is the one answer that must be read rather than
    // assumed, and enableMediaCache has just said so — a cheerful "saved" over
    // the top of it would bury the only line that explains why the box is off.
    if (mediaOn === true || wanted.mediaCache !== true) {
      setNotice(t('okChoiceSaved'), 'ok');
    }
    // After the notice: if reading the state back fails, that failure is the
    // more urgent thing and must be the line left standing.
    await refreshState();
    closeChoicePanel();
  } finally {
    state.savingChoices = false;
    els.choiceConfirm.disabled = false;
  }
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
    // The master switch decides whether the sweep switch can do anything, so
    // its enabled state is re-derived from the checkbox itself rather than from
    // whatever the settings round-trip happened to leave behind. `.finally`
    // covers the paths that bail out early, including a revoked permission.
    void onMediaToggle().finally(() => {
      els.optBackfillMedia.disabled = els.optMedia.checked !== true;
    });
  });

  els.optBackfillMedia.addEventListener('change', () => {
    void (async () => {
      const ok = await applySettings({ backfillMedia: els.optBackfillMedia.checked });
      if (ok) {
        // Two literal lookups rather than one computed key: the i18n checker
        // matches on literal t('...') calls, and a computed key would read as an
        // unused string rather than as a real reference.
        setNotice(
          els.optBackfillMedia.checked ? t('okBackfillMediaOn') : t('okBackfillMediaOff'),
          'ok'
        );
      }
    })();
  });

  els.fillMedia.addEventListener('click', () => {
    void (async () => {
      els.fillMedia.disabled = true;
      setNotice(t('busyFillMedia'));
      try {
        const response = await send({ type: 'XTB_FILL_MEDIA' });
        if (!response || response.ok !== true) {
          // The two refusals are actionable, so they get their own wording
          // rather than a generic failure.
          const reason = (response && response.error) || '';
          if (reason === 'media caching is off') setNotice(t('errFillMediaOff'), 'error');
          else if (reason === 'media host permission not granted') setNotice(t('errFillMediaNoPerm'), 'error');
          else setNotice(t('errFillMedia', [reason || t('unknownError')]), 'error');
          return;
        }
        let message = t('okFillMedia', [String(response.queued), String(response.withMedia)]);
        if (response.overflow > 0) message += t('okFillMediaOverflow', [String(response.overflow)]);
        setNotice(message, 'ok');
        // Downloads run in the background; refresh later so the counts catch up.
        setTimeout(() => { void refreshState(); }, 2500);
      } finally {
        els.fillMedia.disabled = state.settings.mediaCache !== true;
      }
    })();
  });

  els.optCaptureReplies.addEventListener('change', () => {
    void (async () => {
      const on = els.optCaptureReplies.checked;
      const ok = await applySettings({ captureReplies: on });
      if (ok) setNotice(on ? t('okCaptureRepliesOn') : t('okCaptureRepliesOff'), 'ok');
    })();
  });

  // Only ever shows what is stored, so this is the way back to the panel for
  // anyone who answered it before understanding one of the costs.
  els.choiceShow.addEventListener('click', () => openChoicePanel());

  els.choiceConfirm.addEventListener('click', () => {
    void confirmChoices();
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

  // Already a page rather than the toolbar popup: the button would open a
  // duplicate of the page it is already on, and could not close this one.
  if (!isToolbarPopup()) els.tab.hidden = true;

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

  // The first-run panel, asked once. Opened from the same state read the
  // settings toggles use, so its boxes start on the values that are really in
  // force, and opened before the list is built so the popup is never seen in the
  // un-asked state first.
  //
  // It is an overlay, not a gate. Posts, edits and deletions have been captured
  // since the moment the extension was installed — nothing below this line, and
  // nothing in settings.js, waits on the answer. The list loads on exactly the
  // same schedule whether the panel is up or has been answered for months.
  if (state.settings.choicePanelAnswered !== true) openChoicePanel();

  await reload();
}

void init();
