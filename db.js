/* ============================================================================
 * db.js  —  IndexedDB access layer.
 *
 * This module is imported by background.js (service worker, "type": "module")
 * and by popup.js (module script). Both run on the EXTENSION's origin, so both
 * see exactly the same database. content.js deliberately does NOT import this:
 * a content script lives on the x.com origin and its IndexedDB would be the
 * page's, not ours.
 * ========================================================================== */

export const DB_NAME = 'xTweetBackup';
// Bumped only when the OBJECT STORES or INDEXES change; additive record fields
// do not need a migration.
//   v2 added the `deletions` store (see below).
export const DB_VERSION = 2;
// Version of the RECORD/export shape. v2 added `lang` and `entities`
// (link expansions, hashtags, mentions). Records captured under v1 simply have
// no such fields — the shape is additive, so readers must tolerate their
// absence rather than assume them.
export const SCHEMA_VERSION = 2;

export const STORE_TWEETS = 'tweets';
export const STORE_MEDIA = 'media';
/**
 * Observed deletion events: { id, deletedAt } and nothing else.
 *
 * Kept apart from `tweets` on purpose. A deletion has to be recordable even
 * when the tweet itself was never archived here — that happens whenever the
 * post came from another machine — and inventing a content-free row in the
 * tweet list to hold it would put an entry in the archive that has no text, no
 * author and no media.
 *
 * The tweet list stays clean; the merge tool reads this array and applies each
 * deletion to whichever machine did archive the tweet.
 */
export const STORE_DELETIONS = 'deletions';

export const INDEX_CAPTURED_AT = 'capturedAt';
export const INDEX_CREATED_AT = 'createdAt';
export const INDEX_AUTHOR = 'authorScreenName';
export const INDEX_MEDIA_TWEET = 'tweetId';

let dbPromise = null;

/* -------------------------------------------------------------------------- */
/* Open / migrate                                                             */
/* -------------------------------------------------------------------------- */

export function openDB() {
  if (dbPromise !== null) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      // v0 -> v1: initial schema.
      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains(STORE_TWEETS)) {
          const tweets = db.createObjectStore(STORE_TWEETS, { keyPath: 'id' });
          tweets.createIndex(INDEX_CAPTURED_AT, 'capturedAt', { unique: false });
          tweets.createIndex(INDEX_CREATED_AT, 'createdAt', { unique: false });
          tweets.createIndex(INDEX_AUTHOR, 'author.screenName', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_MEDIA)) {
          const media = db.createObjectStore(STORE_MEDIA, { keyPath: 'key' });
          media.createIndex(INDEX_MEDIA_TWEET, 'tweetId', { unique: false });
        }
      }

      // v1 -> v2: deletion events get their own store. Nothing existing is
      // touched, so an upgrade cannot lose a record.
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains(STORE_DELETIONS)) {
          db.createObjectStore(STORE_DELETIONS, { keyPath: 'id' });
        }
      }

      // Future migrations go here as `if (oldVersion < 3) { ... }`.
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch (_) { /* ignore */ }
      };
      resolve(db);
    };

    request.onerror = () => {
      reject(request.error || new Error('IndexedDB open failed'));
    };

    request.onblocked = () => {
      // Another tab/popup holds an old version open. The promise stays pending
      // on purpose; the caller-side timeout decides what to do.
    };
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });

  return dbPromise;
}

export function closeDB() {
  if (dbPromise === null) return Promise.resolve();
  const pending = dbPromise;
  dbPromise = null;
  return pending.then(
    (db) => {
      try {
        db.close();
      } catch (_) { /* ignore */ }
    },
    () => { /* ignore */ }
  );
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Insert or update one tweet. The tweet id is the primary key, so re-capturing
 * the same tweet updates the existing row instead of duplicating it. The
 * original capturedAt is preserved so list ordering stays stable.
 *
 * Resolves with { existed, record }.
 */
export function upsertTweet(db, record) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_TWEETS, 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }

    const store = tx.objectStore(STORE_TWEETS);
    let existed = false;
    let merged = record;
    let failure = null;

    const done = transactionDone(tx);
    done.then(
      () => {
        if (failure !== null) reject(failure);
        else resolve({ existed: existed, record: merged });
      },
      (err) => {
        if (failure !== null) reject(failure);
        else reject(err);
      }
    );

    try {
      const getRequest = store.get(record.id);
      getRequest.onsuccess = () => {
        const previous = getRequest.result;
        if (previous && typeof previous === 'object') {
          existed = true;
          merged = Object.assign({}, record, {
            capturedAt: previous.capturedAt || record.capturedAt,
            firstCapturedAt: previous.firstCapturedAt || previous.capturedAt || record.capturedAt,
            updatedAt: record.capturedAt
          });
        }
        try {
          store.put(merged);
        } catch (err) {
          failure = err;
          try {
            tx.abort();
          } catch (_) { /* ignore */ }
        }
      };
    } catch (err) {
      failure = err;
      try {
        tx.abort();
      } catch (_) { /* ignore */ }
    }
  });
}

