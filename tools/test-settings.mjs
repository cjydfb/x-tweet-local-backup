/* ============================================================================
 * test-settings.mjs — the settings store's read/write plumbing.
 *
 * settings.js is the one file both realms agree on, and what it implements is a
 * whitelist: a key that is not in DEFAULT_SETTINGS cannot be read back, and a
 * value of the wrong type is dropped rather than stored. Neither of those
 * failures throws. Both just produce a setting that silently never persists,
 * which is the hardest kind to notice — and the one the first-run choice panel
 * must not have, because it is answered ONCE. An answer that fails to store is
 * either a question asked again forever or a choice never applied at all.
 *
 * What the panel looks like, and what its checkboxes were set to, is DOM-bound
 * and is not tested here: a jsdom-shaped test of "the box was checked" would
 * prove that a line of code ran, not that a user was told anything. The half
 * that can be pinned down without a browser is this half — whether the answer,
 * once given, survives the round trip.
 *
 * chrome.storage is mocked, and deliberately made to fail in places: absent,
 * empty, junk-filled and throwing are all states this code has to survive rather
 * than hypotheticals, since the real API is missing entirely outside the
 * extension.
 *
 *   node tools/test-settings.mjs
 * ========================================================================== */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

/* ------------------------------------------------------------------ mocks -- */

const store = new Map();
let failGet = false;
let failSet = false;

globalThis.chrome = {
  storage: {
    local: {
      get: async (defaults) => {
        if (failGet) throw new Error('storage unavailable');
        const out = {};
        for (const key of Object.keys(defaults || {})) {
          out[key] = store.has(key) ? store.get(key) : defaults[key];
        }
        return out;
      },
      set: async (obj) => {
        if (failSet) throw new Error('quota exceeded');
        for (const key of Object.keys(obj)) store.set(key, obj[key]);
      }
    }
  }
};

// Imported AFTER the mock is installed. settings.js reads `chrome` inside its
// functions rather than at import time, but relying on that would be a test that
// breaks for the wrong reason the day someone hoists a lookup.
const S = await import(pathToFileURL(path.join(REPO, 'settings.js')).href);

/** Put an object in storage under the settings key, bypassing the writer. */
function storeSettings(value) {
  store.set(S.SETTINGS_KEY, value);
}

function reset() {
  store.clear();
  failGet = false;
  failSet = false;
}

/* --------------------------------------------------------------- harness -- */

let passed = 0;
const failures = [];

/**
 * Run one check and wait for it.
 *
 * Awaited by every caller, so exactly one check is in flight at a time. That is
 * not tidiness: every check here shares one mock storage and one module-level
 * settings cache, and letting two overlap made each one read state the other had
 * just reset — four checks failed for reasons that had nothing to do with the
 * code under test.
 */
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === false) throw new Error('assertion returned false');
    passed++;
  } catch (err) {
    failures.push({ name, message: err && err.message ? err.message : String(err) });
    console.log('  FAIL  ' + name + '\n        ' + (err && err.message ? err.message : err));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '\n        got      ' + sa + '\n        expected ' + sb);
}

const BOOLEAN_KEYS = [
  'debug', 'mediaCache', 'showRemoteThumbnails', 'backfillMedia', 'captureReplies',
  'captureConnections', 'waybackEnabled', 'waybackAll', 'choicePanelAnswered'
];

/* --------------------------------------------------------------- defaults -- */

console.log('== defaults ==');

await check('DEFAULT_SETTINGS is exactly the documented set of values', () => {
  // Compared whole rather than key by key, on purpose. These values are what
  // every install that never opens the settings panel actually does, and the
  // first-run panel is only allowed to add a moment of choice — the moment it
  // offers must show these same answers, so a change here has to be a deliberate
  // edit in two places rather than one.
  assertEqual(S.DEFAULT_SETTINGS, {
    debug: false,
    mediaCache: false,
    showRemoteThumbnails: true,
    backfillMedia: true,
    captureReplies: false,
    captureConnections: false,
    waybackEnabled: false,
    waybackBatch: 100,
    waybackAll: false,
    waybackHandle: '',
    choicePanelAnswered: false,
    pageSize: 30
  });
});

await check('the archive import is off, and points at nobody, on a fresh install', async () => {
  // The one switch here that makes requests of its own to a server that is not
  // X. It must not be possible to arrive at it by default.
  reset();
  const settings = await S.getSettings();
  assertEqual(settings.waybackEnabled, false, 'a new install could reach the archive without asking');
  assertEqual(settings.waybackHandle, '', 'a handle was invented for an account nobody has seen');
});

