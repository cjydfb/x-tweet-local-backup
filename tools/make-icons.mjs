/* ============================================================================
 * make-icons.mjs — generate the extension icons, with no dependencies.
 *
 * Node's zlib is the only thing needed: a PNG is a zlib stream wrapped in four
 * chunks, so a small encoder here beats pulling in a rendering library (and
 * matches how zip.js was written for this project).
 *
 * Shapes are drawn at 4x and box-filtered down, which is what keeps the 16x16
 * output legible instead of a jagged mess — the small size is the one that
 * actually matters in a browser toolbar.
 *
 * Run:  node make-icons.mjs            -> icon-candidates.png (contact sheet)
 *       node make-icons.mjs emit       -> writes the four PNGs into the extension
 * ========================================================================== */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root is one level up from tools/, so this works from a fresh clone
// on any machine instead of depending on where it happened to be written.
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------------ PNG ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8ClampedArray of width*height*4 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* -------------------------------------------------------------- drawing ---- */

/** A canvas that composites with straight alpha and can be resized down. */
function canvas(w, h) {
  return { w, h, px: new Float64Array(w * h * 4) };
}

/** Source-over composite of one solid colour with coverage `a` (0..1). */
function blend(cv, x, y, r, g, b, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 4;
  const dstA = cv.px[i + 3];
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  cv.px[i]     = (r * a + cv.px[i]     * dstA * (1 - a)) / outA;
  cv.px[i + 1] = (g * a + cv.px[i + 1] * dstA * (1 - a)) / outA;
  cv.px[i + 2] = (b * a + cv.px[i + 2] * dstA * (1 - a)) / outA;
  cv.px[i + 3] = outA;
}

/**
 * Fill every pixel whose centre passes `inside`, in normalised 0..1 space.
 * Working in normalised coordinates is what lets one shape definition be
 * rendered correctly at 16px and at 128px without any size-specific tweaking.
 */
function fill(cv, inside, color, scale) {
  const s = scale || 1;
  for (let y = 0; y < cv.h; y++) {
    for (let x = 0; x < cv.w; x++) {
      const u = (x + 0.5) / cv.w / s;
      const v = (y + 0.5) / cv.h / s;
      if (inside(u, v)) blend(cv, x, y, color[0], color[1], color[2], 1);
    }
  }
}

/** Box-filter down to `size`, which is where the anti-aliasing comes from. */
function downsample(cv, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  const factor = cv.w / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * cv.w + (x * factor + sx)) * 4;
          const pa = cv.px[i + 3];
          r += cv.px[i] * pa; g += cv.px[i + 1] * pa; b += cv.px[i + 2] * pa;
          a += pa; n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o + 3] = Math.round((a / n) * 255);
      if (a > 0) {
        // r/g/b are alpha-weighted sums of 0..1 values, so dividing by `a`
        // gives a 0..1 colour that still has to be scaled to a byte. Rounding
        // it directly collapses every colour to 0 or 1 — black and white only.
        out[o]     = Math.round((r / a) * 255);
        out[o + 1] = Math.round((g / a) * 255);
        out[o + 2] = Math.round((b / a) * 255);
      }
    }
  }
  return out;
}

/* --------------------------------------------------------------- shapes ---- */

const BG = [0, 0, 0];               // black plate, matching the X app icon
const FG = [1, 1, 1];

function roundRect(mx, my, r) {
  return (u, v) => {
    if (u < mx || u > 1 - mx || v < my || v > 1 - my) return false;
    const x = Math.min(Math.max(u, mx + r), 1 - mx - r);
    const y = Math.min(Math.max(v, my + r), 1 - my - r);
    const dx = u - x, dy = v - y;
    return dx * dx + dy * dy <= r * r + 1e-9;
  };
}

function rect(x0, y0, x1, y1) {
  return (u, v) => u >= x0 && u <= x1 && v >= y0 && v <= y1;
}

