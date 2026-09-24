/* ============================================================================
 * settings.js  —  chrome.storage.local backed settings + diagnostics counters.
 *
 * Shared by background.js (writer) and popup.js (reader/editor).
 * No credentials are ever stored here: only booleans, numbers and short
 * diagnostic strings produced by our own code.
 * ========================================================================== */

export const SETTINGS_KEY = 'xtbSettings';
export const STATS_KEY = 'xtbStats';

export const DEFAULT_SETTINGS = {
  /** Verbose console output in the page and the service worker. Default off. */
  debug: false,
  /** Download media blobs into the extension's own IndexedDB (needs a permission grant). */
  mediaCache: false,
  /** Show remote twimg thumbnails in the popup when no cached blob exists. */
  showRemoteThumbnails: true,
  /**
   * Whether a profile-timeline sweep should also download the media for the
   * posts it recovers.
   *
   * Separate from `mediaCache` on purpose. `mediaCache` is a standing decision
   * about how this archive works; a sweep is a single action that can recover
   * hundreds of posts at once. Scrolling through a whole profile with the
   * master switch on would otherwise start a multi-gigabyte download nobody
   * asked for at that moment. On by default, because recovering a post without
   * its picture is only half the post — but it stays switchable.
   */
  backfillMedia: true,
  /**
   * Whether the profile's Replies tab is read as well as the Posts tab.
   *
   * Off by default. Turning it on can add a large number of rows in one go —
   * nearly every entry in that response is a conversation holding both sides of
   * an exchange — and that is a decision the archive's owner should make
   * deliberately rather than discover afterwards.
   */
  captureReplies: false,
  /**
   * Whether the follow / follower roster is recorded.
   *
   * Off by default, and different in kind from every switch above it: they
   * decide how much of YOUR writing to keep, this one decides whether to keep a
   * list of other people. It is also the only line whose safety rests on a check
   * that can fail quietly — the roster is stored only when the request says the
   * list belongs to one of your own accounts — so it stays opt-in rather than
   * switching itself on the moment the feature exists.
   */
  captureConnections: false,
  /**
   * Whether the first-run choice panel has been answered.
   *
   * The four behaviours above are the reason the panel exists: each one changes
   * what gets stored and what it costs, and none of them had a moment where the
   * archive's owner agreed to it. This flag is only that moment — it is NOT a
   * gate. Capturing posts, edits and deletions reads none of it, so the core of
   * the extension works from the first second after install whether this is
   * true, false or missing entirely.
   *
   * It lives in the settings store rather than its own key because it is read
   * at the same instant as the settings it is about: the popup has to know
   * whether to ask before it can know what to pre-set the boxes to, and two
   * reads could disagree. A later version that re-asks (a new behaviour worth
   * deciding) can ignore the stored `true` rather than needing a second key.
   *
   * False by default, so a fresh install is asked exactly once — and the panel
   * stays reachable from the settings section afterwards, so answering it is
   * never a one-way door.
   */
  choicePanelAnswered: false,
  /** Records per page in the popup list. */
  pageSize: 30
};

