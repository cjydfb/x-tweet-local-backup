/* ============================================================================
 * test-profile.mjs — your own profile card, and the guard that keeps it yours.
 *
 * UserByScreenName is how X resolves a handle to an account ANYWHERE in the
 * product, so this operation fires far more often than a Following page does.
 * That makes one property load-bearing above all others: the card is stored
 * only when the RESPONSE names an account this browser has watched publish.
 *
 * The difference from the roster line is the whole point of this file. A follow
 * list has to be recognised from the request, because its response says nothing
 * about whose list it is; a profile response names its own account in
 * `data.user.result.rest_id`, so the guard can be settled by what came back.
 * The trap is the shortcut — teaching the id set from this line — because then
 * whoever you look at next becomes "you" and their posts get archived as yours.
 *
 *   node tools/test-profile.mjs            (reads inject.js from the repo)
 *   node tools/test-profile.mjs path/to/inject.js
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const SRC_PATH = process.argv[2] || path.join(REPO, 'inject.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const TOKEN = 'testtoken0123456789';
const OWN = '2032037309219315712';
const STRANGER = '999999999999999999';

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (err) { fail++; failures.push(name + ' :: ' + err.message); console.log('  FAIL  ' + name + '  -> ' + err.message); }
}

function makeFakeXHR(state) {
  return class FakeXHR {
    constructor() {
      this.__listeners = {};
      this.status = 0; this.readyState = 0;
      this.responseType = ''; this.responseText = ''; this.response = null;
      this.onload = null; this.onreadystatechange = null; this.onerror = null;
    }
    open(method, url) { this.__method = method; this.__url = url; this.readyState = 1; state.opens.push({ method, url }); }
    setRequestHeader() {}
    getAllResponseHeaders() { return ''; }
    send(body) {
      this.__body = body;
      state.sends.push({ method: this.__method, url: this.__url, body });
      const responder = state.responder;
      setTimeout(() => {
        let res;
        try { res = responder ? responder(this.__method, this.__url, body) : { status: 200, text: '{}' }; }
        catch (e) { res = { status: 200, text: '{}' }; }
        if (res === null) return;
        this.status = res.status;
        this.readyState = 4;
        if (this.responseType === 'json') this.response = res.json !== undefined ? res.json : JSON.parse(res.text);
        else if (this.responseType === '') this.responseText = res.text;
        else this.response = res.binary || null;
        this.__fire('readystatechange'); this.__fire('load'); this.__fire('loadend');
      }, 0);
    }
    addEventListener(type, fn) { (this.__listeners[type] = this.__listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
      const l = this.__listeners[type] || []; const i = l.indexOf(fn);
      if (i !== -1) l.splice(i, 1);
    }
    __fire(type) {
      try { if (typeof this['on' + type] === 'function') this['on' + type](); }
      catch (e) { state.pageHandlerErrors.push(type + ': ' + e.message); }
      for (const fn of (this.__listeners[type] || []).slice()) {
        try { fn(); } catch (e) { state.pageHandlerErrors.push(type + ': ' + e.message); }
      }
    }
  };
}

function makeRealm(responder) {
  const out = { messages: [], handlers: [], intervals: [], state: { opens: [], sends: [], responder, pageHandlerErrors: [] } };
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.location = { origin: 'https://x.com', href: 'https://x.com/home' };
  sandbox.console = { log() {}, warn() {}, debug() {}, error() {} };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = (fn, ms) => { out.intervals.push({ fn, ms }); return out.intervals.length; };
  sandbox.clearInterval = () => {};
  sandbox.URL = URL; sandbox.URLSearchParams = URLSearchParams;
  sandbox.Request = Request; sandbox.Response = Response; sandbox.Headers = Headers;
  sandbox.Blob = Blob; sandbox.WeakMap = WeakMap;
  sandbox.fetch = async () => new Response('{}', { status: 200 });
  sandbox.XMLHttpRequest = makeFakeXHR(out.state);
  sandbox.__handlers = out.handlers;
  sandbox.addEventListener = (type, fn) => { out.handlers.push({ type, fn }); };
  sandbox.postMessage = (msg) => { out.messages.push(msg); };
  out.sandbox = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  out.dispatch = (data) => {
    sandbox.__msg = data;
    vm.runInContext(
      '__handlers.forEach(function (h) { if (h.type === "message") {' +
      '  h.fn({ source: window, origin: window.location.origin, data: __msg }); } });',
      sandbox
    );
  };
  return out;
}

const handshake = (out, extra) => out.dispatch(Object.assign(
  { __xtb: true, source: 'xtb-bridge', type: 'XTB_HELLO', token: TOKEN, debug: false },
  extra || {}
));
const settle = () => new Promise((r) => setTimeout(r, 60));
const settleDiag = () => new Promise((r) => setTimeout(r, 600));

const cards = (out) => out.messages.filter((m) => m.type === 'X_PROFILE_SEEN');
const card = (out) => (cards(out)[0] || {}).payload || null;
const diagOf = (out) => {
  const d = out.messages.filter((m) => m.type === 'XTB_DIAG');
  return d.length ? d[d.length - 1].payload : {};
};

/** Issue a real XHR through the page's own XMLHttpRequest, the way x.com does. */
function xhr(realm, method, url) {
  const x = new realm.sandbox.XMLHttpRequest();
  x.open(method, url);
  x.responseType = 'json';
  x.send();
}

