/**
 * import-wayback.mjs — pull an account's tweets out of the Internet Archive
 * and write them as an envelope this project's reader already understands.
 *
 *   node tools/import-wayback.mjs <handle> [--limit=N] [--out=FILE] [--all]
 *
 * This is the command-line half. What an archived payload MEANS — the mapping
 * from the Archive's JSON to this project's record, the offset arithmetic, the
 * fetching — lives in `wayback.js` at the repository root, which the extension
 * ships and its service worker uses for the same job. One implementation, two
 * callers; a second copy here would drift, and the copy that drifted would be
 * the one running inside the extension.
 *
 * What is left here is only what a command line needs: argument parsing, the
 * sampling policy, the file writer, and the order things happen in.
 *
 * This tool is NOT part of the extension and never ships in the package
 * (`make-zip.mjs` skips `tools/`). It makes exactly one kind of request, to
 * `web.archive.org`, and it never talks to X.
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { toRecord, toProfile, getJson, listSnapshots, normalizeSnapshots,
  SCHEMA_VERSION, DELAY_MS, WAYBACK } from '../wayback.js';

/** How many snapshots one run samples unless told otherwise. */
const DEFAULT_LIMIT = 100;

/* -------------------------------------------------------------------------- */
/* arguments                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = { handle: null, limit: DEFAULT_LIMIT, out: null, all: false };
  for (const arg of argv) {
    if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice(8), 10);
      if (Number.isFinite(n) && n > 0) out.limit = n;
    } else if (arg.startsWith('--out=')) {
      out.out = arg.slice(6);
    } else if (arg === '--all') {
      out.all = true;
    } else if (!arg.startsWith('--') && out.handle === null) {
      out.handle = arg.replace(/^@/, '');
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* sampling                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Pick `count` snapshots spread evenly across the whole span rather than the
 * first `count`. A validation run wants a sample of every period, not a
 * hundred records from one afternoon.
 */
function spread(snapshots, count) {
  if (snapshots.length === 0) return [];
  // One is a special case rather than the loop's own limit, because the loop
  // divides by `count - 1`: at one that is 0/0, Math.floor gives NaN, and the
  // result was a one-element array holding `undefined` — which then threw on
  // `.timestamp` several frames away from the arithmetic that caused it.
  if (count <= 1) return [snapshots[0]];
  if (snapshots.length <= count) return snapshots;
  const picked = [];
  const seen = new Set();
  for (let k = 0; k < count; k++) {
    const index = Math.floor((snapshots.length - 1) * k / (count - 1));
    if (!seen.has(index)) { seen.add(index); picked.push(snapshots[index]); }
  }
  return picked;
}

/* -------------------------------------------------------------------------- */
/* envelope                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Serialize to the exact bytes `buildTweetsJson` in popup.js produces: the
 * envelope keys on their own lines, one record per line.
 *
 * Both halves of that matter.
 *
 * The ORDER is load-bearing. The reader finds the tweets array by scanning
 * bytes for `"tweets"`, so anything large must not sit in front of it — and on
 * the way back it only probes a bounded window forward from the closing bracket
 * for `deletions` / `connections`, so nothing thick may sit behind it either.
 *
 * The COMPACTNESS is size. Pretty-printing every record inflates the file by
 * about a third (measured on a 100-record run: 217 KB against 151 KB), and at
 * a few thousand records that is the difference between a file the reader
 * opens at once and one it has to chew on.
 */
function serializeEnvelope(records, exportedAt, profile = null) {
  const rows = records.map((record) => JSON.stringify(record));
  return '{\n' +
    '  "schemaVersion": ' + SCHEMA_VERSION + ',\n' +
    '  "generator": "import-wayback",\n' +
    '  "generatorVersion": "1.1.0",\n' +
    '  "exportedAt": ' + JSON.stringify(exportedAt) + ',\n' +
    '  "timezone": ' + JSON.stringify({ name: 'UTC', offsetMinutes: 0, note: 'Timestamps are UTC.' }) + ',\n' +
    '  "tweets": [' + (rows.length === 0 ? '' : '\n    ' + rows.join(',\n    ') + '\n  ') + '],\n' +
    '  "count": ' + rows.length + ',\n' +
    /* The account's card, in the same place popup.js puts it: after `count` and
       in front of the two lists the reader probes a bounded window backwards
       from the end for. Written as an explicit null rather than omitted, so the
       key order does not depend on whether a card was found. */
    '  "profile": ' + JSON.stringify(profile) + ',\n' +
    '  "deletions": [],\n' +
    '  "connections": []\n' +
    '}\n';
}

