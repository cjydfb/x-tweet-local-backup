# reader/src — where `reader.html` comes from

`../reader.html` is a **generated file**. It is not edited directly, and editing
it outside the CORE block will be silently thrown away by the next build.

```
node reader/src/assemble.mjs            # write ../reader.html
node reader/src/assemble.mjs --check    # say whether it is already up to date
```

## How it is put together

```
00-head.html     doctype, <head>, all CSS, all markup, and the opening <script>
   +  the CORE block, sliced VERBATIM out of the reader.html currently on disk
   +  10-helpers.js   state, output helpers, avatars, timezone, the PURE block
   +  20-loading.js   open / unzip / index / media map / envelope probes
   +  25-stats.js     the stat line and the integrity report
   +  30-scroll.js    the variable-height virtual scroller
   +  40-card.js      one post, built as DOM
   +  50-search.js    full-text search, and the jump-to-a-day bisection
   +  60-media.js     blob URL lifetime, and the lightbox
   +  70-page.js      the post dialog, verify, preferences, wiring
```

## Why the CORE block is sliced, not stored here

The byte scanner, the offset index and the ZIP directory reader are the part of
this file that must not change — `tools/test-reader.mjs` covers them with 26
assertions, and they are the reason a hundred-thousand-post archive does not
become a gigabyte of heap.

Keeping them out of this directory is deliberate: `assemble.mjs` pulls them out
of the file it is about to replace, using the exact rules the test uses to
extract them. **Byte-identity across a rebuild is therefore a property of how the
build is constructed, not something a reviewer has to check.** Nothing in this
directory can perturb them, however large the rest of the file grows.

The two marker words appear exactly once each in the built file. That is not
stylistic either: the extractor finds them with `indexOf`, so a second mention —
even inside a comment — would move the boundary.

## Two rules the tests enforce on the built file

1. **No literal `https://` next to `src=` or `href=`.** This is how "the reader
   never phones home" is executed rather than promised. `img.src = url` is fine;
   `src="https://…"` is not.
2. **Exactly one `<script>`, and no `</script>` inside the JavaScript.**

Run `node tools/test-reader.mjs` after every change. It compiles the whole
script body, so a syntax error anywhere fails in about a second.
