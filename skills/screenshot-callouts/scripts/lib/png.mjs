// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// PNG in and out. Decoding goes through pngjs, which hands back 8-bit RGBA for every colour type,
// depth and interlace. Encoding writes a fresh file: pngjs emits IHDR, IDAT and IEND only, and we
// splice back the colour chunks of the input (sRGB, gAMA, cHRM) plus pHYs, the first of each type.
// Every text, time, EXIF and animation chunk, and any byte after IEND, is dropped on purpose:
// that is where a capture leaks metadata, and where aCropalypse left the old image behind. An
// embedded ICC profile (iCCP) is dropped too: a calibrated profile carries free text such as the
// display's model and the calibrating tool, so a Display P3 capture renders as sRGB, a little duller.

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { refused } from "./errors.mjs";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Ancillary chunks that change how pixels look or how big they are, and nothing else. */
export const KEPT_CHUNKS = Object.freeze(["sRGB", "gAMA", "cHRM", "pHYs"]);
/** About a 7000 x 6000 capture. A larger input is refused before its pixels are inflated. */
export const MAX_INPUT_PIXELS = 42_000_000;
export const MAX_SIDE = 32_768;
const MAX_CHUNKS = 65_536;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(buf) {
  return buf.length > 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

/** Every chunk in file order, plus whatever trails IEND. */
export function readChunks(buf) {
  if (!isPng(buf)) throw refused("INPUT_FORMAT", "the file is not a PNG", { fix: "convert it first: magick in.jpg in.png" });
  const chunks = [];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw refused("INPUT_FORMAT", `the PNG is truncated inside chunk ${type}`);
    if (crc32(buf.subarray(i + 4, i + 8 + len)) !== buf.readUInt32BE(i + 8 + len)) {
      throw refused("INPUT_FORMAT", `the PNG chunk ${type} fails its checksum`, { fix: "re-save the image; a damaged file is not evidence" });
    }
    // A count cap: every chunk is kept as an entry, so a 1 x 1 image with a million empty
    // ancillary chunks would grow the heap with no pixel cap to stop it. Real files, split into
    // 8 KB image chunks at the pixel cap, stay far below it.
    if (chunks.length >= MAX_CHUNKS) throw refused("INPUT_FORMAT", `the PNG has more than ${MAX_CHUNKS} chunks`, { fix: "re-save the image as PNG" });
    chunks.push({ type, data: buf.subarray(i + 8, i + 8 + len), raw: buf.subarray(i, end) });
    i = end;
    if (type === "IEND") break;
  }
  return { chunks, trailing: buf.length - i, end: i };
}

/** 72 dpi per device pixel is the macOS convention. Any other density says nothing about dpr. */
export function dprFromPhys(chunks) {
  const phys = chunks.find((c) => c.type === "pHYs");
  if (!phys || phys.data.length !== 9 || phys.data[8] !== 1) return undefined;
  const dpi = phys.data.readUInt32BE(0) * 0.0254;
  const ratio = dpi / 72;
  const k = Math.round(ratio);
  return k >= 1 && k <= 4 && Math.abs(ratio - k) < 0.02 ? k : undefined;
}

/** The exact payload length each kept chunk may have, and a check of its values. */
const KEPT_SHAPE = {
  sRGB: (d) => d.length === 1 && d[0] <= 3,
  gAMA: (d) => d.length === 4 && d.readUInt32BE(0) > 0,
  cHRM: (d) => d.length === 32,
  pHYs: (d) => d.length === 9 && d[8] <= 1,
};

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/** The inflated size of a PNG's image data, from its header alone. */
function scanlineBytes(w, h, depth, colour, interlace) {
  const bits = CHANNELS[colour] * depth;
  const row = (cols) => (cols ? 1 + Math.ceil((cols * bits) / 8) : 0);
  if (!interlace) return h * row(w);
  let total = 0;
  for (const [x0, y0, dxp, dyp] of ADAM7) {
    const cols = Math.max(0, Math.ceil((w - x0) / dxp));
    const rows = Math.max(0, Math.ceil((h - y0) / dyp));
    if (cols && rows) total += rows * row(cols);
  }
  return total;
}

