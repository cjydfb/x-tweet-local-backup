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
  queryConnections,
  listConnections,
  listProfiles,
  sameKey,
  SCHEMA_VERSION
} from './db.js';

import { DEFAULT_SETTINGS } from './settings.js';

import { requestMediaPermission, isAllowedMediaUrl, avatarKey } from './media-cache.js';

import { buildZip, describeMediaArchive, buildMediaIndexJson, buildConnectionsCsv } from './zip.js';

import { isHandle, hasWaybackPermission, requestWaybackPermission } from './wayback.js';

import {
  buildHostedLayout, utf8Bytes, safeNamePart, mediaExtension, HOSTED_TWEETS_SOFT_MAX
} from './hosted.js';

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
  counts: { tweets: null, media: null, following: null, followers: null },
  purgeCounts: { superseded: 0, deleted: 0 },
  mediaPermission: false,
  /** The ids this browser has learned to treat as this account. Empty means the
   *  roster line cannot be working yet, and the note under its switch says so.
   *  The ids themselves, not a count: a wrong one has to be removable, and it
   *  cannot be removed if it cannot be seen. */
  ownAuthors: [],
  armedPurge: null,
  savingChoices: false,
  /** Which list is on screen: 'tweets', 'following' or 'followers'. */
  view: 'tweets',
  /**
   * Paging state, one set per view, INCLUDING the search term.
   *
   * A single shared term would be actively hostile: type a handle under Posts,
   * switch to the roster, and it renders empty with nothing on screen to say
   * why. A resume key is a fresh array each time it comes back from IndexedDB,
   * so callers compare it by value through sameKey.
   */
  paging: {
    tweets: { query: '', nextKey: null, hasMore: false, rendered: new Set() },
    following: { query: '', nextKey: null, hasMore: false, rendered: new Set() },
    followers: { query: '', nextKey: null, hasMore: false, rendered: new Set() }
  },
  loading: false,
  exporting: false,
  exportingMedia: false,
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
  connections: document.getElementById('connections'),
  viewswitch: document.getElementById('viewswitch'),
  viewTweets: document.getElementById('view-tweets'),
  viewFollowing: document.getElementById('view-following'),
  viewFollowers: document.getElementById('view-followers'),
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
  optCaptureConnections: document.getElementById('opt-capture-connections'),
  noteConnections: document.getElementById('note-connections'),
  cleanup: document.getElementById('cleanup'),
  purgeSuperseded: document.getElementById('btn-purge-superseded'),
  purgeDeleted: document.getElementById('btn-purge-deleted'),
  purgeSupersededCount: document.getElementById('cleanup-superseded-count'),
  purgeDeletedCount: document.getElementById('cleanup-deleted-count'),
  tab: document.getElementById('btn-tab'),
  media: document.getElementById('btn-media'),
  hosted: document.getElementById('btn-hosted'),
  clear: document.getElementById('btn-clear'),
  choice: document.getElementById('choice'),
  choiceMedia: document.getElementById('choice-media'),
  choiceBackfill: document.getElementById('choice-backfill'),
  choiceReplies: document.getElementById('choice-replies'),
  choiceConnections: document.getElementById('choice-connections'),
  choiceThumbs: document.getElementById('choice-thumbs'),
  choiceWayback: document.getElementById('choice-wayback'),
  choiceConfirm: document.getElementById('btn-choice-confirm'),
  choiceShow: document.getElementById('btn-choice-show'),
  optWayback: document.getElementById('opt-wayback'),
  optWaybackAll: document.getElementById('opt-wayback-all'),
  noteWayback: document.getElementById('note-wayback'),
  settingsPanel: document.getElementById('settings'),
  waybackPanel: document.getElementById('wayback'),
  ownAuthorsPanel: document.getElementById('own-authors'),
  ownAuthorList: document.getElementById('own-author-list'),
  waybackHandle: document.getElementById('wayback-handle'),
  waybackBatch: document.getElementById('wayback-batch'),
  waybackFill: document.getElementById('btn-wayback-fill'),
  waybackVerify: document.getElementById('btn-wayback-verify'),
  waybackCancel: document.getElementById('btn-wayback-cancel'),
  waybackChoice: document.getElementById('wayback-choice'),
  waybackConfirm: document.getElementById('btn-wayback-confirm')
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
/**
 * The account's own avatar, as a data: URL, or null.
 *
 * INLINED into the profile object rather than written as a file, because the
 * archive has two export forms and only the ZIP can carry a file. A picture
 * that appears in one of them and not the other is a difference nobody would
 * remember six months later — this one rides in the JSON, so both forms open
 * with a real face and neither needs the network.
 *
 * It is one image of about thirty kilobytes, which is under three percent of a
 * normal archive and nothing at all next to the photographs it sits beside.
 */
async function avatarDataUrl(db, profile) {
  if (!profile || typeof profile.userId !== 'string' || profile.userId.length === 0) return null;
  try {
    const record = await getMediaRecord(db, avatarKey(profile.userId));
    if (!record || !record.blob) return null;
    return await blobToDataUrl(record.blob);
  } catch (_) {
    return null;   /* no picture is an ordinary outcome, not a failed export */
  }
}

/**
 * Is the account's own picture in the database right now?
 *
 * Answered by looking, not by counting: the counter records that a download
 * happened once, and after that first time it can never move again — so a pair
 * of zeroes was equally consistent with "stored and healthy" and with "never
 * attempted". Returns false for every failure, because "no picture" is the safe
 * reading of a database that will not answer.
 */
async function avatarIsStored(db) {
  try {
    if (!db) return false;
    const profiles = await listProfiles(db);
    const newest = profiles && profiles.length > 0 ? profiles[0] : null;
    if (!newest || typeof newest.userId !== 'string' || newest.userId.length === 0) return false;
    const record = await getMediaRecord(db, avatarKey(newest.userId));
    return !!(record && record.blob);
  } catch (_) {
    return false;
  }
}

/**
 * Who this archive says it is: the newest profile card's handle and user id.
 *
 * The handle names export files — two archives exported on the same day from
 * two accounts were both called `x-tweet-backup-archive-2026-10-02.zip`, and
 * once they are out of the browser nothing on either of them says whose it is.
 * The id marks which of the remembered author ids is this account, in the list
 * of ones that are, so a wrong entry can be told from the right one.
 */
async function ownIdentity() {
  const card = await identityFromProfileCard();
  if (card.handle !== null) return card;
  return await identityFromArchiveContent();
}

/** The profile card's own answer, when there is one. */
async function identityFromProfileCard() {
  try {
    const profiles = await listProfiles(state.db);
    const newest = profiles && profiles.length > 0 ? profiles[0] : null;
    if (newest === null) return { handle: null, userId: null };
    const name = typeof newest.screenName === 'string' ? newest.screenName : '';
    const safe = safeNamePart(name);
    const id = newest.userId;
    return {
      handle: safe.length > 0 ? safe : null,
      userId: typeof id === 'string' && id.length > 0 ? id
        : (typeof id === 'number' && isFinite(id) ? String(id) : null)
    };
  } catch (_) {
    return { handle: null, userId: null };
  }
}

/**
 * Whose archive this is, worked out from what is IN it.
 *
 * The profile card is the right answer and the usual one, but it is only
 * written when this browser sees the account's own profile — so an archive can
 * hold hundreds of posts and have no card at all. That is not hypothetical: it
 * is the state this was reported from, an export of 447 posts by one account
 * that came out with nothing in its file name, because there was no card to
 * read a name from and the file was left nameless rather than guessed at.
 *
 * The fallback is the account the archive is mostly MADE of, which is the
 * question a file name is really answering — and it is right whether those
 * posts came from this browser or from the Internet Archive, where an import
 * leaves the same shape behind.
 *
 * One page, not the whole store. A dominant author is obvious within a few
 * hundred records, and the alternative is parsing a hundred thousand of them
 * every time the popup opens.
 */
async function identityFromArchiveContent() {
  try {
    const page = await queryTweets(state.db, { pageSize: 2000, scanBudget: 20000 });
    const items = page && Array.isArray(page.items) ? page.items : [];
    const tally = new Map();
    for (const record of items) {
      const author = record && record.author;
      if (!author || typeof author.screenName !== 'string' || author.screenName.length === 0) continue;
      const key = typeof author.id === 'string' && author.id.length > 0 ? author.id : author.screenName;
      const seen = tally.get(key);
      if (seen === undefined) tally.set(key, { count: 1, screenName: author.screenName, id: author.id });
      else seen.count++;
    }
    let best = null;
    for (const entry of tally.values()) {
      if (best === null || entry.count > best.count) best = entry;
    }
    if (best === null) return { handle: null, userId: null };
    const safe = safeNamePart(best.screenName);
    return {
      handle: safe.length > 0 ? safe : null,
      userId: typeof best.id === 'string' && best.id.length > 0 ? best.id : null
    };
  } catch (_) {
    return { handle: null, userId: null };
  }
}