function triangle(ax, ay, bx, by, cx, cy) {
  const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  return (u, v) => {
    const d1 = sign(u, v, ax, ay, bx, by);
    const d2 = sign(u, v, bx, by, cx, cy);
    const d3 = sign(u, v, cx, cy, ax, ay);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
}

/** Polygon fill by even-odd ray casting. */
function polygon(points) {
  return (u, v) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

const union = (...fns) => (u, v) => fns.some((f) => f(u, v));

function glyphShield(cv) {
  fill(cv, polygon([
    [0.50, 0.16], [0.80, 0.28], [0.80, 0.52],
    [0.50, 0.84], [0.20, 0.52], [0.20, 0.28]
  ]), FG);
  // Cut a tick back out of it so the shape reads as protection, not a blob.
  fill(cv, polygon([
    [0.44, 0.50], [0.50, 0.58], [0.66, 0.36], [0.60, 0.31], [0.49, 0.47]
  ]), BG);
}

function glyphBox(cv) {
  fill(cv, rect(0.20, 0.36, 0.80, 0.82), FG);                          // body
  fill(cv, rect(0.14, 0.24, 0.86, 0.35), FG);                          // lid
  fill(cv, rect(0.42, 0.44, 0.58, 0.56), BG);                          // handle slot
}

function glyphPlus(cv) {
  fill(cv, rect(0.42, 0.20, 0.58, 0.80), FG);
  fill(cv, rect(0.20, 0.42, 0.80, 0.58), FG);
}

/**
 * A plus drawn as an outline: the two bars are hollow, so the plate shows
 * through. `arm` is the half-length of each bar, `thick` the bar width and
 * `stroke` how thick the outline itself is.
 */
function plusOutline(arm, thick, stroke) {
  return (cv) => {
    const lo = 0.5 - thick / 2, hi = 0.5 + thick / 2;
    const a0 = 0.5 - arm, a1 = 0.5 + arm;
    const outerV = [lo, a0, hi, a1];
    const outerH = [a0, lo, a1, hi];
    const innerV = [lo + stroke, a0 + stroke, hi - stroke, a1 - stroke];
    const innerH = [a0 + stroke, lo + stroke, a1 - stroke, hi - stroke];

    const outer = union(rect(outerV[0], outerV[1], outerV[2], outerV[3]),
                        rect(outerH[0], outerH[1], outerH[2], outerH[3]));
    const inner = union(rect(innerV[0], innerV[1], innerV[2], innerV[3]),
                        rect(innerH[0], innerH[1], innerH[2], innerH[3]));

    fill(cv, (u, v) => outer(u, v) && !inner(u, v), FG);
  };
}

const glyphPlusOutline = plusOutline(0.30, 0.22, 0.055);
const glyphPlusOutlineBold = plusOutline(0.31, 0.26, 0.085);

/**
 * A plus outline whose bars stay CONNECTED at the crossing: the holes are cut
 * out of the four arms only, so the centre block remains solid and the shape
 * reads as one mark instead of a ring with a gap in the middle.
 */
function plusOutlineConnected(arm, thick, stroke) {
  return (cv) => {
    const lo = 0.5 - thick / 2, hi = 0.5 + thick / 2;
    const a0 = 0.5 - arm, a1 = 0.5 + arm;

    const outer = union(rect(lo, a0, hi, a1), rect(a0, lo, a1, hi));
    const inner = union(
      rect(lo + stroke, a0 + stroke, hi - stroke, lo),   // top arm
      rect(lo + stroke, hi, hi - stroke, a1 - stroke),   // bottom arm
      rect(a0 + stroke, lo + stroke, lo, hi - stroke),   // left arm
      rect(hi, lo + stroke, a1 - stroke, hi - stroke)    // right arm
    );

    fill(cv, (u, v) => outer(u, v) && !inner(u, v), FG);
  };
}

const glyphPlusConnected = plusOutlineConnected(0.31, 0.24, 0.055);
const glyphPlusConnectedBold = plusOutlineConnected(0.32, 0.28, 0.078);

/** One hollow bar: the rectangle's border is kept, its interior is not. */
function outlinedBar(x0, y0, x1, y1, stroke) {
  return (u, v) => {
    if (u < x0 || u > x1 || v < y0 || v > y1) return false;
    return !(u >= x0 + stroke && u <= x1 - stroke && v >= y0 + stroke && v <= y1 - stroke);
  };
}

/**
 * The X-mark construction, straightened into a plus: two bars that are each
 * outlined on their own and simply overlap where they cross, rather than one
 * outline traced around the union. That overlap is what gives the mark its
 * characteristic look at the crossing instead of a plain hole.
 */
function plusTwoBars(arm, thick, stroke) {
  return (cv) => {
    const lo = 0.5 - thick / 2, hi = 0.5 + thick / 2;
    const a0 = 0.5 - arm, a1 = 0.5 + arm;
    const vertical = outlinedBar(lo, a0, hi, a1, stroke);
    const horizontal = outlinedBar(a0, lo, a1, hi, stroke);
    fill(cv, (u, v) => vertical(u, v) || horizontal(u, v), FG);
  };
}

const glyphPlusBars = plusTwoBars(0.34, 0.26, 0.055);
const glyphPlusBarsBold = plusTwoBars(0.35, 0.30, 0.072);

/**
 * The chosen mark: a SOLID vertical bar crossed by a HOLLOW (outlined)
 * horizontal one, with the solid bar showing through the hollow bar's window.
 *
 *    vHalf  half-width of the vertical bar
 *    hHalf  half-height of the horizontal bar's outer edge
 *    border how thick the horizontal bar's outline is
 *
 * The border is the fragile number: at 16px it is only `border * 16` pixels, so
 * a value copied from a 1280px mock-up (0.022 -> 0.35px) simply disappears.
 */
function plusSolidHollow(vHalf, hHalf, border, vTop, vBottom, hHalfWidth) {
  return (cv) => {
    const vertical = (u, v) =>
      u >= 0.5 - vHalf && u <= 0.5 + vHalf && v >= vTop && v <= vBottom;

    const outer = rect(0.5 - hHalfWidth, 0.5 - hHalf, 0.5 + hHalfWidth, 0.5 + hHalf);
    const inner = rect(0.5 - hHalfWidth + border, 0.5 - hHalf + border,
                       0.5 + hHalfWidth - border, 0.5 + hHalf - border);
    const horizontal = (u, v) => outer(u, v) && !inner(u, v);

    fill(cv, (u, v) => vertical(u, v) || horizontal(u, v), FG);
  };
}

/** Proportions traced from the reference image — correct at 128, dead at 16. */
const glyphSolidHollowFaithful = plusSolidHollow(0.040, 0.085, 0.022, 0.14, 0.845, 0.3625);
/** Same design, features thickened until they survive a 16px toolbar. */
const glyphSolidHollowTuned = plusSolidHollow(0.075, 0.115, 0.052, 0.10, 0.90, 0.375);

function glyphDownloadPlain(cv) {
  fill(cv, rect(0.435, 0.18, 0.565, 0.52), FG);
  fill(cv, triangle(0.30, 0.47, 0.70, 0.47, 0.50, 0.72), FG);
  fill(cv, rect(0.26, 0.79, 0.74, 0.87), FG);
}

const CANDIDATES = [
  { key: 'solid-hollow',      label: '实心竖 + 空心横（照你给的比例）', paint: glyphSolidHollowFaithful },
  { key: 'solid-hollow-tuned', label: '实心竖 + 空心横（加粗到 16px 可用）', paint: glyphSolidHollowTuned },
  { key: 'plus-bars',         label: '两笔各自描边（细）', paint: glyphPlusBars },
  { key: 'arrow-tray',        label: '向下箭头 + 托盘',    paint: glyphDownloadPlain }
];

/* ------------------------------------------------------------- rendering --- */

const SS = 4; // supersampling factor

function renderIcon(paint, size, opts) {
  const cv = canvas(size * SS, size * SS);
  const bg = (opts && opts.background) || BG;
  if (opts && opts.transparent) {
    // Bare glyph, no plate — used to judge how it sits on a toolbar.
    const glyphOnly = canvas(size * SS, size * SS);
    paint(glyphOnly);
    return downsample(glyphOnly, size);
  }
  fill(cv, roundRect(0.035, 0.035, 0.22), bg);
  const inner = canvas(size * SS, size * SS);
  paint(inner);
  for (let i = 0; i < cv.px.length; i += 4) {
    const a = inner.px[i + 3];
    if (a > 0) blend(cv, (i / 4) % cv.w, Math.floor((i / 4) / cv.w), inner.px[i], inner.px[i + 1], inner.px[i + 2], a);
  }
  return downsample(cv, size);
}

/** `src` is byte-per-channel; the sheet's own canvas is 0..1 floats. */
function paste(target, tw, th, src, size, ox, oy) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4;
      const a = src[si + 3] / 255;
      if (a <= 0) continue;
      const dx = ox + x, dy = oy + y;
      if (dx < 0 || dy < 0 || dx >= tw || dy >= th) continue;
      const di = (dy * tw + dx) * 4;
      target.px[di]     = (src[si] / 255) * a + target.px[di] * (1 - a);
      target.px[di + 1] = (src[si + 1] / 255) * a + target.px[di + 1] * (1 - a);
      target.px[di + 2] = (src[si + 2] / 255) * a + target.px[di + 2] * (1 - a);
      target.px[di + 3] = 1;
    }
  }
}

