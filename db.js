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
//   v3 added the `createdAtId` compound index on `tweets`.
//   v4 added the `connections` store (see below).
export const DB_VERSION = 4;
// Version of the RECORD/export shape. v2 added `lang` and `entities`
// (link expansions, hashtags, mentions); v3 added the `connections` array to the
// export envelope. Records and files written under an earlier version simply
// have no such fields — the shape is additive, so readers must tolerate their
// absence rather than assume them.
export const SCHEMA_VERSION = 3;

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

/**
 * The follow / follower roster: one row per person, per list.
 *
 *   { list, userId, screenName, screenNameLower, name, accountCreatedAt, bio,
 *     bioUrls, location, websiteUrl, lang, blueVerified, verified,
 *     followersCount, followingCount, tweetCount, avatarUrl,
 *     ownerIds, firstSeenAt, lastSeenAt, source, schemaVersion }
 *
 * Keyed by [list, userId] rather than by screen name, because a screen name can
 * be changed and the numeric id cannot. Someone who renames half way through a
 * sweep would otherwise appear twice under two handles, and a handle released by
 * a rename and taken by somebody else would quietly merge two people into one
 * row — the worst outcome in a store whose only job is to say who someone was.
 *
 * This store records who was SEEN, never who is gone. A partial scan and a
 * complete one are indistinguishable from the extension's side: a page nobody
 * scrolled looks exactly like a page whose people have all left. A removal mark
 * written on that evidence would invent history, so no such mark exists, and
 * nothing here should ever grow one without a way to know a sweep reached the
 * end.
 */
export const STORE_CONNECTIONS = 'connections';

/** The two lists this archive keeps. Part of the primary key, so the set is closed. */
export const CONNECTION_LISTS = ['following', 'followers'];

export const INDEX_CAPTURED_AT = 'capturedAt';
export const INDEX_CREATED_AT = 'createdAt';
export const INDEX_AUTHOR = 'authorScreenName';
export const INDEX_MEDIA_TWEET = 'tweetId';

/**
 * The list is ordered by publish time, and paginated with a cursor over this
 * compound index rather than over `createdAt` alone.
 *
 * X reports `created_at` to the second, so two posts made in the same second
 * share a timestamp. Paging with an exclusive upper bound on `createdAt` would
 * silently skip the second of the pair — the record would still be in the
 * database and in every export, but it would never appear in the list, which is
 * exactly the kind of invisible loss this archive exists to prevent. Adding the
 * tweet id makes every cursor position unique.
 */
export const INDEX_CREATED_AT_ID = 'createdAtId';

/**
 * Orders the roster by handle within its list — which is how it is listed,
 * searched and exported.
 *
 * Not by `firstSeenAt`, which looks like "when I followed them" and is not. A
 * sweep is partial by nature: scroll the top of a list today and the rest next
 * week, and ordering by first sighting puts the OLDEST follows at the top of the
 * list, exactly inverted, with nothing to say so. Handle order is what a roster
 * is for — looking a person up — and it is stable, so two exports of the same
 * data can be compared.
 *
 * `userId` completes the key because the handle alone is not unique: a row whose
 * handle was unusable stores an empty string, and a released handle can be taken
 * by someone else. The cursor resume key has to be unique or paging skips rows —
 * the same reasoning as INDEX_CREATED_AT_ID above.
 */
export const INDEX_CONNECTION_LIST = 'listScreenName';

let dbPromise = null;

/**
 * Deadline for a single open attempt.
 *
 * Opening a local database is a millisecond-scale operation; the only thing
 * that makes it take seconds is `onblocked`, where a connection holding an
 * older version — a tab or popup left open across an extension update — has to
 * close before the upgrade can run, and may never do so.
 *
 * Ten seconds is far longer than any healthy open (the popup's own scan over
 * twenty thousand records finishes faster) and short enough that the caller
 * that was waiting still exists to report it. Without a deadline this promise
 * simply never settles, and a hang is the worst possible failure here: the
 * service worker never answers the message, the page that sent it waits
 * forever, and nothing anywhere says why.
 */
const OPEN_TIMEOUT_MS = 10000;

/**
 * The rejection a blocked open produces. Named, so a caller can tell "the
 * database is blocked by another connection" apart from "the open failed" —
 * the two want different advice and the message has to carry that.
 */
