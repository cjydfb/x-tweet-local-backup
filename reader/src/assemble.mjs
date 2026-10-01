/* Assemble the new reader.html.
 *
 * The CORE block is not rewritten here — it is sliced out of the file that is
 * already on disk, using the exact same rules tools/test-reader.mjs uses to
 * extract it, and pasted in verbatim. Retyping it would risk a one-character
 * change in the one part of this file that must not change at all.
 *
 *   node assemble.mjs [--check]
 *
 * --check writes nothing and reports whether the file on disk already matches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* The parts live next to this file, in reader/src/, and the result is written
   one level up as reader/reader.html. Both are resolved from this script's own
   location rather than hard-coded, so the checkout can sit anywhere.
 *
 * These parts used to live in %TEMP%, which meant the deliverable was a
 * generated file whose generator could be deleted by a disk cleanup — leaving
 * reader.html readable but unmaintainable, with nothing in the repository to say
 * where it came from. It is also worth knowing that reader/ is in make-zip.mjs's
 * SKIP_DIRS, so none of this is ever packaged with the extension. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(path.dirname(HERE), 'reader.html');
const check = process.argv.includes('--check');

/* --- slice the untouched middle out of the existing file ------------------ */

const old = fs.readFileSync(TARGET, 'utf8');
const beginMarker = old.indexOf('CORE BEGIN');
const endMarker = old.indexOf('CORE END');
if (beginMarker < 0 || endMarker < 0 || endMarker < beginMarker) {
  console.error('the CORE markers are not where they were expected');
  process.exit(1);
}
const coreStart = old.indexOf('*/', beginMarker) + 2;
const coreEnd = old.lastIndexOf('/*', endMarker);
const core = old.slice(coreStart, coreEnd);
if (core.indexOf('findTweetsArray') < 0 || core.length < 5000) {
  console.error('the CORE slice came out wrong (length ' + core.length + ')');
  process.exit(1);
}
/* The prose comment that opens the block, and the closing comment. Both are
   carried across unchanged; they are part of what the markers delimit for a
   reader of the file, even though the test only takes the code between them. */
const openingComment = old.slice(old.lastIndexOf('/*', beginMarker), coreStart);
const closingComment = old.slice(coreEnd, old.indexOf('\n', old.indexOf('*/', endMarker)) + 1);

/* --- read the new parts --------------------------------------------------- */

const PARTS = ['00-head.html', '10-helpers.js', '20-loading.js', '25-stats.js',
  '30-scroll.js', '40-card.js', '50-search.js', '55-tabs.js', '57-me.js',
  '58-roster.js', '60-media.js', '70-page.js', '80-export.js'];

let out = '';
const head = fs.readFileSync(path.join(HERE, '00-head.html'), 'utf8');
if (!/\<script\>\s*$/.test(head)) {
  console.error('00-head.html must end with an open <script> tag');
  process.exit(1);
}
out += head;

out += openingComment + core + closingComment;
out += '\n';

for (const name of PARTS.slice(1)) {
  const src = fs.readFileSync(path.join(HERE, name), 'utf8');
  out += '\n' + src.replace(/\s*$/, '') + '\n';
}

out += '</script>\n</body>\n</html>\n';

/* --- structural checks ---------------------------------------------------- */

const problems = [];
const count = (needle) => out.split(needle).length - 1;

if (count('CORE BEGIN') !== 1) problems.push('CORE BEGIN appears ' + count('CORE BEGIN') + ' times');
if (count('CORE END') !== 1) problems.push('CORE END appears ' + count('CORE END') + ' times');
if (count('<script>') !== 1) problems.push('<script> appears ' + count('<script>') + ' times');
if (count('</script>') !== 1) problems.push('</script> appears ' + count('</script>') + ' times');

const externals = out.match(/(?:src|href)\s*=\s*["']https?:[^"']+/gi) || [];
if (externals.length) problems.push('external references: ' + externals.join(', '));

if (out.indexOf(core) < 0) problems.push('the CORE block did not survive the join');

/* A NUL byte makes the file binary as far as most tools are concerned, and
   silently breaks every text search over it. */
for (let i = 0; i < out.length; i++) {
  const c = out.charCodeAt(i);
  if (c === 0) { problems.push('NUL byte at ' + i); break; }
  if (c >= 0x7f && c <= 0x9f && c !== 0x85) { problems.push('control character U+' + c.toString(16) + ' at ' + i); break; }
}

if (problems.length) {
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

if (check) {
  const same = fs.existsSync(TARGET) && fs.readFileSync(TARGET, 'utf8') === out;
  console.log(same ? 'reader.html matches the assembled output' : 'reader.html differs from the assembled output');
  process.exit(same ? 0 : 1);
}

fs.writeFileSync(TARGET, out, 'utf8');
const lines = out.split('\n').length;
console.log('wrote reader/reader.html — ' + lines + ' lines, ' + out.length + ' bytes');
console.log('  CORE slice: ' + core.length + ' bytes (carried over verbatim)');