await check('a batch size outside the range is refused, not clamped', async () => {
  reset();
  const before = await S.getSettings();
  for (const batch of [0, -1, 1.5, 501, '100', null]) {
    const after = await S.saveSettings({ waybackBatch: batch });
    assertEqual(after.waybackBatch, before.waybackBatch, 'accepted ' + JSON.stringify(batch));
  }
  const ok = await S.saveSettings({ waybackBatch: 250 });
  assertEqual(ok.waybackBatch, 250, 'a sane value was refused');
});

await check('the first-run panel is unanswered on a fresh install', async () => {
  reset();
  const settings = await S.getSettings();
  assertEqual(settings.choicePanelAnswered, false, 'a new install would not be asked');
});

await check('and it stays unanswered when storage holds other settings', async () => {
  reset();
  storeSettings({ debug: true, pageSize: 50 });
  const settings = await S.getSettings();
  assertEqual(settings.choicePanelAnswered, false);
  assertEqual(settings.debug, true, 'a stored key was lost');
  assertEqual(settings.pageSize, 50, 'a stored key was lost');
});

console.log('\n== the answered flag round-trips ==');

await check('saving the answer reads back', async () => {
  reset();
  await S.saveSettings({ choicePanelAnswered: true });
  assertEqual((await S.getSettings()).choicePanelAnswered, true);
});

await check('it is stored inside the settings object, not as a key of its own', async () => {
  // One storage key is the whole point: the popup has to know whether to ask and
  // what to pre-set the boxes to at the same instant, and two keys read in two
  // round trips could disagree with each other.
  reset();
  await S.saveSettings({ choicePanelAnswered: true });
  const stored = store.get(S.SETTINGS_KEY);
  assert(stored && typeof stored === 'object', 'nothing was written under the settings key');
  assertEqual(stored.choicePanelAnswered, true);
  assertEqual(store.size, 1, 'the flag was written under a key of its own: ' + [...store.keys()].join(', '));
});

await check('answering it does not disturb any other setting', async () => {
  reset();
  await S.saveSettings({ captureReplies: true, pageSize: 60 });
  await S.saveSettings({ choicePanelAnswered: true });
  const settings = await S.getSettings();
  assertEqual(settings.captureReplies, true, 'an earlier answer was lost');
  assertEqual(settings.pageSize, 60, 'an earlier answer was lost');
  assertEqual(settings.choicePanelAnswered, true);
});

await check('the flag alone changes no behaviour', async () => {
  // The panel exists to record that the question was asked. If answering it were
  // itself enough to switch something on, the four boxes would be decoration and
  // the answer would be whatever the code decided.
  reset();
  await S.saveSettings({ choicePanelAnswered: true });
  const settings = await S.getSettings();
  for (const key of BOOLEAN_KEYS) {
    if (key === 'choicePanelAnswered') continue;
    assertEqual(settings[key], S.DEFAULT_SETTINGS[key], key + ' moved when only the panel flag was written');
  }
});

console.log('\n== the whitelist holds ==');

await check('every boolean setting refuses a non-boolean, in storage and in a patch', async () => {
  for (const key of BOOLEAN_KEYS) {
    reset();
    // A string is the shape a hand-edited or corrupted store produces; `1` and
    // `null` are what a caller passing the wrong variable produces.
    for (const junk of ['yes', 1, null, {}]) {
      storeSettings(Object.assign({}, S.DEFAULT_SETTINGS, { [key]: junk }));
      assertEqual((await S.getSettings())[key], S.DEFAULT_SETTINGS[key],
        'getSettings accepted ' + JSON.stringify(junk) + ' for ' + key);
    }
    reset();
    await S.saveSettings({ [key]: 'yes' });
    assertEqual((await S.getSettings())[key], S.DEFAULT_SETTINGS[key],
      'saveSettings accepted a string for ' + key);
  }
});

await check('unknown keys in storage are dropped rather than carried through', async () => {
  reset();
  storeSettings(Object.assign({}, S.DEFAULT_SETTINGS, { notASetting: 'x', captureRetweets: true }));
  const settings = await S.getSettings();
  assert(!('notASetting' in settings), 'an unknown key survived the read');
  assert(!('captureRetweets' in settings), 'a retired key was carried forward');
  assertEqual(Object.keys(settings).sort(), Object.keys(S.DEFAULT_SETTINGS).sort());
});