/**
 * What an export is called: `x-tweet-backup-archive-<handle>-<date>.<ext>`.
 *
 * The handle is left out entirely when there is no profile card yet, rather
 * than filled in with a placeholder — `archive-unknown-2026-10-02.zip` reads
 * like an answer, and "no name" is not one.
 *
 * Both exports get it. The ZIP used to say `x-tweet-backup-archive-<date>` and
 * the JSON `x-tweet-backup-<date>`, and neither said whose — which is the same
 * question for both of them, so both keep their own prefix and gain the handle
 * in the same place. Files exported earlier keep the names they already have;
 * this only changes what is written from here on.
 */
function archiveFileName(extension) {
  const identity = state.ownIdentity && typeof state.ownIdentity === 'object' ? state.ownIdentity : {};
  const handle = typeof identity.handle === 'string' && identity.handle.length > 0 ? identity.handle : null;
  const stem = extension === 'zip' ? 'x-tweet-backup-archive-' : 'x-tweet-backup-';
  return stem + (handle === null ? '' : handle + '-') + todayStamp() + '.' + extension;
}

/**
 * Make sure the name is knowable before a picker is opened.
 *
 * `refreshState` fills this on every popup open, and that is where it normally
 * comes from. This is the backstop for when that did not happen — a state read
 * that failed, an extension reloaded while the popup was already open — because
 * the failure is completely silent: the file is simply nameless, and nothing
 * anywhere says why.
 *
 * It costs an IndexedDB read of a handful of rows, and it only runs when the
 * value is missing. The picker wants the click's activation, which is why this
 * is not done unconditionally before one.
 */
async function ensureIdentity() {
  // Retried on a MISSING HANDLE, not on a missing object: `ownIdentity` returns
  // `{handle: null}` for every way it can fail, so "there is an object" is not
  // the same question as "there is a name".
  const handle = state.ownIdentity && typeof state.ownIdentity.handle === 'string'
    ? state.ownIdentity.handle : '';
  if (handle.length > 0) return;
  state.ownIdentity = await ownIdentity();
}

/**
 * The list of ids this browser thinks are this account.
 *
 * Shown because there was no way to see it, and the only way out of a wrong
 * entry was to wipe the extension's storage. Every line says which id, whether
 * it is the one on this archive's own profile card, and offers to forget it.
 *
 * A removed id is NOT removed from x.com pages that are already open — the page
 * keeps its own copy of the set and only ever adds to it — so the note under
 * the list says to reload them. That is the same "F5 after touching the
 * extension" the project already asks for, but here it decides whether the
 * removal appears to have worked at all.
 */
function renderOwnAuthors() {
  els.ownAuthorList.textContent = '';
  if (state.ownAuthors.length === 0) {
    els.ownAuthorList.appendChild(noteLine(t('ownAuthorsNone')));
    return;
  }

  const own = state.ownIdentity && typeof state.ownIdentity.userId === 'string' ? state.ownIdentity.userId : null;
  for (const id of state.ownAuthors) {
    const row = document.createElement('div');
    row.className = 'ownauthor';

    const label = document.createElement('span');
    label.className = 'ownauthor__id';
    label.textContent = id;
    row.appendChild(label);

    const tag = document.createElement('span');
    tag.className = 'ownauthor__tag';
    tag.textContent = id === own ? t('ownAuthorsThisOne') : t('ownAuthorsOther');
    row.appendChild(tag);

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'button button--danger button--small';
    forget.textContent = t('ownAuthorsForget');
    forget.addEventListener('click', () => { void forgetOwnAuthor(id); });
    row.appendChild(forget);

    els.ownAuthorList.appendChild(row);
  }

  els.ownAuthorList.appendChild(noteLine(t('ownAuthorsReload')));
}

function noteLine(text) {
  const p = document.createElement('p');
  p.className = 'settings__note';
  p.textContent = text;
  return p;
}

async function forgetOwnAuthor(id) {
  const response = await send({ type: 'XTB_FORGET_OWN_AUTHOR', id: id });
  if (!response || response.ok !== true) {
    setNotice(t('errForgetOwnAuthor', [(response && response.error) || t('unknownError')]), 'error');
    return;
  }
  state.ownAuthors = Array.isArray(response.ownAuthors) ? response.ownAuthors : [];
  renderOwnAuthors();
  renderConnectionsNote();
  setNotice(t('okOwnAuthorForgotten'), 'ok');
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch (_) {
      resolve(null);
    }
  });
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
  state.counts = response.counts || { tweets: null, media: null, following: null, followers: null };
  state.purgeCounts = Object.assign({ superseded: 0, deleted: 0 }, response.purgeCounts || {});
  state.mediaPermission = response.mediaPermission === true;
  state.ownAuthors = Array.isArray(response.ownAuthors) ? response.ownAuthors : [];
  /* Whether the account's picture is actually in the database.
   *
   * The lifetime counter could not answer this and was read as if it could:
   * caching happens ONCE and every sighting after that is `skipped`, which
   * bumps nothing at all — so `0 / 0` meant "already stored" exactly as often
   * as it meant "never tried", and the two could not be told apart from the
   * panel. This is the fact itself rather than a count of an event. */
  state.avatarStored = await avatarIsStored(state.db);
  /* For the export file names — see archiveFileName(). Read here and not at
     export time because the save picker only opens while the click's activation
     is still live, and an IndexedDB read in front of it is time spent before
     the dialog is allowed to appear. */
  state.ownIdentity = await ownIdentity();
  state.waybackPermission = response.waybackPermission === true;
  state.wayback = response.wayback || null;
  renderCleanup();
  renderConnectionsNote();
  renderOwnAuthors();

  els.optDebug.checked = state.settings.debug === true;
  els.optThumbs.checked = state.settings.showRemoteThumbnails === true;
  els.optMedia.checked = state.settings.mediaCache === true;
  els.optBackfillMedia.checked = state.settings.backfillMedia === true;
  els.optCaptureReplies.checked = state.settings.captureReplies === true;
  els.optCaptureConnections.checked = state.settings.captureConnections === true;
  els.optWayback.checked = state.settings.waybackEnabled === true;
  els.optWaybackAll.checked = state.settings.waybackAll === true;
  // Meaningless without the master switch, so it says so rather than looking
  // like a setting that does nothing.
  els.optBackfillMedia.disabled = state.settings.mediaCache !== true;
  // Same reasoning: with media caching off there is nothing to fill.
  els.fillMedia.disabled = state.settings.mediaCache !== true;
  els.diagnostics.hidden = state.settings.debug !== true;

  els.waybackBatch.value = String(state.settings.waybackBatch);
  // Never overwritten once it has a value: this box is the one thing here the
  // user has to supply rather than choose, and it is refilled from the stored
  // setting on every open so a typo is not permanent.
  if (String(els.waybackHandle.value || '').trim() === '') {
    els.waybackHandle.value = state.settings.waybackHandle || '';
  }
  renderWaybackNote();
  updateWaybackButtons();
  // A run can be going while this popup was closed, or opened again while one
  // is still going. Either way the poll has to be running to see it end.
  if (state.wayback !== null && state.wayback.running === true) startWaybackPoll();

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
    // The follow lists, counted on their own for the same reason: a page read is
    // not a post kept, and the third row is the one that explains an empty
    // roster — a list seen and refused because the request did not name an
    // account this browser knows is its own.
    [t('diagConnectionsSeen'), String(page.connectionsSeen || 0), ''],
    [t('diagConnectionsKept'), String(page.connectionsKept || 0), ''],
    [t('diagConnectionsNoOwner'), String(page.connectionsNoOwner || 0), ''],
    // And the profile card, on its own for the same reason. These four are what
    // say whether the reader's header will draw: seen-but-not-kept means the
    // pages being visited are somebody else's, and noUser rising on your OWN
    // profile is the signal that the response shape moved.
    [t('diagProfileSeen'), String(page.profileSeen || 0), ''],
    [t('diagProfileKept'), String(page.profileKept || 0), page.profileKept ? 'is-good' : ''],
    [t('diagProfileNoOwner'), String(page.profileNoOwner || 0), ''],
    [t('diagProfileNoUser'), String(page.profileNoUser || 0), page.profileNoUser ? 'is-bad' : ''],
    [t('diagReceived'), String(lifetime.received || 0), ''],
    [t('diagMarkedDeleted'), String(lifetime.deletedMarked || 0), ''],
    [t('diagUnmatchedDelete'), String(lifetime.deletedUnmatched || 0), ''],
    [t('diagBackfilled'), String(lifetime.backfilled || 0), lifetime.backfilled ? 'is-good' : ''],
    [t('diagBackfillSkipped'), String(lifetime.backfillSkipped || 0), ''],
    [t('diagLinksFilled'), String(lifetime.linksFilled || 0), lifetime.linksFilled ? 'is-good' : ''],
    [t('diagLinksUnmatched'), String(lifetime.linksUnmatched || 0), ''],
    // New people written against people already known. One counter could not
    // tell a roster that has stopped growing from one being written to
    // constantly, and those want opposite investigations.
    [t('diagConnectionsAdded'), String(lifetime.connectionsAdded || 0), lifetime.connectionsAdded ? 'is-good' : ''],
    [t('diagConnectionsRefreshed'), String(lifetime.connectionsRefreshed || 0), ''],
    [t('diagProfileAdded'), String(lifetime.profileAdded || 0), lifetime.profileAdded ? 'is-good' : ''],
    [t('diagProfileRefreshed'), String(lifetime.profileRefreshed || 0), ''],
    /* The account's own picture. The first row is the FACT — is it in the
       database — and it is the one to read; the two below are history, and
       `avatarCached` in particular cannot move again once it has fired once,
       because every later sighting is skipped. A pair of zeroes down there is
       not a fault, which is what it looked like. */
    [t('diagAvatarStored'), state.avatarStored === true ? t('diagAvatarYes') : t('diagAvatarNo'),
      state.avatarStored === true ? 'is-good' : ''],
    [t('diagAvatarCached'), String(lifetime.avatarCached || 0), lifetime.avatarCached ? 'is-good' : ''],
    [t('diagAvatarFailed'), String(lifetime.avatarFailed || 0), lifetime.avatarFailed ? 'is-bad' : ''],
    // The archive import. `skipped` is the one that says "fill the gaps" is
    // doing its job: each of those is a post the archive already had, and each
    // one cost a local read instead of a request to somebody else's server.
    [t('diagWaybackImported'), String(lifetime.waybackImported || 0), lifetime.waybackImported ? 'is-good' : ''],
    [t('diagWaybackEnriched'), String(lifetime.waybackEnriched || 0), lifetime.waybackEnriched ? 'is-good' : ''],
    [t('diagWaybackSkipped'), String(lifetime.waybackSkipped || 0), ''],
    [t('diagWaybackFailed'), String(lifetime.waybackFailed || 0), lifetime.waybackFailed ? 'is-bad' : ''],
    [t('diagUpsertOk'), String(lifetime.upsertOk || 0), lifetime.upsertOk ? 'is-good' : ''],
    [t('diagUpsertFailed'), String(lifetime.upsertFailed || 0), lifetime.upsertFailed ? 'is-bad' : ''],
    [t('diagRejected'), String(lifetime.rejected || 0), lifetime.rejected ? 'is-bad' : ''],
    [t('diagMediaCached'), String(lifetime.mediaCached || 0), ''],
    // Which of the two sources answered. A number here is not a problem — it is
    // the only way a picture from a deleted account gets into an archive at all.
    [t('diagMediaFromArchive'), String(lifetime.mediaFromArchive || 0), lifetime.mediaFromArchive ? 'is-good' : ''],
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
/* Which list is on screen                                                    */
/* -------------------------------------------------------------------------- */