export function decode(buf) {
  const { chunks, end } = readChunks(buf);
  // Exactly one IHDR, first. A second one could declare a small size to pass the cap below.
  const ihdrs = chunks.filter((c) => c.type === "IHDR");
  if (chunks[0]?.type !== "IHDR" || ihdrs.length !== 1 || ihdrs[0].data.length !== 13) {
    throw refused("INPUT_FORMAT", "the PNG needs exactly one IHDR chunk, first", { fix: "re-save the image as PNG" });
  }
  const ihdr = ihdrs[0].data;
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  // The fields the inflate ceiling is computed from must be ones the PNG spec allows: a
  // declared depth of 255 would raise the ceiling thirty-fold for the same pixel count.
  const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!DEPTHS[ihdr[9]]?.includes(ihdr[8]) || ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] > 1) {
    throw refused("INPUT_FORMAT", "the PNG header declares a bit depth, colour type, compression, filter or interlace the format does not allow", { fix: "re-save the image as PNG" });
  }
  // A zero side passes the pixel cap while the width alone still sizes the inflate ceiling.
  if (w < 1 || h < 1) throw refused("INPUT_FORMAT", `the PNG declares a ${w}x${h} image`, { fix: "re-save the image as PNG" });
  // Each side is capped too: the decoder pays per row, so a 1 x 40,000,000 strip under the pixel
  // cap still runs Node out of memory (measured), which aborts with no error line at all.
  if (w > MAX_SIDE || h > MAX_SIDE) throw refused("INPUT_TOO_LARGE", `the image is ${w}x${h}, a side above ${MAX_SIDE} pixels`, { fix: "crop the capture to the part the figure is about" });
  if (w * h > MAX_INPUT_PIXELS) {
    throw refused("INPUT_TOO_LARGE", `the image is ${w}x${h}, above ${MAX_INPUT_PIXELS} pixels`, { fix: "crop the capture to the part the figure is about" });
  }
  // Inflate once with a ceiling: the exact size of the declared scanlines (a filter byte plus
  // the row's bytes at its bit depth and colour type, per Adam7 pass when interlaced). A stream
  // that inflates past it is a decompression bomb, or carries data past the image.
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  try {
    inflateSync(idat, { maxOutputLength: scanlineBytes(w, h, ihdr[8], ihdr[9], ihdr[12]) + 1 });
  } catch {
    throw refused("INPUT_FORMAT", "the PNG image data does not inflate to its declared size", { fix: "re-save the image as PNG" });
  }
  // Kept chunks are copied as bytes, so each must be exactly its standard shape: a longer one
  // could carry a payload past the redaction.
  const seen = new Set();
  const kept = chunks.filter((c) => KEPT_CHUNKS.includes(c.type) && KEPT_SHAPE[c.type](c.data) && !seen.has(c.type) && seen.add(c.type));
  // pngjs rejects bytes after IEND, which is exactly what an aCropalypse-damaged file carries.
  let png;
  try {
    png = PNG.sync.read(buf.subarray(0, end));
  } catch (e) {
    throw refused("INPUT_FORMAT", `the PNG cannot be decoded: ${String(e.message).split("\n")[0]}`, { fix: "re-save the image as PNG" });
  }
  return {
    width: png.width,
    height: png.height,
    data: Buffer.from(png.data),
    kept: kept.map((c) => c.raw),
    dprHint: dprFromPhys(chunks),
  };
}

/** Encode RGBA pixels and splice the kept chunks in right after IHDR. */
export function encode(img, kept = []) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  const fresh = PNG.sync.write(png, { colorType: 6 });
  const ihdrEnd = 8 + 12 + 13;
  return Buffer.concat([fresh.subarray(0, ihdrEnd), ...kept, fresh.subarray(ihdrEnd)]);
}

/**
 * Composite onto opaque white. resvg returns premultiplied pixels, so a partly transparent input
 * (a macOS window capture with its soft shadow) never compares equal to its own base, and the
 * output is opaque anyway. Flattening once at decode makes base and output the same kind of pixel.
 */
export function flatten(img) {
  const d = img.data;
  let changed = false;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255) continue;
    changed = true;
    for (let c = 0; c < 3; c++) d[i + c] = Math.round((d[i + c] * a + 255 * (255 - a)) / 255);
    d[i + 3] = 255;
  }
  return changed;
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const pixelHash = (img) => sha256(Buffer.concat([Buffer.from(`${img.width}x${img.height}:`), img.data]));