/**
 * An edit is published as a NEW tweet, so the previous version stays in the
 * archive as its own row. Writing the forward pointer here — rather than
 * deriving it in the UI — is what lets a card say "已有新版本" without scanning
 * the whole database once per card.
 *
 * A previous version that was never archived (the user edited a tweet written
 * before the extension was installed) is simply left alone.
 */
export function markSuperseded(db, previousId, newId) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_TWEETS, 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }

    const done = transactionDone(tx);
    let failure = null;
    done.then(
      () => { if (failure !== null) reject(failure); else resolve(); },
      (err) => reject(failure !== null ? failure : err)
    );

    try {
      const store = tx.objectStore(STORE_TWEETS);
      const request = store.get(previousId);
      request.onsuccess = () => {
        const previous = request.result;
        if (!previous || typeof previous !== 'object') return;
        try {
          store.put(Object.assign({}, previous, {
            supersededBy: newId,
            updatedAt: new Date().toISOString()
          }));
        } catch (err) {
          failure = err;
          try { tx.abort(); } catch (_) { /* ignore */ }
        }
      };
    } catch (err) {
      failure = err;
      try { tx.abort(); } catch (_) { /* ignore */ }
    }
  });
}

/**
 * Record that a tweet was deleted on X. Written for EVERY observed deletion,
 * whether or not this machine archived the tweet — that is the whole point,
 * since the machine that saw the deletion is often not the machine that
 * published it.
 *
 * The first deletion time wins; a tweet can only be deleted once.
 */
export function recordDeletion(db, id, deletedAt) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_DELETIONS, 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }

    const done = transactionDone(tx);
    let failure = null;
    done.then(
      () => { if (failure !== null) reject(failure); else resolve(); },
      (err) => reject(failure !== null ? failure : err)
    );

    try {
      const store = tx.objectStore(STORE_DELETIONS);
      const request = store.get(id);
      request.onsuccess = () => {
        const existing = request.result;
        if (existing && typeof existing === 'object' &&
            typeof existing.deletedAt === 'string' && existing.deletedAt.length > 0) {
          return; // already known
        }
        try {
          store.put({ id: id, deletedAt: deletedAt });
        } catch (err) {
          failure = err;
          try { tx.abort(); } catch (_) { /* ignore */ }
        }
      };
    } catch (err) {
      failure = err;
      try { tx.abort(); } catch (_) { /* ignore */ }
    }
  });
}

/** Every recorded deletion, oldest first, for the export. */
export function listDeletions(db) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_DELETIONS, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const request = tx.objectStore(STORE_DELETIONS).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      out.push(cursor.value);
      cursor.continue();
    };
    transactionDone(tx).then(() => {
      out.sort((a, b) => String(a.deletedAt).localeCompare(String(b.deletedAt)));
      resolve(out);
    }, reject);
  });
}

/**
 * Mark an archived tweet as deleted on X.
 *
 * The record is NOT removed. An archive that silently drops what you published
 * and then deleted would be worthless for the one question it exists to answer
 * — "what did I put out there?" — so the row stays and records the removal.
 *
 * A tweet that was never archived (published before the extension was
 * installed, or deleted from another client) has nothing to mark and is left
 * alone. Resolves with true when a row was actually updated.
 */
export function markDeleted(db, id, deletedAt) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_TWEETS, 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }

    const done = transactionDone(tx);
    let failure = null;
    let marked = false;
    done.then(
      () => { if (failure !== null) reject(failure); else resolve(marked); },
      (err) => reject(failure !== null ? failure : err)
    );

    try {
      const store = tx.objectStore(STORE_TWEETS);
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result;
        if (!record || typeof record !== 'object') return;
        // The first deletion time wins: it is the one that actually happened.
        if (typeof record.deletedAt === 'string' && record.deletedAt.length > 0) {
          marked = true;
          return;
        }
        try {
          store.put(Object.assign({}, record, {
            deletedAt: deletedAt,
            updatedAt: new Date().toISOString()
          }));
          marked = true;
        } catch (err) {
          failure = err;
          try { tx.abort(); } catch (_) { /* ignore */ }
        }
      };
    } catch (err) {
      failure = err;
      try { tx.abort(); } catch (_) { /* ignore */ }
    }
  });
}

/**
 * Remove one backup completely.
 *
 * Everything the archive knows about that id goes: the record, its cached
 * media, and any deletion event. Removing only the record would leave a
 * tombstone behind that would silently re-mark the tweet as deleted on the
 * next merge — after the user had deliberately removed it.
 */
