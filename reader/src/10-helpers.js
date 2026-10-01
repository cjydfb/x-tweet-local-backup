/* ===========================================================================
 * UI
 *
 * Everything below may touch the DOM. It only ever calls into the block above,
 * which is what keeps the tested part tested.
 *
 * The CORE block above is not modified by any of this: it scans bytes, indexes
 * offsets and reads the ZIP directory, and none of that cares what a card looks
 * like. Three of its rules are load-bearing here and are easy to break by
 * "improving" them:
 *   - readRecordAt never throws — it returns {ok:false,error}
 *   - eachChunk does NOT await its callback, so the visitor must be synchronous
 *   - locateEntryData DOES throw, and is the only one that does
 * ======================================================================== */

/* ------------------------------------------------------------------ pure --
 * Arithmetic with real edge cases and no DOM, kept behind markers so
 * tools/test-reader.mjs can extract and test it exactly the way it tests the
 * core block. It sits BELOW the core block on purpose: the core slice is taken
 * with a lastIndexOf that walks backwards from the closing marker, so nothing
 * down here can perturb it however large it grows.
 * ------------------------------------------------------------------------ */

/* PURE BEGIN */

/**
 * Card height before the card exists.
 *
 * The only per-row size signal the index holds is the record's byte length, so
 * this is a monotone map from bytes to pixels. It does not have to be good: a
 * wrong estimate never reaches the screen, because positions and the display
 * both come from the same table and every visible row is measured before the
 * frame is painted. It only decides how wrong the scrollbar's scale looks.
 */
function estimateHeight(bytes) {
  if (!(bytes > 0)) return 118;
  if (bytes <= 800) return 118;          /* no text, no media: one line */
  if (bytes <= 1600) return 196;
  var h = 200 + (bytes - 1600) * 0.5;
  return h > 2400 ? 2400 : h;
}

/**
 * Per-row heights with a two-level prefix sum.
 *
 *  h        Float32Array(n)          current height of each row
 *  blk      Float64Array(ceil(n/B))  sum of h over one block
 *  measured Uint8Array(n)            1 once a real DOM height came back
 *  total    number                   cached sum of blk
 *
 * Rows are addressed by index rather than as objects: at 100k records an array
 * of {start,end} objects is megabytes before it holds a single value, and the
 * same reasoning is why this is typed arrays and not a plain Array.
 */
var HT_BLOCK = 256;

function createHeightTable(n, estimateAt) {
  /* `h`, `measured` and `blk` are filled once and then only mutated, so they
     never need rebinding — which is what lets the closures below read them
     directly. `n` and `total` do change, and are the two the methods track. */
  var h = new Float32Array(n);
  var measured = new Uint8Array(n);
  for (var i = 0; i < n; i++) h[i] = estimateAt(i);

  var nb = Math.ceil(n / HT_BLOCK) || 1;
  var blk = new Float64Array(nb);
  var total = 0;
  for (var j = 0; j < n; j++) { blk[(j / HT_BLOCK) | 0] += h[j]; total += h[j]; }

  var t = {
    n: n,
    h: h,
    blk: blk,
    measured: measured,
    total: total,
    counts: new Uint8Array(n),   /* how many times a row has been corrected */
    frozen: false,

    get: function (i) { return h[i]; },

    set: function (i, px) {
      if (!(px > 0) || i < 0 || i >= n) return 0;
      var d = px - h[i];
      if (d === 0) return 0;
      h[i] = px;
      blk[(i / HT_BLOCK) | 0] += d;
      total += d;
      t.total = total;
      measured[i] = 1;
      return d;
    },

    /** Sum of h[0..i-1]. */
    offsetOf: function (i) {
      if (i <= 0) return 0;
      if (i > n) i = n;
      var b = (i / HT_BLOCK) | 0;
      var acc = 0;
      for (var k = 0; k < b; k++) acc += blk[k];
      for (var j2 = b * HT_BLOCK; j2 < i; j2++) acc += h[j2];
      return acc;
    },

    /** Largest index whose top is at or above y. */
    indexAt: function (y) {
      if (n === 0) return 0;
      if (!(y > 0)) return 0;
      var b = 0, acc = 0, nblk = blk.length;
      while (b < nblk && acc + blk[b] <= y) { acc += blk[b]; b++; }
      if (b >= nblk) return n - 1;
      var i = b * HT_BLOCK, end = Math.min(n, i + HT_BLOCK);
      while (i < end && acc + h[i] <= y) { acc += h[i]; i++; }
      return i > n - 1 ? n - 1 : i;
    },

    bump: function (i) {
      if (t.counts[i] < 255) t.counts[i]++;
      return t.counts[i];
    }
  };
  return t;
}

/**
 * The height table for the list currently on screen — sized from the LIST, not
 * from the archive.
 *
 * This one function is the whole of a bug that shipped: `rebuildHeights` built
 * its table from `archive.ranges.length` whatever the list was, so a search
 * returning 592 hits got a 20 592-row table. The scroll area grew to 4 274 710
 * pixels instead of about 118 000, and everything past hit 592 was a row whose
 * record did not exist — every card below the fold read "这一条读不出来：
 * Cannot read properties of undefined (reading 'start')".
 *
 * `ids` is the displayed record indices in order, or null for "the archive in
 * its own order". It is the same array `list.ids` holds, and the row at
 * position i is sized from the record the list says is there — which is the
 * property that makes the table and the list impossible to disagree.
 */
function buildHeightsFor(ranges, ids) {
  var n = ids === null ? ranges.length : ids.length;
  return createHeightTable(n, function (i) {
    var r = ranges[ids === null ? i : ids[i]];
    return estimateHeight(r ? r.end - r.start : 0);
  });
}