const PROFILE_URL = (op, vars) => 'https://x.com/i/api/graphql/KybxDj9RrADIITXlGG8kpw/' + op
  + (vars === undefined ? '' : '?variables=' + encodeURIComponent(JSON.stringify(vars))
    + '&features=' + encodeURIComponent('{"hidden_profile_subscriptions_enabled":true}'));

const BY_NAME = (handle) => PROFILE_URL('UserByScreenName', { screen_name: handle, withGrokTranslatedBio: true });
const BY_ID = (id) => PROFILE_URL('UserByRestId', { userId: id });

/** The real path, with no query string at all — see the test that uses it. */
const NO_VARIABLES = PROFILE_URL('UserByScreenName', undefined);

/* ------------------------------------------------------------ fixtures ---- */

/**
 * One account node, shaped like the live response.
 *
 * The field paths were read off a real UserByScreenName capture, not guessed:
 * X now answers with the flat `core` / `avatar` / `profile_bio` /
 * `relationship_counts` / `tweet_counts` blocks and NO `legacy` key at all.
 */
function account(id, screenName, name, extra) {
  return Object.assign({
    __typename: 'User',
    rest_id: id,
    core: { created_at: 'Thu Mar 12 10:13:51 +0000 2026', name: name, screen_name: screenName },
    avatar: { image_url: 'https://pbs.twimg.com/profile_images/2100687239407947776/rskeY8JE_normal.jpg' },
    banner: { image_url: 'https://pbs.twimg.com/profile_banners/2032037309219315712/1787394878' },
    profile_bio: {
      description: '转生新帐号\n什么都发，电影游戏精神病学心理学',
      entities: { description: {} }
    },
    location: { location: '家里，万达广场附近' },
    website: { url: 'https://example.com/me' },
    relationship_counts: { followers: 86, following: 64 },
    tweet_counts: { media_tweets: 118, tweets: 1280 },
    is_blue_verified: true,
    verification: { verified: false },
    profile_description_language: 'zh',
    // Everything below is real response junk a whitelist rebuild must drop.
    action_counts: { favorites_count: 688 },
    privacy: { protected: false },
    pinned_items: { tweet_ids_str: ['2102788085704794409'] },
    highlights_info: { can_highlight_tweets: true, highlighted_tweets: '4' },
    relationship_perspectives: { following: false, blocking: false }
  }, extra || {});
}

const profileBody = (user) => ({ data: { user: { result: user } } });

/** A real fixture: the account, resolved by name. */
const OWN_BODY = profileBody(account(OWN, 'fcjdfb', 'cjy'));
const STRANGER_BODY = profileBody(account(STRANGER, 'someone', 'Someone Else'));

/* ========================================================================== */