/* Three views, two kinds of list. The roster's two share everything — same
   query function, same row renderer, same empty state, same paging loop — and
   differ only in which store list they ask for, which rides in the paging
   options rather than in a second code path. */

function isRosterView() {
  return state.view !== 'tweets';
}

/** The paging record for the view on screen. */
function paging() {
  return state.paging[state.view];
}

/** The scroll container for the view on screen. */
function viewElement() {
  return isRosterView() ? els.connections : els.list;
}

/** What identifies a row, for the "already drawn" set. */
function rowKey(record) {
  return isRosterView() ? record.list + ':' + record.userId : record.id;
}

/** One page of the view on screen, from the database. */
function queryView(options) {
  if (!isRosterView()) return queryTweets(state.db, options);
  return queryConnections(state.db, Object.assign({ list: state.view }, options));
}

/**
 * The layout the roster view needs, as a media query string.
 *
 * The same 610 popup.css uses to decide whether this page is a toolbar popup or
 * a real page, and the two have to mean the same thing. They are not two
 * sources of truth for one decision: CSS hides the switch, and this read only
 * decides whether the roster is reachable at all. If they ever disagreed the
 * failure is one-directional — a view hidden with its switch still on screen —
 * which is why CSS is the thing that actually enforces visibility.
 */
const PAGE_LAYOUT_QUERY = '(min-height: 610px)';

function pageLayoutMatches() {
  try {
    return window.matchMedia(PAGE_LAYOUT_QUERY).matches;
  } catch (_) {
    return false;
  }
}

function renderViewTabs() {
  els.viewTweets.classList.toggle('is-active', state.view === 'tweets');
  els.viewFollowing.classList.toggle('is-active', state.view === 'following');
  els.viewFollowers.classList.toggle('is-active', state.view === 'followers');
}

/**
 * Show one of the three lists.
 *
 * Switching back to a view that is already drawn costs nothing: its container is
 * left alone, its blob URLs stay alive, and its paging state still says where it
 * got to. Nothing is re-fetched, so moving between Posts and the roster does not
 * lose the reader's place in either.
 */
async function setView(next) {
  if (!Object.prototype.hasOwnProperty.call(state.paging, next)) return;
  if (next === state.view) return;

  state.view = next;
  renderViewTabs();

  els.list.hidden = next !== 'tweets';
  els.connections.hidden = next === 'tweets';

  // The search box is one element serving both lists, so its contents have to be
  // swapped with the view rather than left behind — see the input handler.
  els.search.value = paging().query;
  els.search.placeholder = next === 'tweets'
    ? t('searchPlaceholder')
    : t('searchPlaceholderConnections');

  if (paging().rendered.size > 0 || viewElement().firstChild !== null) {
    updateListFooter();
    return;
  }
  await reload();
}

/**
 * The line under the follow-list switch.
 *
 * Two states, because "on and working" and "on but it cannot possibly store
 * anything yet" are identical from the outside otherwise — and the second is not
 * an error, it is a browser that has never seen this account publish. A switch
 * that silently does nothing is indistinguishable from a broken one, so it says
 * which it is. Deliberately NOT disabled in that state: the dependency is a fact
 * about history rather than another setting, and a disabled box with nothing to
 * fix reads as a broken control.
 */
function renderConnectionsNote() {
  els.noteConnections.textContent = state.ownAuthors.length > 0
    ? t('noteConnections')
    : t('noteConnectionsInactive');
}

/** Thousands separators, in whatever locale the browser is set to. */
function formatCount(value) {
  try {
    return Number(value).toLocaleString();
  } catch (_) {
    return String(value);
  }
}

/**
 * One person in the roster.
 *
 * Built with createElement and textContent like every other row in this file: a
 * handle and a bio are other people's text and are never markup.
 *
 * The profile link is built from the NUMERIC ID rather than the handle, because
 * the whole reason a roster exists is the day the handle no longer resolves —
 * `x.com/i/user/<id>` survives a rename, and a link built from a handle that has
 * since been taken would point at somebody else.
 */
function renderConnection(record) {
  const article = document.createElement('article');
  article.className = 'conn';
  article.dataset.id = record.userId;

  const head = document.createElement('div');
  head.className = 'conn__head';

  const name = document.createElement('span');
  name.className = 'conn__name';
  name.textContent = (typeof record.name === 'string' && record.name.length > 0)
    ? record.name
    : t('unknownAuthor');
  head.appendChild(name);

  if (typeof record.screenName === 'string' && record.screenName.length > 0) {
    const handle = document.createElement('span');
    handle.className = 'conn__handle';
    handle.textContent = '@' + record.screenName;
    head.appendChild(handle);
  }

  if (record.blueVerified === true || record.verified === true) {
    const badge = document.createElement('span');
    badge.className = 'conn__badge';
    badge.textContent = t('badgeVerified');
    head.appendChild(badge);
  }

  article.appendChild(head);

  if (typeof record.bio === 'string' && record.bio.length > 0) {
    const bio = document.createElement('p');
    bio.className = 'conn__bio';
    bio.textContent = record.bio;
    article.appendChild(bio);
  }

  const meta = document.createElement('div');
  meta.className = 'conn__meta';

  const numbers = [];
  if (typeof record.followersCount === 'number') {
    numbers.push(t('connFollowers', [formatCount(record.followersCount)]));
  }
  if (typeof record.followingCount === 'number') {
    numbers.push(t('connFollowing', [formatCount(record.followingCount)]));
  }
  if (typeof record.tweetCount === 'number') {
    numbers.push(t('connPosts', [formatCount(record.tweetCount)]));
  }
  for (const text of numbers) {
    const span = document.createElement('span');
    span.textContent = text;
    meta.appendChild(span);
  }

  if (typeof record.location === 'string' && record.location.length > 0) {
    const place = document.createElement('span');
    place.textContent = record.location;
    meta.appendChild(place);
  }

  const seen = document.createElement('span');
  seen.textContent = t('connSeen', [formatRelative(record.lastSeenAt)]);
  seen.title = t('connSeenTitle', [String(record.firstSeenAt || ''), String(record.lastSeenAt || '')]);
  meta.appendChild(seen);

  const open = document.createElement('a');
  open.className = 'conn__link';
  open.href = 'https://x.com/i/user/' + record.userId;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.textContent = t('openProfile');
  meta.appendChild(open);

  article.appendChild(meta);
  return article;
}

/* -------------------------------------------------------------------------- */
/* List rendering                                                             */
/* -------------------------------------------------------------------------- */

function listIsEmpty() {
  return viewElement().querySelector('.card, .conn') === null;
}