export function deleteTweet(db, id) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction([STORE_TWEETS, STORE_MEDIA, STORE_DELETIONS], 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }

    const done = transactionDone(tx);
    done.then(resolve, reject);

    try {
      tx.objectStore(STORE_TWEETS).delete(id);
      tx.objectStore(STORE_DELETIONS).delete(id);
      const mediaIndex = tx.objectStore(STORE_MEDIA).index(INDEX_MEDIA_TWEET);
      const cursorRequest = mediaIndex.openKeyCursor(IDBKeyRange.only(id));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        try {
          tx.objectStore(STORE_MEDIA).delete(cursor.primaryKey);
        } catch (_) { /* ignore */ }
        cursor.continue();
      };
    } catch (err) {
      try {
        tx.abort();
      } catch (_) { /* ignore */ }
      reject(err);
    }
  });
}

export function clearAll(db) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction([STORE_TWEETS, STORE_MEDIA], 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }
    const done = transactionDone(tx);
    done.then(resolve, reject);
    try {
      tx.objectStore(STORE_TWEETS).clear();
      tx.objectStore(STORE_MEDIA).clear();
      tx.objectStore(STORE_DELETIONS).clear();
    } catch (err) {
      try {
        tx.abort();
      } catch (_) { /* ignore */ }
      reject(err);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export function countTweets(db) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_TWEETS, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    requestToPromise(tx.objectStore(STORE_TWEETS).count()).then(resolve, reject);
  });
}

export function countMedia(db) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_MEDIA, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    requestToPromise(tx.objectStore(STORE_MEDIA).count()).then(resolve, reject);
  });
}

export function getTweet(db, id) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_TWEETS, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    requestToPromise(tx.objectStore(STORE_TWEETS).get(id)).then(resolve, reject);
  });
}

function recordMatches(record, term) {
  if (!record || typeof record !== 'object') return false;
  const text = typeof record.text === 'string' ? record.text : '';
  if (text.toLowerCase().indexOf(term) !== -1) return true;
  if (typeof record.id === 'string' && record.id.indexOf(term) !== -1) return true;
  const author = record.author;
  if (author && typeof author === 'object') {
    if (typeof author.screenName === 'string' && author.screenName.toLowerCase().indexOf(term) !== -1) return true;
    if (typeof author.name === 'string' && author.name.toLowerCase().indexOf(term) !== -1) return true;
  }
  return false;
}

/**
 * Paged, newest-first listing with local keyword search.
 *
 * Search runs over an IndexedDB cursor, never over the network. A single call
 * scans at most `scanBudget` records so a huge database cannot freeze the
 * popup; if the budget runs out before the page is full, the caller gets
 * hasMore: true plus a resume key and simply asks for the next batch.
 *
 * Pagination uses an exclusive upper bound on the capturedAt index. Two tweets
 * captured within the same millisecond could theoretically be skipped; a human
 * publishing tweets cannot realistically hit that.
 */
export function queryTweets(db, options) {
  const opts = options || {};
  const term = typeof opts.query === 'string' ? opts.query.trim().toLowerCase() : '';
  const pageSize = Number.isInteger(opts.pageSize) && opts.pageSize > 0 ? opts.pageSize : 30;
  const scanBudget = Number.isInteger(opts.scanBudget) && opts.scanBudget > 0 ? opts.scanBudget : 20000;
  const afterKey = typeof opts.afterKey === 'string' && opts.afterKey.length > 0 ? opts.afterKey : null;

  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_TWEETS, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }

    const store = tx.objectStore(STORE_TWEETS);
    const index = store.index(INDEX_CAPTURED_AT);

    let range = null;
    if (afterKey !== null) {
      try {
        range = IDBKeyRange.upperBound(afterKey, true);
      } catch (_) {
        range = null;
      }
    }

    const items = [];
    let scanned = 0;
    let stopReason = 'exhausted';
    let lastCollectedKey = null;
    let lastScannedKey = null;
    let cursorFailed = null;

    const request = index.openCursor(range, 'prev');

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        stopReason = 'exhausted';
        return;
      }

      const record = cursor.value;
      lastScannedKey = cursor.key;
      scanned++;

      if (recordMatches(record, term)) {
        items.push(record);
        lastCollectedKey = cursor.key;
        if (items.length >= pageSize) {
          stopReason = 'page-full';
          return; // stop iterating; transaction completes
        }
      }

      if (scanned >= scanBudget) {
        stopReason = 'scan-budget';
        return;
      }

      try {
        cursor.continue();
      } catch (err) {
        cursorFailed = err;
      }
    };

    request.onerror = () => {
      cursorFailed = request.error || new Error('cursor failed');
    };

    transactionDone(tx).then(
      () => {
        if (cursorFailed !== null) {
          reject(cursorFailed);
          return;
        }
        const hasMore = stopReason !== 'exhausted';
        let nextKey = null;
        if (hasMore) {
          nextKey = stopReason === 'page-full' ? lastCollectedKey : lastScannedKey;
          if (nextKey === null) nextKey = afterKey;
        }
        resolve({
          items: items,
          hasMore: hasMore,
          nextKey: nextKey,
          scanned: scanned,
          exhaustedScan: stopReason === 'scan-budget'
        });
      },
      (err) => reject(cursorFailed || err)
    );
  });
}

