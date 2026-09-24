/* ============================================================================
 * content.js  —  ISOLATED world, document_start, x.com only.
 *
 * ROLE
 *   Be the narrow, suspicious bridge between the page realm (inject.js) and the
 *   extension realm (background.js).
 *
 *   page (MAIN)  --window.postMessage-->  content.js  --chrome.runtime-->  SW
 *
 * NOTES
 *   - This file NEVER reads the DOM for tweet content. It only relays data the
 *     page's own network layer produced.
 *   - window.postMessage is NOT a security boundary: page scripts share the
 *     realm with inject.js and could forge messages. Everything received here is
 *     therefore treated as untrusted input, re-validated, and background.js
 *     validates it again before touching IndexedDB.
 *   - This file has NO access to the extension's IndexedDB. A content script
 *     runs on the host page's origin, so its IndexedDB would be x.com's
 *     database, not the extension's. Persistence happens in background.js.
 * ========================================================================== */
(() => {
  'use strict';

  const PAGE_SOURCE = 'xtb-main';
  const BRIDGE_SOURCE = 'xtb-bridge';
  const MAX_INBOUND_BYTES = 512 * 1024;
  const MAX_TEXT_CHARS = 200000;
  const HANDSHAKE_RETRY_MS = [0, 250, 1000, 3000, 8000];

  const TWEET_ID_PATTERN = /^[0-9]{1,25}$/;

  let sessionToken = null;
  let debugEnabled = false;
  let handshakeDone = false;
  let handshakeIndex = 0;
  let handshakeTimer = null;
  const outboundQueue = [];

  function log() {
    if (!debugEnabled) return;
    try {
      // eslint-disable-next-line no-console
      console.debug('[X Tweet Backup]', ...arguments);
    } catch (_) { /* ignore */ }
  }

  function generateToken() {
    try {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      let out = '';
      for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
      }
      return out;
    } catch (_) {
      // Fallback: still unguessable enough for de-duplicating same-document
      // messages. This is not a cryptographic boundary in either case.
      return 'xtb' + String(Math.random()).slice(2) + String(Date.now());
    }
  }

  /* ------------------------------------------------------------------ */
  /* Type helpers                                                        */
  /* ------------------------------------------------------------------ */

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isTweetId(value) {
    return typeof value === 'string' && TWEET_ID_PATTERN.test(value);
  }

  function ownOrigin() {
    try {
      const o = window.location.origin;
      if (typeof o === 'string' && o && o !== 'null') return o;
    } catch (_) { /* ignore */ }
    return '*';
  }

  /* ------------------------------------------------------------------ */
  /* MAIN world -> background                                            */
  /* ------------------------------------------------------------------ */

  function postToPage(message) {
    try {
      window.postMessage(message, ownOrigin());
    } catch (err) {
      log('postToPage failed', err);
    }
  }

  function beginHandshake() {
    sessionToken = generateToken();
    handshakeDone = false;
    handshakeIndex = 0;
    sendHello();
  }

  function sendHello() {
    if (handshakeDone) return;
    postToPage({
      __xtb: true,
      source: BRIDGE_SOURCE,
      type: 'XTB_HELLO',
      token: sessionToken,
      debug: debugEnabled,
      // Sent on every handshake, not only on change: the page realm needs these
      // before it can decide whether a profile timeline belongs to its owner.
      ownAuthorIds: ownAuthorIds,
      captureReplies: captureReplies,
      captureConnections: captureConnections
    });

    if (handshakeIndex < HANDSHAKE_RETRY_MS.length - 1) {
      const delay = HANDSHAKE_RETRY_MS[handshakeIndex + 1];
      handshakeIndex++;
      if (handshakeTimer !== null) clearTimeout(handshakeTimer);
      handshakeTimer = setTimeout(() => {
        handshakeTimer = null;
        sendHello();
      }, delay);
    }
  }

  function completeHandshake() {
    if (handshakeDone) return;
    handshakeDone = true;
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    log('bridge established');
    flushOutbound();
  }

  /* ------------------------------------------------------------------ */
  /* Validation of anything arriving from the page realm                 */
  /* ------------------------------------------------------------------ */

  function validateInbound(raw) {
    if (!isObject(raw)) return null;
    if (!isObject(raw.payload)) return null;

    const payload = raw.payload;
    if (!isTweetId(payload.id)) return null;
    if (typeof payload.text !== 'string') return null;
    if (payload.text.length > MAX_TEXT_CHARS) return null;
    if (payload.media !== undefined && payload.media !== null && !Array.isArray(payload.media)) return null;
    if (payload.author !== undefined && payload.author !== null && !isObject(payload.author)) return null;

    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch (_) {
      return null;
    }
    if (typeof serialized !== 'string' || serialized.length > MAX_INBOUND_BYTES) return null;
    return payload;
  }

  /**
   * A deletion is only an id plus a timestamp, so it is validated on its own
   * terms. It never carries tweet content, and it can never create a record —
   * background.js only uses it to mark a row that is already stored.
   */
  function validateDeletion(raw) {
    if (!isObject(raw)) return null;
    if (!isObject(raw.payload)) return null;

    const payload = raw.payload;
    if (!isTweetId(payload.id)) return null;
    if (typeof payload.deletedAt !== 'string' || payload.deletedAt.length === 0) return null;

    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch (_) {
      return null;
    }
    if (typeof serialized !== 'string' || serialized.length > MAX_INBOUND_BYTES) return null;
    return payload;
  }

  /** A timeline response is one page or two; a larger batch means something is wrong. */
  const MAX_BACKFILL_RECORDS = 200;
  const MAX_BACKFILL_BYTES = 4 * 1024 * 1024;

  /**
   * A profile-timeline sweep arrives as a batch, so it is the only message that
   * can carry more than one record. Every row is validated on exactly the terms
   * a live capture is — this is not a shortcut past the boundary just because
   * the rows came from a different operation.
   *
   * `source.backfilled` is required, not optional: the whole point of the flag
   * is that a row recovered by a sweep was not witnessed at publish time, and a
   * payload that omitted it would be claiming otherwise.
   *
   * Validation is row by row, and a bad row costs its own row and nothing more.
   * Refusing the whole batch meant one malformed entry threw away every good
   * record travelling with it — and a dropped row here is a lost post, which is
   * the one failure this extension is not allowed to have. The cap is applied by
   * taking the first MAX_BACKFILL_RECORDS instead of rejecting the message: a
   * response that large is unusual, but its first 200 rows are still worth
   * keeping.
   */
  function validateBackfill(raw) {
    if (!isObject(raw)) return null;
    if (!isObject(raw.payload)) return null;
    if (!Array.isArray(raw.payload.records)) return null;
    if (raw.payload.records.length === 0) return null;

    const incoming = raw.payload.records;
    const limit = Math.min(incoming.length, MAX_BACKFILL_RECORDS);
    const overCap = incoming.length - limit;
    const records = [];
    let dropped = 0;

    for (let i = 0; i < limit; i++) {
      const record = incoming[i];
      if (!isObject(record) ||
          !isTweetId(record.id) ||
          typeof record.text !== 'string' ||
          record.text.length > MAX_TEXT_CHARS ||
          (record.media !== undefined && record.media !== null && !Array.isArray(record.media)) ||
          (record.author !== undefined && record.author !== null && !isObject(record.author)) ||
          !isObject(record.source) ||
          record.source.backfilled !== true) {
        dropped++;
        continue;
      }
      records.push(record);
    }
    dropped += overCap;

    let serialized;
    try {
      serialized = JSON.stringify(records);
    } catch (_) {
      return null;
    }
    if (typeof serialized !== 'string' || serialized.length > MAX_BACKFILL_BYTES) {
      reportRejection('a backfill batch exceeded ' + MAX_BACKFILL_BYTES + ' bytes');
      return null;
    }

    // A dropped row has to reach the page, or its only trace is a debug-gated
    // console line nobody reads. reportRejection carries it to the diagnostics
    // panel, which is where a lost post belongs.
    if (dropped > 0) {
      reportRejection('dropped ' + dropped + ' of ' + incoming.length + ' backfill rows before storage' +
        (overCap > 0 ? ' (' + overCap + ' beyond the ' + MAX_BACKFILL_RECORDS + '-row cap)' : ''));
    }

    if (records.length === 0) return null;
    return { records: records };
  }

  /** A follow list is fifty rows a page; the page caps itself at the same number. */
  const MAX_CONNECTION_RECORDS = 200;
  const MAX_CONNECTION_BYTES = 1024 * 1024;

  /**
   * A follow-list batch: rows about other people, from a page that already
   * decided they belong to one of this account's own lists.
   *
   * `list` and `ownerId` are required on the MESSAGE and are not read from the
   * rows. One response is one list belonging to one account, so hoisting them
   * removes a whole class of forgery — a row claiming a different list than the
   * batch it arrived in — and it is also what background.js uses to build the
   * record's primary key, which must not be something a row can assert.
   *
   * Row checks are deliberately minimal here: the fields are rebuilt from a
   * whitelist in background.js, so all this side has to establish is that each
   * row is an object with a numeric id. Anything else it demanded would be a
   * second, weaker copy of the whitelist.
   */
  function validateConnections(raw) {
    if (!isObject(raw)) return null;
    if (!isObject(raw.payload)) return null;

    const payload = raw.payload;
    if (payload.list !== 'following' && payload.list !== 'followers') return null;
    if (!isTweetId(payload.ownerId)) return null;
    if (!Array.isArray(payload.records)) return null;
    if (payload.records.length === 0) return null;

    const incoming = payload.records;
    const limit = Math.min(incoming.length, MAX_CONNECTION_RECORDS);
    const overCap = incoming.length - limit;
    const records = [];
    let dropped = 0;

    for (let i = 0; i < limit; i++) {
      const record = incoming[i];
      if (!isObject(record) || !isTweetId(record.userId)) {
        dropped++;
        continue;
      }
      records.push(record);
    }
    dropped += overCap;

    let serialized;
    try {
      serialized = JSON.stringify(records);
    } catch (_) {
      return null;
    }
    if (typeof serialized !== 'string' || serialized.length > MAX_CONNECTION_BYTES) {
      reportRejection('a follow-list batch exceeded ' + MAX_CONNECTION_BYTES + ' bytes');
      return null;
    }

    if (dropped > 0) {
      reportRejection('dropped ' + dropped + ' of ' + incoming.length + ' follow-list rows before storage' +
        (overCap > 0 ? ' (' + overCap + ' beyond the ' + MAX_CONNECTION_RECORDS + '-row cap)' : ''));
    }

    if (records.length === 0) return null;
    return { list: payload.list, ownerId: payload.ownerId, records: records };
  }

  /** How many link targets one post can have. X's own cap; the page applies it too. */
  const MAX_LINK_ENTRIES = 64;

  /**
   * A focal-tweet response carries link targets and nothing else, so it is
   * validated on its own narrow terms — like a deletion — rather than through
   * the capture path, which would demand text, author and media it never has.
   *
   * All this side checks is that the message could be one: an id, a non-empty
   * list of entries, and a size that a real response could produce. Every field
   * inside those entries is rebuilt from a whitelist in background.js, which is
   * where the real validation lives — this is only the gate that keeps an
   * obvious forgery from being relayed at all.
   */
  function validateLinks(raw) {
    if (!isObject(raw)) return null;
    if (!isObject(raw.payload)) return null;

    const payload = raw.payload;
    if (!isTweetId(payload.id)) return null;
    if (!Array.isArray(payload.urls)) return null;
    if (payload.urls.length === 0 || payload.urls.length > MAX_LINK_ENTRIES) return null;

    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch (_) {
      return null;
    }
    if (typeof serialized !== 'string' || serialized.length > MAX_INBOUND_BYTES) return null;
    return payload;
  }

  /**
   * The extension was reloaded or updated while this tab stayed open. Chrome
   * tears down the extension APIs of the already-injected content script, so
   * every later capture is dropped. The page keeps working, inject.js keeps
   * emitting messages, and NOTHING reaches IndexedDB — a silent data-loss trap
   * for anyone who reloads the extension without refreshing x.com.
   *
   * We cannot repair it from here (only a page refresh creates a fresh content
   * script), so the only useful thing left is to make it impossible to miss.
   */
  let deadContextReported = false;

  function reportDeadContext() {
    if (deadContextReported) return;
    deadContextReported = true;
    try {
      // Bilingual on purpose. This runs in the page's console, and the message
      // that has to get through most urgently is also the one that cannot be
      // localised well: the reader may be either a user or a developer, and
      // guessing wrong means the warning is not understood at all.
      console.error(
        '[X Tweet Backup] 备份通道已失效：扩展被重新加载或更新过。\n' +
        '请在本页面按 F5 刷新以恢复备份。在此之前，本页面发布的推文不会被保存。\n' +
        'Backup channel is dead: the extension was reloaded or updated.\n' +
        'Press F5 on this page to restore it. Posts published here until then are NOT saved.'
      );
    } catch (_) { /* ignore */ }
    // window.postMessage does not need extension APIs, so we can still warn the
    // MAIN world — and therefore the user's console — from here.
    postToPage({
      __xtb: true,
      source: BRIDGE_SOURCE,
      type: 'XTB_BRIDGE_DEAD',
      token: sessionToken
    });
  }

  /** Surface a refusal from the service worker back into the page diagnostics. */
  let lastRejection = null;

  function reportRejection(reason) {
    const text = String(reason).slice(0, 200);
    if (text === lastRejection) return;
    lastRejection = text;
    try {
      console.warn('[X Tweet Backup] 后台拒绝了这条记录：' + text);
    } catch (_) { /* ignore */ }
    postToPage({
      __xtb: true,
      source: BRIDGE_SOURCE,
      type: 'XTB_REJECTED',
      token: sessionToken,
      reason: text
    });
  }

  function forwardToBackground(message) {
    if (deadContextReported) return;

    const send = () => {
      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          reportDeadContext();
          return;
        }
        const result = chrome.runtime.sendMessage(message);
        if (result && typeof result.then === 'function') {
          result.then(
            (response) => {
              // The service worker answered but refused the record (validation
              // failed, database unavailable, ...). Without this the refusal was
              // invisible: the page would look fine and the tweet would simply
              // never appear.
              if (response && response.ok === false) {
                reportRejection(response.error || 'unknown');
              }
            },
            (err) => {
              log('sendMessage rejected', err);
              reportDeadContext();
            }
          );
        }
      } catch (err) {
        // Happens after an extension reload while the tab stays open. Never
        // allowed to bubble into the page — but it must not be silent either.
        log('sendMessage failed', err);
        reportDeadContext();
      }
    };

    if (!handshakeDone) {
      if (outboundQueue.length < 64) outboundQueue.push(send);
      return;
    }
    send();
  }

  function flushOutbound() {
    while (outboundQueue.length > 0) {
      const send = outboundQueue.shift();
      try {
        send();
      } catch (_) { /* ignore */ }
    }
  }

  function onPageMessage(event) {
    try {
      if (event.source !== window) return;
      const expectedOrigin = ownOrigin();
      if (expectedOrigin !== '*' && event.origin !== expectedOrigin) return;

      const data = event.data;
      if (!isObject(data) || data.__xtb !== true) return;
      if (data.source !== PAGE_SOURCE) return;
      if (sessionToken === null || data.token !== sessionToken) return;

      if (data.type === 'XTB_READY') {
        completeHandshake();
        return;
      }

      if (data.type === 'XTB_BRIDGE_DEAD') {
        // The page realm telling us its side is alive but the extension side is
        // gone. Nothing to do but make sure the user sees it.
        reportDeadContext();
        return;
      }

      if (data.type === 'X_TWEET_CAPTURED') {
        const payload = validateInbound(data);
        if (payload === null) {
          log('rejected malformed capture payload');
          return;
        }
        forwardToBackground({
          type: 'X_TWEET_CAPTURE',
          payload: payload
        });
        return;
      }

      if (data.type === 'X_TWEET_BACKFILL') {
        const payload = validateBackfill(data);
        if (payload === null) {
          log('rejected malformed backfill payload');
          return;
        }
        forwardToBackground({
          type: 'X_TWEET_BACKFILL',
          payload: payload
        });
        return;
      }

      if (data.type === 'X_CONNECTIONS_SEEN') {
        const payload = validateConnections(data);
        if (payload === null) {
          log('rejected malformed follow-list payload');
          return;
        }
        forwardToBackground({
          type: 'X_CONNECTIONS_SEEN',
          payload: payload
        });
        return;
      }

      if (data.type === 'X_TWEET_DELETED') {
        // A delete carries no tweet content — only which id was removed and
        // when — so it gets its own narrow validation rather than reusing the
        // capture path (which demands text, author, media and so on).
        const payload = validateDeletion(data);
        if (payload === null) {
          log('rejected malformed deletion payload');
          return;
        }
        forwardToBackground({
          type: 'X_TWEET_DELETE',
          payload: payload
        });
        return;
      }

      if (data.type === 'X_TWEET_LINKS') {
        // One post's link targets, read from its own page. It can only ever
        // fill an empty list on a record that is already archived — it creates
        // nothing and replaces nothing — which is why it needs no setting of
        // its own (see handleLinks in background.js).
        const payload = validateLinks(data);
        if (payload === null) {
          log('rejected malformed link payload');
          return;
        }
        forwardToBackground({
          type: 'X_TWEET_LINKS',
          payload: payload
        });
        return;
      }

      if (data.type === 'XTB_DIAG') {
        if (!isObject(data.payload)) return;
        forwardToBackground({
          type: 'XTB_DIAG',
          payload: {
            sessionId: sessionToken,
            reportedAt: new Date().toISOString(),
            hookInstalled: data.payload.hookInstalled,
            xhrHookInstalled: data.payload.xhrHookInstalled,
            hookOverwritten: data.payload.hookOverwritten,
            createTweetSeen: data.payload.createTweetSeen,
            deleteSeen: data.payload.deleteSeen,
            deleted: data.payload.deleted,
            timelineSeen: data.payload.timelineSeen,
            timelineKept: data.payload.timelineKept,
            detailSeen: data.payload.detailSeen,
            detailKept: data.payload.detailKept,
            requestBodyRead: data.payload.requestBodyRead,
            requestBodyFailed: data.payload.requestBodyFailed,
            responseCloneFailed: data.payload.responseCloneFailed,
            responseJsonFailed: data.payload.responseJsonFailed,
            parseFailed: data.payload.parseFailed,
            parsed: data.payload.parsed,
            posted: data.payload.posted,
            postFailed: data.payload.postFailed,
            lastError: data.payload.lastError,
            lastErrorAt: data.payload.lastErrorAt
          }
        });
        return;
      }

      // Everything else is ignored: this channel carries observations only and
      // can never trigger an extension management operation.
    } catch (err) {
      log('onPageMessage failed', err);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Settings mirror (so debug logging can be toggled without a reload)  */
  /* ------------------------------------------------------------------ */

  function pushConfig() {
    postToPage({
      __xtb: true,
      source: BRIDGE_SOURCE,
      type: 'XTB_CONFIG',
      token: sessionToken,
      debug: debugEnabled,
      ownAuthorIds: ownAuthorIds,
      captureReplies: captureReplies,
      captureConnections: captureConnections
    });
  }

  /**
   * Whether the page realm should also read the Replies tab. Mirrored here
   * because the decision is enforced on the page side, at the point the request
   * is recognised — a disabled Replies tab should cost nothing at all, not be
   * read and then thrown away.
   */
  let captureReplies = false;

  /**
   * Whether the page realm should also read your Following and Followers pages.
   *
   * Mirrored for the same reason as captureReplies, and it matters more here:
   * these are the only responses this extension reads that are about other
   * people, so a line left switched on by accident is a privacy problem rather
   * than just a waste.
   */
  let captureConnections = false;

  /**
   * The account ids learned so far, mirrored into the page realm.
   *
   * These are ids, never credentials — they arrive from the author field of a
   * CreateTweet response the extension already parses, and the page realm uses
   * them for exactly one thing: deciding whether a profile timeline it happens
   * to see belongs to this account.
   */
  let ownAuthorIds = [];

  function adoptStoredOwnAuthors(list) {
    if (!Array.isArray(list)) return;
    ownAuthorIds = list
      .filter((id) => typeof id === 'string' && /^[0-9]{1,25}$/.test(id))
      .slice(0, 20);
    pushConfig();
  }

  function applySettings(settings) {
    if (!isObject(settings)) return;
    let changed = false;
    if (typeof settings.debug === 'boolean' && settings.debug !== debugEnabled) {
      debugEnabled = settings.debug;
      changed = true;
    }
    if (typeof settings.captureReplies === 'boolean' && settings.captureReplies !== captureReplies) {
      captureReplies = settings.captureReplies;
      changed = true;
    }
    if (typeof settings.captureConnections === 'boolean' && settings.captureConnections !== captureConnections) {
      captureConnections = settings.captureConnections;
      changed = true;
    }
    if (changed) pushConfig();
  }

  function loadSettings() {
    try {
      if (!chrome.runtime || !chrome.runtime.id || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get({ xtbSettings: null, xtbOwnAuthors: null }, (result) => {
        try {
          if (chrome.runtime.lastError) return;
          applySettings(result ? result.xtbSettings : null);
          adoptStoredOwnAuthors(result ? result.xtbOwnAuthors : null);
        } catch (_) { /* ignore */ }
      });
    } catch (err) {
      log('loadSettings failed', err);
    }
  }

  function watchSettings() {
    try {
      if (!chrome.storage || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener((changes, areaName) => {
        try {
          if (areaName !== 'local' || !changes.xtbSettings) return;
          applySettings(changes.xtbSettings.newValue);
        } catch (_) { /* ignore */ }
      });
    } catch (err) {
      log('watchSettings failed', err);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  try {
    window.addEventListener('message', onPageMessage, false);
  } catch (err) {
    log('addEventListener failed', err);
  }

  loadSettings();
  watchSettings();
  beginHandshake();
})();