export const DEFAULT_STATS = {
  /** Lifetime counters owned by the service worker. */
  lifetime: {
    received: 0,
    upsertOk: 0,
    upsertFailed: 0,
    rejected: 0,
    // A deletion marks an existing row. The two outcomes are counted apart
    // because "deleted something that was never archived" is normal (it was
    // written before the extension existed) while "could not write the mark" is
    // a real failure, and a single counter could not tell them apart.
    deletedMarked: 0,
    deletedUnmatched: 0,
    /** Records removed by a bulk category cleanup. */
    purged: 0,
    mediaCached: 0,
    mediaFailed: 0,
    /**
     * Media downloads that were never even queued because the queue was full.
     * Counted apart from mediaFailed because the two look identical in the
     * archive — a post with no cached file — while the causes are completely
     * different: one request failed, the other was never made.
     */
    mediaDropped: 0,
    /** Rows recovered from a profile timeline sweep — posts made elsewhere. */
    backfilled: 0,
    /** Swept rows whose id was already archived, so deliberately left untouched. */
    backfillSkipped: 0,
    /**
     * Archived records that gained their link targets from a post's own page.
     * A swept record often has an empty `entities.urls`, which loses the only
     * record of where its t.co links pointed; this counts how many were filled.
     */
    linksFilled: 0,
    /**
     * Link fills that found no record to fill — a tweet this machine never
     * archived. Counted apart from linksFilled because "there was nothing here"
     * and "the write did nothing" look identical in the archive, and the second
     * one would be a real failure.
     */
    linksUnmatched: 0,
    /**
     * Roster rows written for the first time, and rows that were already there.
     *
     * Apart because those are the only two things a sighting can mean, and one
     * counter could not say whether a sweep was still finding anybody new — a
     * roster that has stopped growing looks exactly like one that is being
     * written to constantly.
     */
    connectionsAdded: 0,
    connectionsRefreshed: 0
  },
  /** Latest snapshot reported by the page realm (per page load, not lifetime). */
  page: {
    sessionId: null,
    hookInstalled: false,
    xhrHookInstalled: false,
    hookOverwritten: false,
    createTweetSeen: 0,
    deleteSeen: 0,
    deleted: 0,
    /** Profile timeline responses seen on this page. */
    timelineSeen: 0,
    /** Tweets in those responses that belonged to this account and were kept. */
    timelineKept: 0,
    /** Post-detail responses read on this page (opening one of your own posts). */
    detailSeen: 0,
    /** Link target lists sent from them for posts that are this account's own. */
    detailKept: 0,
    /** Following / Followers responses seen on this page. */
    connectionsSeen: 0,
    /** People in them that were sent on to be stored. */
    connectionsKept: 0,
    /**
     * Responses dropped because the request was not for one of this account's
     * own lists.
     *
     * Its own counter rather than folded into a generic "dropped", because it is
     * the normal outcome while browsing somebody else and because a rising
     * seen-with-no-owner alongside a flat kept is exactly what "this browser has
     * not learned which account is yours yet" looks like. That is the one state
     * of this feature a person can be in without any error appearing anywhere.
     */
    connectionsNoOwner: 0,
    requestBodyRead: 0,
    requestBodyFailed: 0,
    responseCloneFailed: 0,
    responseJsonFailed: 0,
    parseFailed: 0,
    parsed: 0,
    posted: 0,
    postFailed: 0,
    lastError: null,
    lastErrorAt: null,
    reportedAt: null
  },
  /** Service-worker side error surface. */
  lastError: null,
  lastErrorAt: null,
  lastCaptureAt: null
};

