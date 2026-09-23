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
  'debug', 'mediaCache', 'showRemoteThumbnails', 'backfillMedia', 'captureReplies', 'choicePanelAnswered'
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
    choicePanelAnswered: false,
    pageSize: 30
  });
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

/* ------------------------------------------------------------------ done -- */

console.log('\n' + '='.repeat(41));
console.log('passed: ' + passed + '   failed: ' + failures.length);
if (failures.length) {
  for (const f of failures) console.log('  FAILED: ' + f.name + ' — ' + f.message);
  process.exit(1);
}
