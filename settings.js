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
    mediaFailed: 0
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
    'posted', 'postFailed'
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