function contactSheet() {
  const CELL = 190, PAD = 22, COLS = CANDIDATES.length;
  const ROW_H = 190 + 150;
  const w = COLS * CELL + PAD * 2;
  const h = 2 * ROW_H + PAD * 2 + 40;

  const sheet = canvas(w, h);
  // Row backgrounds: light toolbar, then dark toolbar.
  for (let y = 0; y < h; y++) {
    const dark = y > PAD + ROW_H && y < PAD + ROW_H * 2 + 20;
    const c = dark ? [0.11, 0.12, 0.13] : [0.93, 0.94, 0.95];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      sheet.px[i] = c[0]; sheet.px[i + 1] = c[1]; sheet.px[i + 2] = c[2]; sheet.px[i + 3] = 1;
    }
  }

  CANDIDATES.forEach((cand, i) => {
    const cx = PAD + i * CELL + CELL / 2;

    for (let row = 0; row < 2; row++) {
      const rowTop = PAD + row * ROW_H;
      const big = renderIcon(cand.paint, 128);
      paste(sheet, w, h, big, 128, Math.round(cx - 64), rowTop + 20);

      // The sizes that actually matter in a toolbar.
      const sizes = [16, 20, 24, 32];
      let ox = Math.round(cx - (sizes.reduce((a, b) => a + b, 0) + (sizes.length - 1) * 6) / 2);
      for (const s of sizes) {
        paste(sheet, w, h, renderIcon(cand.paint, s), s, ox, rowTop + 160);
        ox += s + 6;
      }
    }
  });

  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < sheet.px.length; i++) {
    rgba[i] = Math.round(sheet.px[i] * 255);
  }
  return { png: encodePng(w, h, rgba), w, h };
}