/* -------------------------------------------------------------------------- */
/* run                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.handle === null) {
    console.error('usage: node tools/import-wayback.mjs <handle> [--limit=N] [--out=FILE] [--all]');
    process.exit(2);
  }

  console.log('[1/3] 查档案馆清单: @' + args.handle);
  const listed = await listSnapshots(args.handle);
  /* One row per CAPTURE, reduced to one per POST, exactly as the extension
     does it. Without this every re-capture of a tweet became its own record in
     the output — the same post written out two, three, a hundred times, which
     the reader shows as a repeated timeline because it only folds duplicates
     when two or more FILES are open, never within one. Measured on a real
     listing: 1666 rows for a few hundred distinct posts. */
  const snapshots = normalizeSnapshots(listed);
  console.log('      共 ' + snapshots.length + ' 条（列了 ' + listed.length + ' 次抓取）');
  if (snapshots.length === 0) {
    console.log('      档案馆里没有这个账号。');
    return;
  }

  const wanted = args.all ? snapshots : spread(snapshots, args.limit);
  console.log('[2/3] 取样 ' + wanted.length + ' 条，逐条拉原始 JSON');

  const seenAt = new Date().toISOString();
  const records = [];
  const failures = [];
  let mediaCount = 0;
  /* Every archived post carries the author's whole user object, so the card
     costs no request — but each payload carries the profile as it stood when
     THAT crawl ran, and they disagree. Measured on one account: 0, 407 and 810
     followers across three snapshots. The first row is the oldest post, so the
     first card would be the account on the day it started posting. Newest crawl
     wins, and `profileFrom` is the timestamp of the one currently held. */
  let profile = null;
  let profileFrom = null;

  for (let i = 0; i < wanted.length; i++) {
    const snapshot = wanted[i];
    const url = WAYBACK + '/' + snapshot.timestamp + 'id_/' + snapshot.original;
    const result = await getJson(url);

    if (!result.ok) {
      failures.push({ timestamp: snapshot.timestamp, error: result.error });
    } else {
      const record = toRecord(result.value, args.handle, seenAt);
      if (record === null) {
        failures.push({ timestamp: snapshot.timestamp, error: 'not a tweet payload' });
      } else {
        records.push(record);
        mediaCount += record.media.length;
      }
      const crawl = typeof snapshot.timestamp === 'string' ? snapshot.timestamp : '';
      if (profileFrom === null || crawl > profileFrom) {
        const card = toProfile(result.value, args.handle);
        if (card !== null) { profile = card; profileFrom = crawl; }
      }
    }

    if ((i + 1) % 10 === 0 || i === wanted.length - 1) {
      console.log('      ' + (i + 1) + '/' + wanted.length);
    }
    await sleep(DELAY_MS);
  }

  console.log('[3/3] 写文件');
  const target = args.out || ('wayback-' + args.handle + '.json');
  writeFileSync(target, serializeEnvelope(records, new Date().toISOString(), profile), 'utf8');

  const dates = records.map((r) => r.createdAt).sort();

  console.log('');
  console.log('  写入      ' + target);
  console.log('  记录      ' + records.length + (failures.length ? '（失败 ' + failures.length + '）' : ''));
  console.log('  带媒体    ' + records.filter((r) => r.media.length > 0).length + ' 条 / ' + mediaCount + ' 个文件');
  console.log('  回复      ' + records.filter((r) => r.isReply).length + '   转推 ' + records.filter((r) => r.isRetweet).length + '   引用 ' + records.filter((r) => r.quoteTweetId).length);
  if (dates.length) console.log('  时间      ' + dates[0] + '  →  ' + dates[dates.length - 1]);
  console.log('  资料卡    ' + (profile === null
    ? '没找到（这几条里没有这个账号的用户对象）'
    : '@' + profile.screenName + '  ' + (profile.name || '') +
      '  粉丝 ' + profile.followersCount + ' / 推文 ' + profile.tweetCount +
      (profile.bannerUrl === null ? '  （无横幅）' : '')));
  if (failures.length) {
    console.log('');
    console.log('  失败样本:');
    for (const failure of failures.slice(0, 5)) console.log('    ' + failure.timestamp + '  ' + failure.error);
  }
  console.log('');
  console.log('  用阅读器打开这个文件看看。');
}

/* -------------------------------------------------------------------------- */
/* exports                                                                    */
/* -------------------------------------------------------------------------- */

/* Only what this file owns. The mapping is imported from ../wayback.js by
   whoever wants it; re-exporting it from here would be a second surface to
   keep in step, which is the thing this split exists to remove. */
export { parseArgs, spread, serializeEnvelope };

/* Run only when this file IS the command. Without this guard, importing it from
   the test would start a real download. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('失败：' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
}
