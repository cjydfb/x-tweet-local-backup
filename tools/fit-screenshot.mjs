/* ============================================================================
 * fit-screenshot.mjs — force a screenshot to the exact size the store wants.
 *
 * A browser screenshot comes out at whatever the emulated viewport happened to
 * be, often multiplied by the device pixel ratio. The stores accept only exact
 * sizes (1280x800 or 640x400), so this scales the image to fit inside the
 * target and pads the remainder.
 *
 * It never stretches: a distorted UI screenshot is both ugly and misleading.
 * Padding uses the colour of the source's own corner pixel, so a dark-themed
 * screenshot gets dark bars instead of white ones.
 *
 * Only PNG, 8-bit, non-interlaced, greyscale or RGB(A) — which is what every
 * browser and OS screenshot tool produces.
 *
 *   node tools/fit-screenshot.mjs <in.png> <out.png> [WxH]
 * ========================================================================== */

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

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

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');

  let pos = 8;
  let header = null;
  const parts = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      };
    } else if (type === 'IDAT') {
      parts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  if (header === null) throw new Error('no IHDR');
  if (header.bitDepth !== 8) throw new Error('only 8-bit PNGs are supported, got ' + header.bitDepth);
  if (header.interlace !== 0) throw new Error('interlaced PNGs are not supported');

  const channels = CHANNELS[header.colorType];
  if (channels === undefined) throw new Error('unsupported colour type ' + header.colorType);

  const { width, height } = header;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const rgba = new Uint8ClampedArray(width * height * 4);

  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 0) { /* none */ }
      else if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 255;
      } else {
        throw new Error('unknown scanline filter ' + filter);
      }
      cur[i] = v;
    }

    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels === 1) { rgba[d] = rgba[d + 1] = rgba[d + 2] = cur[s]; rgba[d + 3] = 255; }
      else if (channels === 2) { rgba[d] = rgba[d + 1] = rgba[d + 2] = cur[s]; rgba[d + 3] = cur[s + 1]; }
      else if (channels === 3) { rgba[d] = cur[s]; rgba[d + 1] = cur[s + 1]; rgba[d + 2] = cur[s + 2]; rgba[d + 3] = 255; }
      else { rgba[d] = cur[s]; rgba[d + 1] = cur[s + 1]; rgba[d + 2] = cur[s + 2]; rgba[d + 3] = cur[s + 3]; }
    }
    prev = cur;
  }

  return { width, height, rgba };
}

/* --------------------------------------------------------------- resize ---- */

/**
 * Area-average resample. Every destination pixel averages exactly the source
 * area it covers, weighted by the overlap, which is what keeps a 2x downscale
 * from aliasing the way nearest-neighbour would.
 */
function resample(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;

  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * yRatio, y1 = (dy + 1) * yRatio;
    const sy0 = Math.floor(y0), sy1 = Math.min(sh, Math.ceil(y1));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * xRatio, x1 = (dx + 1) * xRatio;
      const sx0 = Math.floor(x0), sx1 = Math.min(sw, Math.ceil(x1));

      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = sx0; sx < sx1; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (sy * sw + sx) * 4;
          r += src[i] * w; g += src[i + 1] * w; b += src[i + 2] * w; a += src[i + 3] * w;
          wsum += w;
        }
      }
      const o = (dy * dw + dx) * 4;
      out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum; out[o + 3] = a / wsum;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ main --- */

const [, , inPath, outPath, sizeArg] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node tools/fit-screenshot.mjs <in.png> <out.png> [WxH]');
  process.exit(1);
}

const match = /^(\d+)x(\d+)$/.exec(sizeArg || '1280x800');
if (match === null) {
  console.error('size must look like 1280x800');
  process.exit(1);
}
const targetW = Number(match[1]);
const targetH = Number(match[2]);

const source = decodePng(fs.readFileSync(inPath));
console.log('source : ' + source.width + 'x' + source.height +
  '  (ratio ' + (source.width / source.height).toFixed(4) + ')');
console.log('target : ' + targetW + 'x' + targetH +
  '  (ratio ' + (targetW / targetH).toFixed(4) + ')');

// Scale to fit inside the target, never beyond it.
const scale = Math.min(targetW / source.width, targetH / source.height);
const fitW = Math.max(1, Math.round(source.width * scale));
const fitH = Math.max(1, Math.round(source.height * scale));

const scaled = resample(source.rgba, source.width, source.height, fitW, fitH);
console.log('scaled : ' + fitW + 'x' + fitH + '  (factor ' + scale.toFixed(4) + ')');

// Padding colour: the source's own top-left pixel, so the bars blend in
// instead of announcing themselves.
const padR = source.rgba[0], padG = source.rgba[1], padB = source.rgba[2];

const out = new Uint8ClampedArray(targetW * targetH * 4);
for (let i = 0; i < out.length; i += 4) {
  out[i] = padR; out[i + 1] = padG; out[i + 2] = padB; out[i + 3] = 255;
}

const offX = Math.floor((targetW - fitW) / 2);
const offY = Math.floor((targetH - fitH) / 2);
for (let y = 0; y < fitH; y++) {
  const srcStart = y * fitW * 4;
  const dstStart = ((y + offY) * targetW + offX) * 4;
  out.set(scaled.subarray(srcStart, srcStart + fitW * 4), dstStart);
}

if (fitW !== targetW || fitH !== targetH) {
  console.log('padded : ' + (targetW - fitW) + 'px horizontal, ' + (targetH - fitH) + 'px vertical');
}

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
const png = encodePng(targetW, targetH, out);
fs.writeFileSync(outPath, png);

// Read it back rather than trusting the arithmetic above.
const check = decodePng(fs.readFileSync(outPath));
console.log('written: ' + outPath + '  ' + check.width + 'x' + check.height +
  '  (' + png.length + ' bytes)');
if (check.width !== targetW || check.height !== targetH) {
  console.error('FAILED: written image is not the requested size');
  process.exit(1);
}