/**
 * The same character filter the extension applies when it names a media file.
 *
 * It has to be applied on both sides of the join. A media id that is not purely
 * `[A-Za-z0-9_-]` is stored verbatim in the record but had its other characters
 * dropped when the file was named, so keying the lookup on the raw id would miss
 * every such file — and miss it silently, as an empty frame.
 */
function safeNamePart(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * `media/<tweetId>_<mediaId><ext>` -> `"<tweetId> <mediaId>"`, or null.
 *
 * Split at the FIRST underscore, never the last. The tweet id is numeric and
 * the extension skips any row whose sanitized tweet id is empty, so the leading
 * segment is always the whole tweet id — while the media id itself contains
 * underscores, because it falls back to X's `media_key`, which looks like
 * `3_1234567890`. Splitting at the last underscore would read part of the media
 * key as part of the tweet id and the join would silently find nothing.
 *
 * The space separator stops "12" + "3" colliding with "1" + "23".
 */
function mediaKeyFromEntryName(name) {
  if (typeof name !== 'string') return null;
  if (name.lastIndexOf('media/', 0) !== 0) return null;
  var rest = name.slice(6);
  if (rest.length === 0) return null;
  var dot = rest.lastIndexOf('.');
  if (dot > 0) rest = rest.slice(0, dot);
  var cut = rest.indexOf('_');
  if (cut <= 0 || cut >= rest.length - 1) return null;
  var tweetId = rest.slice(0, cut);
  var mediaId = rest.slice(cut + 1);
  if (!/^[0-9]+$/.test(tweetId) || mediaId.length === 0) return null;
  return tweetId + ' ' + mediaId;
}

/**
 * The key the media map is looked up with, from a record's own ids.
 *
 * Returns null rather than a half-key when the media has no id of its own: a
 * tweet carrying a media object with nothing to match on must render as "no
 * file for this", not as a lookup that will fail later in a different place.
 */
function mediaKeyFor(tweetId, mediaId) {
  var m = safeNamePart(mediaId);
  if (m.length === 0) return null;
  return String(tweetId) + ' ' + m;
}

/** Midnight of a YYYY-MM-DD in the display zone, as a UTC instant. */
function dayStartMs(ymd, offsetMinutes) {
  var p = String(ymd).split('-');
  var y = parseInt(p[0], 10);
  if (!isFinite(y)) return null;
  var mo = p.length > 1 ? parseInt(p[1], 10) : 1;
  var d = p.length > 2 ? parseInt(p[2], 10) : 1;
  if (!isFinite(mo) || !isFinite(d)) return null;
  return Date.UTC(y, mo - 1, d, 0, 0, 0) - offsetMinutes * 60000;
}

/** X's abbreviated counts: 1234 -> 1.2K, 3400000 -> 3.4M. */
function fmtCount(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
  if (n < 1000) return String(n);
  if (n < 1000000) {
    var k = n / 1000;
    return (k < 10 ? k.toFixed(1) : Math.round(k)) + 'K';
  }
  var m = n / 1000000;
  return (m < 10 ? m.toFixed(1) : Math.round(m)) + 'M';
}

/**
 * The grid shape for n media items: 'n1'..'n4' for the layout classes.
 * X shows at most four and counts the rest.
 */
function gridShape(n) {
  if (n <= 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 3;
  return 4;
}

/**
 * Resolve overlapping entity spans in a post's text.
 *
 * X's entities routinely overlap — a t.co link whose display text contains a
 * hashtag, a mention inside a URL — and nesting anchors produces broken HTML.
 * Keep the longest span at each position and drop anything that intersects it,
 * then return the surviving spans in order. Touching spans (end === start) are
 * not overlaps.
 */
function resolveSpans(spans) {
  var ok = [];
  for (var i = 0; i < spans.length; i++) {
    var s = spans[i];
    if (!s || !(s.end > s.start) || s.start < 0) continue;
    ok.push({ start: s.start, end: s.end, kind: s.kind, href: s.href, text: s.text });
  }
  ok.sort(function (a, b) { return a.start - b.start || (b.end - b.start) - (a.end - a.start); });
  var out = [];
  for (var j = 0; j < ok.length; j++) {
    var cur = ok[j];
    var blocked = false;
    for (var k = 0; k < out.length; k++) {
      if (cur.start < out[k].end && cur.end > out[k].start) { blocked = true; break; }
    }
    if (!blocked) out.push(cur);
  }
  out.sort(function (a, b) { return a.start - b.start; });
  return out;
}

/**
 * Where the JSON value that starts at `openIndex` ends.
 *
 * Returns the index just past the value's closing bracket, or -1 when it never
 * closes. It walks CHARACTERS, not bytes: this runs on decoded text, where one
 * character can be several bytes, and a byte count would be wrong for every CJK
 * bio.
 *
 * A depth counter alone is not enough. A bio is free text and routinely contains
 * `{`, `}`, `"` and `\`, so the walk has to know when it is inside a string —
 * and inside a string an escaped character is consumed whole, because `\"` is a
 * quote that closes nothing. The bracket TYPE is matched too: `{"a":1]}` is not
 * a value, and returning a slice of it would only move the failure into
 * JSON.parse, several frames away from the text that caused it.
 */
function readJsonValueEnd(text, openIndex) {
  if (typeof text !== 'string') return -1;
  /* typeof first: `null` and `''` both compare as `>= 0` after coercion, and a
     caller that passed one of those by accident would otherwise get the end of
     whatever brace happens to sit at index 0. */
  if (typeof openIndex !== 'number' || !(openIndex >= 0) || openIndex >= text.length) return -1;
  var first = text.charAt(openIndex);
  if (first !== '{' && first !== '[') return -1;

  var stack = [first === '{' ? '}' : ']'];
  var inString = false;
  for (var i = openIndex + 1; i < text.length; i++) {
    var c = text.charAt(i);
    if (inString) {
      /* `continue` still runs the loop's `i++`, so this consumes both the
         backslash and the character it escapes — which is the whole point. */
      if (c === '\\') { i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); continue; }
    if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The account's own profile out of an export envelope, or null.
 *
 * The envelope is never parsed as a whole — it is most of a large file — so the
 * object is located by its key and cut out with readJsonValueEnd. The value
 * cannot be matched with `[^}]*`: the profile carries a nested `source` object
 * and a `bioUrls` array of objects, and a lazy match would stop at the first
 * `}` — inside somebody's bio, more often than not.
 *
 * A tweet's own text cannot produce a false hit. The quotes around a key inside
 * a JSON string are escaped, so the raw sequence `"profile":` can only occur
 * where a real key is, exactly the property findTweetsArray relies on.
 *
 * Every failure returns null instead of throwing. No profile is a normal state —
 * it is the newest field in the format, so every older export has none — and the
 * caller has a message for it.
 */
function readEnvelopeProfile(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  var m = text.match(/"profile"\s*:\s*[{\[]/);
  if (!m) return null;
  var open = m.index + m[0].length - 1;
  var end = readJsonValueEnd(text, open);
  if (end < 0) return null;
  try {
    var parsed = JSON.parse(text.slice(open, end));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * The intersection of two ascending arrays of record indices, in ascending
 * order, without duplicates.
 *
 * Two pointers, no Set, no sort: both inputs come out of a scan that walked the
 * archive front to back, so they are already ascending and the answer is one
 * linear merge. A Set would hold a second copy of both arrays, and a sort would
 * cost more than the merge it was correcting.
 *
 * This is what narrows a search under a tab: `hits` is what the query matched and
 * the tab's list is what the column holds, and the displayed list is where the
 * two agree.
 */
function intersectAscending(a, b) {
  var out = [];
  if (!Array.isArray(a) || !Array.isArray(b)) return out;
  var i = 0, j = 0;
  while (i < a.length && j < b.length) {
    var x = a[i], y = b[j];
    if (x === y) {
      /* Neither input promises to be free of duplicates, and a duplicated
         position would put the same post on screen twice. */
      if (out.length === 0 || out[out.length - 1] !== x) out.push(x);
      i++; j++;
    } else if (x < y) i++;
    else j++;
  }
  return out;
}

/**
 * Does the envelope carry a NON-EMPTY array under this key?
 *
 * Presence of the key is not the question the caller is asking. `deletions` is
 * written on every export whether or not anything was ever deleted, so a bare
 * key scan told a brand-new archive — nothing deleted, empty array — that it
 * carried a tombstone list, and the reader warned about data the file does not
 * have. A warning that fires on every file is a warning nobody reads.
 *
 * `connections` is omitted when empty, so for that key the two answers coincide;
 * this is used for both anyway, because a hand-assembled file can contain an
 * empty one and the honest answer is the same in both cases.
 *
 * The lookahead is the whole of it: `[]` and `[ ]` are empty, anything else is
 * not. It reads bytes rather than parsing, like every other envelope lookup
 * here, because the array it is looking at may be megabytes long.
 */
/**
 * The two hosts this page is willing to FETCH an image from.
 *
 * The same pair the extension's own sanitizer allows, so a file this extension
 * wrote and a file the reader is handed are judged by one rule.
 */
var REMOTE_MEDIA_HOSTS = ['pbs.twimg.com', 'video.twimg.com'];

/**
 * A URL that may be fetched — a stricter question than safeExternalUrl answers.
 *
 * safeExternalUrl only insists on http(s), which is right for a link the reader
 * clicks: the browser navigates, and the reader sees where they ended up. Fetching
 * is a different act. The 头像 dialog promises in writing that the request goes to
 * `pbs.twimg.com` and nowhere else, and that promise is the entire basis on which
 * the switch was turned on. An avatar or banner address pointing anywhere else
 * must therefore not be loaded at all — otherwise a hand-edited or forwarded
 * archive could use the one switch that opens the network as a beacon, and the
 * consent given would not have covered it.
 *
 * It repeats the protocol check rather than calling safeExternalUrl, because
 * this lives in the PURE block, which is sliced out and evaluated on its own.
 * That is also what makes it testable, and a rule about what may be fetched is
 * worth a test more than most things here.
 */
function remoteMediaUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  var parsed;
  try { parsed = new URL(value); } catch (_) { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (REMOTE_MEDIA_HOSTS.indexOf(parsed.hostname.toLowerCase()) === -1) return null;
  return parsed.href;
}

/**
 * The four renders X makes of one profile picture, smallest first.
 *
 * The size is the last word of the file name, so choosing one is a rename
 * rather than a different request: same host, same permission, same picture.
 */
var AVATAR_TIERS = [
  ['_mini', 24],
  ['_normal', 48],
  ['_bigger', 73],
  ['_400x400', 400]
];

/**
 * Ask for the face at a size worth having in this slot.
 *
 * The address an archive stores is the `_normal` render — 48 pixels square —
 * because that is what X's own timeline bubble asks for and what the capture
 * happens to record. The profile header draws that same address at 142 CSS
 * pixels, which on the 2× screen this was measured on is 284 real pixels: it was
 * being enlarged nearly six times, and it looked it. Measured, before and after:
 * `_normal` is 2.5 KB and 48×48; `_400x400` is 28 KB and 400×400.
 *
 * The rule is the smallest render at least as big as the slot. It picks
 * `_400x400` for the header and `_normal` for a 40px timeline bubble, which is
 * what X itself uses there — a `_400x400` on every face in a list would be
 * seven times the bytes for a difference nobody can see at that size.
 *
 * It never picks a SMALLER render than the address already names. An archive
 * that says `_400x400` was written by something that chose it, and re-pointing
 * it at a smaller file to save bytes is the same class of silent loss this
 * project exists to avoid.
 *
 * Anything that is not one of the four known tiers — a hand-edited address, a
 * different host, a query string hanging off the end — is handed back exactly
 * as it arrived. This rewrites an address; it does not invent one.
 */
function sizedAvatarUrl(value, size) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (typeof size !== 'number' || !isFinite(size) || size <= 0) return value;

  var current = -1;
  var suffix = null;
  for (var i = 0; i < AVATAR_TIERS.length; i++) {
    var re = new RegExp(AVATAR_TIERS[i][0] + '\\.(\\w+)$', 'i');
    if (re.test(value)) { current = i; suffix = AVATAR_TIERS[i][0]; break; }
  }
  if (current < 0) return value;

  var want = AVATAR_TIERS.length - 1;
  for (var j = 0; j < AVATAR_TIERS.length; j++) {
    if (AVATAR_TIERS[j][1] >= size) { want = j; break; }
  }
  if (want <= current) return value;

  return value.replace(new RegExp(suffix + '(\\.\\w+)$', 'i'), AVATAR_TIERS[want][0] + '$1');
}

function envelopeHasList(text, key) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (typeof key !== 'string' || key.length === 0) return false;
  return new RegExp('"' + key + '"\\s*:\\s*\\[(?!\\s*\\])').test(text);
}

/**
 * A data: URL for an image, or null.
 *
 * The account's own picture is carried inside the archive rather than fetched,
 * and this is the one place that value is allowed through. It gets the same
 * treatment as every other URL in this file, and for a sharper reason: a
 * `data:` URL can carry `text/html` and script as easily as a photograph. This
 * one is handed to an `<img>`, which is what makes it harmless today — and
 * "something else will always hand it to an `<img>`" is exactly the assumption
 * that stops being true. The check belongs here, next to the remote one.
 *
 * The size cap is separate from the shape check: the field arrives inside an
 * object the reader parses as the envelope, and a file claiming a gigabyte of
 * avatar should be refused before a regex is asked to walk it.
 */
function safeDataImageUrl(value) {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > 4 * 1024 * 1024) return null;
  return /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? value : null;
}

/* --------------------------------------------------------- the merge rule -- */

/* The same three functions that decide what happens when the extension captures
 * the same post twice, copied here so that merging two EXPORTS of one account
 * reaches the same answer the database would have.
 *
 * A copy, and it is worth being honest about the cost: two implementations of
 * one rule drift. What stops these two is a test — tools/test-reader.mjs feeds
 * the same corpus to both this and db.js and asserts the results are identical,
 * so a change to either one that the other does not follow turns the suite red
 * instead of quietly producing two different archives.
 *
 * The rule, in one line: THE NEWEST ANSWER WINS, UNLESS IT IS EMPTY.
 */

/**
 * Whether a value carries an answer at all.
 *
 * An empty ARRAY counts as empty, and that case is load-bearing: an import from
 * the Internet Archive writes `media: []` for a post whose media it could not
 * lay hands on, and reading that as "this post has no media" would drop the
 * photographs this machine actually watched being posted.
 *
 * Zero and false are NOT empty. They are answers — "no likes", "not marked
 * sensitive" — and the rule exists so a real answer always beats an old one.
 */
function isAbsent(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge one field of a fresher record into the one already held.
 *
 * Lists merge as whole units: the fresh list wins if it has anything in it, and
 * an empty one leaves the stored list alone. Objects merge key by key,
 * downward — a degraded response routinely carries a container with nothing in
 * it, and taking that wholesale would blank four good fields to record one thin
 * one. A key only the older record has survives, which is what keeps
 * `supersededBy` and `deletedAt` alive: they are written to a record that is
 * already on disk and never travel with a capture.
 */
function mergeField(before, next) {
  if (isPlainObject(before) && isPlainObject(next)) {
    var out = {};
    var keys = Object.keys(next);
    for (var i = 0; i < keys.length; i++) {
      /* A record comes from a file anybody can hand this reader, and
         `JSON.parse` makes `__proto__` an ordinary own key — but a plain `[]`
         assignment on it does NOT: it sets the object's prototype instead. A
         record carrying that key would therefore rewrite what `out` inherits
         from. Nothing here reads an inherited field, so this is a hole rather
         than a break-in; it is closed by refusing the key, which costs nothing
         because no real record has one. */
      if (keys[i] === '__proto__') continue;
      out[keys[i]] = mergeField(before[keys[i]], next[keys[i]]);
    }
    var older = Object.keys(before);
    for (var j = 0; j < older.length; j++) {
      if (!Object.prototype.hasOwnProperty.call(out, older[j])) out[older[j]] = before[older[j]];
    }
    return out;
  }
  if (isAbsent(next)) {
    /* Neither side has anything to say. Keeping a stored `undefined` would
       leave the key present with no value where every other record has an
       explicit null, and a reader testing for null would be right about every
       record but this one. */
    return before === undefined ? next : before;
  }
  return next;
}

/** The whole record. Iterated in the fresher record's key order, so fields stay
    in the documented order however many times a record is rewritten. */
function mergeCapture(previous, fresh) {
  var merged = {};
  var keys = Object.keys(fresh);
  for (var i = 0; i < keys.length; i++) merged[keys[i]] = mergeField(previous[keys[i]], fresh[keys[i]]);
  var older = Object.keys(previous);
  for (var j = 0; j < older.length; j++) {
    if (!Object.prototype.hasOwnProperty.call(merged, older[j])) merged[older[j]] = previous[older[j]];
  }
  return merged;
}

/**
 * The account a set of open archives can agree on, or null if they cannot.
 *
 * With one archive this is that archive's own profile and the header is exactly
 * what it always was. With several it is the account they all name — which is
 * the ordinary case rather than the exotic one: two exports of the same account
 * taken an hour apart are two files, and there was never anything ambiguous
 * about putting that account's header above them. Treating "more than one file"
 * as "no single account" hid the header on precisely the reading people do
 * most.
 *
 * A file with no profile at all is not a disagreement. An archive written
 * before the header existed, opened beside a newer one, is still the one
 * account, and the newer file's card is the one to draw.
 *
 * A real disagreement — two different accounts open together — still has no
 * single honest header, and returns null so the caller can draw the list of
 * them instead of drawing one account's name over another account's posts.
 */
function sharedProfile(list) {
  if (!Array.isArray(list)) return null;
  var found = null;
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!p || typeof p !== 'object') continue;
    if (found === null) { found = p; continue; }
    if (accountKey(p) !== accountKey(found)) return null;
  }
  return found;
}

/**
 * What identifies the account behind a profile.
 *
 * The id when there is one, the handle otherwise — a file whose profile lost
 * its `userId` still names somebody, and comparing two empty strings would call
 * two different accounts the same person. The handle is compared folded,
 * because a stored handle's case is whatever the export happened to carry.
 */
function accountKey(p) {
  var userId = p && p.userId !== undefined && p.userId !== null ? String(p.userId) : '';
  if (userId) return 'id ' + userId;
  var handle = p && typeof p.screenName === 'string' ? p.screenName.toLowerCase() : '';
  return 'name ' + handle;
}

/* PURE END */

/* ------------------------------------------------------------------ state -- */

var CACHE_LIMIT = 1500;          /* parsed records; a card is 2-5 KB, not 900 B */
var SCAN_CHUNK = 4 * 1024 * 1024;      /* building the index: few, large reads */
var SCAN_RECORD_CHUNK = 512 * 1024;    /* search: many, small reads, smooth bar */
var OVERSCAN = 4;
var FIXED_H = 118;               /* the #fixed escape hatch */

var archive = {
  /* Every open file, in the order they were opened. Each one owns its bytes,
     its own byte ranges and its own media map.

     The fields below are the MERGED view over these, and with exactly one source
     they are that source's own values — which is the whole reason a single-file
     open behaves exactly as it did before this existed. */
  sources: [],

  file: null,
  source: null,                  /* the tweets.json Blob — offsets are into THIS */
  kind: 'zip',
  entries: null,                 /* the ZIP central directory, when there is one */
  mediaMap: null,                /* key -> {off,len,method,start?,end?} */
  mediaJoin: null,               /* 'index' | 'names' | null */
  mediaStats: null,
  envelope: {},
  profile: null,                 /* the account's own card, or null when the file has none */
  ranges: [],
  headText: null,                /* per-file envelope probe cache */
  /* Identifies the BYTES UNDER EVERY INDEX. It is bumped whenever the source
     set is rebuilt, because rebuilding renumbers every record: a read that
     comes back afterwards is answering a question about a different row. It is
     NOT bumped by a tab click or a new search — the bytes did not move. */
  gen: 0
};

/**
 * Where a merged record index lives: which source, and which record within it.
 *
 * Every record in `archive.ranges` carries the two numbers, put there when the
 * merged array is built, so this is a lookup rather than a search. They have to
 * travel ON the range rather than be derived from its position, because the day
 * the merged order stops being "all of source 0, then all of source 1" — and it
 * does, as soon as the timeline is sorted by time — position stops meaning
 * anything.
 */
function sourceOf(recIdx) {
  var r = archive.ranges[recIdx];
  return r === undefined ? null : archive.sources[r.src];
}

/**
 * What is on screen, as a position -> record index map.
 *
 * `ids` is the whole model: the displayed record indices in ascending order, or
 * null for "the archive in its own order" — which is the unfiltered timeline,
 * and the reason that view costs no scan at all. Everything else — the search,
 * the tabs, the scope — only decides how `ids` is built, and every consumer goes
 * through length() and at() rather than indexing archive.ranges itself.
 *
 * `hits` is the raw search result, unfiltered, kept apart from `ids` so that
 * narrowing under an active search is a merge over two ascending arrays rather
 * than another pass over the file.
 */
var list = {
  mode: 'timeline',              /* 'timeline' | 'search' */
  tab: 'posts',                  /* 'posts' | 'replies' | 'media' */
  scope: 'all',                  /* 'all' | 'posts' — read by the 帖子 tab only */
  q: '',
  terms: [],
  hits: [],                      /* search matches, ascending, unfiltered */
  ids: null,                     /* displayed record indices; null = identity */

  length: function () { return list.ids === null ? archive.ranges.length : list.ids.length; },
  at: function (i) { return list.ids === null ? i : list.ids[i]; },

  /**
   * Where a record sits in the displayed list, or -1.
   *
   * The inverse of at(), and needed because the date jump bisects the ARCHIVE
   * for a record index while the scroller works in positions. The two are the
   * same number only while `ids` is null — exactly the kind of coincidence this
   * file has already been bitten by, which is why this is an explicit lookup
   * rather than an assumption.
   *
   * A binary search: `ids` is ascending by construction, because every scan
   * walks the archive front to back and pushes as it goes.
   */
  positionOf: function (recIdx) {
    if (list.ids === null) return recIdx < archive.ranges.length ? recIdx : -1;
    var lo = 0, hi = list.ids.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (list.ids[mid] === recIdx) return mid;
      if (list.ids[mid] < recIdx) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }
};

/**
 * Build `list.ids` from the current mode and the current tab.
 *
 * The single place the displayed list is derived, so that the height table, the
 * window and the record cache can never be looking at a different list from the
 * one the user selected. Callers change list.mode, list.tab, list.scope and
 * list.hits, then call this, then applyList().
 *
 * A query and a tab are not alternatives. The query says which records match and
 * the tab says which of those are in the column on screen, and the displayed
 * list is the intersection — one linear merge over two ascending arrays, not
 * another pass over the file.
 */
function composeList() {
  var table = filterTable();
  /* The account filter narrows before the query does, and by the same two-pointer
     merge — both sides are ascending record indices, so this is a scan over two
     lists rather than another pass over the file. */
  if (accountIds !== null) {
    table = table === null ? accountIds : intersectAscending(table, accountIds);
  }
  list.ids = list.mode === 'search'
    ? (table === null ? list.hits : intersectAscending(list.hits, table))
    : table;
}

/**
 * The record-index list of the tab on screen, or null for "the whole archive".
 *
 * null is not "an empty filter": it is the identity over `archive.ranges`, which
 * is both the state before any filter exists and the reason the unfiltered
 * timeline costs no scan at all.
 */
function filterTable() {
  var f = currentFilter();
  /* `filters` is assigned in 55-tabs.js, and this is only ever reached from an
     event or from an async open — never while the script is still evaluating —
     so the assignment has always happened by the time this runs. */
  return f === 'all' ? null : filters[f];
}

/** How many records a source still has in the merged list, after folding. */
function recordCountOf(k) {
  var n = 0;
  for (var i = 0; i < archive.ranges.length; i++) {
    if (archive.ranges[i].src === k) n++;
  }
  return n;
}

/**
 * Narrow the timeline to some of the open archives, or to all of them.
 *
 * Takes the sources to KEEP rather than a "which one" selector, because there
 * is no selector any more: both the sidebar and the address bar name an
 * ACCOUNT, and two exports of one handle are one account made of two files.
 * `null` is every source.
 *
 * The filter is a list of record indices rather than a predicate, because every
 * consumer of the displayed list — the height table, positionOf's binary search,
 * the merge with the search hits — is built around an ascending array of
 * indices. A predicate would mean re-deriving all of that.
 */
function setAccountFilter(sources) {
  if (sources === null || sources === undefined || sources.length === 0) {
    accountIds = null;
  } else {
    var want = {};
    var ok = true;
    for (var s = 0; s < sources.length; s++) {
      var k = Number(sources[s]);
      if (!(isFinite(k) && k >= 0 && k < archive.sources.length)) { ok = false; break; }
      want[k] = true;
    }
    if (!ok) {
      accountIds = null;
    } else {
      /* Ascending by construction: this walks the merged array front to back,
         which is what positionOf's binary search requires. */
      var ids = [];
      for (var i = 0; i < archive.ranges.length; i++) {
        if (want[archive.ranges[i].src] === true) ids.push(i);
      }
      accountIds = ids;
    }
  }
  composeList();
  applyList(true);
}

var heights = null;
var view = { first: 0, last: 0, dirty: true };
var cache = new Map();
var pending = new Set();
var rendered = new Map();        /* list position -> <article class="card"> */
/* Which archives the timeline is narrowed to: null for all of them, or the
   ascending record indices belonging to the ones kept. Ascending is what
   positionOf's binary search and intersectAscending both require, and it holds
   by construction — setAccountFilter walks the merged array front to back. */
var accountIds = null;

var search = { gen: 0, running: false, scanned: 0, total: 0, hits: 0 };
var jump = { pending: null, order: null, orderChecked: false };
var prefs = { remoteAvatars: false, tz: 'archive', theme: 'system' };
var display = { offsetMinutes: null, name: null, source: 'local' };

var el = {
  pick: document.getElementById('pick'),
  drop: document.getElementById('drop'),
  profile: document.getElementById('profile'),
  stickyBar: document.getElementById('stickyBar'),
  sbName: document.getElementById('sbName'),
  sbCount: document.getElementById('sbCount'),
  pickLabel: document.getElementById('pickLabel'),
  /* The navigation: three destinations, drawn twice. Which of the two rows is
     visible is the stylesheet's decision — see the 900px query — and both are
     painted from the same route so they can never disagree. */
  navTimeline: document.getElementById('navTimeline'),
  navSearch: document.getElementById('navSearch'),
  navMe: document.getElementById('navMe'),
  tabTimeline: document.getElementById('tabTimeline'),
  tabSearch: document.getElementById('tabSearch'),
  tabMe: document.getElementById('tabMe'),
  sideAccts: document.getElementById('sideAccts'),
  meView: document.getElementById('meView'),
  meList: document.getElementById('meList'),
  meScroll: document.getElementById('meScroll'),
  btnConnect: document.getElementById('btnConnect'),
  tabs: document.getElementById('tabs'),
  scope: document.getElementById('scope'),
  view: document.getElementById('view'),
  stats: document.getElementById('stats'),
  report: document.getElementById('report'),
  reportBar: document.getElementById('reportBar'),
  reportSummary: document.getElementById('reportSummary'),
  btnReport: document.getElementById('btnReport'),
  notice: document.getElementById('notice'),
  scroller: document.getElementById('scroller'),
  spacer: document.getElementById('spacer'),
  win: document.getElementById('win'),
  verify: document.getElementById('btnVerify'),
  exportBtn: document.getElementById('btnExport'),
  q: document.getElementById('q'),
  when: document.getElementById('when'),
  zone: document.getElementById('zone'),
  btnZone: document.getElementById('btnZone'),
  btnTheme: document.getElementById('btnTheme'),
  rosterPage: document.getElementById('rosterPage'),
  rosterList: document.getElementById('rosterList'),
  rosterTabs: document.getElementById('rosterTabs'),
  rosterFilter: document.getElementById('rosterFilter'),
  rosterScroll: document.getElementById('rosterScroll'),
  rosterHeading: document.getElementById('rosterHeading'),
  rosterWhere: document.getElementById('rosterWhere'),
  btnRosterBack: document.getElementById('btnRosterBack'),
  btnAvatar: document.getElementById('btnAvatar'),
  prog: document.getElementById('prog'),
  progFill: document.getElementById('progFill'),
  progText: document.getElementById('progText'),
  progStop: document.getElementById('progStop'),
  postPage: document.getElementById('postPage'),
  postBody: document.getElementById('postBody'),
  ppScroll: document.getElementById('ppScroll'),
  ppWhere: document.getElementById('ppWhere'),
  btnPostBack: document.getElementById('btnPostBack'),
  lightbox: document.getElementById('lightbox'),
  lbStage: document.getElementById('lbStage'),
  lbCap: document.getElementById('lbCap'),
  lbAlt: document.getElementById('lbAlt'),
  askRemote: document.getElementById('askRemote'),
  askYes: document.getElementById('askYes')
};

/* ---------------------------------------------------------------- output -- */

/**
 * A message about what just happened — a search finished, a scan was stopped.
 *
 * Replaces the strip, which is right: the previous message was about a job that
 * is over. Facts about the FILE do not go here; see setReport.
 */
function say(html, kind) {
  el.notice.innerHTML = html ? '<div class="box ' + (kind || '') + '">' + html + '</div>' : '';
}

/**
 * What the reader knows about the file, written once when it opens.
 *
 * Separate from `say()` because these two kinds of statement have opposite
 * lifetimes. A search result count belongs to the view and should be replaced
 * the moment the view changes; "2 000 records located, nothing was lost" is a
 * claim about the archive, and it must survive every click. They used to share
 * one strip, and one tab click wiped the integrity report — which is the one
 * message in this page that is not allowed to be dismissible by accident.
 */
function setReport(html) {
  el.report.innerHTML = html || '';
}

/** Add a box below whatever the report already says, for a later file fact. */
function addNotice(html, kind) {
  var box = document.createElement('div');
  box.className = 'box ' + (kind || '');
  box.innerHTML = html;
  el.report.appendChild(box);
}

/* Every interpolation of archived text goes through one of these two. The text
   came off the network and was only length-capped by the extension's sanitizer
   — it is untrusted input, and this page renders it. */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function attr(s) {
  return esc(s);
}

function fmtBytes(n) {
  if (!(n >= 0)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

/**
 * A stored instant rendered as wall-clock in the display zone.
 *
 * Reads the UTC getters on purpose. `new Date(ms + offset)` shifts the instant
 * so that its UTC fields ARE the target zone's fields; using the local getters
 * would add the machine's offset on top and be wrong everywhere except
 * Greenwich.
 */
function zoneDate(ms) {
  return new Date(ms + (display.offsetMinutes || 0) * 60000);
}

function fmtClock(iso) {
  var ms = Date.parse(iso);
  if (!isFinite(ms)) return '—';
  var d = zoneDate(ms);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
         ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

function fmtDay(iso) {
  var ms = Date.parse(iso);
  if (!isFinite(ms)) return '—';
  var d = zoneDate(ms);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

/**
 * X's relative stamp: seconds, minutes and hours relative; then the date; then
 * the date with a year. Computed against the record's own instant, so the
 * display zone cancels out and this reads the same wherever you are.
 */
function fmtRelative(iso) {
  var ms = Date.parse(iso);
  if (!isFinite(ms)) return '—';
  var diff = Date.now() - ms;
  if (diff < 0) return fmtDay(iso);
  var min = 60000, hour = 60 * min, day = 24 * hour;
  if (diff < min) return Math.max(1, Math.floor(diff / 1000)) + '秒';
  if (diff < hour) return Math.floor(diff / min) + '分钟';
  if (diff < day) return Math.floor(diff / hour) + '小时';
  var d = zoneDate(ms), now = zoneDate(Date.now());
  if (d.getUTCFullYear() === now.getUTCFullYear()) {
    return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日';
  }
  return d.getUTCFullYear() + '年' + (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日';
}

function tzLabel() {
  if (display.offsetMinutes === null) return '本机时区';
  var off = display.offsetMinutes;
  var sign = off < 0 ? '-' : '+';
  var a = Math.abs(off);
  var hh = String(Math.floor(a / 60)).padStart(2, '0');
  var mm = String(a % 60).padStart(2, '0');
  return 'UTC' + sign + hh + ':' + mm + (display.name ? ' ' + display.name : '');
}

/* ------------------------------------------------------------- avatars --- */

/* A stable colour per account, picked from a small palette so letter avatars
   look deliberate rather than random. Same handle always gets the same colour,
   which is what makes them recognisable while scrolling. */
var AVATAR_COLORS = ['#1d9bf0', '#7856ff', '#f91880', '#00ba7c', '#ff7a00', '#536471', '#c2410c', '#0f766e'];

function avatarColor(seed) {
  var s = String(seed || '?');
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function avatarInitial(name, screenName, id) {
  var s = String(name || screenName || id || '?').trim();
  return s.length ? s.charAt(0).toUpperCase() : '?';
}

/**
 * The avatar element for an author.
 *
 * Default is a letter disc and no network. The image branch only runs when the
 * user has explicitly turned it on AND the archive's own URL survives the
 * http(s) check — the address is stored data, so it gets the same treatment as
 * every other URL in this file.
 */
function avatarNode(author, size, cssSized) {
  var a = author || {};
  var node = document.createElement('div');
  node.className = 'card__avatar';
  /* The profile header passes cssSized, because its avatar has to be 142px at
     the top of the page and 36px once the chrome collapses — and an inline
     width beats every rule in the stylesheet, so a JS-sized avatar could not
     shrink. Cards still size inline: their avatar size is a parameter of the
     call, not a state of the page. */
  if (cssSized !== true) {
    node.style.width = size + 'px';
    node.style.height = size + 'px';
    node.style.flexBasis = size + 'px';
    node.style.fontSize = Math.round(size * 0.42) + 'px';
  }

  /* The archive's own copy of the face, inlined at export time. Tried before
     the network branch and before the letter disc, because it is the only one
     of the three that is both REAL and OFFLINE — and it is the reason the
     头像 button is no longer the only way to see a picture. It costs no
     request, so it does not need the opt-in that branch exists to gate. */
  var inlined = safeDataImageUrl(a.avatarData);
  if (inlined !== null) {
    var face = document.createElement('img');
    face.alt = '';
    face.decoding = 'async';
    face.src = inlined;
    node.appendChild(face);
    return node;
  }

  /* Through sizedAvatarUrl first: the archive stores the 48px render, and this
     slot may be the 142px header. See that function for why it is a rename. */
  var remote = prefs.remoteAvatars ? remoteMediaUrl(sizedAvatarUrl(a.avatarUrl, size)) : null;
  if (remote) {
    var img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    /* The URL is only in a variable — the test suite forbids a literal absolute
       URL next to src=, which is how "this file never phones home by default"
       is enforced. This branch cannot run unless the user opted in. */
    img.src = remote;
    /* One step back, to the address the archive actually stored.
     *
     * X makes a `_400x400` of every profile picture it still serves — that is
     * what was measured, on one account — and one measurement is not a rule
     * about every account in every archive, including the dead ones this page
     * is for. If the big render is the one that is missing, the honest outcome
     * is the smaller face, not a letter where a face used to be: that would be
     * a regression wearing the costume of an improvement. Costs nothing in the
     * ordinary case, because the big render answers and this never runs. */
    var stored = remoteMediaUrl(a.avatarUrl);
    img.addEventListener('error', function () {
      if (stored !== null && img.getAttribute('src') !== stored) {
        img.setAttribute('src', stored);
        return;
      }
      node.removeChild(img);
      node.textContent = avatarInitial(a.name, a.screenName, a.id);
    });
    node.appendChild(img);
  } else {
    node.style.background = avatarColor(a.screenName || a.id || a.name);
    node.textContent = avatarInitial(a.name, a.screenName, a.id);
  }
  return node;
}

/* --------------------------------------------------------- time display -- */

/**
 * Pick the zone the archive is shown in.
 *
 * The export states its own zone once, as a fixed offset. This uses that offset
 * and NOT the IANA name: a single fixed offset cannot express a zone that
 * observes DST, and this reader has no timezone database and no network. Asking
 * Intl for `Asia/Shanghai` would look more authoritative and be less correct for
 * any timestamp on the other side of a DST boundary. The name is shown as
 * information, never used for arithmetic.
 */
function applyZone() {
  var tz = archive.envelope.timezone;
  var hasZone = tz && typeof tz.offsetMinutes === 'number';
  if (prefs.tz === 'local' || !hasZone) {
    display.offsetMinutes = -new Date().getTimezoneOffset();
    display.name = null;
    display.source = hasZone ? 'local' : 'none';
  } else {
    display.offsetMinutes = tz.offsetMinutes;
    display.name = typeof tz.name === 'string' ? tz.name : null;
    display.source = 'archive';
  }
  if (el.zone) {
    /* Nothing to say before a file is open, and saying it would be wrong — the
       machine's own offset is not a property of an archive that is not loaded. */
    el.zone.textContent = archive.sources.length > 0
      ? tzLabel() + (display.source === 'none' ? '（这份归档没记时区）' : '')
      : '';
  }
  if (el.btnZone) el.btnZone.disabled = !hasZone;
}

/* -------------------------------------------------------------- memory --- */

/**
 * What is actually held in memory, split into the two things that answer
 * different questions.
 *
 * The old single figure was `ranges*96 + cache*900` and it stopped being true
 * the moment this file gained a height table, a media map and a search result
 * list. The index figure is the one that grows with the archive and is the whole
 * argument for this design; the cache figure is whatever is on screen. Reporting
 * one number for both would overstate the part that matters.
 */
function estimateIndexBytes() {
  /* The height table is a row per DISPLAYED entry, not per record, so it is
     sized from the list — the same distinction whose absence was the search
     bug. Reporting the archive's row count here would have hidden it. */
  var n = list.length();
  /* Each range carries two more numbers than it used to — which file it came
     from and where it sits in that file — because the merged order stops being
     "file 0, then file 1" the moment it is sorted by time. */
  var b = archive.ranges.length * 112;             /* ranges: {start,end,src,local} */
  if (heights) b += n * (4 + 1 + 1) + (Math.ceil(n / HT_BLOCK) * 8);
  if (archive.mediaMap) b += archive.mediaMap.size * 120;
  if (list.ids !== null) b += list.ids.length * 8;
  return b;
}
function estimateCacheBytes() {
  return cache.size * 2400;
}

/* ------------------------------------------------------------------ zone --- */