await check('a stored object holding one key still comes back complete', async () => {
  // The merge, not the replace: a store written by an older version has fewer
  // keys, and every one it lacks has to fall back to the default rather than
  // becoming undefined.
  reset();
  storeSettings({ choicePanelAnswered: true });
  const settings = await S.getSettings();
  assertEqual(Object.keys(settings).sort(), Object.keys(S.DEFAULT_SETTINGS).sort());
  assertEqual(settings.pageSize, 30);
  assertEqual(settings.backfillMedia, true);
});

await check('a stored array is not mistaken for a settings object', async () => {
  reset();
  storeSettings(['choicePanelAnswered']);
  const settings = await S.getSettings();
  assertEqual(settings.choicePanelAnswered, false);
  assertEqual(settings.pageSize, 30);
});

await check('a patch that is not an object is a no-op, not a wipe', async () => {
  reset();
  await S.saveSettings({ choicePanelAnswered: true });
  const before = store.get(S.SETTINGS_KEY);
  for (const junk of [null, undefined, 'x', 42, ['choicePanelAnswered']]) {
    const returned = await S.saveSettings(junk);
    assertEqual(returned.choicePanelAnswered, true, 'a junk patch changed the settings');
  }
  assertEqual(store.get(S.SETTINGS_KEY), before, 'a junk patch reached storage');
});

console.log('\n== when storage misbehaves ==');

await check('a failed write still answers with the merged value', async () => {
  reset();
  failSet = true;
  const returned = await S.saveSettings({ choicePanelAnswered: true });
  assertEqual(returned.choicePanelAnswered, true, 'the caller was told the answer was lost when it was only deferred');
});

await check('but that value was never stored, so the panel asks again', async () => {
  // Documents the deliberate trade in saveSettings: a quota or context error
  // leaves the setting in memory for this session rather than throwing. The
  // consequence for the panel is that the flag is unset after a reload, so the
  // question is asked once more — which is the safe direction to fail in.
  reset();
  failSet = true;
  await S.saveSettings({ choicePanelAnswered: true });
  failSet = false;
  assertEqual((await S.getSettings()).choicePanelAnswered, false);
});

await check('a failed read falls back to the defaults instead of throwing', async () => {
  reset();
  storeSettings({ choicePanelAnswered: true, pageSize: 5 });
  failGet = true;
  const settings = await S.getSettings();
  assertEqual(settings, S.DEFAULT_SETTINGS);
});

await check('storage that is missing entirely is survivable', async () => {
  // What runs outside the extension, and what runs before the API is injected.
  reset();
  const saved = globalThis.chrome;
  delete globalThis.chrome;
  try {
    const settings = await S.getSettings();
    assertEqual(settings, S.DEFAULT_SETTINGS);
    const returned = await S.saveSettings({ choicePanelAnswered: true });
    assertEqual(returned.choicePanelAnswered, true, 'the write path threw without storage');
  } finally {
    globalThis.chrome = saved;
  }
});

/* ------------------------------------------------- the counters, and their wall -- */

console.log('\n== every counter the worker bumps has somewhere to land ==');

/**
 * The argument list of one `name(` call, found by walking brackets.
 *
 * A regex would stop at the first `)` and these calls contain object literals,
 * ternaries and a second string argument, so the shape has to be walked rather
 * than matched.
 */
function callArguments(source, openParenAt) {
  let depth = 0;
  for (let i = openParenAt; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return source.slice(openParenAt + 1, i);
    }
  }
  return '';
}

/* ---------------------------------------------------- known accounts --- */

console.log('\n== which ids are this account ==');

/* The list that decides whose timeline gets swept. It had no tests at all —
 * which is how it came to have no way of taking anything out of it either. */

await check('nothing is learned on a fresh install', async () => {
  reset();
  assertEqual(await S.getOwnAuthors(), []);
});

await check('ids are remembered, once each, in the order they arrived', async () => {
  reset();
  assertEqual(await S.rememberOwnAuthors(['111', '222']), ['111', '222']);
  // The same id again is not a second entry. Without this the list would grow
  // on every single captured post.
  assertEqual(await S.rememberOwnAuthors(['111']), ['111', '222']);
  assertEqual(await S.rememberOwnAuthors(['333']), ['111', '222', '333']);
});

await check('rubbish is refused rather than stored', async () => {
  reset();
  assertEqual(await S.rememberOwnAuthors(['', null, 42, {}, 'not a snowflake']), []);
});

await check('an id can be taken back out — the door that did not exist', async () => {
  reset();
  await S.rememberOwnAuthors(['111', '222']);
  assertEqual(await S.forgetOwnAuthor('111'), ['222']);
  // Written, not merely returned: a caller that trusted the return value while
  // the write had quietly not happened would look exactly like this passing.
  assertEqual(await S.getOwnAuthors(), ['222']);
});