function openTimeoutError() {
  const err = new Error('IndexedDB open timed out after ' + OPEN_TIMEOUT_MS +
    ' ms; another tab or popup is holding an older version open');
  err.name = 'OpenTimeoutError';
  return err;
}

/* -------------------------------------------------------------------------- */
/* Open / migrate                                                             */
/* -------------------------------------------------------------------------- */

export function openDB() {
  if (dbPromise !== null) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    // One gate for every way this promise can finish. An open that is blocked
    // can still fire onsuccess later, once the blocking connection goes away;
    // without this the timeout would reject and the late success would then try
    // to resolve the same promise a second time.
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      finish(value);
    };

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      settle(reject, err);
      return;
    }

    timer = setTimeout(() => settle(reject, openTimeoutError()), OPEN_TIMEOUT_MS);

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

      // v2 -> v3: the list is ordered by publish time instead of capture time.
      //
      // Capture order was fine while every record was written at the moment it
      // was posted. It stops being fine the moment a row can be recovered later
      // by a profile sweep: twenty posts from the last two days would all carry
      // the same capture timestamp and would pile up at the top of the list in
      // an order that has nothing to do with when they were written.
      //
      // Creating an index on an existing store is additive — IndexedDB fills it
      // in from the records already there — so this cannot lose anything.
      if (oldVersion < 3) {
        if (db.objectStoreNames.contains(STORE_TWEETS)) {
          const stores = request.transaction.objectStore(STORE_TWEETS);
          if (!stores.indexNames.contains(INDEX_CREATED_AT_ID)) {
            stores.createIndex(INDEX_CREATED_AT_ID, ['createdAt', 'id'], { unique: true });
          }
        }
      }

      // v3 -> v4: the follow / follower roster gets its own store.
      //
      // A new store is the most additive change there is — nothing that already
      // exists is opened, read or rewritten, so an upgrade cannot lose a tweet.
      // The index is created on the store handle directly rather than through
      // request.transaction, which is only needed for adding an index to a store
      // that was created by an earlier version (see the step above).
      if (oldVersion < 4) {
        if (!db.objectStoreNames.contains(STORE_CONNECTIONS)) {
          const connections = db.createObjectStore(STORE_CONNECTIONS, { keyPath: ['list', 'userId'] });
          connections.createIndex(INDEX_CONNECTION_LIST, ['list', 'screenNameLower', 'userId'], { unique: true });
        }
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // The deadline may already have passed. That connection is still a real
      // one, and leaving it open would be the very thing blocking the next
      // attempt, so it is closed before its result is thrown away.
      if (settled) {
        try {
          db.close();
        } catch (_) { /* ignore */ }
        return;
      }
      db.onversionchange = () => {
        try {
          db.close();
        } catch (_) { /* ignore */ }
      };
      settle(resolve, db);
    };

    request.onerror = () => {
      settle(reject, request.error || new Error('IndexedDB open failed'));
    };

    request.onblocked = () => {
      // Another tab/popup holds an old version open. Nothing further happens
      // here until that connection closes, which may be never — so the deadline
      // above is what turns this into a reported failure rather than a message
      // that never gets an answer.
    };
  }).catch((err) => {
    // A rejection must not stay memoized. dbPromise is the module's only copy
    // of "an open is in flight", and leaving a failed one there would answer
    // every later call with the first failure forever — including the retry
    // that the blocking connection finally going away should allow.
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
/**
 * Insert a record recovered from a profile timeline sweep, WITHOUT touching one
 * that is already archived.
 *
 * A publish-time capture is the better record: it has the request body, the
 * poll card, the edit chain and the full media entities as they stood when the
 * post was made. A timeline record is a later, thinner view of the same tweet —
 * its `entities` may be missing keys entirely, and it is only visible to the
 * extent the profile page happened to page back.
 *
 * So an id that already exists is left exactly as it is. Overwriting it would
 * trade good data for worse, which is the one outcome a backup must never
 * produce. Returns how many rows were actually new.
 */
export function upsertBackfill(db, record) {
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
    let failure = null;

    const done = transactionDone(tx);
    done.then(
      () => {
        if (failure !== null) reject(failure);
        else resolve({ existed: existed });
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
          return; /* already archived from the publish path: leave it alone */
        }
        try {
          store.put(record);
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

          // `record` came out of sanitizeRecord, which rebuilds from a whitelist
          // of fields that a capture can carry. The two marks below are NOT part
          // of a capture — markSuperseded and markDeleted add them afterwards, to
          // a row that is already stored. Copying the fresh record over the old
          // one would therefore erase them, and an erased deletion mark makes the
          // row quietly leave the cleanup panel even though nothing was restored.
          // They are archive history, not capture data, so they survive.
          if (typeof previous.supersededBy === 'string' && previous.supersededBy.length > 0) {
            merged.supersededBy = previous.supersededBy;
          }
          if (typeof previous.deletedAt === 'string' && previous.deletedAt.length > 0) {
            merged.deletedAt = previous.deletedAt;
          }
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
 * Fill in the link targets of a record that is already archived.
 *
 * A post recovered by a profile sweep can arrive with no `entities.urls`,
 * because the sweep response frequently does not carry them: measured over the
 * real response used to build the sweep, 22 of its 24 tweets had no `urls` at
 * all and 15 had an `entities` object with no keys in it. The text still holds
 * the t.co shortlink — nothing rewrites it — but nothing says where it pointed,
 * and t.co stops resolving once the post ages, so the address is lost for good.
 * Opening the post's own page makes X fetch the full entity set, and this is
 * where that lands.
 *
 * Three rules, and they are the whole function:
 *
 *   - It may only FILL A GAP. A non-empty stored `entities.urls` is never
 *     replaced, whatever arrives: the publish path captured it from the
 *     response that created the post, which is the better record, and this path
 *     exists because the sweep had LESS, never because it has more. Nothing is
 *     merged into a non-empty list either — same reason, one rule, no exception.
 *   - It touches nothing else. `capturedAt`, `firstCapturedAt`, `updatedAt` and
 *     every mark (`deletedAt`, `supersededBy`) are archive history rather than
 *     capture data, and are left exactly as they are — the same property
 *     upsertTweet had to be taught, after it erased them once. `entities` is
 *     rebuilt as a copy, so hashtags and mentions survive untouched too.
 *   - It never creates a record. A tweet this machine never archived has no row
 *     to fill; inventing one is what the deletion path also refuses to do, and
 *     for the same reason — a content-free row in the archive is worse than a
 *     missing one, because it looks like data.
 *
 * Resolves ONCE THE TRANSACTION HAS COMMITTED, with `{ ok: true, updated,
 * found }`: `updated` says a write happened, `found` says a record was there to
 * write to. When there is nothing to do — no record, no links to add, or links
 * already stored — NO WRITE IS ISSUED AT ALL and the row is left byte-identical.
 */
export function mergeLinkEntities(db, id, urls) {
  return new Promise((resolve, reject) => {
    const nothing = () => resolve({ ok: true, updated: false, found: false });

    // Nothing to fill is not a reason to open a transaction.
    if (typeof id !== 'string' || id.length === 0) {
      nothing();
      return;
    }
    if (!Array.isArray(urls) || urls.length === 0) {
      nothing();
      return;
    }

    let tx;
    try {
      tx = db.transaction(STORE_TWEETS, 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }

    const store = tx.objectStore(STORE_TWEETS);
    let updated = false;
    let found = false;
    let failure = null;

    const done = transactionDone(tx);
    done.then(
      () => {
        if (failure !== null) reject(failure);
        else resolve({ ok: true, updated: updated, found: found });
      },
      (err) => {
        if (failure !== null) reject(failure);
        else reject(err);
      }
    );

    try {
      const getRequest = store.get(id);
      getRequest.onsuccess = () => {
        const record = getRequest.result;
        if (!record || typeof record !== 'object') return;
        found = true;

        const current = record.entities;
        if (current !== undefined && current !== null) {
          // A container that is not an object is malformed rather than a gap,
          // and there is no way to fill it without destroying whatever it is.
          if (typeof current !== 'object' || Array.isArray(current)) return;
          if (Array.isArray(current.urls) && current.urls.length > 0) {
            return; // already has its links: this path may only fill a gap
          }
        }

        // A MISSING list is materialised as empty, so that a record whose whole
        // `entities` container was absent — one written under schema v1, which
        // predates the field — still ends up in the shape every other writer
        // produces and every reader expects. An existing list, of whatever
        // shape, is copied through untouched; only `urls` is given a value.
        const merged = Object.assign({}, current || {});
        merged.urls = urls;
        if (merged.hashtags === undefined) merged.hashtags = [];
        if (merged.mentions === undefined) merged.mentions = [];

        try {
          store.put(Object.assign({}, record, { entities: merged }));
          updated = true;
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
      // Every store that gets cleared must be named in the scope. Asking a
      // transaction for a store it was not opened over throws NotFoundError,
      // and the abort discards the clears already queued on it — so listing one
      // too few here does not partially clear, it clears nothing at all and
      // reports failure.
      tx = db.transaction([STORE_TWEETS, STORE_MEDIA, STORE_DELETIONS, STORE_CONNECTIONS], 'readwrite');
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
      tx.objectStore(STORE_CONNECTIONS).clear();
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
 * Pagination walks the [createdAt, id] index, newest first, using an exclusive
 * upper bound. This is the whole reason the list is ordered by publish time
 * rather than capture time: a row recovered by a profile sweep was captured
 * today but written days ago, and ordering by capture time would pile every
 * swept row at the top in an order unrelated to when it was written.
 *
 * The id is part of the key because `created_at` only resolves to the second —
 * two posts made in the same second would otherwise share a cursor position and
 * the exclusive bound would skip one of them.
 */
export function queryTweets(db, options) {
  const opts = options || {};
  const term = typeof opts.query === 'string' ? opts.query.trim().toLowerCase() : '';
  const pageSize = Number.isInteger(opts.pageSize) && opts.pageSize > 0 ? opts.pageSize : 30;
  const scanBudget = Number.isInteger(opts.scanBudget) && opts.scanBudget > 0 ? opts.scanBudget : 20000;

  // A resume key is [createdAt, id]. An array coming back from IndexedDB is a
  // fresh object each time, so callers must compare it by value, not identity.
  let afterKey = null;
  if (Array.isArray(opts.afterKey) && opts.afterKey.length === 2) {
    afterKey = [String(opts.afterKey[0]), String(opts.afterKey[1])];
  }

  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_TWEETS, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }

    const store = tx.objectStore(STORE_TWEETS);
    const index = store.index(INDEX_CREATED_AT_ID);

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
/**
 * Value comparison for a [createdAt, id] resume key (arrays never compare ===).
 * Exported so the popup's paging loop uses THIS rule rather than a copy of it.
 */
export function sameKey(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

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
    // The resume key is [createdAt, id]. IndexedDB hands back a fresh array each
    // time and queryTweets re-wraps it, so `===` would never be true and this
    // guard would never fire. Compare by value.
    if (page.nextKey === null || sameKey(page.nextKey, afterKey)) return;
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

/* -------------------------------------------------------------------------- */
/* Connections — the follow / follower roster                                 */
/* -------------------------------------------------------------------------- */

/**
 * How many own accounts one roster row may remember having been seen through.
 *
 * Matches MAX_OWN_AUTHORS in settings.js, which is the only thing that feeds it.
 * Not imported: this module has no dependencies, and the number is a ceiling on
 * a union rather than a value the two modules have to agree on exactly.
 */
const CONNECTION_OWNER_LIMIT = 20;

/**
 * Fields a fresh observation may fill but must never blank.
 *
 * Measured over fifty real entries of a Following response, only the id, the
 * handle, the name and the counts arrive every time: a bio arrives 48 times in
 * 50, a banner 46, a location 28, a website 21. So a later sweep routinely
 * carries LESS than an earlier one, and overwriting wholesale would let the
 * thinner observation destroy the only copy of a bio this archive will ever
 * hold.
 */
const CONNECTION_FILL_ONLY = [
  'screenName', 'name', 'accountCreatedAt', 'bio', 'location', 'websiteUrl',
  'lang', 'avatarUrl'
];

const CONNECTION_COUNTS = ['followersCount', 'followingCount', 'tweetCount'];
const CONNECTION_FLAGS = ['blueVerified', 'verified'];

/**
 * The own-account ids a row has been seen through, oldest first, deduplicated.
 *
 * One Chrome profile can hold more than one X account and `ownAuthorIds` holds
 * up to twenty of them. Without this the rosters of two accounts would be one
 * undifferentiated pile with no way to say which account knew whom — and no way
 * to add the distinction later except by scanning everything again.
 */
function unionOwnerIds(previous, fresh) {
  const out = [];
  const add = (value) => {
    if (typeof value !== 'string' || value.length === 0) return;
    if (out.indexOf(value) === -1) out.push(value);
  };
  if (Array.isArray(previous)) previous.forEach(add);
  if (Array.isArray(fresh)) fresh.forEach(add);
  return out.slice(0, CONNECTION_OWNER_LIMIT);
}

/**
 * Merge a new sighting of a person into the row already stored.
 *
 * The opposite rule to upsertTweet, deliberately. A capture carries every field
 * it knows about and the newest one wins; a roster observation does not, because
 * the same person comes back with a different subset each time. So a non-empty
 * new value wins, an empty one never erases, and the two fields that are this
 * row's own history rather than the page's data — firstSeenAt and ownerIds — are
 * merged instead of replaced.
 *
 * The same principle as mergeLinkEntities: fill the gaps, never take away.
 */
function mergeConnection(previous, fresh, seenAt) {
  const merged = Object.assign({}, fresh);

  for (const field of CONNECTION_FILL_ONLY) {
    const next = fresh[field];
    const before = previous[field];
    const nextEmpty = next === null || next === undefined || next === '';
    if (nextEmpty && typeof before === 'string' && before.length > 0) {
      merged[field] = before;
    }
  }

  // The counts are numbers, and 0 is a real answer — "this account has no
  // followers" is not the same as "this response did not carry the field" — so
  // only a non-number falls back.
  for (const field of CONNECTION_COUNTS) {
    if (typeof fresh[field] !== 'number' && typeof previous[field] === 'number') {
      merged[field] = previous[field];
    }
  }

  for (const field of CONNECTION_FLAGS) {
    if (typeof fresh[field] !== 'boolean' && typeof previous[field] === 'boolean') {
      merged[field] = previous[field];
    }
  }

  if (Array.isArray(fresh.bioUrls) && fresh.bioUrls.length > 0) {
    merged.bioUrls = fresh.bioUrls;
  } else if (Array.isArray(previous.bioUrls)) {
    merged.bioUrls = previous.bioUrls;
  }

  merged.firstSeenAt = typeof previous.firstSeenAt === 'string' && previous.firstSeenAt.length > 0
    ? previous.firstSeenAt
    : seenAt;
  merged.lastSeenAt = seenAt;
  merged.ownerIds = unionOwnerIds(previous.ownerIds, fresh.ownerIds);

  return merged;
}

/**
 * Record one sighting of one person in one list.
 *
 * `seenAt` is supplied by the caller from its own clock, never from the page:
 * the page's timestamp is forgeable and the row's meaning is "when this browser
 * last saw them", which only the browser knows.
 *
 * Resolves with { existed }.
 */
export function upsertConnection(db, record, seenAt) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_CONNECTIONS, 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }

    const store = tx.objectStore(STORE_CONNECTIONS);
    let existed = false;
    let failure = null;

    const done = transactionDone(tx);
    done.then(
      () => { if (failure !== null) reject(failure); else resolve({ existed: existed }); },
      (err) => { if (failure !== null) reject(failure); else reject(err); }
    );

    try {
      const getRequest = store.get([record.list, record.userId]);
      getRequest.onsuccess = () => {
        const previous = getRequest.result;
        let merged;
        if (previous && typeof previous === 'object') {
          existed = true;
          merged = mergeConnection(previous, record, seenAt);
        } else {
          merged = Object.assign({}, record, { firstSeenAt: seenAt, lastSeenAt: seenAt });
        }

        // The index key has to be a string. A row whose screenNameLower is null
        // or missing gets NO index entry at all — it would still be in the store
        // but gone from every listing, which is the silent loss this archive
        // exists to prevent. sanitizeConnection guarantees a string; this is the
        // last gate before the write.
        if (typeof merged.screenNameLower !== 'string') merged.screenNameLower = '';

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

function connectionMatches(record, term) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.screenNameLower === 'string' && record.screenNameLower.indexOf(term) !== -1) return true;
  if (typeof record.name === 'string' && record.name.toLowerCase().indexOf(term) !== -1) return true;
  if (typeof record.userId === 'string' && record.userId.indexOf(term) !== -1) return true;
  if (typeof record.bio === 'string' && record.bio.toLowerCase().indexOf(term) !== -1) return true;
  if (typeof record.location === 'string' && record.location.toLowerCase().indexOf(term) !== -1) return true;
  return false;
}

/**
 * Paged, handle-ordered listing of one roster, with the same local keyword
 * search as queryTweets.
 *
 * The cursor walks the [list, screenNameLower, userId] index, which orders by
 * handle within the list. The range is bounded to the one list at both ends:
 * IndexedDB sorts key types number < date < string < binary < array, so an array
 * as the second component is greater than every string — which makes
 * [list, []] an exclusive upper bound covering every row of that list whatever
 * its handle.
 */
export function queryConnections(db, options) {
  const opts = options || {};
  const list = typeof opts.list === 'string' ? opts.list : '';
  const term = typeof opts.query === 'string' ? opts.query.trim().toLowerCase() : '';
  const pageSize = Number.isInteger(opts.pageSize) && opts.pageSize > 0 ? opts.pageSize : 50;
  const scanBudget = Number.isInteger(opts.scanBudget) && opts.scanBudget > 0 ? opts.scanBudget : 20000;

  // A resume key is [list, screenNameLower, userId] — a fresh array each time it
  // comes back from IndexedDB, so callers compare it by value via sameKey.
  let afterKey = null;
  if (Array.isArray(opts.afterKey) && opts.afterKey.length === 3) {
    afterKey = [String(opts.afterKey[0]), String(opts.afterKey[1]), String(opts.afterKey[2])];
  }

  return new Promise((resolve, reject) => {
    if (list.length === 0) {
      resolve({ items: [], hasMore: false, nextKey: null, scanned: 0, exhaustedScan: false });
      return;
    }

    let tx;
    try {
      tx = db.transaction(STORE_CONNECTIONS, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }

    const index = tx.objectStore(STORE_CONNECTIONS).index(INDEX_CONNECTION_LIST);

    let range;
    try {
      range = afterKey !== null
        ? IDBKeyRange.bound([list], afterKey, false, true)
        : IDBKeyRange.bound([list], [list, []], false, true);
    } catch (_) {
      range = IDBKeyRange.bound([list], [list, []], false, true);
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

      if (connectionMatches(record, term)) {
        items.push(record);
        lastCollectedKey = cursor.key;
        if (items.length >= pageSize) {
          stopReason = 'page-full';
          return;
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
 * Every roster row, for the export.
 *
 * This walks the STORE, not the index, and sorts afterwards. An index walk would
 * be one line shorter and would be wrong: a row whose index key was somehow
 * unusable has no index entry, and a whole-file export that quietly omits a
 * person is the one failure this feature must not have. Sorting after the
 * transaction resolves is the same shape as listDeletions.
 */
export function listConnections(db) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_CONNECTIONS, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const request = tx.objectStore(STORE_CONNECTIONS).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      out.push(cursor.value);
      cursor.continue();
    };
    transactionDone(tx).then(() => {
      out.sort((a, b) => {
        const byList = String(a.list).localeCompare(String(b.list));
        if (byList !== 0) return byList;
        const byHandle = String(a.screenNameLower).localeCompare(String(b.screenNameLower));
        if (byHandle !== 0) return byHandle;
        return String(a.userId).localeCompare(String(b.userId));
      });
      resolve(out);
    }, reject);
  });
}

/**
 * How many rows one list holds, or the whole roster when `list` is omitted.
 *
 * A bare count on the index rather than a scan: the figures are shown beside the
 * list and refreshed on every open of the popup.
 */
export function countConnections(db, list) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_CONNECTIONS, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    const index = tx.objectStore(STORE_CONNECTIONS).index(INDEX_CONNECTION_LIST);
    let range = null;
    if (typeof list === 'string' && list.length > 0) {
      try {
        range = IDBKeyRange.bound([list], [list, []], false, true);
      } catch (_) {
        range = null;
      }
    }
    requestToPromise(index.count(range)).then(resolve, reject);
  });
}