/**
 * Stream every tweet, newest first, in batches. Yields to the event loop
 * between batches so the popup stays responsive and so a large export does not
 * build one enormous array of objects.
 */
export async function forEachTweet(db, onRecord, options) {
  const opts = options || {};
  const batchSize = Number.isInteger(opts.batchSize) && opts.batchSize > 0 ? opts.batchSize : 500;

  let afterKey = null;
  for (;;) {
    const page = await queryTweets(db, {
      query: '',
      pageSize: batchSize,
      afterKey: afterKey,
      scanBudget: batchSize + 1
    });

    for (let i = 0; i < page.items.length; i++) {
      onRecord(page.items[i]);
    }

    if (!page.hasMore) return;
    if (page.nextKey === null || page.nextKey === afterKey) return;
    afterKey = page.nextKey;

    // Yield: keeps the popup's UI thread breathing during big exports.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/* -------------------------------------------------------------------------- */
/* Bulk cleanup of whole categories                                           */
/* -------------------------------------------------------------------------- */

/**
 * Two categories a user may reasonably not want to keep:
 *
 *   'superseded' — an older version of a post that has since been edited. The
 *                  current version is archived separately, so this is a
 *                  duplicate of something you still have.
 *   'deleted'    — a post you published and later deleted on X.
 *
 * The definitions live here rather than being passed in as a predicate,
 * because a function cannot cross the extension message boundary. The popup
 * and the service worker must agree on exactly what each category means, and
 * one shared definition is how that is guaranteed.
 */
export const PURGE_FILTERS = ['superseded', 'deleted'];

export function matchesPurgeFilter(record, filter) {
  if (!record || typeof record !== 'object') return false;
  if (filter === 'superseded') {
    return typeof record.supersededBy === 'string' && record.supersededBy.length > 0;
  }
  if (filter === 'deleted') {
    return typeof record.deletedAt === 'string' && record.deletedAt.length > 0;
  }
  return false;
}

/** How many records fall into each category. One cursor pass for both. */
export async function countTweetsByFilter(db) {
  const counts = { superseded: 0, deleted: 0 };
  await forEachTweet(db, (record) => {
    for (const filter of PURGE_FILTERS) {
      if (matchesPurgeFilter(record, filter)) counts[filter]++;
    }
  });
  return counts;
}

/**
 * Delete every record in one category, along with its cached media.
 *
 * Ids are collected first and removed afterwards, so the cursor used to find
 * them is finished before anything is mutated. A failure on one record does not
 * strand the others — the caller gets back how many actually went, which is
 * what it reports to the user.
 */
export async function purgeTweets(db, filter) {
  if (PURGE_FILTERS.indexOf(filter) === -1) return 0;

  const ids = [];
  await forEachTweet(db, (record) => {
    if (matchesPurgeFilter(record, filter)) ids.push(record.id);
  });

  let removed = 0;
  for (const id of ids) {
    try {
      await deleteTweet(db, id);
      removed++;
    } catch (_) { /* keep going */ }
  }
  return removed;
}

/* -------------------------------------------------------------------------- */
/* Media blob cache (optional module surface)                                 */
/* -------------------------------------------------------------------------- */

export function getMediaRecord(db, key) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_MEDIA, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    requestToPromise(tx.objectStore(STORE_MEDIA).get(key)).then(resolve, reject);
  });
}

export function putMediaRecord(db, record) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_MEDIA, 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }
    const done = transactionDone(tx);
    done.then(resolve, reject);
    try {
      tx.objectStore(STORE_MEDIA).put(record);
    } catch (err) {
      try {
        tx.abort();
      } catch (_) { /* ignore */ }
      reject(err);
    }
  });
}

/** Every cached media record, for the media archive export. */
export function listAllMedia(db) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_MEDIA, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const request = tx.objectStore(STORE_MEDIA).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      out.push(cursor.value);
      cursor.continue();
    };
    transactionDone(tx).then(() => resolve(out), reject);
  });
}

export function listMediaKeysForTweet(db, tweetId) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_MEDIA, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    const keys = [];
    const request = tx.objectStore(STORE_MEDIA).index(INDEX_MEDIA_TWEET).openKeyCursor(IDBKeyRange.only(tweetId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      keys.push(cursor.primaryKey);
      cursor.continue();
    };
    transactionDone(tx).then(() => resolve(keys), reject);
  });
}
