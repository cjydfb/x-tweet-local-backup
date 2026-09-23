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
      debug: debugEnabled
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
      debug: debugEnabled
    });
  }

  function applySettings(settings) {
    if (!isObject(settings)) return;
    if (typeof settings.debug === 'boolean' && settings.debug !== debugEnabled) {
      debugEnabled = settings.debug;
      pushConfig();
    }
  }

  function loadSettings() {
    try {
      if (!chrome.runtime || !chrome.runtime.id || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get({ xtbSettings: null }, (result) => {
        try {
          if (chrome.runtime.lastError) return;
          applySettings(result ? result.xtbSettings : null);
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