export function cloneImage(img) {
  return { ...img, data: Buffer.from(img.data) };
}

/** Integer pixel rect, grown outward, clamped to the image. */
export function pixelRect(img, r, grow = 0) {
  const x0 = Math.max(0, Math.floor(r.x) - grow);
  const y0 = Math.max(0, Math.floor(r.y) - grow);
  const x1 = Math.min(img.width, Math.ceil(r.x + r.w) + grow);
  const y1 = Math.min(img.height, Math.ceil(r.y + r.h) + grow);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

export function fillRect(img, r, [cr, cg, cb]) {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(img.width, r.x + r.w);
  const y1 = Math.min(img.height, r.y + r.h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = cr;
      img.data[i + 1] = cg;
      img.data[i + 2] = cb;
      img.data[i + 3] = 255;
    }
  }
}

export function crop(img, r) {
  const out = { width: r.w, height: r.h, data: Buffer.alloc(r.w * r.h * 4), kept: img.kept, dprHint: img.dprHint };
  for (let y = 0; y < r.h; y++) {
    const from = ((r.y + y) * img.width + r.x) * 4;
    img.data.copy(out.data, y * r.w * 4, from, from + r.w * 4);
  }
  return out;
}

/**
 * `img` scaled down to at most `w` x `h`, averaging each block of source pixels (a box filter).
 * An image already that small is returned as it is. Used where a large image is only shown small:
 * embedding it whole would make the rasteriser decode it at full size once per use.
 */
export function shrink(img, w, h) {
  const ow = Math.max(1, Math.min(img.width, Math.round(w)));
  const oh = Math.max(1, Math.min(img.height, Math.round(h)));
  if (ow === img.width && oh === img.height) return img;
  const out = { width: ow, height: oh, data: Buffer.alloc(ow * oh * 4), kept: img.kept, dprHint: img.dprHint };
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor((y * img.height) / oh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / oh));
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor((x * img.width) / ow);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / ow));
      const sum = [0, 0, 0, 0];
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.width + sx) * 4;
          for (let c = 0; c < 4; c++) sum[c] += img.data[i + c];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < 4; c++) out.data[(y * ow + x) * 4 + c] = Math.round(sum[c] / n);
    }
  }
  return out;
}

/**
 * A Gaussian blur of `rect` in place, standard deviation `sd` px, drawn from the pixels up to 3 sd
 * around it and written back inside `rect` only. Three box blurs approximate the Gaussian
 * (Wells 1986), each a running sum, so the cost is linear in the region's pixels whatever `sd`.
 * Done here, on the pixels, rather than as an SVG filter: the rasteriser allocates a full-size
 * buffer per filtered image, which multiplied memory by the number of blurs.
 */
export function blurRect(img, rect, sd) {
  const g = Math.ceil(sd * 3);
  const x0 = Math.max(0, Math.floor(rect.x) - g);
  const y0 = Math.max(0, Math.floor(rect.y) - g);
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.w) + g);
  const y1 = Math.min(img.height, Math.ceil(rect.y + rect.h) + g);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 1 || h < 1 || sd <= 0) return img;
  // Box sizes whose three passes match the Gaussian's variance.
  const ideal = Math.sqrt((12 * sd * sd) / 3 + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sd * sd - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  const radii = [0, 1, 2].map((i) => ((i < m ? wl : wl + 2) - 1) / 2);
  for (let c = 0; c < 3; c++) {
    let a = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = img.data[((y0 + y) * img.width + x0 + x) * 4 + c];
    let b = new Float32Array(w * h);
    for (const r of radii) {
      boxPass(a, b, w, h, r, 1, w); // rows
      boxPass(b, a, h, w, r, w, 1); // columns
    }
    const rx0 = Math.max(x0, Math.floor(rect.x));
    const ry0 = Math.max(y0, Math.floor(rect.y));
    const rx1 = Math.min(x1, Math.ceil(rect.x + rect.w));
    const ry1 = Math.min(y1, Math.ceil(rect.y + rect.h));
    for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) img.data[(y * img.width + x) * 4 + c] = Math.round(a[(y - y0) * w + (x - x0)]);
    b = null;
    a = null;
  }
  return img;
}