/**
 * The wording for an empty list.
 *
 * Written as explicit branches with literal t() calls, not a lookup keyed by
 * view. tools/check-i18n.mjs only counts keys it can see written out literally,
 * so a computed key reads as "defined but unused" and fails the check — and a
 * typo in one would reach the screen as a raw key name.
 */
function emptyStateText() {
  const term = paging().query;
  if (!isRosterView()) {
    return term.length > 0 ? t('emptyNoMatch', [term]) : t('emptyNone');
  }
  return term.length > 0 ? t('emptyConnectionsNoMatch', [term]) : t('emptyConnections');
}

function showEmptyState() {
  if (!listIsEmpty()) return;
  const box = viewElement();
  while (box.firstChild) box.removeChild(box.firstChild);
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = emptyStateText();
  box.appendChild(div);
}

function clearEmptyState() {
  const empty = viewElement().querySelector('.empty');
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
  const box = viewElement();
  const drawn = paging().rendered;
  for (const record of items) {
    if (!record || typeof record !== 'object') continue;
    const key = rowKey(record);
    if (typeof key !== 'string' || key.length === 0) continue;
    if (drawn.has(key)) continue;
    drawn.add(key);

    if (isRosterView()) {
      box.appendChild(renderConnection(record));
    } else {
      const card = renderCard(record);
      box.appendChild(card);
      // Reading scrollHeight forces layout, so the measurement is valid here.
      syncExpandVisibility(card);
    }
    appended++;
  }
  if (appended > 0) clearEmptyState();
  return appended;
}

function updateListFooter() {
  const view = paging();
  els.more.hidden = view.hasMore !== true;
  els.more.disabled = state.loading === true;
  els.more.textContent = state.loading ? t('loading') : t('loadMore');

  const rendered = view.rendered.size;
  if (rendered === 0) {
    els.listHint.textContent = '';
    return;
  }
  // "已到底部" used to be appended whenever everything was loaded — which is
  // almost always, since a normal archive fits in the first page — so the hint
  // permanently claimed something the user could already see for themselves
  // (the 加载更多 button is absent). Only the useful half is kept.
  //
  // Literal keys, not a table, for the same reason emptyStateText spells its own
  // out: the i18n checker cannot see a computed one.
  if (isRosterView()) {
    els.listHint.textContent = view.hasMore
      ? t('listShownConnectionsMore', [String(rendered)])
      : t('listShownConnections', [String(rendered)]);
  } else {
    els.listHint.textContent = view.hasMore
      ? t('listShownMore', [String(rendered)])
      : t('listShown', [String(rendered)]);
  }
}

/* -------------------------------------------------------------------------- */
/* Paging + search                                                            */
/* -------------------------------------------------------------------------- */