await check('forgetting something that is not there changes nothing', async () => {
  reset();
  await S.rememberOwnAuthors(['111']);
  assertEqual(await S.forgetOwnAuthor('999'), ['111']);
  assertEqual(await S.forgetOwnAuthor(''), ['111']);
  assertEqual(await S.forgetOwnAuthor(null), ['111']);
  assertEqual(await S.getOwnAuthors(), ['111']);
});

await check('taking out the wrong one leaves the right one alone', async () => {
  // The whole point: one bad id goes, the account itself stays.
  reset();
  await S.rememberOwnAuthors(['me', 'them'].map((s) => (s === 'me' ? '2032037309219315712' : '999000111222333444')));
  assertEqual(await S.forgetOwnAuthor('999000111222333444'), ['2032037309219315712']);
});

await check('an id taken out can be learned again if it really was you', async () => {
  // The removal must not be a blacklist: the next post from that account puts
  // it straight back, because the learning path is unchanged.
  reset();
  await S.rememberOwnAuthors(['111']);
  await S.forgetOwnAuthor('111');
  assertEqual(await S.getOwnAuthors(), []);
  assertEqual(await S.rememberOwnAuthors(['111']), ['111']);
});

await check('DEFAULT_STATS.lifetime is where a counter has to be declared to exist', () => {
  assert(S.DEFAULT_STATS && S.DEFAULT_STATS.lifetime && typeof S.DEFAULT_STATS.lifetime === 'object',
    'DEFAULT_STATS.lifetime is missing');
  assert(Object.keys(S.DEFAULT_STATS.lifetime).length > 20,
    'the lifetime block looks empty: ' + Object.keys(S.DEFAULT_STATS.lifetime).join(', '));
});

await check('every counter background.js bumps is declared, so none is dropped in silence', async () => {
  /* bumpLifetime adds a key only when `stats.lifetime` already HAS it:
   *
   *   if (Object.prototype.hasOwnProperty.call(stats.lifetime, key)) ...
   *
   * so a counter that was never declared is not an error, not a warning and not
   * a zero — the bump simply does not happen, and the diagnostics panel shows a
   * number that can never move. That is exactly how the avatar counters shipped
   * dead, and then how the archive-media counter did. The whitelist is the right
   * design; a whitelist with no test is a trap. */
  const src = await readFile(path.join(REPO, 'background.js'), 'utf8');
  const declared = new Set(Object.keys(S.DEFAULT_STATS.lifetime));
  const marker = 'bumpLifetime(';
  const offenders = new Set();
  let at = src.indexOf(marker);

  while (at !== -1) {
    /* String literals out first. `bumpLifetime(x, 'IndexedDB open failed: ')`
       contains ` failed: ` and matched as a counter name — the guard has to be
       right about what it is looking at, or it reports a defect that is not
       there and gets switched off. */
    const args = callArguments(src, at + marker.length - 1)
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const keyPattern = /(?:^|[{,\s])([a-z][A-Za-z0-9_]*)\s*:/g;
    let m = keyPattern.exec(args);
    while (m !== null) {
      if (!declared.has(m[1])) offenders.add(m[1]);
      m = keyPattern.exec(args);
    }
    at = src.indexOf(marker, at + marker.length);
  }

  assert(offenders.size === 0,
    'bumped but never declared, so the bump is dropped: ' + [...offenders].join(', '));
});

await check('and the panel does not list a counter that is not declared', async () => {
  // The other direction: a row reading `lifetime.someKey || 0` for a key that
  // does not exist shows a permanent zero, which reads as "this never happens"
  // rather than as a typo.
  const src = await readFile(path.join(REPO, 'popup.js'), 'utf8');
  const declared = new Set(Object.keys(S.DEFAULT_STATS.lifetime));
  const offenders = new Set();
  const pattern = /lifetime\.([a-zA-Z][A-Za-z0-9_]*)/g;
  let m = pattern.exec(src);
  while (m !== null) {
    if (!declared.has(m[1])) offenders.add(m[1]);
    m = pattern.exec(src);
  }
  assert(offenders.size === 0,
    'the panel reads counters that do not exist: ' + [...offenders].join(', '));
});

/* ------------------------------------------------------------------ done -- */

console.log('\n' + '='.repeat(41));
console.log('passed: ' + passed + '   failed: ' + failures.length);
if (failures.length) {
  for (const f of failures) console.log('  FAILED: ' + f.name + ' — ' + f.message);
  process.exit(1);
}