function storageArea() {
  try {
    if (chrome && chrome.storage && chrome.storage.local) return chrome.storage.local;
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * chrome.storage read-modify-write is not atomic. Two tweets posted in quick
 * succession would otherwise interleave and lose a counter bump, so every
 * mutation goes through this chain.
 */
let mutationChain = Promise.resolve();

function serialize(task) {
  const run = mutationChain.then(task, task);
  mutationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return null;
  }
}

export async function getSettings() {
  const area = storageArea();
  if (area === null) return Object.assign({}, DEFAULT_SETTINGS);
  try {
    const result = await area.get({ [SETTINGS_KEY]: null });
    const stored = result ? result[SETTINGS_KEY] : null;
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
    // Unknown keys cannot be injected through storage; only known keys survive.
    const merged = Object.assign({}, DEFAULT_SETTINGS);
    if (typeof stored.debug === 'boolean') merged.debug = stored.debug;
    if (typeof stored.mediaCache === 'boolean') merged.mediaCache = stored.mediaCache;
    if (typeof stored.showRemoteThumbnails === 'boolean') merged.showRemoteThumbnails = stored.showRemoteThumbnails;
    if (typeof stored.backfillMedia === 'boolean') merged.backfillMedia = stored.backfillMedia;
    if (typeof stored.captureReplies === 'boolean') merged.captureReplies = stored.captureReplies;
    if (typeof stored.captureConnections === 'boolean') merged.captureConnections = stored.captureConnections;
    if (typeof stored.choicePanelAnswered === 'boolean') merged.choicePanelAnswered = stored.choicePanelAnswered;
    // A stored `captureRetweets` from an older version is simply ignored — the
    // key is gone, and carrying it forward would suggest a setting that no
    // longer does anything.
    if (Number.isInteger(stored.pageSize) && stored.pageSize >= 10 && stored.pageSize <= 200) {
      merged.pageSize = stored.pageSize;
    }
    return merged;
  } catch (_) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

export function saveSettings(patch) {
  return serialize(() => saveSettingsInternal(patch));
}

async function saveSettingsInternal(patch) {
  const area = storageArea();
  const current = await getSettings();
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    if (typeof patch.debug === 'boolean') current.debug = patch.debug;
    if (typeof patch.mediaCache === 'boolean') current.mediaCache = patch.mediaCache;
    if (typeof patch.showRemoteThumbnails === 'boolean') current.showRemoteThumbnails = patch.showRemoteThumbnails;
    if (typeof patch.backfillMedia === 'boolean') current.backfillMedia = patch.backfillMedia;
    if (typeof patch.captureReplies === 'boolean') current.captureReplies = patch.captureReplies;
    if (typeof patch.captureConnections === 'boolean') current.captureConnections = patch.captureConnections;
    if (typeof patch.choicePanelAnswered === 'boolean') current.choicePanelAnswered = patch.choicePanelAnswered;
    if (Number.isInteger(patch.pageSize) && patch.pageSize >= 10 && patch.pageSize <= 200) {
      current.pageSize = patch.pageSize;
    }
  } else {
    return current;
  }
  if (area !== null) {
    try {
      await area.set({ [SETTINGS_KEY]: current });
    } catch (_) { /* quota or context error: settings stay in-memory this session */ }
  }
  return current;
}

/* -------------------------------------------------------------------------- */
/* Whose posts are "mine"                                                     */
/* -------------------------------------------------------------------------- */

export const OWN_AUTHORS_KEY = 'xtbOwnAuthors';

/** A cap, not an expectation: one person rarely has more than a couple of accounts. */
const MAX_OWN_AUTHORS = 20;

function validAuthorId(value) {
  return typeof value === 'string' && /^[0-9]{1,25}$/.test(value);
}

/**
 * The account ids whose posts this archive is allowed to keep.
 *
 * This is what makes the timeline sweep safe to run at all. Opening your own
 * profile makes X fetch a timeline; opening *someone else's* profile makes it
 * fetch theirs, through the same operation. Without a list of your own ids the
 * sweep could not tell the two apart, and the archive would quietly start
 * hoovering up other people's posts — a different product, and not one anybody
 * asked for.
 *
 * Ids are learned from the CreateTweet responses the extension already
 * processes (the author id is in every one), then persisted here. A brand-new
 * install therefore learns its first id from the first post made in the
 * browser, and the sweep stays inert until then.
 */
export async function getOwnAuthors() {
  const area = storageArea();
  if (area === null) return [];
  try {
    const result = await area.get({ [OWN_AUTHORS_KEY]: null });
    const stored = result ? result[OWN_AUTHORS_KEY] : null;
    if (!Array.isArray(stored)) return [];
    return stored.filter(validAuthorId).slice(0, MAX_OWN_AUTHORS);
  } catch (_) {
    return [];
  }
}

export function rememberOwnAuthors(ids) {
  return serialize(() => rememberOwnAuthorsInternal(ids));
}

async function rememberOwnAuthorsInternal(ids) {
  const existing = await getOwnAuthors();
  const merged = existing.slice();
  if (Array.isArray(ids)) {
    for (const id of ids) {
      if (validAuthorId(id) && merged.indexOf(id) === -1) merged.push(id);
    }
  }
  if (merged.length === existing.length) return existing; /* nothing new: no write */
  const capped = merged.slice(-MAX_OWN_AUTHORS);
  const area = storageArea();
  if (area !== null) {
    try {
      await area.set({ [OWN_AUTHORS_KEY]: capped });
    } catch (_) { /* quota or context error: it will be relearned from the next post */ }
  }
  return capped;
}

export async function getStats() {
  const area = storageArea();
  if (area === null) return clone(DEFAULT_STATS);
  try {
    const result = await area.get({ [STATS_KEY]: null });
    const stored = result ? result[STATS_KEY] : null;
    const base = clone(DEFAULT_STATS);
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return base;

    if (stored.lifetime && typeof stored.lifetime === 'object') {
      for (const key of Object.keys(base.lifetime)) {
        if (typeof stored.lifetime[key] === 'number' && Number.isFinite(stored.lifetime[key])) {
          base.lifetime[key] = stored.lifetime[key];
        }
      }
    }
    if (stored.page && typeof stored.page === 'object') {
      for (const key of Object.keys(base.page)) {
        const value = stored.page[key];
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          base.page[key] = value;
        }
      }
    }
    if (typeof stored.lastError === 'string') base.lastError = stored.lastError;
    if (typeof stored.lastErrorAt === 'string') base.lastErrorAt = stored.lastErrorAt;
    if (typeof stored.lastCaptureAt === 'string') base.lastCaptureAt = stored.lastCaptureAt;
    return base;
  } catch (_) {
    return clone(DEFAULT_STATS);
  }
}