console.log('== the card is stored when the response names an account of ours ==');
{
  const realm = makeRealm(() => ({ status: 200, json: OWN_BODY }));
  handshake(realm, { ownAuthorIds: [OWN] });
  await settle();
  xhr(realm, 'GET', BY_NAME('fcjdfb'));
  await settle();
  await settleDiag();

  const c = card(realm);
  check('a card was sent', () => assert.ok(c, 'no X_PROFILE_SEEN message'));
  check('it carries the account it came from', () => assert.equal(c.userId, OWN));
  check('the handle, the name and the join date survive', () => {
    assert.equal(c.screenName, 'fcjdfb');
    assert.equal(c.screenNameLower, 'fcjdfb');
    assert.equal(c.name, 'cjy');
    assert.equal(c.accountCreatedAt, 'Thu Mar 12 10:13:51 +0000 2026');
  });
  check('the counts come from the flat response blocks', () => {
    assert.equal(c.followersCount, 86);
    assert.equal(c.followingCount, 64);
    assert.equal(c.tweetCount, 1280);
  });
  check('the bio keeps its newlines', () => {
    assert.ok(c.bio.indexOf('\n') !== -1, 'newlines were lost');
  });
  check('the banner is kept, and it is the one field only this line has', () => {
    assert.ok(typeof c.bannerUrl === 'string' && c.bannerUrl.indexOf('profile_banners') !== -1);
  });
  check('the counters say seen once, kept once, nobody refused', () => {
    const d = diagOf(realm);
    assert.equal(d.profileSeen, 1);
    assert.equal(d.profileKept, 1);
    assert.equal(d.profileNoOwner, 0);
    assert.equal(d.profileNoUser, 0);
  });
  check('a profile read is not counted as a post the hook saw and lost', () => {
    // Without the isProfile branch in the send-time counter chain, resolving any
    // handle would inflate createTweetSeen — the one number the diagnostics
    // panel is read for.
    assert.equal(diagOf(realm).createTweetSeen, 0);
  });
  check('nothing from the response arrives by default', () => {
    const s = JSON.stringify(c);
    for (const junk of ['legacy', 'action_counts', 'favorites_count', 'privacy',
                        'pinned_items', 'highlights_info', 'relationship_perspectives',
                        'media_tweets']) {
      assert.ok(s.indexOf(junk) === -1, 'stored a field it should have dropped: ' + junk);
    }
  });
  check('the count field is tweetCount and never `tweets`', () => {
    // reader.html finds the exported tweet array by scanning the raw bytes for
    // that literal key, so a second one anywhere in the envelope is a trap.
    assert.ok(Object.prototype.hasOwnProperty.call(c, 'tweetCount'));
    assert.ok(!Object.prototype.hasOwnProperty.call(c, 'tweets'));
  });
}

console.log('\n== somebody else\'s profile is not ours ==');
{
  const realm = makeRealm(() => ({ status: 200, json: STRANGER_BODY }));
  handshake(realm, { ownAuthorIds: [OWN] });
  await settle();
  xhr(realm, 'GET', BY_NAME('someone'));
  await settle();
  await settleDiag();

  check('nothing was stored', () => assert.equal(cards(realm).length, 0));
  check('and the counter says why', () => assert.equal(diagOf(realm).profileNoOwner, 1));
  check('it was still counted as seen', () => assert.equal(diagOf(realm).profileSeen, 1));
}

console.log('\n== the shortcut that must never be taken ==');
{
  // The whole safety argument, in one test. If this line ever taught ownAuthorIds
  // from its own response, the SECOND visit would succeed — and from then on
  // that stranger's posts would be swept into the archive as this account's.
  const realm = makeRealm(() => ({ status: 200, json: STRANGER_BODY }));
  handshake(realm, { ownAuthorIds: [OWN] });
  await settle();

  xhr(realm, 'GET', BY_NAME('someone'));
  await settle();
  xhr(realm, 'GET', BY_NAME('someone'));
  await settle();
  xhr(realm, 'GET', BY_ID(STRANGER));
  await settle();
  await settleDiag();

  check('looking at somebody three times still stores nothing', () => {
    assert.equal(cards(realm).length, 0, 'the id set was polluted by a profile response');
  });
  check('every one of them is counted as refused', () => {
    assert.equal(diagOf(realm).profileNoOwner, 3);
  });
}

console.log('\n== the guard is on the RESPONSE, not the request ==');
{
  // This is the property that separates this line from the roster's, and the
  // test fails the moment somebody "fixes" it by reading the request's
  // `variables.screenName`. A request carrying no variables at all — which X
  // does not send, but which nothing in the response contradicts — is still
  // accepted, because the response says who it is.
  const realm = makeRealm(() => ({ status: 200, json: OWN_BODY }));
  handshake(realm, { ownAuthorIds: [OWN] });
  await settle();
  xhr(realm, 'GET', NO_VARIABLES);
  await settle();
  await settleDiag();

  check('a request with no variables is accepted on the strength of the response', () => {
    assert.equal(cards(realm).length, 1, 'the request was consulted for identity');
    assert.equal(card(realm).userId, OWN);
  });
}

console.log('\n== UserByRestId resolves the same node ==');
{
  const realm = makeRealm(() => ({ status: 200, json: OWN_BODY }));
  handshake(realm, { ownAuthorIds: [OWN] });
  await settle();
  xhr(realm, 'GET', BY_ID(OWN));
  await settle();
  await settleDiag();

  check('a profile opened by id is stored too', () => {
    assert.equal(cards(realm).length, 1);
    assert.equal(card(realm).userId, OWN);
  });
  check('the operation it came from is recorded', () => {
    assert.equal(card(realm).source.operationName, 'UserByRestId');
    assert.equal(card(realm).source.capturedVia, 'xhr');
  });
}