async function fetchBatch(targetCount) {
  const collected = [];
  const view = paging();
  let rounds = 0;

  while (collected.length < targetCount && rounds < 8) {
    rounds++;
    const remaining = targetCount - collected.length;
    const previousKey = view.nextKey;

    const page = await queryView({
      query: view.query,
      pageSize: remaining,
      afterKey: view.nextKey,
      scanBudget: 20000
    });

    for (const record of page.items) collected.push(record);
    view.nextKey = page.nextKey;
    view.hasMore = page.hasMore;

    if (!page.hasMore) break;
    if (page.nextKey === null) break;
    // Guard against a resume key that does not advance, which would spin.
    // sameKey comes from db.js — the same rule queryTweets itself applies, so
    // the two cannot drift apart.
    if (page.items.length === 0 && sameKey(page.nextKey, previousKey)) {
      view.hasMore = false;
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
    const box = viewElement();
    while (box.firstChild) box.removeChild(box.firstChild);
    // Only the post list holds blob: URLs, and clearing it here is the only
    // thing that discards the cards using them. Revoking while the roster is on
    // screen would break the pictures on the hidden post cards — which are still
    // in the DOM, and are meant to come back untouched when the view switches.
    if (!isRosterView()) revokeObjectUrls();

    const view = paging();
    view.rendered = new Set();
    view.nextKey = null;
    view.hasMore = false;

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
  if (state.db === null || state.loading || paging().hasMore !== true) return;
  state.loading = true;
  updateListFooter();
  try {
    const batch = await fetchBatch(state.settings.pageSize);
    const appended = appendItems(batch);
    if (appended === 0 && paging().hasMore === false) {
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
  /* `state.renderedIds` never existed — the set of drawn rows lives per list, on
     the paging state. Reading a missing property gave `undefined` and the call
     on it threw a TypeError, and because the record was already gone from the
     database and the card already removed from the page by then, the only
     symptom was the count, the empty state and the "deleted" notice never
     updating. */
  paging().rendered.delete(id);
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

/**
 * One envelope, or several.
 *
 * `options.maxShardBytes` splits the record array into more than one complete
 * envelope. It exists for GitHub: a single file there is refused outright over
 * 100 MB, and refusing means the upload has already pushed every media blob
 * before it finds out. Each shard is a whole envelope — its own count, its own
 * schema version — so each one opens on its own in this reader and in anything
 * else that reads this format.
 *
 * `options.omitConnections` leaves the follow roster out. The hosted form
 * writes it to its own file: a roster is tens of megabytes, and inlined it
 * would be most of a single file's budget and a huge tail for a reader to
 * range-read.
 *
 * With neither option set the output is byte-for-byte what this function has
 * always produced — asserted, because the plain export is what people already
 * have on disk and a changed byte there is a changed archive.
 */
async function buildTweetsJson(options) {
  const opts = options || {};
  const exportedAt = new Date().toISOString();
  const timezone = timezoneBlock();

  const head = '{\n  "schemaVersion": ' + JSON.stringify(SCHEMA_VERSION) + ',\n' +
    '  "generator": "x-tweet-backup",\n' +
    '  "generatorVersion": ' + JSON.stringify(extensionVersion()) + ',\n' +
    '  "exportedAt": ' + JSON.stringify(exportedAt) + ',\n' +
    '  "timezone": ' + JSON.stringify(timezone) + ',\n' +
    '  "tweets": [';

  const recordTexts = [];
  let count = 0;
  await forEachTweet(state.db, (record) => {
    recordTexts.push(JSON.stringify(record));
    count++;
  });

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

  // Your own profile card sits immediately after `count`, and BOTH sides of that
  // position are load-bearing.
  //
  // It has to come AFTER the tweet array, because reader.html locates that array
  // by scanning the raw bytes for the literal "tweets" key inside a probe
  // measured in kilobytes — anything placed before it that grew large enough
  // would stop the archive opening at all. A bio capped at 2000 characters would
  // usually be fine, and "usually fine" is not the standard this invariant is
  // held to.
  //
  // And it has to come BEFORE the roster, because the reader reaches this part
  // of the file with one bounded forward read from the array's closing bracket.
  // The roster can be tens of megabytes; the card would be out of reach behind it.
  //
  // A failed read STOPS the export, like the deletion log and the roster: a file
  // that looks complete while silently missing the header is worse than no file.
  let profiles;
  try {
    profiles = await listProfiles(state.db);
  } catch (err) {
    throw new Error(t('errProfileUnreadable', [describe(err)]));
  }
  /* WHICH card names the archive and supplies its face.
   *
   * listProfiles returns most-recently-seen first, and an imported card is
   * stamped with the IMPORT time — so a card taken off a crawl of the account's
   * first day (measured on a real one: 0 followers, 1 post) sorts ahead of the
   * card this browser captured today, even though its contents are years old.
   * The export should describe the account as this browser knows it, so a card
   * the browser captured itself wins over any import; only an archive whose
   * every card came from the Archive falls back to the newest of those, which
   * still beats leaving the header empty. */
  let profile = null;
  for (const row of profiles) {
    const via = row && row.source && typeof row.source.operationName === 'string'
      ? row.source.operationName : '';
    if (via !== 'WaybackImport') { profile = row; break; }
  }
  if (profile === null && profiles.length > 0) profile = profiles[0];
  if (profile !== null) {
    const face = await avatarDataUrl(state.db, profile);
    if (face !== null) profile.avatarData = face;
  }
  // The follow roster rides LAST, and that position is load-bearing rather than
  // tidy. reader.html does not parse this file: it finds the tweet array by
  // scanning the raw bytes for the literal "tweets" key inside a probe whose
  // window is measured in kilobytes. Anything placed before that key which grew
  // large enough to push it past the window would stop the archive opening at
  // all. Nothing after `count` is read by that scanner, so this section can be
  // any size it likes.
  //
  // A failed read STOPS the export, for the same reason the deletion log does: a
  // file that looks complete while silently omitting everyone you follow is
  // worse than no file at all.
  let connections;
  try {
    connections = await listConnections(state.db);
  } catch (err) {
    throw new Error(t('errConnectionsUnreadable', [describe(err)]));
  }

  /**
   * Everything after the record array, for one shard.
   *
   * Shard 1 carries the profile and the deletions; the later ones carry
   * neither. Their `deletions` is an EMPTY ARRAY rather than a missing key, and
   * that is not tidiness: `envelopeHasList` reads `[]` as "no list here", so a
   * shard without it stays quiet, while an absent key would be the same answer
   * arrived at differently and a `null` would be a third.
   */
  function tailFor(shardCount, extras) {
    let out = (shardCount === 0 ? ']' : '\n  ]') + ',\n  "count": ' + shardCount + ',\n';
    if (extras.profile !== null && extras.profile !== undefined) {
      out += '  "profile": ' + JSON.stringify(extras.profile) + ',\n';
    }
    out += '  "deletions": ' + JSON.stringify(extras.deletions || []);
    // Omitted entirely when empty, so an archive belonging to someone who never
    // switched the feature on is byte-for-byte what earlier versions wrote.
    if (Array.isArray(extras.connections) && extras.connections.length > 0) {
      out += ',\n  "connections": ' + JSON.stringify(extras.connections) + '\n}\n';
    } else {
      out += '\n}\n';
    }
    return out;
  }

  function renderShard(records, isFirst) {
    let body = '';
    for (let i = 0; i < records.length; i++) {
      body += (i === 0 ? '\n    ' : ',\n    ') + records[i];
    }
    return head + body + tailFor(records.length, {
      profile: isFirst ? profile : null,
      deletions: isFirst ? deletions : [],
      connections: isFirst && opts.omitConnections !== true ? connections : []
    });
  }

  const groups = [];
  if (!(opts.maxShardBytes > 0)) {
    groups.push(recordTexts);
  } else {
    let current = [];
    let bytes = 0;
    for (const text of recordTexts) {
      // The separator and the indentation, and nothing for the head — this is a
      // guard against a hard limit, not an exact budget.
      const cost = utf8Bytes(text) + 6;
      if (current.length > 0 && bytes + cost > opts.maxShardBytes) {
        groups.push(current);
        current = [];
        bytes = 0;
      }
      current.push(text);
      bytes += cost;
    }
    if (current.length > 0 || groups.length === 0) groups.push(current);
  }

  const shards = groups.map((records, i) => ({
    text: renderShard(records, i === 0),
    count: records.length
  }));

  return {
    text: shards[0].text,
    shards: shards,
    count: count,
    deletions: deletions.length,
    deletionsRows: deletions,
    connections: connections.length,
    connectionsRows: connections,
    profile: profile,
    timezone: timezone,
    exportedAt: exportedAt
  };
}

async function exportAll() {
  if (state.exporting || state.db === null) return;
  state.exporting = true;
  els.export.disabled = true;
  els.export.textContent = t('busyExportingShort');

  try {
    await ensureIdentity();
    const filename = archiveFileName('json');
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

function parseDateOrNow(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms) : new Date();
}

/**
 * Everything an archive is made of, gathered once.
 *
 * The envelope, the media rows, how many rows could not be named. Extracted so
 * that the ZIP export and the hosted-layout export cannot disagree about what
 * an archive contains: they lay the files out differently — a ZIP puts every
 * picture in one `media/` directory, a hosted archive splits them by year and
 * month — but the rows are the same rows and the envelope is the same envelope.
 *
 * `tweetId` and `mediaId` are the values AS STORED, because they are the join
 * key: the reader pairs a file back to a post by looking them up in the media
 * index, and an id that had been sanitised out of recognition would simply
 * never match. `fileName` is the sanitised form, because that one is a path.
 * For every real tweet the two are identical — a snowflake id and a media key
 * are digits and underscores already — so this costs nothing and is correct for
 * the file that comes from somewhere else.
 */
async function collectArchiveInputs(options) {
  const built = await buildTweetsJson(options);
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
      fileName: 'media/' + tweetId + '_' + mediaId + mediaExtension(record.contentType, record.type),
      tweetId: String(record.tweetId),
      mediaId: String(record.mediaId),
      type: typeof record.type === 'string' ? record.type : null,
      contentType: typeof record.contentType === 'string' ? record.contentType : null,
      bytes: record.blob.size,
      blob: record.blob,
      cachedAt: typeof record.cachedAt === 'string' ? record.cachedAt : null,
      date: parseDateOrNow(record.cachedAt)
    });
  }

  return { built: built, rows: rows, skipped: skipped, generatedAt: new Date().toISOString() };
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
    await ensureIdentity();
    const filename = archiveFileName('zip');
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

    const input = await collectArchiveInputs();
    const built = input.built;
    const rows = input.rows;
    const skipped = input.skipped;
    const generatedAt = input.generatedAt;
    setNotice(t('busyPacking', [String(built.count), String(rows.length)]));

    // The ZIP's own naming rule, kept here rather than in collectArchiveInputs:
    // a ZIP puts every picture in one `media/` directory, while the hosted form
    // splits them by year and month. Two different questions, two answers.
    const zipRows = rows.map((row) => ({
      fileName: row.fileName,
      tweetId: row.tweetId,
      mediaId: row.mediaId,
      type: row.type,
      contentType: row.contentType,
      bytes: row.bytes
    }));

    const extraFiles = [
      { name: 'tweets.json', text: built.text, date: new Date() },
      { name: 'MEDIA-INDEX.txt', text: describeMediaArchive(zipRows, { generatedAt: generatedAt, skipped: skipped, connections: built.connections, profile: built.profile }), date: new Date() },
      { name: 'MEDIA-INDEX.json', text: buildMediaIndexJson(zipRows, { generatedAt: generatedAt, skipped: skipped, schemaVersion: SCHEMA_VERSION, version: extensionVersion() }), date: new Date() }
    ];

    // Only when there is a roster to write. An archive from someone who never
    // switched the feature on gets exactly the file list it always got.
    if (built.connections > 0) {
      extraFiles.push({
        name: 'CONNECTIONS.csv',
        text: buildConnectionsCsv(built.connectionsRows),
        date: new Date()
      });
    }

    const zip = await buildZip(
      rows.map((row) => ({ name: row.fileName, blob: row.blob, date: row.date })),
      { extraFiles: extraFiles }
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

/**
 * Write the archive as a hosted layout — the shape a GitHub repository wants.
 *
 * Not a ZIP, and that is the entire point. This reader opens an archive by
 * reading a few bytes here and a few bytes there: the head to find the record
 * array, the tail for the envelope, one record at a time as you scroll. Over a
 * ZIP none of that is possible without unpacking the whole thing first, which
 * is the one thing this project refuses to do. See hosted.js for the layout.
 *
 * Runs only in a full tab. The directory picker takes focus, and Chrome closes
 * a toolbar popup the moment it loses focus — so the picker's promise would
 * never settle and the export would disappear with no error at all. That is the
 * same question, asked for the same reason, as the first-run panel asks.
 */
async function exportHostedToFolder() {
  if (state.exportingMedia || state.db === null) return;
  if (isToolbarPopup()) {
    setNotice(t('errHostedNeedsTab'), 'error');
    return;
  }
  if (typeof window.showDirectoryPicker !== 'function') {
    setNotice(t('errNoDirectoryPicker'), 'error');
    return;
  }

  state.exportingMedia = true;
  els.hosted.disabled = true;
  els.hosted.textContent = t('busyPackingShort');

  try {
    // Before anything is built: the picker needs the click's activation, and
    // building an envelope spends it.
    let root;
    try {
      root = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (err) {
      if (err && err.name === 'AbortError') setNotice(t('exportCancelled'), '');
      else setNotice(t('errHosted', [describe(err)]), 'error');
      return;
    }

    /* Refused rather than merged into. A folder that already holds an older
       archive would keep the media files this run no longer writes, and the
       result is a directory whose index names files that are there and whose
       files include ones the index has never heard of — pushed to GitHub, that
       is an archive that looks complete and has ghosts in it. */
    for await (const _entry of root.values()) {
      setNotice(t('errHostedNotEmpty'), 'error');
      return;
    }

    setNotice(t('busyReading'));
    const input = await collectArchiveInputs({ maxShardBytes: HOSTED_TWEETS_SOFT_MAX });

    const profile = input.built.profile;
    const layout = buildHostedLayout({
      shards: input.built.shards,
      mediaRows: input.rows,
      deletions: input.built.deletionsRows,
      connections: input.built.connectionsRows,
      profile: profile,
      listing: false,
      meta: {
        generatedAt: input.generatedAt,
        generatorVersion: extensionVersion(),
        schemaVersion: SCHEMA_VERSION,
        timezone: input.built.timezone,
        totalCount: input.built.count,
        account: profile === null ? null : {
          userId: profile.userId === undefined ? null : String(profile.userId),
          screenName: typeof profile.screenName === 'string' ? profile.screenName : null,
          name: typeof profile.name === 'string' ? profile.name : null
        }
      }
    });

    let written = 0;
    for (const file of layout.files) {
      // index.json is FIRST in the list and written LAST: a reader that opens a
      // folder while its index names files that have not been written yet finds
      // half an archive, and an index that arrives last can only ever be
      // complete when it lands.
      if (file.path === 'index.json') continue;
      await writeFileInto(root, file.path, file.text === undefined ? file.blob : file.text);
      written++;
      if (written % 25 === 0) {
        setNotice(t('busyHostedWriting', [String(written), String(layout.files.length - 1)]));
      }
    }
    await writeFileInto(root, 'index.json', layout.indexText);

    let message = t('okHostedWritten', [
      String(input.built.count),
      String(layout.index.media.count),
      formatBytes(layout.index.media.bytesTotal),
      root.name
    ]);
    if (input.skipped > 0) message += t('okArchiveSkipped', [String(input.skipped)]);
    if (layout.problems.length > 0) message += t('okHostedProblems', [String(layout.problems.length)]);
    setNotice(message, 'ok');
  } catch (err) {
    setNotice(t('errHosted', [describe(err)]), 'error');
  } finally {
    state.exportingMedia = false;
    els.hosted.disabled = false;
    els.hosted.textContent = t('exportHosted');
  }
}

/** One file, at a slash-separated path, inside a directory handle. */
async function writeFileInto(root, path, content) {
  const parts = String(path).split('/');
  let dir = root;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create: true });
  }
  const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const stream = await handle.createWritable();
  await stream.write(content);
  await stream.close();
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
  // The intent goes down BEFORE the browser is asked, and for the same reason
  // the archive switch does: the prompt takes the focus, the popup closes, and
  // everything after the request is code that may never run. Written here it
  // has already happened, so a grant lands on a setting that is already on
  // instead of on a switch the user has to come back and flip a second time.
  //
  // A refusal needs no undoing here: init() reads the permission back on the
  // next open and turns the switch off if it is not there. That reconciliation
  // is the reason this is allowed to write a claim it has not earned yet.
  void applySettings({ mediaCache: true });
  // The checkbox shows intent; enableMediaCache reports what happened, so a
  // refused grant puts the switch back to off instead of leaving it claiming
  // caching that does not exist.
  if ((await enableMediaCache()) !== true) els.optMedia.checked = false;
}

/* -------------------------------------------------------------------------- */
/* The archive import                                                         */
/* -------------------------------------------------------------------------- */

/* Nothing in this section runs by itself. The switch is off until somebody
   turns it on, and the run only starts from a button — this is the one part of
   the extension that makes requests of its own, to a server that is not X, and
   it does not get to decide that on the user's behalf. */

/** What is in the batch box, clamped to what the background will accept. */
function waybackBatchValue() {
  const n = Number.parseInt(els.waybackBatch.value, 10);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.waybackBatch;
  return Math.min(500, Math.max(1, n));
}

/** Who will be swept: whatever is typed, minus a leading @. Empty means no. */
function waybackHandleValue() {
  const typed = String(els.waybackHandle.value || '').trim().replace(/^@/, '');
  return isHandle(typed) ? typed : '';
}

/**
 * The line under the switch.
 *
 * The same reasoning as the note under the follow-list switch: a control that
 * is on and doing nothing is indistinguishable from one that is broken, so it
 * says which of the states it is in rather than sitting there inert.
 */
function renderWaybackNote() {
  const summary = state.wayback;
  const job = summary && summary.job ? summary.job : null;

  if (state.settings.waybackEnabled !== true) {
    els.noteWayback.textContent = t('noteWaybackOff');
    return;
  }
  if (summary && summary.running === true && job !== null) {
    els.noteWayback.textContent = t('waybackProgress', [
      t(job.mode === 'verify' ? 'btnWaybackVerify' : 'btnWaybackFill'),
      String(job.imported + job.enriched + job.skipped),
      String(job.batch)
    ]);
    return;
  }
  if (job !== null && job.pauseReason !== null) {
    els.noteWayback.textContent = t('noteWaybackPaused', [
      String(job.cursor), String(summary.total), pauseReasonText(job.pauseReason)
    ]);
    return;
  }
  if (job !== null) {
    // A batch that stopped the ordinary way: the run is still on disk with its
    // position, and the one thing worth saying is that pressing again carries
    // on rather than starting over. Without this the note read like a finished
    // run and the leftovers were invisible.
    const remaining = Math.max(0, summary.total - job.cursor);
    els.noteWayback.textContent = t('noteWaybackMore', [String(remaining), String(summary.total)]);
    return;
  }
  if (summary && summary.last) {
    const last = summary.last;
    els.noteWayback.textContent = t('noteWaybackDone', [
      String(last.imported), String(last.enriched), String(last.skipped), String(last.failed)
    ]);
    return;
  }
  if (waybackHandleValue() === '') {
    els.noteWayback.textContent = t('noteWaybackNoHandle');
    return;
  }
  // Ready and nothing to say. Every branch above reports a state worth knowing;
  // this one is the absence of one — the two buttons name what they do and the
  // field above says how many, so a sentence repeating both was noise. Empty
  // rather than hidden by hand: `.settings__note:empty` takes it out of the
  // layout, so the switch does not sit above a blank line.
  els.noteWayback.textContent = '';
}

/**
 * Why a paused run is paused, in words.
 *
 * A table of thunks rather than a table of key names, and the difference
 * matters: tools/check-i18n.mjs finds a string by matching a literal call with
 * a quoted name in this file, so a key that only ever appears as a computed
 * value reads as an unused string and the check fails — which is the check
 * working, because a key reached only through a variable is one nobody can find
 * by searching.
 */
const WAYBACK_PAUSE_TEXT = {
  'off': function () { return t('waybackPausedOff'); },
  'permission': function () { return t('waybackPausedPermission'); },
  'archive-down': function () { return t('waybackPausedArchive'); },
  'stopped': function () { return t('waybackPausedStopped'); }
};

function pauseReasonText(reason) {
  const entry = Object.prototype.hasOwnProperty.call(WAYBACK_PAUSE_TEXT, reason)
    ? WAYBACK_PAUSE_TEXT[reason] : null;
  return entry === null ? t('waybackPausedOff') : entry();
}

/** Both buttons are live only when a press would actually do something. */
function updateWaybackButtons() {
  const summary = state.wayback;
  const running = summary !== null && summary !== undefined && summary.running === true;
  const enabled = state.settings.waybackEnabled === true && state.waybackPermission === true;
  const ready = enabled && waybackHandleValue() !== '' && !running;
  els.waybackFill.disabled = !ready;
  els.waybackVerify.disabled = !ready;
  els.waybackCancel.hidden = !running;
  // Disabled rather than hidden: the number still means something the moment
  // that switch goes off, and a field that vanished and came back would look
  // like it had been forgotten.
  els.waybackBatch.disabled = state.settings.waybackAll === true;
}

/**
 * Put the import controls in front of the user.
 *
 * They sit behind two closed drawers — 设置, and 导入设置 inside it — which is
 * the right place for a feature nobody has switched on and the wrong one for a
 * feature that has just been granted a browser permission. The reported symptom
 * was exactly that: the switch was on, the prompt had been answered, and there
 * was no button anywhere. Nothing was broken — the buttons were two clicks away
 * and no sentence on the page said so.
 *
 * `outer` is the whole difference between the two moments this is called.
 * Opening 导入设置 on its own costs nothing while 设置 is shut: the controls are
 * simply waiting the next time it is opened, which is the right amount of help
 * for a popup that is only being looked at. Opening 设置 as well rearranges the
 * window and shortens the list, so it happens only when the user is in the
 * middle of setting this up — straight after the grant, and on the first open
 * after a popup died on the prompt.
 */
function revealWaybackPanel(outer) {
  if (outer === true) els.settingsPanel.open = true;
  els.waybackPanel.open = true;
}

/**
 * True until a run has ever been started — the state the reveal above is for.
 *
 * A settled job is not nothing to say; it has a note of its own, and the drawers
 * should stay where the user left them. This is only ever about the stretch
 * between switching the feature on and pressing the button for the first time.
 */
function waybackUntouched() {
  const summary = state.wayback;
  if (summary === null || summary === undefined) return true;
  const job = summary.job === undefined ? null : summary.job;
  const last = summary.last === undefined ? null : summary.last;
  return job === null && last === null;
}

/* ---- the progress poll ---- */

let waybackPoll = null;

/**
 * Stop asking. Called from three places and all three are needed: the run
 * finishing, the popup going away, and the request failing. A timer left
 * running in a popup that was opened as a tab would ask the service worker for
 * something every second for as long as the tab lives.
 */
function stopWaybackPoll() {
  if (waybackPoll !== null) {
    clearInterval(waybackPoll);
    waybackPoll = null;
  }
}

async function pollWayback() {
  const response = await send({ type: 'XTB_WAYBACK_STATUS' });
  if (!response || response.ok !== true) {
    stopWaybackPoll();
    return;
  }
  state.wayback = response.wayback;
  renderWaybackNote();
  updateWaybackButtons();

  if (state.wayback === null || state.wayback.running !== true) {
    stopWaybackPoll();
    const last = state.wayback && state.wayback.last ? state.wayback.last : null;
    if (last !== null) {
      setNotice(t('okWaybackDone', [
        String(last.imported), String(last.enriched), String(last.skipped), String(last.failed)
      ]), 'ok');
    }
    // The saved-posts counter in the summary is now out of date by however many
    // records this run wrote, and nothing else would refresh it.
    await refreshState();
  }
}

function startWaybackPoll() {
  if (waybackPoll === null) waybackPoll = setInterval(() => { void pollWayback(); }, 1000);
  updateWaybackButtons();
}

/* ---- starting, and stopping ---- */

/* The same thunk table as WAYBACK_PAUSE_TEXT, and for the same reason: these
   strings have to appear as literal `t('...')` calls or the i18n check cannot
   see them. The codes are the background's own error words. */
const WAYBACK_ERROR_TEXT = {
  'off': function () { return t('errWaybackOff'); },
  'permission': function () { return t('errWaybackPermission'); },
  'already running': function () { return t('errWaybackAlreadyRunning'); },
  'invalid handle': function () { return t('errWaybackBadHandle'); },
  'invalid batch': function () { return t('errWaybackBadBatch'); },
  'invalid mode': function () { return t('errWaybackBadBatch'); },
  'no snapshots for that handle': function () { return t('errWaybackNoSnapshots'); },
  'could not reach the archive': function () { return t('errWaybackArchiveDown'); }
};

async function startWayback(mode) {
  const handle = waybackHandleValue();
  if (handle === '') {
    setNotice(t('errWaybackBadHandle'), 'error');
    return;
  }
  const batch = waybackBatchValue();
  const all = state.settings.waybackAll === true;
  els.waybackBatch.value = String(batch);

  els.waybackFill.disabled = true;
  els.waybackVerify.disabled = true;
  setNotice(t('busyWayback'));

  let response = null;
  try {
    response = await send({ type: 'XTB_WAYBACK_START', handle: handle, batch: batch, mode: mode, all: all });
  } catch (err) {
    response = null;
  }

  if (!response || response.ok !== true) {
    const code = response && response.error ? response.error : '';
    const entry = Object.prototype.hasOwnProperty.call(WAYBACK_ERROR_TEXT, code)
      ? WAYBACK_ERROR_TEXT[code] : null;
    setNotice(entry === null ? t('errWayback') : entry(), 'error');
    updateWaybackButtons();
    return;
  }

  // Only written once the run has actually started: a handle or a size that was
  // refused is not a preference, it is a mistake.
  await applySettings({ waybackHandle: handle, waybackBatch: batch });
  state.wayback = response.wayback;
  setNotice(all ? t('okWaybackStartedAll') : t('okWaybackStarted', [String(batch)]), 'ok');
  startWaybackPoll();
  renderWaybackNote();
  revealWaybackPanel(false);
}

async function onWaybackCancel() {
  els.waybackCancel.disabled = true;
  try {
    await send({ type: 'XTB_WAYBACK_CANCEL' });
    setNotice(t('okWaybackCancelling'));
  } finally {
    els.waybackCancel.disabled = false;
  }
}

/* ---- the switch, and the one permission this extension asks for ---- */

/**
 * Turning it on asks first, and the asking happens BEFORE the permission
 * prompt — because Chrome's prompt says what is granted and never what it is
 * for, and "read and change your data on web.archive.org" is not an
 * explanation of anything.
 */
function openWaybackChoice() {
  // The switch is already ON by the time this is called, and deliberately so —
  // see onWaybackToggle. Turning it on here instead would be writing a wish:
  // Chrome's permission prompt takes the focus, an extension popup closes the
  // moment it loses focus, and everything after the request in confirmWayback
  // is code that may simply never run. What was written BEFORE the prompt is
  // the only part that is certain to have happened.
  els.waybackChoice.hidden = false;
  els.waybackConfirm.focus();
  void prefillWaybackHandle().then(renderWaybackNote);
}

function closeWaybackChoice() {
  els.waybackChoice.hidden = true;
  // Backing out is not a commitment, so the switch goes back off — unless the
  // permission is already there, in which case the only thing that happened is
  // that a disclosure was read twice.
  if (state.waybackPermission !== true) {
    void applySettings({ waybackEnabled: false });
    els.optWayback.checked = false;
    return;
  }
  els.optWayback.checked = state.settings.waybackEnabled === true;
}

async function confirmWayback() {
  els.waybackConfirm.disabled = true;
  try {
    // FIRST await in this handler, before anything else. chrome.permissions
    // .request is only honoured while the click's activation is still live, and
    // any await ahead of it spends that activation.
    //
    // And this is very likely the last line of this function that ever runs:
    // the prompt takes the focus, the popup closes on the spot, and the code
    // below is written for the case where it did not. Everything the answer
    // implies is already on disk — the switch was set by the toggle that opened
    // this panel — so a popup that dies here loses nothing. The next open reads
    // the permission back and reconciles in init().
    const granted = await requestWaybackPermission();

    if (granted !== true) {
      await applySettings({ waybackEnabled: false });
      els.optWayback.checked = false;
      els.waybackChoice.hidden = true;
      setNotice(t('errWaybackPermission'), 'error');
      return;
    }

    // Belt and braces: already true in practice, since the toggle wrote it.
    if (state.settings.waybackEnabled !== true) {
      await applySettings({ waybackEnabled: true });
    }
    state.waybackPermission = true;
    els.waybackChoice.hidden = true;
    // Before refreshState, not after: this is DOM only, and a throw inside the
    // state read must not be what stops the buttons from being found.
    revealWaybackPanel(true);
    setNotice(t('okWaybackOn'), 'ok');
    await refreshState();
  } finally {
    els.waybackConfirm.disabled = false;
  }
}

/**
 * The switch, and where the intent is written down.
 *
 * OFF is the easy half. ON writes the setting IMMEDIATELY, before the panel
 * that explains it and before the browser prompt that grants it — which is
 * backwards from how it reads, and is the whole point. Chrome's permission
 * prompt takes the focus away from the popup, and a popup closes the moment it
 * loses focus; so anything the confirm handler writes AFTER the prompt is code
 * that may never run. Written here, in a click handler of its own, the intent
 * is on disk before the prompt exists.
 *
 * The state this leaves in between — switch on, no permission yet — is not a
 * lie the code has to remember to undo. init() reads the permission back on
 * every open and turns the switch off if it is not there, the same way it
 * already does for the media cache.
 */
function onWaybackToggle() {
  if (els.optWayback.checked !== true) {
    void (async () => {
      await applySettings({ waybackEnabled: false });
      els.waybackChoice.hidden = true;
      setNotice(t('okWaybackOff'), 'ok');
      await refreshState();
    })();
    return;
  }
  void applySettings({ waybackEnabled: true });
  openWaybackChoice();
}

/**
 * Fill the handle box from the account this browser has seen, once.
 *
 * The Archive's index is keyed by handle and an account that was renamed has
 * its older posts filed under the old name — which only its owner knows, so the
 * box is theirs to fill. This is a starting point, not an answer.
 */
async function prefillWaybackHandle() {
  if (String(els.waybackHandle.value || '').trim() !== '') return;
  try {
    const profiles = await listProfiles(state.db);
    const newest = profiles && profiles.length > 0 ? profiles[0] : null;
    if (newest && typeof newest.screenName === 'string' && isHandle(newest.screenName)) {
      els.waybackHandle.value = newest.screenName;
    }
  } catch (_) { /* no card stored yet: the box stays empty and the note says so */ }
}

/* -------------------------------------------------------------------------- */
/* First-run choices                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The questions the panel asks, each bound to the settings key it writes.
 *
 * A table rather than a copy of the same three lines per box: a box added to
 * the markup but forgotten here — or wired to a key that settings.js does not
 * know — would be a behaviour the user can see and cannot set, and it would look
 * like a checkbox that simply does nothing.
 *
 * The archive import is the odd one out. The other four decide what gets KEPT
 * out of what the page already says; this one decides whether the extension
 * goes and asks somebody else, which is why it is the only one that hands over
 * to a second panel before anything is granted.
 */
const CHOICE_QUESTIONS = [
  { box: els.choiceMedia, key: 'mediaCache' },
  { box: els.choiceBackfill, key: 'backfillMedia' },
  { box: els.choiceReplies, key: 'captureReplies' },
  { box: els.choiceConnections, key: 'captureConnections' },
  { box: els.choiceThumbs, key: 'showRemoteThumbnails' },
  { box: els.choiceWayback, key: 'waybackEnabled' }
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
 * window it has to run in.
 *
 * WHICH IS WHY THE PATCH IS SENT BEFORE IT, WITHOUT BEING AWAITED. Chrome's
 * permission prompt takes the focus, a popup closes the moment it loses focus,
 * and this function does not survive that — it is not "slow", it is gone, and
 * nothing below the request will ever run. So the request cannot come first in
 * the *order of effects*; it can only come first among the awaits. send() hands
 * the message to the service worker synchronously, inside this same click, and
 * the service worker is a context that does not close when the popup does.
 *
 * The one thing that cannot go in that patch is mediaCache, because its value
 * is the permission's answer and there is no answer yet. It is written
 * afterwards, and if the popup died before that, it stays false — which is the
 * safe direction to fail in: a cache that is off is a cache that downloads
 * nothing, and the switch is a click away.
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

    // Sent, not awaited — see above. Every one of these needs no permission, so
    // every one of them can be settled before the prompt exists.
    const settling = applySettings({
      backfillMedia: wanted.backfillMedia,
      captureReplies: wanted.captureReplies,
      captureConnections: wanted.captureConnections,
      showRemoteThumbnails: wanted.showRemoteThumbnails,
      waybackEnabled: wanted.waybackEnabled,
      choicePanelAnswered: true
    });

    let mediaOn = state.settings.mediaCache === true && wanted.mediaCache === true;
    if (wanted.mediaCache === true && state.settings.mediaCache !== true) {
      mediaOn = await enableMediaCache();
      // The box shows intent; a refused grant must not leave it showing caching
      // that is not there.
      els.choiceMedia.checked = mediaOn === true;
    }

    const saved = await settling;
    // applySettings has already said what went wrong; the panel stays open so
    // the answers are not closed away along with the message.
    if (saved !== true) return;

    if (state.settings.mediaCache !== mediaOn) {
      await applySettings({ mediaCache: mediaOn });
    }

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

    // The archive import cannot be granted from here: its permission needs a
    // disclosure first, and a disclosure needs a button. So the panel settles
    // the switch and hands over to the panel that explains it — which is a
    // second click, and therefore a second user gesture, for the request.
    if (wanted.waybackEnabled === true && state.waybackPermission !== true) {
      openWaybackChoice();
    }
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
      // The term belongs to the view it was typed in. One shared term would
      // empty the other list the moment you switched, with nothing on screen to
      // say the filter had followed you.
      paging().query = els.search.value.trim();
      void reload();
    }, 250);
  });

  els.search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      els.search.value = '';
      paging().query = '';
      void reload();
    }
  });

  for (const name of ['tweets', 'following', 'followers']) {
    const button = name === 'tweets' ? els.viewTweets
      : (name === 'following' ? els.viewFollowing : els.viewFollowers);
    button.addEventListener('click', () => { void setView(name); });
  }

  els.export.addEventListener('click', () => {
    void exportAll();
  });

  els.media.addEventListener('click', () => {
    void exportArchive();
  });

  els.hosted.addEventListener('click', () => {
    void exportHostedToFolder();
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

  els.optCaptureConnections.addEventListener('change', () => {
    void (async () => {
      const on = els.optCaptureConnections.checked;
      const ok = await applySettings({ captureConnections: on });
      if (ok) setNotice(on ? t('okCaptureConnectionsOn') : t('okCaptureConnectionsOff'), 'ok');
      renderConnectionsNote();
    })();
  });

  // Only ever shows what is stored, so this is the way back to the panel for
  // anyone who answered it before understanding one of the costs.
  els.choiceShow.addEventListener('click', () => openChoicePanel());

  els.choiceConfirm.addEventListener('click', () => {
    void confirmChoices();
  });

  els.optWayback.addEventListener('change', onWaybackToggle);
  els.waybackConfirm.addEventListener('click', () => { void confirmWayback(); });
  els.waybackChoice.querySelector('#btn-wayback-dismiss')
    .addEventListener('click', closeWaybackChoice);
  els.waybackFill.addEventListener('click', () => { void startWayback('gaps'); });
  els.waybackVerify.addEventListener('click', () => { void startWayback('verify'); });
  els.waybackCancel.addEventListener('click', () => { void onWaybackCancel(); });
  els.waybackHandle.addEventListener('input', () => { renderWaybackNote(); updateWaybackButtons(); });
  els.waybackBatch.addEventListener('change', () => {
    els.waybackBatch.value = String(waybackBatchValue());
    renderWaybackNote();
  });
  els.optWaybackAll.addEventListener('change', () => {
    void (async () => {
      const ok = await applySettings({ waybackAll: els.optWaybackAll.checked });
      if (ok) {
        updateWaybackButtons();
        renderWaybackNote();
      }
    })();
  });
  // Opening the panel is the moment the handle is worth guessing: it costs a
  // database read, and there is no reason to spend one on every popup open for
  // a box nobody has looked at.
  els.waybackPanel.addEventListener('toggle', () => {
    if (els.waybackPanel.open === true) void prefillWaybackHandle().then(renderWaybackNote);
  });
  // A popup left open as a tab would otherwise keep asking the worker for a
  // status every second for as long as the tab lives.
  window.addEventListener('pagehide', stopWaybackPoll);

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

  // The switch's visibility is CSS's decision, but WHICH VIEW is up is state,
  // and the two can come apart: a phone's bottom sheet resized under the page,
  // a window dragged shorter — the switch disappears and the roster would be
  // stranded with no way back to the posts. So the layout is re-derived here and
  // the view is sent home when it stops being reachable.
  try {
    const layout = window.matchMedia(PAGE_LAYOUT_QUERY);
    const onLayoutChange = () => {
      if (!pageLayoutMatches() && isRosterView()) void setView('tweets');
    };
    if (typeof layout.addEventListener === 'function') layout.addEventListener('change', onLayoutChange);
  } catch (_) { /* the switch is hidden by CSS regardless, so this is belt only */ }

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
    // A popup (or tab) left open across an extension update opens the database
    // at the version ITS copy of db.js knows, and gets a VersionError whose raw
    // text — "The requested version (3) is less than the existing version (4)" —
    // explains nothing to anyone. The fix is one reload, so say that instead.
    if (err && err.name === 'VersionError') {
      setNotice(t('errPageOutdated', [describe(err)]), 'error');
    } else {
      setNotice(t('errOpenDb', [describe(err)]), 'error');
    }
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
      // The same sentence as a refusal from the switch, and deliberately: this
      // path is now reached by BOTH — a revoke from chrome://extensions, and a
      // declined prompt whose popup closed before the answer could be read.
      // From here they are the same fact: the permission is not there.
      setNotice(t('errMediaPermission'), 'error');
    }
  }

  // The same reconciliation for the archive import, and it is load-bearing here
  // in a way it is not for the media cache: that switch is deliberately written
  // BEFORE the browser asks, because the prompt takes the focus and the popup
  // closes — so "on with no permission yet" is a state this flow creates on
  // purpose, and this is the one place it gets read back. Granted turns it into
  // a working switch with nothing said; refused turns it off and says why.
  if (state.settings.waybackEnabled === true && state.waybackPermission !== true) {
    const sync = await send({ type: 'XTB_SYNC_WAYBACK_PERMISSION' });
    if (sync && sync.ok === true && sync.waybackPermission !== true) {
      state.settings = Object.assign({}, DEFAULT_SETTINGS, sync.settings || {});
      els.optWayback.checked = false;
      setNotice(t('errWaybackPermission'), 'error');
    }
  }

  /* On, and permitted. The controls belong somewhere the user can see them.
   *
   * This is the branch a popup that died on the permission prompt comes back
   * through — the grant is already on disk and refreshState has just read it
   * back, so nothing above fires — and it is the only chance to say where the
   * buttons are. It deliberately says nothing: the drawers opening is the
   * whole message, and a sentence about it would be one more line to read on
   * the way to the thing it is describing.
   *
   * Once a run exists the drawers stay as the user left them; the note under
   * the switch is telling that story by then. */
  if (state.settings.waybackEnabled === true && state.waybackPermission === true) {
    revealWaybackPanel(waybackUntouched());
  }

  renderViewTabs();
  await reload();

  /* The first-run panel, asked once — and asked in a TAB.

     Not a stylistic choice. Two of the five questions need a browser
     permission, and Chrome's permission prompt takes the focus, and an
     extension popup closes the instant it loses focus. In the popup the first
     prompt ends the whole flow: the second question is never asked, and the
     answer to the first is never read back, so the setting the user just chose
     is still off when they look again. A tab has none of that — nothing closes,
     both prompts run in sequence, and both answers are observed and stored.

     So the popup says where to go rather than showing a panel it cannot finish.
     The button that opens the tab is already in the footer; this only points at
     it. The panel is opened from the same state read the settings toggles use,
     so its boxes start on the values really in force rather than on the
     defaults.

     LAST, and it has to be last: reload() clears the notice on its way in, so
     a line written before it is wiped a moment later and the popup ends up
     saying nothing at all. (Found by the popup harness — the only thing in this
     project that runs this file.) Opening the panel after the list is built
     costs one frame of the list underneath an overlay that covers it, which is
     the reason moving it is safe.

     Either way it is an overlay, not a gate. Posts, edits and deletions have
     been captured since the moment the extension was installed — nothing above
     this line, and nothing in settings.js, waits on the answer. The list loads
     on exactly the same schedule whether the panel is up or has been answered
     for months. */
  if (state.settings.choicePanelAnswered !== true) {
    // isToolbarPopup, not pageLayoutMatches. The question here is "will a
    // permission prompt kill me", and the answer is "only if I am the toolbar
    // popup" — which is capped at 800x600, so a short wide TAB is fine and
    // pageLayoutMatches would have wrongly turned it away. The other reading
    // (the roster switch's) is about which layout CSS is drawing, and that is
    // a different question with a different answer.
    if (isToolbarPopup()) setNotice(t('choiceNeedsTab'));
    else openChoicePanel();
  }
}

void init();
