/* ============================================================================
 * inject.js  —  MAIN world, document_start, x.com only.
 *
 * SINGLE RESPONSIBILITY
 *   Observe the responses the page already receives, and when the page
 *   successfully creates a Tweet/Reply, hand an ALREADY PARSED plain-JSON
 *   record to the ISOLATED world via window.postMessage.
 *
 * TWO TRANSPORTS, because x.com does not use just one:
 *   - window.fetch                      (verified: NOT used for publishing)
 *   - XMLHttpRequest.prototype.open/send (verified 2026-09: THIS is what
 *     publishes. POST https://x.com/i/api/graphql/<queryId>/CreateTweet)
 *   Hooking only fetch captures nothing. Both are hooked and both feed the
 *   same URL-detection -> response-parse -> record-build pipeline.
 *
 * HARD RULES OBEYED HERE
 *   - The page always receives the ORIGINAL fetch promise. We never replace,
 *     re-wrap, delay or reject it. Verification/archiving runs on a detached
 *     side-channel ("bypass observation").
 *   - We never modify Request / Headers / Response, never read the original
 *     response body, never consume the original request body.
 *   - No DOM access of any kind. No querySelector, no MutationObserver,
 *     no input/textarea reading, no click/keyboard synthesis.
 *   - No credentials are ever read, stored or transmitted. This file does not
 *     touch cookies, headers, auth_token, ct0 or Authorization.
 *   - This file never calls chrome.* APIs: it lives in the page's own realm.
 * ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */

  const PAGE_SOURCE = 'xtb-main';        // messages we emit
  const BRIDGE_SOURCE = 'xtb-bridge';    // messages we accept
  const HOOK_MARKER = '__xTweetBackupFetchHook__';
  const MAX_BRIDGE_BYTES = 256 * 1024;   // refuse to post absurd payloads
  const MAX_QUEUE = 32;                  // pre-handshake backlog
  const BODY_READ_TIMEOUT_MS = 3000;     // never hang on request-body parsing
  const INTEGRITY_CHECK_MS = 20000;      // low-frequency, detection only
  const MAX_TEXT_CHARS = 200000;
  const MAX_MEDIA_ITEMS = 64;
  const MAX_POLL_CHOICES = 4;            // X offers 2, 3 or 4 choices
  const MAX_BINDING_VALUES = 256;        // card binding_values is a small list
  const MAX_EDIT_VERSIONS = 64;          // an edit chain, defensive cap
  const MAX_ENTITY_URLS = 64;
  const MAX_ENTITY_TAGS = 64;
  const MAX_ENTITY_MENTIONS = 64;

  /* Operation names we archive, LOWERCASED.
   *
   * X's GraphQL URL shape is https://x.com/i/api/graphql/<queryId>/<Operation>
   * The queryId rotates (~weekly) and MUST NOT be hardcoded anywhere. The
   * operation name is the stable part, which is why matching happens here.
   *
   * 'createtweet'     : normal posts, replies, quotes, and (currently) most
   *                     long-form posts.
   * 'createnotetweet' : the variant X routes oversized Premium long-form posts
   *                     to. It is the same user-initiated publish action, so it
   *                     is archived too. Delete this entry if you want strictly
   *                     CreateTweet-only behaviour.
   *
   * This array is the ONLY place that decides what counts as "a post".
   */
  const CREATE_OPERATIONS = ['createtweet', 'createnotetweet'];

  /* Pure retweets (`CreateRetweet`) are deliberately NOT matched.
   *
   * This was an opt-in feature and was removed: the response returns nothing
   * but the new retweet's own id, so a "retweet record" could never contain the
   * original's text, author, media or timestamp — the original id has to be
   * scavenged from the request body, and X does not re-fetch the original
   * either. What you got was an empty row pointing at somebody else's post.
   *
   * Do not re-add it without a way to capture the original, because a
   * content-free record in a personal archive is worse than no record.
   */

  /* Deleting one of your own posts. This is not archived as a new record — it
   * MARKS the record already in the archive, because for an archive "I said
   * this and then removed it" is the interesting fact, and throwing the row
   * away would destroy the only copy.
   *
   * Verified from X's own API client (the method table in main.<hash>.js):
   *   destroy(e) { return t.graphQL(DeleteTweet, { tweet_id: e.id }) }
   * Note it passes NO response selector — unlike retweet/bookmark, which check
   * create_retweet / tweet_bookmark_put. X itself only looks at GraphQL errors,
   * and the string "delete_tweet" appears nowhere in the bundles, so there is
   * no success field to read. Success is therefore exactly what it is for X:
   * a 2xx response carrying no errors.
   */
  const DELETE_OPERATIONS = ['deletetweet'];

  const ALL_OPERATIONS = CREATE_OPERATIONS.concat(DELETE_OPERATIONS);

  /* Reading your own profile makes X fetch your posts — including the ones
   * published from the phone, which this browser can never observe directly.
   *
   * This is the one place the extension listens to something other than a
   * publish or a delete, and it is a QUERY rather than a mutation. It is safe
   * for a reason that does not generalise to other queries: the page was making
   * this exact request anyway, so the extension issues nothing, adds no traffic,
   * and touches no credential. It simply reads a response that already exists.
   *
   * The response is not filtered to you — a timeline response also carries
   * "who to follow" cards and any post you quoted. Nothing is archived until the
   * author id matches an account this browser has been seen to publish from, so
   * on a fresh install the sweep is inert until the first post is made here.
   */
  const TIMELINE_OPERATIONS = ['useroriginalstimeline'];

  /* The Replies tab, reached from the same profile page.
   *
   * Structurally it is the same query — identical response path, identical
   * tweet shape — so it costs almost nothing to read. The difference is what
   * comes back: nearly every entry is a conversation module holding BOTH sides
   * of the exchange. Measured on a real response, 31 tweets of which only 22
   * were the account's own, so the author filter is doing real work here rather
   * than being a formality.
   *
   * Off unless asked for: switching this on can add a great many rows to the
   * archive at once, and that is a choice the archive's owner should make
   * rather than find out about afterwards.
   */
  const REPLY_TIMELINE_OPERATIONS = ['userrepliestimeline'];

  /* The focal tweet's own page.
   *
   * Opening https://x.com/<user>/status/<id> makes X fetch that one post with
   * its FULL entity set, which is exactly what a swept record is missing:
   * measured on the real sweep response next to this, 22 of its 24 tweets carry
   * no `urls` at all and 15 carry an `entities` object with no keys in it. The
   * post's text keeps the t.co shortlink, but nothing says where that shortlink
   * pointed — and t.co stops resolving once the post ages, so the address is
   * gone for good. This reads it back while the page is showing it anyway.
   *
   * Same principle as the timeline sweep, and it is safe for the same reason:
   * the page was making this request on its own, so the extension issues
   * nothing, adds no traffic and touches no credential.
   *
   * `TweetDetail` fires on the same page and carries the same tweet, but also a
   * whole conversation — `TweetResultByRestId` is one tweet with nothing to
   * filter, so it is the one read here.
   */
  const DETAIL_OPERATIONS = ['tweetresultbyrestid'];

  /** Guard against a pathological response; no real timeline page approaches this. */
  const MAX_TIMELINE_NODES = 200000;
  const MAX_TIMELINE_TWEETS = 500;

  /* ------------------------------------------------------------------ */
  /* Diagnostics (primitives only, never credentials)                    */
  /* ------------------------------------------------------------------ */

  const diag = {
    hookInstalled: false,
    xhrHookInstalled: false,
    hookOverwritten: false,
    createTweetSeen: 0,
    // A delete is not a CreateTweet, so counting the two together would report
    // a delete as a post the hook saw and then failed to archive.
    deleteSeen: 0,
    deleted: 0,
    // Counted apart from createTweetSeen: a timeline sweep did not observe a
    // publish, and folding the two together would report one publish as several.
    timelineSeen: 0,
    timelineKept: 0,
    // And apart from the timeline pair again: opening one post is not a sweep,
    // and a detail page reports nothing about the profile it was opened from.
    detailSeen: 0,
    detailKept: 0,
    requestBodyRead: 0,
    requestBodyFailed: 0,
    responseCloneFailed: 0,
    responseJsonFailed: 0,
    parseFailed: 0,
    parsed: 0,
    posted: 0,
    postFailed: 0,
    lastError: null,
    lastErrorAt: null
  };

  let debugEnabled = false;

  function log() {
    if (!debugEnabled) return;
    try {
      // eslint-disable-next-line no-console
      console.debug('[X Tweet Backup]', ...arguments);
    } catch (_) { /* ignore */ }
  }

  function warn() {
    try {
      // eslint-disable-next-line no-console
      console.warn('[X Tweet Backup]', ...arguments);
    } catch (_) { /* ignore */ }
  }

  function recordError(where, err) {
    let message;
    try {
      message = (err && err.message) ? String(err.message) : String(err);
    } catch (_) {
      message = 'unknown error';
    }
    diag.lastError = where + ': ' + message.slice(0, 300);
    diag.lastErrorAt = new Date().toISOString();
    if (debugEnabled) warn(where, err);
    scheduleDiag();
  }

  function snapshotDiag() {
    return {
      hookInstalled: diag.hookInstalled,
      xhrHookInstalled: diag.xhrHookInstalled,
      hookOverwritten: diag.hookOverwritten,
      createTweetSeen: diag.createTweetSeen,
      deleteSeen: diag.deleteSeen,
      deleted: diag.deleted,
      timelineSeen: diag.timelineSeen,
      timelineKept: diag.timelineKept,
      detailSeen: diag.detailSeen,
      detailKept: diag.detailKept,
      requestBodyRead: diag.requestBodyRead,
      requestBodyFailed: diag.requestBodyFailed,
      responseCloneFailed: diag.responseCloneFailed,
      responseJsonFailed: diag.responseJsonFailed,
      parseFailed: diag.parseFailed,
      parsed: diag.parsed,
      posted: diag.posted,
      postFailed: diag.postFailed,
      lastError: diag.lastError,
      lastErrorAt: diag.lastErrorAt
    };
  }

  /* ------------------------------------------------------------------ */
  /* Bridge to the ISOLATED world                                        */
  /* ------------------------------------------------------------------ */

  let sessionToken = null;
  const preHandshakeQueue = [];
  let diagTimer = null;
  /** Set when the ISOLATED world reports that the extension side is gone. */
  let bridgeDead = false;

  function safeOrigin() {
    try {
      const o = window.location.origin;
      if (typeof o === 'string' && o && o !== 'null') return o;
    } catch (_) { /* ignore */ }
    return '*';
  }

  /**
   * The exact envelope post() puts on the wire. Shared with the backfill
   * chunker, which has to know what a message will weigh BEFORE sending it:
   * the bridge limit applies to this finished shape, envelope included.
   */
  function bridgeMessage(type, payload) {
    return {
      __xtb: true,
      source: PAGE_SOURCE,
      type: type,
      token: sessionToken,
      payload: payload
    };
  }

  /** Returns true when the message actually reached the bridge. */
  function post(type, payload) {
    // The extension side is gone from this page; posting is pointless until the
    // user refreshes. The warning was already logged when we found out.
    if (bridgeDead) return false;

    if (sessionToken === null) {
      if (preHandshakeQueue.length < MAX_QUEUE) {
        preHandshakeQueue.push({ type: type, payload: payload });
      }
      return false;
    }
    try {
      const message = bridgeMessage(type, payload);
      let serialized;
      try {
        serialized = JSON.stringify(message);
      } catch (err) {
        diag.postFailed++;
        recordError('postMessage serialize', err);
        return false;
      }
      if (serialized.length > MAX_BRIDGE_BYTES) {
        diag.postFailed++;
        recordError('postMessage', 'payload exceeds ' + MAX_BRIDGE_BYTES + ' bytes');
        return false;
      }
      window.postMessage(message, safeOrigin());
      return true;
    } catch (err) {
      diag.postFailed++;
      recordError('postMessage', err);
      return false;
    }
  }

  function flushQueue() {
    while (preHandshakeQueue.length > 0) {
      const item = preHandshakeQueue.shift();
      post(item.type, item.payload);
    }
  }

  function scheduleDiag() {
    if (diagTimer !== null) return;
    try {
      diagTimer = setTimeout(() => {
        diagTimer = null;
        post('XTB_DIAG', snapshotDiag());
      }, 400);
    } catch (_) {
      diagTimer = null;
    }
  }

  function onBridgeMessage(event) {
    try {
      if (event.source !== window) return;
      const expectedOrigin = safeOrigin();
      if (expectedOrigin !== '*' && event.origin !== expectedOrigin) return;
      const data = event.data;
      if (!isObject(data) || data.__xtb !== true) return;
      if (data.source !== BRIDGE_SOURCE) return;

      if (data.type === 'XTB_HELLO') {
        if (typeof data.token !== 'string' || data.token.length < 8) return;
        // A token is accepted only while none is set — i.e. only to establish the
        // session. content.js stops sending after its five retries, so a HELLO
        // arriving later could only come from the page, and re-keying the bridge
        // here would make every subsequent message fail the token check in BOTH
        // directions, silently, for the rest of the page's life. Ignoring it
        // costs nothing: the handshake it offers is already done.
        if (sessionToken !== null) return;
        sessionToken = data.token;
        if (typeof data.debug === 'boolean') debugEnabled = data.debug;
        adoptOwnAuthors(data.ownAuthorIds);
        if (typeof data.captureReplies === 'boolean') captureReplies = data.captureReplies;
        post('XTB_READY', {
          hookInstalled: diag.hookInstalled,
          operations: ALL_OPERATIONS.concat(TIMELINE_OPERATIONS)
            .concat(REPLY_TIMELINE_OPERATIONS).concat(DETAIL_OPERATIONS)
        });
        flushQueue();
        return;
      }

      if (data.type === 'XTB_CONFIG') {
        if (typeof data.debug === 'boolean') debugEnabled = data.debug;
        adoptOwnAuthors(data.ownAuthorIds);
        if (typeof data.captureReplies === 'boolean') captureReplies = data.captureReplies;
        return;
      }

      if (data.type === 'XTB_REJECTED') {
        // The record was parsed here but the extension refused to store it.
        // Record why, so the popup's diagnostics panel shows it.
        const reason = nonEmptyString(data.reason) || 'unknown';
        diag.lastError = 'background rejected: ' + reason;
        diag.lastErrorAt = new Date().toISOString();
        if (debugEnabled) warn('background rejected the record:', reason);
        scheduleDiag();
        return;
      }

      if (data.type === 'XTB_BRIDGE_DEAD') {
        // Always warned, regardless of debug mode: this is a data-loss
        // condition, not a debugging nicety.
        if (!bridgeDead) {
          bridgeDead = true;
          // Bilingual: the MAIN world has no access to chrome.i18n, so this
          // cannot be localised the normal way.
          warn('[X Tweet Backup] 备份通道已失效：扩展被重新加载或更新过。' +
               '请刷新本页面（F5）恢复备份 —— 在此之前，本页面发布的推文不会被保存。\n' +
               '[X Tweet Backup] Backup channel is dead: the extension was reloaded or updated. ' +
               'Press F5 on this page to restore it. Posts published here until then are NOT saved.');
        }
        return;
      }

      // Anything else from the page is ignored on purpose: this channel does
      // not accept commands, it only emits observations.
    } catch (err) {
      recordError('onBridgeMessage', err);
    }
  }

  try {
    window.addEventListener('message', onBridgeMessage, false);
  } catch (err) {
    recordError('addEventListener', err);
  }

  /* ------------------------------------------------------------------ */
  /* Type helpers — every field is checked, optional chaining alone is   */
  /* not enough because a node may flip from object to null/array/string */
  /* ------------------------------------------------------------------ */

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function asObject(value) {
    return isObject(value) ? value : null;
  }

  function asArray(value) {
    return Array.isArray(value) ? value : null;
  }

  function asString(value) {
    return typeof value === 'string' ? value : null;
  }

  function nonEmptyString(value) {
    const s = asString(value);
    return (s !== null && s.length > 0) ? s : null;
  }

  function asFiniteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length > 0) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function asBoolOrNull(value) {
    return typeof value === 'boolean' ? value : null;
  }

  /** Walk a chain of object keys; returns undefined if any hop is not an object. */
  function walk(start, keys) {
    let current = start;
    for (let i = 0; i < keys.length; i++) {
      const obj = asObject(current);
      if (obj === null) return undefined;
      current = obj[keys[i]];
    }
    return current;
  }

  function firstStringFromPaths(root, paths) {
    for (let i = 0; i < paths.length; i++) {
      const raw = walk(root, paths[i]);
      const s = nonEmptyString(raw);
      if (s !== null) return s;
    }
    return null;
  }

  function normalizeTweetId(value) {
    let s = null;
    if (typeof value === 'string') s = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) s = String(value);
    if (s === null) return null;
    s = s.trim();
    return /^[0-9]{1,25}$/.test(s) ? s : null;
  }

  function clampText(value) {
    const s = asString(value);
    if (s === null) return null;
    return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) : s;
  }

  /* ------------------------------------------------------------------ */
  /* URL / request analysis                                              */
  /* ------------------------------------------------------------------ */

  function isXHost(hostname) {
    const h = hostname.toLowerCase();
    return h === 'x.com' || h.endsWith('.x.com') ||
           h === 'twitter.com' || h.endsWith('.twitter.com');
  }

  /**
   * Decide whether a request is a CreateTweet POST.
   * Parses the URL properly instead of substring-matching the whole string,
   * and never looks at a hardcoded queryId.
   */
  function analyzeRequestUrl(rawUrl, method) {
    if (typeof method !== 'string') return null;
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;

    const upperMethod = method.toUpperCase();
    if (upperMethod !== 'POST' && upperMethod !== 'GET') return null;

    let url;
    try {
      url = new URL(rawUrl);
    } catch (_) {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!isXHost(url.hostname)) return null;

    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    const graphqlIndex = segments.indexOf('graphql');
    if (graphqlIndex === -1) return null;
    if (graphqlIndex + 2 > segments.length - 1) return null;

    const queryId = segments[graphqlIndex + 1];
    const operationName = segments[graphqlIndex + 2];
    if (!queryId || !operationName) return null;

    const lower = operationName.toLowerCase();
    const isReplyTimeline = REPLY_TIMELINE_OPERATIONS.indexOf(lower) !== -1;
    if (isReplyTimeline && !captureReplies) return null;
    const isTimeline = TIMELINE_OPERATIONS.indexOf(lower) !== -1 || isReplyTimeline;
    const isDetail = DETAIL_OPERATIONS.indexOf(lower) !== -1;

    // A publish or a delete is always a POST. Matching those names on a GET
    // would mean the operation is not what we think it is, so they are kept
    // strictly POST-only; the two queries are the GETs that are wanted.
    if (isTimeline || isDetail) {
      if (upperMethod !== 'GET') return null;
    } else if (upperMethod !== 'POST' || ALL_OPERATIONS.indexOf(lower) === -1) {
      return null;
    }

    return {
      queryId: queryId,
      operationName: operationName,
      isDelete: DELETE_OPERATIONS.indexOf(lower) !== -1,
      isTimeline: isTimeline,
      isDetail: isDetail
    };
  }

  /**
   * Collect method/url (and, when safe, a copy of the body) WITHOUT disturbing
   * anything the page is about to send.
   *
   * Body policy:
   *   - Request object           -> Request.clone() (the original stays intact)
   *   - fetch(url, {body: str})  -> reuse the string, nothing is consumed
   *   - ReadableStream/FormData/Blob bodies are NOT touched at all, because
   *     constructing a Request around them can lock the stream and break the
   *     page's own request.
   */
  function buildRequestInfo(input, init) {
    const info = {
      isCreateTweet: false,
      isDelete: false,
      isDetail: false,
      url: null,
      method: 'GET',
      queryId: null,
      operationName: null,
      bodyClone: null,
      bodyString: null
    };

    try {
      const initObject = isObject(init) ? init : null;
      const initMethod = initObject ? asString(initObject.method) : null;
      const initBody = initObject ? initObject.body : undefined;

      const hasRequestCtor = typeof Request !== 'undefined';

      if (hasRequestCtor && typeof Request === 'function' && input instanceof Request) {
        info.method = initMethod !== null ? initMethod : (asString(input.method) || 'GET');
        info.url = asString(input.url);
      } else {
        info.method = initMethod !== null ? initMethod : 'GET';
        if (typeof input === 'string') {
          info.url = new URL(input, window.location.href).href;
        } else if (input && typeof input === 'object' && typeof input.url === 'string') {
          info.url = input.url;
        } else {
          info.url = String(input);
        }
      }

      const analysis = analyzeRequestUrl(info.url, info.method);
      if (analysis === null) return info;

      info.isCreateTweet = true;
      info.isDelete = analysis.isDelete === true;
      info.isDetail = analysis.isDetail === true;
      info.queryId = analysis.queryId;
      info.operationName = analysis.operationName;

      // Prefer the literal body when it is a plain string (init.body wins over
      // the Request's own body, matching fetch semantics).
      if (typeof initBody === 'string') {
        info.bodyString = initBody;
      } else if (initBody === undefined || initBody === null) {
        if (hasRequestCtor && typeof Request === 'function' && input instanceof Request) {
          try {
            info.bodyClone = input.clone();
          } catch (err) {
            diag.requestBodyFailed++;
            log('request clone unavailable (streamed body?)', err);
          }
        }
      } else if (typeof URLSearchParams !== 'undefined' && initBody instanceof URLSearchParams) {
        info.bodyString = initBody.toString();
      }
      // Any other body type is deliberately left alone.
    } catch (err) {
      diag.requestBodyFailed++;
      log('buildRequestInfo failed', err);
    }

    return info;
  }

  /**
   * Pull the GraphQL variables out of a CreateTweet request body.
   * Shared by both transports (fetch and XHR). Purely auxiliary: request-side
   * data can never trigger a save on its own.
   */
  function parseVariablesFromBody(text) {
    const s = asString(text);
    if (s === null || s.length === 0) return null;

    try {
      const parsed = JSON.parse(s);
      if (isObject(parsed)) {
        // Callers want the GraphQL *variables*, not the envelope. Some payloads
        // carry them at the root, so fall back to the root object.
        const variables = asObject(parsed.variables);
        return variables !== null ? variables : parsed;
      }
    } catch (_) { /* not JSON, try form encoding */ }

    try {
      const params = new URLSearchParams(s);
      const variables = params.get('variables');
      if (typeof variables === 'string') {
        const parsed = JSON.parse(variables);
        if (isObject(parsed)) return parsed;
      }
    } catch (_) { /* not form encoded either */ }

    return null;
  }

  /**
   * Read the CreateTweet variables for FALLBACK use only.
   * Request-side data can never trigger a save on its own.
   */
  function readRequestVariables(info) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const timer = setTimeout(() => {
        diag.requestBodyFailed++;
        finish(null);
      }, BODY_READ_TIMEOUT_MS);

      const done = (payload) => {
        clearTimeout(timer);
        finish(payload);
      };

      try {
        if (typeof info.bodyString === 'string') {
          diag.requestBodyRead++;
          done(parseVariablesFromBody(info.bodyString));
          return;
        }
        if (info.bodyClone && typeof info.bodyClone.text === 'function') {
          info.bodyClone.text().then(
            (text) => {
              diag.requestBodyRead++;
              done(parseVariablesFromBody(text));
            },
            (err) => {
              diag.requestBodyFailed++;
              log('request body read failed', err);
              done(null);
            }
          );
          return;
        }
      } catch (err) {
        diag.requestBodyFailed++;
        log('readRequestVariables failed', err);
      }

      clearTimeout(timer);
      finish(null);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Response parsing                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Candidate containers that may hold the created tweet "result" node.
   * Ordered most-likely first. Every hop is type-checked.
   */
  /**
   * Response envelopes that can carry a newly created post.
   *
   * These do NOT follow the operation name, which is exactly what made this
   * hard to guess. Verified against live traffic:
   *
   *   operation CreateTweet      -> data.create_tweet
   *   operation CreateNoteTweet  -> data.notetweet_create   <-- not "create_note_tweet"
   *
   * The other entries are kept as fallbacks for shapes seen in older clients.
   *
   * There is deliberately no `create_retweet` entry: CreateRetweet is not a
   * matched operation (see CREATE_OPERATIONS), so no response that reaches this
   * parser can carry that key — it could only ever have matched a forged one.
   */
  const CREATE_RESULT_KEYS = [
    'create_tweet',
    'notetweet_create',
    'create_note_tweet',
    'CreateTweet'
  ];

  function findCreateNode(data) {
    for (let i = 0; i < CREATE_RESULT_KEYS.length; i++) {
      const node = asObject(data[CREATE_RESULT_KEYS[i]]);
      if (node !== null) return node;
    }
    return null;
  }

  function collectResultCandidates(data) {
    const out = [];

    const push = (value) => {
      const obj = asObject(value);
      if (obj !== null) out.push(obj);
    };

    const createNode = findCreateNode(data);

    const tweetResults = createNode ? asObject(createNode.tweet_results) : null;
    const primary = tweetResults ? asObject(tweetResults.result) : null;

    push(primary);
    if (primary) {
      push(walk(primary, ['tweet_results', 'result']));
      push(primary.tweet);
      push(primary.result);
    }

    push(walk(createNode, ['tweet_result', 'result']));
    push(walk(data, ['tweet_results', 'result']));
    push(walk(data, ['tweet_result', 'result']));
    if (createNode) push(createNode.result);
    push(createNode);

    return out;
  }

  /**
   * A "result" node is only accepted when it really is a created tweet:
   * it must carry a numeric rest_id and must not be a tombstone/error node.
   */
  function extractTweetId(result) {
    const candidates = [
      result.rest_id,
      walk(result, ['legacy', 'id_str']),
      result.id_str
    ];
    for (let i = 0; i < candidates.length; i++) {
      const id = normalizeTweetId(candidates[i]);
      if (id !== null) return id;
    }

    // Distinguish "no id at all" from "the id arrived as a JSON number too
    // large for a double". Snowflake ids exceed Number.MAX_SAFE_INTEGER, so
    // coercing one would silently store a WRONG id and a broken permalink.
    // Refuse it, and make the reason visible in the diagnostics panel.
    const raw = result.rest_id;
    if (typeof raw === 'number' && Number.isFinite(raw) && !Number.isSafeInteger(raw)) {
      recordError('extractTweetId',
        'rest_id arrived as an unsafe JSON number (' + raw + '); refusing a lossy id');
    }
    return null;
  }

  function looksLikeBadNode(result) {
    const typename = asString(result.__typename);
    if (typename !== null && /tombstone|tweettombstone|tweetunavailable/i.test(typename)) return true;
    if (isObject(result.tombstone)) return true;
    if (isObject(result.tweet_tombstone)) return true;
    // A node containing only an error is not a tweet.
    if (result.rest_id === undefined && isObject(walk(result, ['legacy', 'error']))) return true;
    return false;
  }

  /* Long-form text lives in note_tweet and outranks the possibly truncated
   * legacy.full_text. */
  const NOTE_TEXT_PATHS = [
    ['note_tweet', 'note_tweet_results', 'result', 'text'],
    ['legacy', 'note_tweet', 'note_tweet_results', 'result', 'text'],
    ['note_tweet_results', 'result', 'text'],
    ['tweet', 'note_tweet', 'note_tweet_results', 'result', 'text']
  ];

  const LEGACY_TEXT_PATHS = [
    ['legacy', 'full_text'],
    ['full_text'],
    ['legacy', 'text'],
    ['tweet', 'legacy', 'full_text']
  ];

  /**
   * X represents a media-only post as full_text = "https://t.co/<media>" plus
   * display_text_range [0,0], meaning "no user-authored text is displayed".
   * Archiving that link as the tweet text would be wrong: the user typed
   * nothing, and the real image URL already lives in media[].
   *
   * ONLY a zero-width range counts as empty. A reply's leading @mentions are
   * hidden by a NON-ZERO range start (e.g. "@bob hi" -> [5,8]) and must stay in
   * the archived text — this is an archive of what was published, not a copy of
   * what the UI chooses to render.
   */
  function hasNoDisplayText(legacy) {
    const range = asArray(legacy ? legacy.display_text_range : undefined);
    if (range === null || range.length !== 2) return false;
    return asFiniteNumber(range[0]) === 0 && asFiniteNumber(range[1]) === 0;
  }

  const MEDIA_PATHS = [
    ['legacy', 'extended_entities', 'media'],
    ['legacy', 'entities', 'media'],
    ['extended_entities', 'media'],
    ['entities', 'media'],
    ['tweet', 'legacy', 'extended_entities', 'media']
  ];

  /**
   * X appends a t.co placeholder for every attached media item to full_text.
   * Observed live: "@user the actual text https://t.co/33Q3ctjQCE".
   *
   * The published text is what remains once those placeholders are removed; the
   * real media URL is archived separately in media[]. A placeholder is only cut
   * when the entity's OWN indices cover a slice that literally starts with that
   * entity's `url`, so a malformed or absent index can never eat real text.
   */
  function stripMediaPlaceholders(text, result) {
    const s = asString(text);
    if (s === null || s.length === 0) return text;

    const ranges = [];

    for (let p = 0; p < MEDIA_PATHS.length && ranges.length === 0; p++) {
      const list = asArray(walk(result, MEDIA_PATHS[p]));
      if (list === null || list.length === 0) continue;

      const limit = Math.min(list.length, MAX_MEDIA_ITEMS);
      for (let i = 0; i < limit; i++) {
        const item = asObject(list[i]);
        if (item === null) continue;

        const indices = asArray(item.indices);
        if (indices === null || indices.length !== 2) continue;

        const start = asFiniteNumber(indices[0]);
        const end = asFiniteNumber(indices[1]);
        if (start === null || end === null) continue;
        if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
        if (start < 0 || end > s.length || start >= end) continue;

        const mediaUrl = nonEmptyString(item.url);
        if (mediaUrl === null) continue;
        if (s.slice(start, end).indexOf(mediaUrl) !== 0) continue;

        ranges.push([start, end]);
      }
    }

    if (ranges.length === 0) return s;

    // Cut from the end backwards so earlier indices stay valid.
    ranges.sort((a, b) => b[0] - a[0]);
    let out = s;
    for (let i = 0; i < ranges.length; i++) {
      out = out.slice(0, ranges[i][0]) + out.slice(ranges[i][1]);
    }
    return out.replace(/\s+$/, '');
  }

  function extractText(result, legacy) {
    const noteText = firstStringFromPaths(result, NOTE_TEXT_PATHS);
    if (noteText !== null) return clampText(noteText);
    if (hasNoDisplayText(legacy)) return null;

    const legacyText = firstStringFromPaths(result, LEGACY_TEXT_PATHS);
    if (legacyText === null) return null;

    // Only the legacy path is stripped: media indices index into full_text, and
    // what they mean for a note_tweet body is unverified, so that path is left
    // untouched rather than guessed at.
    return clampText(stripMediaPlaceholders(legacyText, result));
  }

  function extractMedia(result) {
    let list = null;
    for (let i = 0; i < MEDIA_PATHS.length; i++) {
      const found = asArray(walk(result, MEDIA_PATHS[i]));
      if (found !== null && found.length > 0) {
        list = found;
        break;
      }
    }
    if (list === null) return [];

    const out = [];
    const limit = Math.min(list.length, MAX_MEDIA_ITEMS);
    for (let i = 0; i < limit; i++) {
      const item = normalizeMedia(list[i]);
      if (item !== null) out.push(item);
    }
    return out;
  }

  function normalizeMedia(raw) {
    const media = asObject(raw);
    if (media === null) return null;

    const url = nonEmptyString(media.media_url_https) || nonEmptyString(media.media_url);
    const id = normalizeTweetId(media.id_str) || normalizeTweetId(media.id) ||
               nonEmptyString(media.media_key);

    let thumbnailUrl = null;
    if (url !== null) {
      thumbnailUrl = url + (url.indexOf('?') === -1 ? '?' : '&') + 'name=small';
    }

    const originalInfo = asObject(media.original_info);
    let width = originalInfo ? asFiniteNumber(originalInfo.width) : null;
    let height = originalInfo ? asFiniteNumber(originalInfo.height) : null;
    if (width === null || height === null) {
      const large = asObject(walk(media, ['sizes', 'large']));
      if (large) {
        if (width === null) width = asFiniteNumber(large.w);
        if (height === null) height = asFiniteNumber(large.h);
      }
    }

    const videoInfo = asObject(media.video_info);
    const variants = [];
    if (videoInfo) {
      const rawVariants = asArray(videoInfo.variants);
      if (rawVariants !== null) {
        for (let i = 0; i < rawVariants.length && i < 32; i++) {
          const v = asObject(rawVariants[i]);
          if (v === null) continue;
          const variantUrl = nonEmptyString(v.url);
          if (variantUrl === null) continue;
          variants.push({
            url: variantUrl,
            bitrate: asFiniteNumber(v.bitrate),
            contentType: nonEmptyString(v.content_type)
          });
        }
      }
    }

    let aspectRatio = null;
    if (videoInfo) {
      const rawRatio = asArray(videoInfo.aspect_ratio);
      if (rawRatio !== null && rawRatio.length === 2) {
        const w = asFiniteNumber(rawRatio[0]);
        const h = asFiniteNumber(rawRatio[1]);
        if (w !== null && h !== null) aspectRatio = [w, h];
      }
    }

    const altText = nonEmptyString(media.ext_alt_text) ||
                    nonEmptyString(walk(media, ['ext_alt_text']));

    return {
      id: id,
      mediaKey: nonEmptyString(media.media_key),
      type: nonEmptyString(media.type),
      url: url,
      thumbnailUrl: thumbnailUrl,
      width: width,
      height: height,
      altText: altText,
      durationMs: videoInfo ? asFiniteNumber(videoInfo.duration_millis) : null,
      aspectRatio: aspectRatio,
      variants: variants
    };
  }

  /* ------------------------------------------------------------------ entities */

  /* Where the link / hashtag / mention lists live. Long-form posts carry their
   * own `entity_set` instead of (or as well as) `legacy.entities`, and it holds
   * the same three lists, so both shapes are read the same way. */
  const ENTITY_PATHS = [
    ['legacy', 'entities'],
    ['entities'],
    ['note_tweet', 'note_tweet_results', 'result', 'entity_set'],
    ['legacy', 'note_tweet', 'note_tweet_results', 'result', 'entity_set'],
    ['note_tweet_results', 'result', 'entity_set'],
    ['tweet', 'legacy', 'entities']
  ];

  /**
   * One entry of an entity container's `urls` list, or null when it carries
   * nothing usable. The single definition of what a stored link entity looks
   * like — the focal-tweet reader below builds the same shape through it, so a
   * record filled from a detail page and one captured at publish time stay
   * indistinguishable to every reader.
   */
  function normalizeEntityUrl(raw) {
    const item = asObject(raw);
    if (item === null) return null;
    const shortUrl = nonEmptyString(item.url);
    const expandedUrl = nonEmptyString(item.expanded_url);
    if (shortUrl === null && expandedUrl === null) return null;
    return {
      url: shortUrl,
      expandedUrl: expandedUrl,
      displayUrl: nonEmptyString(item.display_url)
    };
  }

  /**
   * X rewrites every link in the text to a t.co shortlink and puts the real
   * destination only in entities.urls. The shortlink resolves through X's own
   * service, so once it dies the text alone no longer says where it pointed —
   * which is why the expanded URL is archived alongside the text rather than
   * being derivable from it later.
   *
   * The text itself is NEVER rewritten: what is archived is what was published.
   */
  function extractEntities(result) {
    let source = null;
    for (let i = 0; i < ENTITY_PATHS.length; i++) {
      const found = asObject(walk(result, ENTITY_PATHS[i]));
      if (found !== null) { source = found; break; }
    }
    if (source === null) return { urls: [], hashtags: [], mentions: [] };

    const urls = [];
    const rawUrls = asArray(source.urls);
    if (rawUrls !== null) {
      const limit = Math.min(rawUrls.length, MAX_ENTITY_URLS);
      for (let i = 0; i < limit; i++) {
        const entry = normalizeEntityUrl(rawUrls[i]);
        if (entry !== null) urls.push(entry);
      }
    }

    const hashtags = [];
    const rawTags = asArray(source.hashtags);
    if (rawTags !== null) {
      const limit = Math.min(rawTags.length, MAX_ENTITY_TAGS);
      for (let i = 0; i < limit; i++) {
        const item = asObject(rawTags[i]);
        if (item === null) continue;
        const text = nonEmptyString(item.text);
        if (text !== null) hashtags.push(text);
      }
    }

    const mentions = [];
    const rawMentions = asArray(source.user_mentions);
    if (rawMentions !== null) {
      const limit = Math.min(rawMentions.length, MAX_ENTITY_MENTIONS);
      for (let i = 0; i < limit; i++) {
        const item = asObject(rawMentions[i]);
        if (item === null) continue;
        const screenName = nonEmptyString(item.screen_name);
        const name = nonEmptyString(item.name);
        if (screenName === null && name === null) continue;
        mentions.push({
          id: normalizeTweetId(item.id_str),
          screenName: screenName,
          name: name
        });
      }
    }

    return { urls: urls, hashtags: hashtags, mentions: mentions };
  }

  function extractLang(result, legacy) {
    const fromLegacy = legacy ? nonEmptyString(legacy.lang) : null;
    return fromLegacy !== null ? fromLegacy : nonEmptyString(walk(result, ['lang']));
  }

  function extractAuthor(result) {
    const userResult = asObject(walk(result, ['core', 'user_results', 'result'])) ||
                       asObject(walk(result, ['user_results', 'result']));

    let id = null;
    let screenName = null;
    let name = null;
    let avatarUrl = null;

    if (userResult !== null) {
      id = normalizeTweetId(userResult.rest_id) ||
           normalizeTweetId(walk(userResult, ['legacy', 'id_str']));
      screenName = nonEmptyString(walk(userResult, ['legacy', 'screen_name'])) ||
                   nonEmptyString(walk(userResult, ['core', 'screen_name'])) ||
                   nonEmptyString(userResult.screen_name);
      name = nonEmptyString(walk(userResult, ['legacy', 'name'])) ||
             nonEmptyString(walk(userResult, ['core', 'name'])) ||
             nonEmptyString(userResult.name);
      avatarUrl = nonEmptyString(walk(userResult, ['legacy', 'profile_image_url_https'])) ||
                  nonEmptyString(walk(userResult, ['avatar', 'image_url']));
    }

    const legacy = asObject(result.legacy);
    if (id === null && legacy) id = normalizeTweetId(legacy.user_id_str);

    return { id: id, screenName: screenName, name: name, avatarUrl: avatarUrl };
  }

  function extractMetrics(result) {
    const legacy = asObject(result.legacy) || {};
    const views = asObject(result.views);
    return {
      likeCount: asFiniteNumber(legacy.favorite_count),
      retweetCount: asFiniteNumber(legacy.retweet_count),
      replyCount: asFiniteNumber(legacy.reply_count),
      quoteCount: asFiniteNumber(legacy.quote_count),
      bookmarkCount: asFiniteNumber(legacy.bookmark_count),
      viewCount: views ? asFiniteNumber(views.count) : null
    };
  }

  function extractQuoteTweetId(result, variables) {
    const fromLegacy = normalizeTweetId(walk(result, ['legacy', 'quoted_status_id_str']));
    if (fromLegacy !== null) return fromLegacy;
    const fromResult = normalizeTweetId(walk(result, ['quoted_status_result', 'result', 'rest_id']));
    if (fromResult !== null) return fromResult;

    // Fallback: the composer puts the quoted permalink in attachment_url.
    const attachmentUrl = variables ? nonEmptyString(variables.attachment_url) : null;
    if (attachmentUrl !== null) {
      const match = /\/status\/([0-9]{1,25})/.exec(attachmentUrl);
      if (match) return match[1];
    }
    return null;
  }

  /* ------------------------------------------------------------------ polls */

  /**
   * Verbatim port of X's own isPollCard() card-name test. Two shapes exist in
   * X's card registry (CardNames in the client bundle):
   *
   *   "poll2choice_text_only"                  plain, must start with "poll"
   *   "1906814671912599552:poll_choice_images" id-prefixed, so the SECOND
   *                                            colon-separated part is tested
   *
   * The prefix test is case-sensitive and lowercase. Writing /^poll/i instead
   * would both over-match ("Poll…") and miss the id-prefixed image-poll card.
   */
  function isPollCardName(rawName) {
    const name = nonEmptyString(rawName);
    if (name === null) return false;
    if (name.indexOf(':') !== -1) {
      const parts = name.split(':');
      return parts.length === 2 && parts[1].indexOf('poll') === 0;
    }
    return name.indexOf('poll') === 0;
  }

  /**
   * binding_values reaches us in one of two shapes, and X's own code handles
   * both: the raw GraphQL transport sends an array of {key, value} entries,
   * while the client's normalised entity is a plain map of key -> value.
   * Fold both into one map so the readers below only know a single form.
   */
  function readBindingMap(raw) {
    const map = {};

    const arr = asArray(raw);
    if (arr !== null) {
      const limit = Math.min(arr.length, MAX_BINDING_VALUES);
      for (let i = 0; i < limit; i++) {
        const entry = asObject(arr[i]);
        if (entry === null) continue;
        const key = nonEmptyString(entry.key);
        const value = asObject(entry.value);
        if (key === null || value === null) continue;
        map[key] = value;
      }
      return map;
    }

    const obj = asObject(raw);
    if (obj !== null) {
      const keys = Object.keys(obj);
      const limit = Math.min(keys.length, MAX_BINDING_VALUES);
      for (let i = 0; i < limit; i++) {
        const value = asObject(obj[keys[i]]);
        if (value !== null) map[keys[i]] = value;
      }
    }
    return map;
  }

  function bindingString(map, key) {
    const value = asObject(map[key]);
    if (value === null) return null;
    return nonEmptyString(value.string_value);
  }

  function bindingBool(map, key) {
    const value = asObject(map[key]);
    if (value === null) return null;
    if (typeof value.boolean_value === 'boolean') return value.boolean_value;
    // Some cards carry the flag as the string "true"/"false" instead.
    const s = nonEmptyString(value.string_value);
    if (s === 'true') return true;
    if (s === 'false') return false;
    return null;
  }

  /* A card hangs off the tweet result, but the interesting fields sit either on
   * it directly or one level down under `legacy`, depending on which endpoint
   * produced the response. */
  const CARD_PATHS = [
    ['card'],
    ['legacy', 'card'],
    ['tweet', 'card'],
    ['tweet_results', 'result', 'card'],
    ['quoted_status_result', 'result', 'card']
  ];

  function readCard(result) {
    for (let i = 0; i < CARD_PATHS.length; i++) {
      const card = asObject(walk(result, CARD_PATHS[i]));
      if (card === null) continue;

      const legacy = asObject(card.legacy);
      const name = nonEmptyString(card.name) ||
                   (legacy !== null ? nonEmptyString(legacy.name) : null);
      const rawBindings = card.binding_values !== undefined
        ? card.binding_values
        : (legacy !== null ? legacy.binding_values : undefined);
      const bindings = readBindingMap(rawBindings);

      if (name === null && Object.keys(bindings).length === 0) continue;
      return {
        name: name,
        url: nonEmptyString(card.url) || (legacy !== null ? nonEmptyString(legacy.url) : null),
        bindings: bindings
      };
    }
    return null;
  }

  /**
   * A poll arrives as an attached card, so the card NAME is what decides that
   * this is a poll — exactly the test X's own isPollCard() applies.
   *
   * variables.card_uri is NOT that test: link previews, players and product
   * cards all attach a card_uri too. A request-side card_uri is therefore
   * recorded as "a card was attached" and nothing more. When the response does
   * not inline the card we keep the record and say the choices are missing,
   * rather than letting a poll quietly look like a plain text post.
   */
  function extractPoll(result, variables) {
    const requestCardUri = variables ? nonEmptyString(variables.card_uri) : null;
    const card = readCard(result);
    const isPollCard = card !== null && isPollCardName(card.name);

    if (requestCardUri === null && card === null) return null;

    const choices = [];
    let endDatetimeUtc = null;
    let countsAreFinal = null;

    if (isPollCard) {
      for (let i = 1; i <= MAX_POLL_CHOICES; i++) {
        const label = bindingString(card.bindings, 'choice' + i + '_label');
        if (label !== null) choices.push(label);
      }
      endDatetimeUtc = bindingString(card.bindings, 'end_datetime_utc');
      countsAreFinal = bindingBool(card.bindings, 'counts_are_final');
    }

    return {
      isPoll: isPollCard,
      cardUri: requestCardUri !== null ? requestCardUri : card.url,
      cardName: card !== null ? card.name : null,
      choices: choices,
      endDatetimeUtc: endDatetimeUtc,
      countsAreFinal: countsAreFinal,
      choicesFromResponse: choices.length > 0
    };
  }

  /* ------------------------------------------------------------------ edits */

  /**
   * Editing is NOT a separate GraphQL operation. X publishes an edit as an
   * ordinary CreateTweet / CreateNoteTweet that additionally carries
   *
   *   variables.edit_options.previous_tweet_id
   *
   * (read out of the client's own CreateTweet variable builder). The response
   * returns a NEW tweet id, and the full version chain comes back in
   * `result.edit_control`, whose edit_tweet_ids list ends with the current id —
   * the same last-element rule X's own code uses to pick a permalink.
   */
  function extractEditInfo(result, variables) {
    const options = variables ? asObject(variables.edit_options) : null;
    const editedFrom = options ? normalizeTweetId(options.previous_tweet_id) : null;

    // Two shapes are in the wild: edit_control.edit_control_initial and
    // edit_control.edit.edit_control_initial. X's client unwraps both.
    const control = asObject(result.edit_control);
    const nestedEdit = control ? asObject(control.edit) : null;
    const source = (control ? asObject(control.edit_control_initial) : null) ||
                   (nestedEdit ? asObject(nestedEdit.edit_control_initial) : null);

    const ids = [];
    const rawIds = source !== null ? asArray(source.edit_tweet_ids) : null;
    if (rawIds !== null) {
      const limit = Math.min(rawIds.length, MAX_EDIT_VERSIONS);
      for (let i = 0; i < limit; i++) {
        const id = normalizeTweetId(rawIds[i]);
        if (id !== null && ids.indexOf(id) === -1) ids.push(id);
      }
    }

    return {
      editedFrom: editedFrom,
      // A tweet whose chain holds only itself has never been edited; that is
      // exactly the test X's client applies before showing the Edited label.
      isEdit: editedFrom !== null || ids.length > 1,
      editTweetIds: ids,
      editInitialTweetId: source !== null ? normalizeTweetId(source.initial_tweet_id) : null,
      editsRemaining: source !== null ? asFiniteNumber(source.edits_remaining) : null
    };
  }

  function parseXDate(raw) {
    const s = nonEmptyString(raw);
    if (s === null) return null;
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) return null;
    try {
      return new Date(ms).toISOString();
    } catch (_) {
      return null;
    }
  }

  function buildTweetRecord(result, variables, requestInfo, httpStatus, capturedVia) {
    const id = extractTweetId(result);
    if (id === null) return null;
    if (looksLikeBadNode(result)) return null;

    const capturedAt = new Date().toISOString();
    const legacy = asObject(result.legacy);

    const responseText = extractText(result, legacy);
    const requestText = variables ? clampText(variables.tweet_text) : null;
    let text = responseText;
    let textFromRequest = false;
    if ((text === null || text.length === 0) && requestText !== null && requestText.length > 0) {
      text = requestText;
      textFromRequest = true;
    }
    if (text === null) text = '';

    const createdAtRaw = legacy ? nonEmptyString(legacy.created_at) : null;
    const createdAt = parseXDate(createdAtRaw) || capturedAt;

    const author = extractAuthor(result);

    // --- reply information: response first, request variables as fallback ---
    const varsReply = variables ? asObject(variables.reply) : null;
    const replyTweetId = (legacy ? normalizeTweetId(legacy.in_reply_to_status_id_str) : null) ||
                         (varsReply ? normalizeTweetId(varsReply.in_reply_to_tweet_id) : null);
    const replyUserId = (legacy ? normalizeTweetId(legacy.in_reply_to_user_id_str) : null) ||
                        (varsReply ? normalizeTweetId(varsReply.in_reply_to_user_id) : null);
    const replyScreenName = (legacy ? nonEmptyString(legacy.in_reply_to_screen_name) : null) ||
                            (varsReply ? nonEmptyString(varsReply.in_reply_to_screen_name) : null);

    let conversationId = legacy ? normalizeTweetId(legacy.conversation_id_str) : null;
    let conversationIdInferred = false;
    if (conversationId === null) {
      // Response did not carry it. For a top-level post the conversation is the
      // tweet itself; for a reply the best local approximation is the parent id.
      conversationId = replyTweetId !== null ? replyTweetId : id;
      conversationIdInferred = true;
    }

    const media = extractMedia(result);
    if (media.length === 0 && variables) {
      const entities = asArray(walk(variables, ['media', 'media_entities']));
      if (entities !== null) {
        const limit = Math.min(entities.length, MAX_MEDIA_ITEMS);
        for (let i = 0; i < limit; i++) {
          const entity = asObject(entities[i]);
          if (entity === null) continue;
          const mediaId = normalizeTweetId(entity.media_id) || nonEmptyString(entity.media_id);
          if (mediaId === null) continue;
          media.push({
            id: mediaId,
            mediaKey: nonEmptyString(entity.media_key),
            type: null,
            url: null,
            thumbnailUrl: null,
            width: null,
            height: null,
            altText: null,
            durationMs: null,
            aspectRatio: null,
            variants: []
          });
        }
      }
    }

    const quoteTweetId = extractQuoteTweetId(result, variables);
    const edit = extractEditInfo(result, variables);
    const poll = extractPoll(result, variables);
    const entities = extractEntities(result);
    const lang = extractLang(result, legacy);
    const screenName = author.screenName;
    const tweetUrl = screenName !== null
      ? 'https://x.com/' + screenName + '/status/' + id
      : 'https://x.com/i/web/status/' + id;

    return {
      id: id,
      text: text,
      lang: lang,
      createdAt: createdAt,
      createdAtRaw: createdAtRaw,
      capturedAt: capturedAt,
      tweetUrl: tweetUrl,
      isReply: replyTweetId !== null,
      // Retweets are never captured (see CREATE_OPERATIONS), so these are
      // always false/null on a new record. They stay in the shape because
      // records archived before the feature was removed still carry them, and
      // the list renders that badge from the stored value.
      isRetweet: false,
      retweetedTweetId: null,
      isEdit: edit.isEdit,
      editedFrom: edit.editedFrom,
      editTweetIds: edit.editTweetIds,
      editInitialTweetId: edit.editInitialTweetId,
      editsRemaining: edit.editsRemaining,
      isPoll: poll !== null && poll.isPoll === true,
      poll: poll,
      replyTo: {
        tweetId: replyTweetId,
        userId: replyUserId,
        screenName: replyScreenName
      },
      conversationId: conversationId,
      conversationIdInferred: conversationIdInferred,
      quoteTweetId: quoteTweetId,
      author: author,
      entities: entities,
      media: media,
      metrics: extractMetrics(result),
      source: {
        operationName: requestInfo.operationName,
        queryId: requestInfo.queryId,
        capturedVia: capturedVia === 'xhr' ? 'xhr' : 'fetch',
        httpStatus: httpStatus,
        textFromRequest: textFromRequest,
        // Set to true by the timeline path below. A backfilled row was not
        // witnessed at publish time, so its capturedAt is the sweep time and it
        // may lack fields the publish path would have had.
        backfilled: false,
        tombstone: false
      },
      schemaVersion: 2
    };
  }

  function hasGraphqlErrors(value) {
    if (value === undefined || value === null) return false;
    const arr = asArray(value);
    if (arr !== null) return arr.length > 0;
    const obj = asObject(value);
    if (obj !== null) return Object.keys(obj).length > 0;
    return false;
  }

  /**
   * Turn a GraphQL errors node into a short, non-sensitive description.
   * These are X's own status strings ("You already sent this Tweet." etc.),
   * never credentials, and they make a rejection diagnosable instead of opaque.
   */
  function describeGraphqlErrors(value) {
    const arr = asArray(value);
    if (arr === null || arr.length === 0) return 'present (unstructured)';
    const first = asObject(arr[0]);
    if (first === null) return 'present (non-object entry)';
    const message = nonEmptyString(first.message);
    const code = asFiniteNumber(first.code);
    let text = message !== null ? message : 'no message';
    if (code !== null) text += ' [code ' + code + ']';
    if (arr.length > 1) text += ' (+' + (arr.length - 1) + ' more)';
    return text.slice(0, 200);
  }

  /**
   * Success requires ALL of:
   *   2xx status, response.ok, readable clone, valid JSON, no GraphQL errors,
   *   an extractable numeric tweet id, and a non-tombstone result node.
   * Otherwise nothing is written anywhere.
   */
  function parseCreateTweetResponse(json) {
    const root = asObject(json);
    if (root === null) return { ok: false, reason: 'response body is not an object' };

    const data = asObject(root.data);
    const createTweet = data === null ? null : findCreateNode(data);

    // GraphQL permits partial success (data AND errors together). This archive
    // never treats a response carrying errors as a successful publish, but if a
    // usable tweet result was ALSO present we say so explicitly, so a dropped
    // tweet shows up in diagnostics instead of vanishing silently.
    const topLevelErrors = hasGraphqlErrors(root.errors);
    const operationErrors = createTweet !== null && hasGraphqlErrors(createTweet.errors);
    if (topLevelErrors || operationErrors) {
      let note = '';
      if (data !== null) {
        const found = collectResultCandidates(data);
        for (let i = 0; i < found.length; i++) {
          if (extractTweetId(found[i]) !== null) {
            note = '; NOTE a valid tweet result was also present';
            break;
          }
        }
      }
      const raw = topLevelErrors ? root.errors : createTweet.errors;
      return { ok: false, reason: 'graphql errors: ' + describeGraphqlErrors(raw) + note };
    }

    if (data === null) return { ok: false, reason: 'no data node' };

    const candidates = collectResultCandidates(data);
    if (candidates.length === 0) {
      // Naming the keys we actually received turns an opaque failure into a
      // one-line diagnosis: this is how data.notetweet_create was found.
      let keys = 'none';
      try {
        const names = Object.keys(data);
        keys = names.length > 0 ? names.slice(0, 12).join(',') : '(empty object)';
      } catch (_) { /* ignore */ }
      return { ok: false, reason: 'no tweet result candidate (data keys: ' + keys + ')' };
    }

    return { ok: true, candidates: candidates };
  }

  /**
   * A delete does not create a record — it marks the one already archived, so
   * "I published this and later removed it" survives. Throwing the row away
   * would destroy the only copy, which is the opposite of what an archive is
   * for.
   *
   * Success is a 2xx response with no GraphQL errors. X's own client passes no
   * response selector for this mutation (every other mutation we handle has
   * one), so there is no success field to read — and the tweet id can only come
   * from the request, because the response carries no data at all.
   */
  function reportDelete(json, variables, requestInfo, capturedVia) {
    try {
      const root = asObject(json);
      if (root === null) return false;

      const topErrors = root.errors;
      if (hasGraphqlErrors(topErrors)) {
        diag.lastError = 'delete rejected: ' + describeGraphqlErrors(topErrors);
        diag.lastErrorAt = new Date().toISOString();
        return false;
      }

      // X sometimes nests errors under the operation node instead of the root.
      const data = asObject(root.data);
      if (data !== null) {
        const names = Object.keys(data);
        for (let i = 0; i < names.length; i++) {
          const node = asObject(data[names[i]]);
          if (node !== null && hasGraphqlErrors(node.errors)) {
            diag.lastError = 'delete rejected: ' + describeGraphqlErrors(node.errors);
            diag.lastErrorAt = new Date().toISOString();
            return false;
          }
        }
      }

      const tweetId = variables ? normalizeTweetId(variables.tweet_id) : null;
      if (tweetId === null) {
        // Without an id there is nothing we could mark, and guessing would
        // mark the wrong row.
        diag.lastError = 'a delete was seen but its request carried no usable tweet_id';
        diag.lastErrorAt = new Date().toISOString();
        return false;
      }

      return post('X_TWEET_DELETED', {
        id: tweetId,
        deletedAt: new Date().toISOString(),
        source: {
          operationName: requestInfo.operationName,
          queryId: requestInfo.queryId,
          capturedVia: capturedVia === 'xhr' ? 'xhr' : 'fetch'
        }
      });
    } catch (err) {
      recordError('reportDelete', err);
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Response observation (detached side channel)                        */
  /* ------------------------------------------------------------------ */

  function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(fallback);
      }, ms);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      );
    });
  }

  /* ------------------------------------------------------- profile timeline */

  /**
   * The account ids whose posts this archive may keep.
   *
   * Seeded from storage (ids learned by earlier sessions) and grown from every
   * publish this page witnesses. The id is read out of the CreateTweet response
   * the extension already parses — no extra request, no credential, no lookup.
   *
   * This set is the entire safety argument for reading a timeline at all: the
   * same operation serves your profile and anybody else's, and only this list
   * can tell them apart.
   */
  const ownAuthorIds = new Set();

  /** Whether the Replies tab is read as well. Off until the user turns it on. */
  let captureReplies = false;

  function noteOwnAuthor(record) {
    try {
      if (record !== null && record.author !== null && record.author.id !== null) {
        ownAuthorIds.add(record.author.id);
      }
    } catch (err) {
      recordError('noteOwnAuthor', err);
    }
  }

  /** Seed the set from ids learned by earlier sessions (via content.js). */
  function adoptOwnAuthors(list) {
    try {
      if (!Array.isArray(list)) return;
      const limit = Math.min(list.length, 20);
      for (let i = 0; i < limit; i++) {
        const id = normalizeTweetId(list[i]);
        if (id !== null) ownAuthorIds.add(id);
      }
    } catch (err) {
      recordError('adoptOwnAuthors', err);
    }
  }

  /**
   * Collect every tweet node in a timeline response, wherever it is nested.
   *
   * Walking specific paths does not work here. A timeline entries array mixes
   * single posts with modules, and one kind of module holds a thread of your own
   * posts while another holds "who to follow" profile cards. Measured against a
   * real response, reading only the single-post entries missed a third of the
   * posts. So this walks the whole structure and lets the author filter decide.
   *
   * Posts you quote are skipped on purpose: a quoted tweet hangs off
   * `quoted_status_result`, not `tweet_results`, so it is never collected — and
   * it usually belongs to somebody else anyway.
   */
  function collectTimelineTweets(root) {
    const out = [];
    const seen = new Set();
    let visited = 0;

    const walk = (node, depth) => {
      if (visited++ > MAX_TIMELINE_NODES) return;
      if (depth > 30 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }

      const tweetResults = node.tweet_results;
      if (tweetResults !== null && typeof tweetResults === 'object' && !Array.isArray(tweetResults)) {
        const inner = tweetResults.result;
        if (inner !== null && typeof inner === 'object') {
          // A visibility wrapper sits between: {result: {tweet: {...}}}
          const tweet = (inner.tweet !== null && typeof inner.tweet === 'object') ? inner.tweet : inner;
          if (!seen.has(tweet)) {
            seen.add(tweet);
            out.push(tweet);
          }
        }
      }

      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] === 'quoted_status_result') continue;
        walk(node[keys[i]], depth + 1);
      }
    };

    walk(root, 0);
    return out;
  }

  /**
   * Turn one timeline response into records, keeping only this account's posts.
   *
   * Every tweet that is not ours is dropped here, on this side of the bridge —
   * other people's content is never even transmitted, let alone stored.
   */
  function buildTimelineRecords(json, requestInfo, httpStatus, capturedVia) {
    const tweets = collectTimelineTweets(json);
    const records = [];
    const seenIds = new Set();
    const limit = Math.min(tweets.length, MAX_TIMELINE_TWEETS);

    for (let i = 0; i < limit; i++) {
      let record = null;
      try {
        const author = extractAuthor(tweets[i]);
        if (author.id === null || !ownAuthorIds.has(author.id)) continue;
        record = buildTweetRecord(tweets[i], null, requestInfo, httpStatus, capturedVia);
      } catch (err) {
        recordError('buildTimelineRecord', err);
        continue;
      }
      if (record === null) continue;
      if (seenIds.has(record.id)) continue;
      seenIds.add(record.id);
      record.source.backfilled = true;
      records.push(record);
    }
    return records;
  }

  /**
   * Send a sweep's records in as few messages as the bridge limit allows.
   *
   * A whole timeline page routinely serializes past MAX_BRIDGE_BYTES, and post()
   * refuses an oversized message outright — which discarded the ENTIRE sweep,
   * every post on the page. So the batch is split, and the split point is found
   * by measuring real serializations rather than by guessing a record count: one
   * long-form post can weigh more than a hundred short ones.
   *
   * Returns how many records actually left the page. A record that cannot fit in
   * a message even on its own is skipped and named in the diagnostics — one
   * oversized row must never cost the rest of the page.
   */
  function postBackfillRecords(records) {
    // Fixed per-message cost: the envelope (source/type/token) plus the empty
    // records array. Measured, not assumed, and measured against the same token
    // post() will send. If it cannot be measured, 0 makes the chunks look
    // smaller than they are — post() then refuses one, counts nothing as kept,
    // and the refusal shows up in the diagnostics instead of vanishing.
    let overhead = 0;
    try {
      overhead = JSON.stringify(bridgeMessage('X_TWEET_BACKFILL', { records: [] })).length;
    } catch (_) { /* fall through: post() is the backstop */ }

    let chunk = [];
    let chunkBytes = 0;   // serialized length of the records array alone
    let posted = 0;

    const flush = () => {
      if (chunk.length === 0) return;
      const batch = chunk;
      const batchBytes = chunkBytes;
      chunk = [];
      chunkBytes = 0;
      const delivered = post('X_TWEET_BACKFILL', { records: batch });
      if (delivered) {
        posted += batch.length;
        diag.posted++;
      }
      log('timeline chunk: ' + batch.length + ' records, ' + (overhead + batchBytes) +
          ' bytes, ' + (delivered ? 'delivered' : 'refused'));
    };

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      let recordBytes;
      try {
        recordBytes = JSON.stringify(record).length;
      } catch (err) {
        diag.postFailed++;
        recordError('timeline serialize', err);
        continue;
      }
      // JSON.stringify joins an array's elements with ',' — so the running total
      // is the exact length of the finished array, not an approximation.
      const grownBytes = chunkBytes === 0 ? recordBytes : chunkBytes + recordBytes + 1;

      if (overhead + grownBytes <= MAX_BRIDGE_BYTES) {
        chunk.push(record);
        chunkBytes = grownBytes;
        continue;
      }

      // Full: send what fits, then retry this record against an empty chunk.
      flush();
      if (overhead + recordBytes <= MAX_BRIDGE_BYTES) {
        chunk = [record];
        chunkBytes = recordBytes;
        continue;
      }

      diag.postFailed++;
      recordError('postMessage',
        'timeline record ' + record.id + ' exceeds the bridge limit on its own and was skipped');
    }

    flush();
    return posted;
  }

  function handleTimelineJson(json, requestInfo, httpStatus, capturedVia) {
    diag.timelineSeen++;
    if (ownAuthorIds.size === 0) {
      // Not an error: a fresh install has published nothing here yet, so there
      // is no way to know which posts in this response are its owner's.
      if (debugEnabled) warn('timeline seen, but no own author id is known yet — skipping');
      scheduleDiag();
      return;
    }
    if (json === null || typeof json !== 'object') {
      diag.responseJsonFailed++;
      diag.lastError = 'timeline response was not a usable object';
      diag.lastErrorAt = new Date().toISOString();
      scheduleDiag();
      return;
    }

    let records = [];
    try {
      records = buildTimelineRecords(json, requestInfo, httpStatus, capturedVia);
    } catch (err) {
      recordError('buildTimelineRecords', err);
      scheduleDiag();
      return;
    }

    // Counted only once a chunk has actually left the page. Incrementing before
    // the post let the panel claim rows were kept that post() had just refused.
    diag.timelineKept += postBackfillRecords(records);
    scheduleDiag();
  }

  /* ------------------------------------------------------- focal tweet detail */

  /**
   * The one tweet in a TweetResultByRestId response.
   *
   * The timeline walker cannot be reused for this, and the reason is in the
   * shape: that walker matches on a `tweet_results` object, and this response
   * contains none — its tweet sits at `data.tweetResult` (singular, no
   * underscore) with the tweet node directly under `result`. There is nothing
   * to search for either: one fixed path, one tweet, no conversation, which is
   * exactly why this operation was chosen over TweetDetail.
   */
  function findDetailTweet(json) {
    const result = asObject(walk(json, ['data', 'tweetResult', 'result'])) ||
                   asObject(walk(json, ['data', 'tweet_result', 'result']));
    if (result === null) return null;
    // A visibility wrapper sits between: {result: {tweet: {...}}}
    return asObject(result.tweet) || result;
  }

  /**
   * Where a tweet's link entities live.
   *
   * Every container is read, not just the first one that exists — which is what
   * extractEntities does, and precisely how a swept record ended up with no
   * link targets at all. On a long-form post the two disagree: `legacy.entities`
   * carries the media attachments while the note_tweet `entity_set` carries the
   * links. The real capture this was written against has exactly that shape.
   *
   * This reader is used on the detail page only. The publish path is untouched:
   * a record captured at publish time keeps whatever it captured.
   */
  const DETAIL_URL_PATHS = [
    ['legacy', 'entities', 'urls'],
    ['note_tweet', 'note_tweet_results', 'result', 'entity_set', 'urls'],
    ['legacy', 'note_tweet', 'note_tweet_results', 'result', 'entity_set', 'urls'],
    ['note_tweet_results', 'result', 'entity_set', 'urls'],
    ['entities', 'urls']
  ];

  /**
   * The links this post's text points at, deduplicated by shortlink: the same
   * target can appear in more than one container, and the popup renders this
   * list verbatim, so a duplicate would show up as a repeated line.
   */
  function extractLinkUrls(result) {
    const out = [];
    const seen = new Set();

    for (let p = 0; p < DETAIL_URL_PATHS.length && out.length < MAX_ENTITY_URLS; p++) {
      const list = asArray(walk(result, DETAIL_URL_PATHS[p]));
      if (list === null) continue;

      const limit = Math.min(list.length, MAX_ENTITY_URLS);
      for (let i = 0; i < limit && out.length < MAX_ENTITY_URLS; i++) {
        const entry = normalizeEntityUrl(list[i]);
        if (entry === null) continue;
        const key = entry.url !== null ? entry.url : entry.expandedUrl;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Turn one detail-page response into a link-fill message, or null.
   *
   * The author filter is the safety property here even more than on a profile
   * sweep: this operation fires for ANY post the user opens, most of which are
   * somebody else's, and a detail response can also carry the conversation
   * around the focal tweet. Nothing but the focal tweet is ever looked at, and
   * only when its author id is one this browser has published from.
   *
   * No record is created by this path and no existing value is replaced — it
   * can only fill a gap (see mergeLinkEntities in db.js) — so a post that is not
   * archived here yet simply has nothing to fill, and that is not an error.
   */
  function buildDetailLinks(json, requestInfo, capturedVia) {
    if (ownAuthorIds.size === 0) {
      // Same as the sweep: with no known own author id there is no way to tell
      // whose post this is, and guessing would archive a stranger's links.
      if (debugEnabled) warn('a post page was seen, but no own author id is known yet — skipping');
      return null;
    }

    const tweet = findDetailTweet(json);
    if (tweet === null) return null;

    const author = extractAuthor(tweet);
    if (author.id === null || !ownAuthorIds.has(author.id)) return null;

    const id = extractTweetId(tweet);
    if (id === null) return null;

    const urls = extractLinkUrls(tweet);
    // A post with no links, or whose links are already archived, is the normal
    // case; sending an empty list would only make the extension write nothing.
    if (urls.length === 0) return null;

    return {
      id: id,
      urls: urls,
      source: {
        operationName: requestInfo.operationName,
        queryId: requestInfo.queryId,
        capturedVia: capturedVia === 'xhr' ? 'xhr' : 'fetch'
      }
    };
  }

  function handleDetailJson(json, requestInfo, capturedVia) {
    diag.detailSeen++;
    if (json === null || typeof json !== 'object') {
      // Counted, not swallowed: a detail page whose body could not be read is
      // exactly the case where a link stays missing with no other trace.
      diag.responseJsonFailed++;
      scheduleDiag();
      return;
    }
    let payload = null;
    try {
      payload = buildDetailLinks(json, requestInfo, capturedVia);
    } catch (err) {
      recordError('buildDetailLinks', err);
      scheduleDiag();
      return;
    }
    // Counted only once the message actually left the page, like the sweep: a
    // payload post() refused must not be reported as recovered.
    if (payload !== null && post('X_TWEET_LINKS', payload)) diag.detailKept++;
    scheduleDiag();
  }

  async function handleResponse(response, requestInfo, variablesPromise) {
    try {
      if (!response || typeof response !== 'object') return;

      const status = asFiniteNumber(response.status);
      if (status === null || status < 200 || status > 299) return;
      if (response.ok !== true) return;

      // A profile timeline is a query, not a publish. It is read for posts that
      // were made elsewhere and is never treated as one that just happened.
      if (requestInfo.isTimeline === true) {
        let timelineClone;
        try {
          timelineClone = response.clone();
        } catch (err) {
          diag.responseCloneFailed++;
          recordError('response.clone (timeline)', err);
          return;
        }
        let timelineJson = null;
        try {
          timelineJson = await timelineClone.json();
        } catch (err) {
          diag.responseJsonFailed++;
          recordError('clone.json (timeline)', err);
          return;
        }
        handleTimelineJson(timelineJson, requestInfo, status, 'fetch');
        return;
      }

      // A post's own page is a query too, and it is read for the link targets
      // the sweep left empty. Nothing here is a publish either.
      if (requestInfo.isDetail === true) {
        let detailClone;
        try {
          detailClone = response.clone();
        } catch (err) {
          diag.responseCloneFailed++;
          recordError('response.clone (detail)', err);
          return;
        }
        let detailJson = null;
        try {
          detailJson = await detailClone.json();
        } catch (err) {
          diag.responseJsonFailed++;
          recordError('clone.json (detail)', err);
          return;
        }
        handleDetailJson(detailJson, requestInfo, 'fetch');
        return;
      }

      // A delete marks an existing record instead of writing a new one.
      // (deleteSeen was already counted when the request went out.)
      if (requestInfo.isDelete === true) {
        let deleteClone;
        try {
          deleteClone = response.clone();
        } catch (err) {
          diag.responseCloneFailed++;
          recordError('response.clone (delete)', err);
          return;
        }
        let deleteJson;
        try {
          deleteJson = await deleteClone.json();
        } catch (err) {
          diag.responseJsonFailed++;
          recordError('clone.json (delete)', err);
          return;
        }
        const deleteVars = await withTimeout(variablesPromise, BODY_READ_TIMEOUT_MS, null);
        if (reportDelete(deleteJson, deleteVars, requestInfo, 'fetch')) diag.deleted++;
        scheduleDiag();
        return;
      }

      let clone;
      try {
        clone = response.clone();
      } catch (err) {
        diag.responseCloneFailed++;
        recordError('response.clone', err);
        return;
      }

      let json;
      try {
        json = await clone.json();
      } catch (err) {
        diag.responseJsonFailed++;
        recordError('clone.json', err);
        return;
      }

      const parsed = parseCreateTweetResponse(json);
      if (!parsed.ok) {
        diag.parseFailed++;
        // Always record the reason, not only when debug is off: the diagnostics
        // panel is most useful precisely when debug logging is enabled.
        diag.lastError = 'parse: ' + parsed.reason;
        diag.lastErrorAt = new Date().toISOString();
        if (debugEnabled) warn('CreateTweet response could not be parsed:', parsed.reason);
        scheduleDiag();
        return;
      }

      // Request-side variables are auxiliary only; never a save trigger.
      const variables = await withTimeout(variablesPromise, BODY_READ_TIMEOUT_MS, null);

      let record = null;
      for (let i = 0; i < parsed.candidates.length; i++) {
        try {
          record = buildTweetRecord(parsed.candidates[i], variables, requestInfo, status);
        } catch (err) {
          record = null;
          recordError('buildTweetRecord', err);
        }
        if (record !== null) break;
      }

      if (record === null) {
        diag.parseFailed++;
        if (debugEnabled) warn('no usable tweet result (no valid tweet id)');
        scheduleDiag();
        return;
      }

      diag.parsed++;
      noteOwnAuthor(record);
      if (post('X_TWEET_CAPTURED', record)) diag.posted++;
      scheduleDiag();
    } catch (err) {
      recordError('handleResponse', err);
    }
  }

  function observeResponse(originalPromise, requestInfo) {
    let variablesPromise = null;
    try {
      variablesPromise = readRequestVariables(requestInfo);
    } catch (err) {
      diag.requestBodyFailed++;
      variablesPromise = Promise.resolve(null);
    }

    // Detached branch: the page keeps the untouched original promise.
    try {
      originalPromise.then(
        (response) => {
          // Fire-and-forget; every failure is swallowed inside.
          void handleResponse(response, requestInfo, variablesPromise).catch((err) => {
            recordError('handleResponse (async)', err);
          });
        },
        () => {
          // Original request failed: nothing to archive, nothing to do.
        }
      );
    } catch (err) {
      recordError('observeResponse', err);
    }
  }

  /* ------------------------------------------------------------------ */
  /* XMLHttpRequest transport                                            */
  /*                                                                     */
  /* x.com publishes tweets over XHR, not fetch. Verified against live    */
  /* traffic: POST https://x.com/i/api/graphql/<queryId>/CreateTweet      */
  /* arrives through XMLHttpRequest.prototype.send, so a fetch-only hook  */
  /* can never see it.                                                    */
  /*                                                                     */
  /* The hook below is observation-only: it never touches the request,    */
  /* never reorders arguments, and never overwrites the page's own        */
  /* onload/onreadystatechange handlers. Reading an XHR response is safe  */
  /* because the body is already buffered, so nothing is consumed.        */
  /* ------------------------------------------------------------------ */

  /** Per-instance request info, kept off the object so the page cannot see it. */
  const xhrInfoMap = new WeakMap();

  function resolveUrl(rawUrl) {
    try {
      if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;
      return new URL(rawUrl, window.location.href).href;
    } catch (_) {
      return null;
    }
  }

  /**
   * Read an XHR response as JSON without consuming anything.
   * responseText is a buffered string: reading it does not disturb the page.
   */
  function readXhrResponseJson(xhr) {
    try {
      const type = xhr.responseType;
      if (type === '' || type === 'text') {
        const text = xhr.responseText;
        if (typeof text !== 'string' || text.length === 0) return null;
        try {
          return JSON.parse(text);
        } catch (_) {
          return null;
        }
      }
      if (type === 'json') {
        const value = xhr.response;
        return isObject(value) ? value : null;
      }
      // arraybuffer / blob / document carry no GraphQL JSON we can use.
      return null;
    } catch (_) {
      return null;
    }
  }

  function handleXhrCompletion(xhr, info, bodyString) {
    try {
      const status = asFiniteNumber(xhr.status);
      if (status === null || status < 200 || status > 299) return;

      if (info.isTimeline === true) {
        handleTimelineJson(readXhrResponseJson(xhr), info, status, 'xhr');
        return;
      }

      if (info.isDetail === true) {
        handleDetailJson(readXhrResponseJson(xhr), info, 'xhr');
        return;
      }

      // A delete marks an existing record instead of writing a new one.
      // (deleteSeen was already counted when the request went out.)
      if (info.isDelete === true) {
        const deleteJson = readXhrResponseJson(xhr);
        if (deleteJson === null) {
          diag.responseJsonFailed++;
          diag.lastError = 'delete response was not usable JSON';
          diag.lastErrorAt = new Date().toISOString();
          scheduleDiag();
          return;
        }
        const deleteVars = typeof bodyString === 'string' ? parseVariablesFromBody(bodyString) : null;
        if (reportDelete(deleteJson, deleteVars, info, 'xhr')) diag.deleted++;
        scheduleDiag();
        return;
      }

      const json = readXhrResponseJson(xhr);
      if (json === null) {
        diag.responseJsonFailed++;
        if (debugEnabled) warn('XHR CreateTweet response was not usable JSON');
        scheduleDiag();
        return;
      }

      const parsed = parseCreateTweetResponse(json);
      if (!parsed.ok) {
        diag.parseFailed++;
        diag.lastError = 'xhr parse: ' + parsed.reason;
        diag.lastErrorAt = new Date().toISOString();
        if (debugEnabled) warn('XHR CreateTweet could not be parsed:', parsed.reason);
        scheduleDiag();
        return;
      }

      const variables = typeof bodyString === 'string' ? parseVariablesFromBody(bodyString) : null;
      if (variables !== null) diag.requestBodyRead++;

      let record = null;
      for (let i = 0; i < parsed.candidates.length; i++) {
        try {
          record = buildTweetRecord(parsed.candidates[i], variables, info, status, 'xhr');
        } catch (err) {
          record = null;
          recordError('buildTweetRecord (xhr)', err);
        }
        if (record !== null) break;
      }

      if (record === null) {
        diag.parseFailed++;
        scheduleDiag();
        return;
      }

      diag.parsed++;
      noteOwnAuthor(record);
      if (post('X_TWEET_CAPTURED', record)) diag.posted++;
      scheduleDiag();
    } catch (err) {
      recordError('handleXhrCompletion', err);
    }
  }

  function installXhrHook() {
    try {
      const proto = window.XMLHttpRequest ? window.XMLHttpRequest.prototype : null;
      if (!proto || typeof proto.open !== 'function' || typeof proto.send !== 'function') {
        log('XMLHttpRequest unavailable; XHR transport not hooked');
        return;
      }
      if (proto.open === installedHooks.xhrOpen) return;

      const originalOpen = proto.open;
      const originalSend = proto.send;

      /**
       * True only for a real XMLHttpRequest.
       *
       * These methods live on the prototype, so a page can call them with ANY
       * receiver. A plain object carrying its own status/responseText/
       * addEventListener used to be good enough to get an entry written into
       * xhrInfoMap and a listener attached to it — and the page could then fire
       * that listener itself, feeding a fabricated response straight into the
       * pipeline with no bridge message involved. The prototype check keeps
       * every legitimate receiver (including a page that subclasses XHR) and
       * rejects everything else before anything is written.
       */
      function isGenuineXhr(receiver) {
        try {
          return typeof window.XMLHttpRequest === 'function' &&
                 receiver instanceof window.XMLHttpRequest;
        } catch (_) {
          return false;
        }
      }

      const hookedOpen = function open(method, url) {
        if (!isGenuineXhr(this)) return Reflect.apply(originalOpen, this, arguments);
        try {
          const absolute = resolveUrl(url);
          const analysis = absolute === null ? null : analyzeRequestUrl(absolute, method);
          if (analysis !== null) {
            xhrInfoMap.set(this, {
              method: String(method).toUpperCase(),
              url: absolute,
              queryId: analysis.queryId,
              operationName: analysis.operationName,
              isDelete: analysis.isDelete,
              isTimeline: analysis.isTimeline,
              isDetail: analysis.isDetail
            });
          } else {
            // The same XHR object can be reused via open(); never let stale
            // info from a previous request leak into this one.
            xhrInfoMap.delete(this);
          }
        } catch (err) {
          log('xhr open hook', err);
        }
        return Reflect.apply(originalOpen, this, arguments);
      };

      const hookedSend = function send(body) {
        // Same check as open(): a receiver that never went through open() has no
        // entry to read, but it must not get a listener attached to it either.
        if (!isGenuineXhr(this)) return Reflect.apply(originalSend, this, arguments);
        try {
          const info = xhrInfoMap.get(this);
          if (info !== undefined) {
            if (info.isDelete === true) diag.deleteSeen++;
            else if (info.isTimeline === true) { /* counted when the body arrives */ }
            // A post's own page is a read as well, so it is counted when its
            // body arrives, never as a publish.
            else if (info.isDetail === true) { /* counted when the body arrives */ }
            else diag.createTweetSeen++;
            // The body is handed to us as-is; we only read it when it is a
            // string, and we never modify or replace it.
            const bodyString = typeof body === 'string' ? body : null;
            const xhr = this;
            // addEventListener is additive: the page keeps its own handlers.
            xhr.addEventListener('loadend', () => {
              try {
                handleXhrCompletion(xhr, info, bodyString);
              } catch (err) {
                recordError('xhr loadend', err);
              }
            });
            scheduleDiag();
          }
        } catch (err) {
          recordError('xhr send hook', err);
        }
        return Reflect.apply(originalSend, this, arguments);
      };

      proto.open = hookedOpen;
      proto.send = hookedSend;

      if (proto.open !== hookedOpen || proto.send !== hookedSend) {
        recordError('installXhrHook', 'assignment to XMLHttpRequest.prototype was rejected');
        return;
      }

      installedHooks.xhrOpen = hookedOpen;
      installedHooks.xhrSend = hookedSend;
      diag.xhrHookInstalled = true;
      log('XHR hook installed');
      scheduleDiag();
    } catch (err) {
      recordError('installXhrHook', err);
    }
  }

  /* ------------------------------------------------------------------ */
  /* The hook                                                            */
  /* ------------------------------------------------------------------ */

  let integrityTimer = null;
  const installedHooks = { fetch: null, xhrOpen: null, xhrSend: null };
  /** Per-transport health, so one loss cannot mislabel the others. */
  const hookHealth = { fetch: true, xhrOpen: true, xhrSend: true };

  function installHook() {
    try {
      if (window[HOOK_MARKER] === true) {
        diag.hookInstalled = true;
        return;
      }

      const nativeFetch = window.fetch;
      if (typeof nativeFetch !== 'function') {
        recordError('installHook', 'window.fetch is not a function');
        return;
      }

      const hook = function fetch(input, init) {
        let requestInfo = null;
        try {
          requestInfo = buildRequestInfo(input, init);
        } catch (err) {
          recordError('buildRequestInfo', err);
        }

        let originalPromise;
        try {
          // Reflect.apply preserves the original receiver, arguments and any
          // synchronous throw the native fetch would have produced.
          originalPromise = Reflect.apply(nativeFetch, this, arguments);
        } catch (err) {
          throw err;
        }

        try {
          if (requestInfo !== null && requestInfo.isCreateTweet) {
            if (requestInfo.isDelete === true) diag.deleteSeen++;
            // A timeline GET is a query, not a publish — it is counted when the
            // body arrives (handleTimelineJson), exactly as on the XHR path.
            else if (requestInfo.isTimeline === true) { /* counted when the body arrives */ }
            else if (requestInfo.isDetail === true) { /* counted when the body arrives */ }
            else diag.createTweetSeen++;
            observeResponse(originalPromise, requestInfo);
            scheduleDiag();
          }
        } catch (err) {
          recordError('fetch observer', err);
        }

        // The page receives exactly what native fetch returned.
        return originalPromise;
      };

      try {
        Object.defineProperty(hook, 'name', { value: 'fetch', configurable: true });
      } catch (_) { /* cosmetic only */ }
      try {
        Object.defineProperty(hook, 'length', { value: nativeFetch.length, configurable: true });
      } catch (_) { /* cosmetic only */ }
      try {
        Object.defineProperty(hook, HOOK_MARKER, {
          value: true,
          enumerable: false,
          configurable: true,
          writable: false
        });
      } catch (_) { /* cosmetic only */ }

      window.fetch = hook;

      if (window.fetch !== hook) {
        recordError('installHook', 'assignment to window.fetch was rejected');
        return;
      }

      // Non-enumerable, configurable marker: we can detect our own hook, the
      // page can still freely replace window.fetch afterwards.
      try {
        Object.defineProperty(window, HOOK_MARKER, {
          value: true,
          enumerable: false,
          configurable: true,
          writable: true
        });
      } catch (_) { /* ignore */ }

      installedHooks.fetch = hook;
      diag.hookInstalled = true;
      log('fetch hook installed');

      // x.com publishes over XHR, so both transports must be observed.
      installXhrHook();

      scheduleDiag();
      startIntegrityCheck();
    } catch (err) {
      recordError('installHook', err);
    }
  }

  /**
   * Low-frequency detection ONLY. If the page replaces window.fetch we record
   * it and stop — we do not fight the page for control of its own API.
   */
  function startIntegrityCheck() {
    if (integrityTimer !== null) return;
    try {
      integrityTimer = setInterval(() => {
        try {
          const lost = [];

          // Each transport is tracked on its own. Losing one says nothing about
          // the other, and x.com currently publishes over XHR — so losing fetch
          // is cosmetic while losing XHR is fatal.
          if (hookHealth.fetch && installedHooks.fetch !== null && window.fetch !== installedHooks.fetch) {
            hookHealth.fetch = false;
            lost.push('window.fetch');
          }
          const proto = window.XMLHttpRequest ? window.XMLHttpRequest.prototype : null;
          if (proto) {
            if (hookHealth.xhrOpen && installedHooks.xhrOpen !== null && proto.open !== installedHooks.xhrOpen) {
              hookHealth.xhrOpen = false;
              lost.push('XMLHttpRequest.prototype.open');
            }
            if (hookHealth.xhrSend && installedHooks.xhrSend !== null && proto.send !== installedHooks.xhrSend) {
              hookHealth.xhrSend = false;
              lost.push('XMLHttpRequest.prototype.send');
            }
          }

          if (lost.length > 0) {
            const xhrAlive = hookHealth.xhrOpen && hookHealth.xhrSend;
            diag.hookInstalled = hookHealth.fetch;
            diag.xhrHookInstalled = xhrAlive;
            diag.hookOverwritten = true;

            const surviving = [];
            if (xhrAlive) surviving.push('XHR (the transport x.com actually publishes on)');
            if (hookHealth.fetch) surviving.push('fetch');

            recordError('integrity',
              'the page replaced ' + lost.join(', ') + ' — ' +
              (surviving.length > 0
                ? 'still capturing via ' + surviving.join(' and ')
                : 'no transport is hooked, capture is inactive'));
          }
          // The timer deliberately keeps running: a transport that is healthy
          // now can be replaced later, and that must not go unnoticed.
        } catch (_) { /* ignore */ }
      }, INTEGRITY_CHECK_MS);
    } catch (_) {
      integrityTimer = null;
    }
  }

  installHook();
})();