console.log('\n== a fresh install has no idea which account is yours ==');
{
  const realm = makeRealm(() => ({ status: 200, json: OWN_BODY }));
  handshake(realm, { ownAuthorIds: [] });
  await settle();
  xhr(realm, 'GET', BY_NAME('fcjdfb'));
  await settle();
  await settleDiag();

  check('nothing is stored, even for the account it will turn out to be', () => {
    assert.equal(cards(realm).length, 0);
  });
  check('and it is refused rather than counted as an error', () => {
    assert.equal(diagOf(realm).profileNoOwner, 1);
    assert.equal(diagOf(realm).profileNoUser, 0);
  });
}

console.log('\n== responses that name no account ==');
{
  const shapes = [
    ['a suspended or withheld account', { data: { user: { result: { __typename: 'UserUnavailable' } } } }],
    ['an empty user wrapper', { data: { user: {} } }],
    ['an error envelope', { errors: [{ message: 'Not authorized.' }] }],
    ['an empty object', {}],
    ['a node whose id is not an id', { data: { user: { result: { rest_id: 'nonsense' } } } }]
  ];
  for (const [label, body] of shapes) {
    const realm = makeRealm(() => ({ status: 200, json: body }));
    handshake(realm, { ownAuthorIds: [OWN] });
    await settle();
    xhr(realm, 'GET', BY_NAME('fcjdfb'));
    await settle();
    await settleDiag();

    check(label + ': stores nothing and does not throw', () => {
      assert.equal(cards(realm).length, 0);
      assert.equal(realm.state.pageHandlerErrors.length, 0, 'a page handler threw');
      assert.equal(diagOf(realm).profileNoUser, 1);
    });
  }
}

console.log('\n== transport and shape rules ==');
{
  const realm = makeRealm(() => ({ status: 200, json: OWN_BODY }));
  handshake(realm, { ownAuthorIds: [OWN] });
  await settle();
  xhr(realm, 'POST', BY_NAME('fcjdfb'));
  await settle();
  await settleDiag();
  check('a POST to a profile operation is refused', () => assert.equal(cards(realm).length, 0));
  // Not `sends.length === 0` — the fake transport records what the PAGE sent, and
  // the page really did send it. What matters is that the hook never treated it
  // as a profile read: no counter moved, which means analyzeRequestUrl returned
  // null before any listener was attached.
  check('and the hook never treated it as a profile read', () => {
    const d = diagOf(realm);
    assert.equal(d.profileSeen || 0, 0, 'a POST reached the profile handler');
    assert.equal(d.profileKept || 0, 0);
  });
}
{
  const realm = makeRealm(() => ({ status: 500, json: {} }));
  handshake(realm, { ownAuthorIds: [OWN] });
  await settle();
  xhr(realm, 'GET', BY_NAME('fcjdfb'));
  await settle();
  await settleDiag();
  check('an error status stores nothing', () => assert.equal(cards(realm).length, 0));
}

console.log('\n== a huge bio cannot be refused by the bridge ==');
{
  const huge = 'x'.repeat(500000);
  const body = profileBody(account(OWN, 'fcjdfb', 'cjy', {
    profile_bio: { description: huge, entities: { description: {} } }
  }));
  const realm = makeRealm(() => ({ status: 200, json: body }));
  handshake(realm, { ownAuthorIds: [OWN] });
  await settle();
  xhr(realm, 'GET', BY_NAME('fcjdfb'));
  await settle();
  await settleDiag();

  check('the card is clamped and still delivered', () => {
    const c = card(realm);
    assert.ok(c, 'the card was refused whole by the bridge');
    assert.ok(c.bio.length <= 2000, 'bio was not clamped: ' + c.bio.length);
    assert.ok(JSON.stringify(c).length < 256 * 1024, 'the message exceeds the bridge limit');
  });
}

console.log('\n== no setting gates this line ==');
{
  // Unlike the roster, which is opt-in because it is about other people. This is
  // about you, and there is no switch to leave off — a HELLO that never mentions
  // captureConnections must still store the card.
  const realm = makeRealm(() => ({ status: 200, json: OWN_BODY }));
  handshake(realm, { ownAuthorIds: [OWN] });
  await settle();
  xhr(realm, 'GET', BY_NAME('fcjdfb'));
  await settle();
  await settleDiag();
  check('the card is stored with no captureConnections in the handshake', () => {
    assert.equal(cards(realm).length, 1);
  });
}

console.log('\n' + '='.repeat(41));
console.log('passed: ' + pass + '   failed: ' + fail);
if (fail) {
  for (const f of failures) console.log('  FAILED: ' + f);
  process.exit(1);
}
