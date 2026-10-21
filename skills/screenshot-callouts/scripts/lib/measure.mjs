// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Seed measurement: flood-fill from one point inside a flat-coloured element (a button, a field, a
// badge) to find its exact bounding box. It measures what a vision model would only estimate.
// It refuses rather than guesses when the fill escapes: a region that reaches the image edge or
// covers a large part of the image is the background, not an element.

import { readFileSync } from "node:fs";
import { refused, usage } from "./errors.mjs";
import { decode } from "./png.mjs";
import { readInputFile } from "./files.mjs";

const TOLERANCE = 30; // L1 distance in RGB, so anti-aliased text inside a button stays a hole
const MAX_FRACTION = 0.25;

export function seedBox(img, sx, sy, who = {}) {
  const x0 = Math.round(sx);
  const y0 = Math.round(sy);
  if (x0 < 0 || y0 < 0 || x0 >= img.width || y0 >= img.height) {
    throw refused("TARGET_OFF_FRAME", "the seed point is outside the image", who);
  }
  const W = img.width;
  const H = img.height;
  const d = img.data;
  const i0 = (y0 * W + x0) * 4;
  const [r0, g0, b0] = [d[i0], d[i0 + 1], d[i0 + 2]];
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let top = 0;
  stack[top++] = y0 * W + x0;
  seen[y0 * W + x0] = 1;
  let minX = x0;
  let maxX = x0;
  let minY = y0;
  let maxY = y0;
  let count = 0;
  const limit = W * H * MAX_FRACTION;
  while (top) {
    const p = stack[--top];
    const x = p % W;
    const y = (p - x) / W;
    count++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || count > limit) {
      throw refused("SEED_LEAK", "the fill escaped to the image edge or over a quarter of the image: that is background, not an element", {
        ...who,
        fix: "seed inside a flat-coloured element, or use a box, ref or text target",
      });
    }
    for (const q of [p - 1, p + 1, p - W, p + W]) {
      if (seen[q]) continue;
      const j = q * 4;
      if (Math.abs(d[j] - r0) + Math.abs(d[j + 1] - g0) + Math.abs(d[j + 2] - b0) > TOLERANCE) continue;
      seen[q] = 1;
      stack[top++] = q;
    }
  }
  if (maxX - minX < 3 || maxY - minY < 3) {
    throw refused("SEED_TOO_SMALL", "the fill found a region under 4 px: the seed is on text or a border", { ...who, fix: "move the seed onto the element's flat fill" });
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function measureCommand(imagePath, opt) {
  if (!imagePath || !opt.seed) throw usage("USAGE", "measure needs IMG.png --seed X,Y");
  const [x, y] = String(opt.seed).split(",").map(Number);
  if (![x, y].every(Number.isFinite)) throw usage("USAGE", "--seed is X,Y in image pixels, such as --seed 120,48", { path: "--seed" });
  const img = decode(readInputFile(imagePath, "IMG.png"));
  const b = seedBox(img, x, y, { id: "seed" });
  return { ok: true, box: [b.x, b.y, b.w, b.h], target: { box: [b.x, b.y, b.w, b.h] } };
}
