/* Verifies that every i18n key referenced anywhere actually exists in both
   locale files, and that no key was left defined-but-unused. Wrong keys are
   silent at runtime — chrome.i18n.getMessage returns "" and the UI shows the
   raw key — so this is the only place they can be caught. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file's own location, so the checker runs from a fresh
// clone regardless of the working directory.
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const en = JSON.parse(read('_locales/en/messages.json'));
const zh = JSON.parse(read('_locales/zh_CN/messages.json'));

const used = new Set();

for (const m of read('popup.js').matchAll(/\bt\('([A-Za-z0-9_]+)'/g)) used.add(m[1]);

const ATTR = /data-i18n(?:-html|-title|-placeholder|-aria-label)?="([A-Za-z0-9_]+)"/g;
for (const m of read('popup.html').matchAll(ATTR)) used.add(m[1]);

for (const m of read('manifest.json').matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);

// Any getMessage('literal') elsewhere (e.g. future background use).
for (const m of read('popup.js').matchAll(/getMessage\('([A-Za-z0-9_]+)'/g)) used.add(m[1]);

console.log('referenced keys:', used.size);

const missEn = [...used].filter((k) => !en[k]);
const missZh = [...used].filter((k) => !zh[k]);
console.log('missing in en:', missEn.length ? missEn : 'none');
console.log('missing in zh:', missZh.length ? missZh : 'none');

const unused = Object.keys(en).filter((k) => !used.has(k));
console.log('defined but unused:', unused.length ? unused : 'none');

// The two files must stay in lockstep.
const onlyEn = Object.keys(en).filter((k) => !zh[k]);
const onlyZh = Object.keys(zh).filter((k) => !en[k]);
console.log('only in en:', onlyEn.length ? onlyEn : 'none');
console.log('only in zh:', onlyZh.length ? onlyZh : 'none');

// Placeholders must match, or a translation silently drops a value.
const bad = [];
for (const k of Object.keys(en)) {
  if (!zh[k]) continue;
  const pe = (en[k].message.match(/\$[0-9]/g) || []).sort().join(',');
  const pz = (zh[k].message.match(/\$[0-9]/g) || []).sort().join(',');
  if (pe !== pz) bad.push(k + '  en[' + pe + '] zh[' + pz + ']');
}
console.log('placeholder mismatches:', bad.length ? bad : 'none');

const fail = missEn.length + missZh.length + onlyEn.length + onlyZh.length + bad.length + unused.length;
console.log(fail === 0 ? '\nOK' : '\nFAILED');
process.exit(fail === 0 ? 0 : 1);