/* ------------------------------------------------------------------ main --- */

const mode = process.argv[2] || 'sheet';
const OUT_DIR = REPO;

if (mode === 'emit') {
  const chosen = process.argv[3] || 'arrow-tray';
  const cand = CANDIDATES.find((c) => c.key === chosen);
  if (!cand) {
    console.error('unknown icon "' + chosen + '"; options: ' + CANDIDATES.map((c) => c.key).join(', '));
    process.exit(1);
  }
  const target = path.join(OUT_DIR, 'icons');
  fs.mkdirSync(target, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const png = encodePng(size, size, renderIcon(cand.paint, size));
    fs.writeFileSync(path.join(target, 'icon' + size + '.png'), png);
    console.log('wrote icons/icon' + size + '.png  (' + png.length + ' bytes)');
  }
} else {
  const { png, w, h } = contactSheet();
  // The previous sheet may still be open in an image viewer, which locks it.
  // Fall through to a numbered name rather than failing the whole run.
  let file = path.join(OUT_DIR, 'tools', 'icon-candidates.png');
  for (let n = 2; ; n++) {
    try {
      fs.writeFileSync(file, png);
      break;
    } catch (err) {
      if (n > 20) throw err;
      file = path.join(OUT_DIR, 'tools', 'icon-candidates-' + n + '.png');
    }
  }
  console.log('wrote ' + file + '  (' + w + 'x' + h + ')');
  console.log('columns: ' + CANDIDATES.map((c) => c.key).join(' | '));
  console.log('row 1: light toolbar   row 2: dark toolbar   (128px, then 16/20/24/32)');
}