export async function saveStats(stats) {
  const area = storageArea();
  if (area === null) return;
  try {
    await area.set({ [STATS_KEY]: stats });
  } catch (_) { /* ignore */ }
}

export function resetStats() {
  return serialize(async () => {
    const fresh = clone(DEFAULT_STATS);
    await saveStats(fresh);
    return fresh;
  });
}

/** Merge one lifetime counter bump into persisted stats. */
export function bumpLifetime(bumps, error) {
  return serialize(() => bumpLifetimeInternal(bumps, error));
}

async function bumpLifetimeInternal(bumps, error) {
  const stats = await getStats();
  if (bumps && typeof bumps === 'object') {
    for (const key of Object.keys(bumps)) {
      if (Object.prototype.hasOwnProperty.call(stats.lifetime, key) && typeof bumps[key] === 'number') {
        stats.lifetime[key] += bumps[key];
      }
    }
  }
  if (typeof error === 'string' && error.length > 0) {
    stats.lastError = error.slice(0, 300);
    stats.lastErrorAt = new Date().toISOString();
  }
  await saveStats(stats);
  return stats;
}

/** Replace the page-realm snapshot (never added, so retries cannot double count). */
export function mergePageDiag(diag) {
  return serialize(() => mergePageDiagInternal(diag));
}

async function mergePageDiagInternal(diag) {
  if (!diag || typeof diag !== 'object') return getStats();
  const stats = await getStats();
  const target = stats.page;
  const numericKeys = [
    'createTweetSeen', 'deleteSeen', 'deleted', 'requestBodyRead', 'requestBodyFailed',
    'responseCloneFailed', 'responseJsonFailed', 'parseFailed', 'parsed',
    'posted', 'postFailed', 'timelineSeen', 'timelineKept', 'detailSeen', 'detailKept',
    'connectionsSeen', 'connectionsKept', 'connectionsNoOwner'
  ];
  // A new document means a new session token: start the page counters over so
  // the popup never shows a stale maximum from a previous tab or reload.
  const sessionId = typeof diag.sessionId === 'string' && diag.sessionId.length > 0 ? diag.sessionId : null;
  if (sessionId !== null && sessionId !== target.sessionId) {
    target.sessionId = sessionId;
    for (const key of numericKeys) target[key] = 0;
    target.hookOverwritten = false;
    target.lastError = null;
    target.lastErrorAt = null;
  }

  for (const key of numericKeys) {
    const value = diag[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      // Within one page load the counters only grow: keep the max so an
      // out-of-order or duplicated message cannot rewind the display.
      target[key] = Math.max(target[key], value);
    }
  }
  if (typeof diag.hookInstalled === 'boolean') target.hookInstalled = diag.hookInstalled;
  if (typeof diag.xhrHookInstalled === 'boolean') target.xhrHookInstalled = diag.xhrHookInstalled;
  if (typeof diag.hookOverwritten === 'boolean' && diag.hookOverwritten) target.hookOverwritten = true;
  if (typeof diag.lastError === 'string') target.lastError = diag.lastError.slice(0, 300);
  if (typeof diag.lastErrorAt === 'string') target.lastErrorAt = diag.lastErrorAt;
  if (typeof diag.reportedAt === 'string') target.reportedAt = diag.reportedAt;

  if (typeof diag.lastError === 'string' && diag.lastError.length > 0) {
    stats.lastError = diag.lastError.slice(0, 300);
    stats.lastErrorAt = typeof diag.lastErrorAt === 'string' ? diag.lastErrorAt : new Date().toISOString();
  }

  await saveStats(stats);
  return stats;
}

export function noteCaptureTime(iso) {
  return serialize(async () => {
    const stats = await getStats();
    stats.lastCaptureAt = iso;
    await saveStats(stats);
    return stats;
  });
}