/** One box-blur pass along lines of `len` samples (`step` apart), `lines` of them (`stride` apart); edges clamp. */
function boxPass(src, dst, len, lines, r, step, stride) {
  const n = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const base = l * stride;
    const at = (i) => src[base + Math.min(len - 1, Math.max(0, i)) * step];
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += at(i);
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = sum / n;
      sum += at(i + r + 1) - at(i - r);
    }
  }
}

/** A new canvas of `w` x `h` filled with `rgb`, with `img` pasted at (dx, dy). Used by frame layout. */
export function extend(img, w, h, dx, dy, [cr, cg, cb]) {
  const out = { width: w, height: h, data: Buffer.alloc(w * h * 4), kept: img.kept, dprHint: img.dprHint };
  for (let i = 0; i < w * h; i++) out.data.set([cr, cg, cb, 255], i * 4);
  for (let y = 0; y < img.height; y++) {
    const from = y * img.width * 4;
    img.data.copy(out.data, ((y + dy) * w + dx) * 4, from, from + img.width * 4);
  }
  return out;
}

export function pixelAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/** The most common colour along the image border: the canvas a frame margin should continue. */
export function borderColor(img) {
  const counts = new Map();
  const add = (x, y) => {
    const [r, g, b] = pixelAt(img, x, y);
    const k = (r << 16) | (g << 8) | b;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (let x = 0; x < img.width; x += 2) { add(x, 0); add(x, img.height - 1); }
  for (let y = 0; y < img.height; y += 2) { add(0, y); add(img.width - 1, y); }
  const [k] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return [(k >> 16) & 255, (k >> 8) & 255, k & 255];
}

/**
 * Summed-area tables of grey and grey squared, so the mean and spread of any rect cost O(1).
 * Placement uses the spread to prefer calm background for labels.
 */
export function greyIntegrals(img) {
  const W = img.width + 1;
  const sum = new Float64Array(W * (img.height + 1));
  const sq = new Float64Array(W * (img.height + 1));
  for (let y = 0; y < img.height; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const g = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
      rs += g;
      rq += g * g;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rs;
      sq[(y + 1) * W + x + 1] = sq[y * W + x + 1] + rq;
    }
  }
  // A third table counts edge pixels. Variance misses a thin field border running through a
  // label (measured: a label landed across an input's outline), an edge count does not.
  const edge = new Float64Array(W * (img.height + 1));
  const grey = (x, y) => {
    const i = (y * img.width + x) * 4;
    return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
  };
  for (let y = 0; y < img.height; y++) {
    let re = 0;
    for (let x = 0; x < img.width; x++) {
      const g = grey(x, y);
      const dx = x + 1 < img.width ? Math.abs(grey(x + 1, y) - g) : 0;
      const dy = y + 1 < img.height ? Math.abs(grey(x, y + 1) - g) : 0;
      re += dx + dy > 30 ? 1 : 0;
      edge[(y + 1) * W + x + 1] = edge[y * W + x + 1] + re;
    }
  }
  const box = (t, x0, y0, x1, y1) => t[y1 * W + x1] - t[y0 * W + x1] - t[y1 * W + x0] + t[y0 * W + x0];
  return {
    stats(r) {
      const x0 = Math.max(0, Math.floor(r.x));
      const y0 = Math.max(0, Math.floor(r.y));
      // A rect off the image has no pixels: report it as busy, never as calm space to place on.
      const x1 = Math.max(x0, Math.min(img.width, Math.ceil(r.x + r.w)));
      const y1 = Math.max(y0, Math.min(img.height, Math.ceil(r.y + r.h)));
      if (x0 >= img.width || y0 >= img.height || x1 === x0 || y1 === y0) return { mean: 0, std: 0, edges: 1 };
      const n = (x1 - x0) * (y1 - y0);
      const mean = box(sum, x0, y0, x1, y1) / n;
      const variance = Math.max(0, box(sq, x0, y0, x1, y1) / n - mean * mean);
      return { mean, std: Math.sqrt(variance), edges: box(edge, x0, y0, x1, y1) / n };
    },
  };
}
