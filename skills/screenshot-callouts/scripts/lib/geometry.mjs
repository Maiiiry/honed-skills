// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Rectangles are { x, y, w, h } in canvas pixels. These predicates are shared by the layout (which
// uses them to choose) and the proof (which uses them to check what was chosen).

export const grow = (r, d) => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
export const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];
export const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);
export const shift = (r, dx, dy) => ({ ...r, x: r.x + dx, y: r.y + dy });

export function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function union(rects) {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function insideRect(outer, r, slack = 0) {
  return r.x >= outer.x - slack && r.y >= outer.y - slack && r.x + r.w <= outer.x + outer.w + slack && r.y + r.h <= outer.y + outer.h + slack;
}

export function containsPoint(r, [x, y]) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** Distance from a point to a rectangle (0 when inside). */
export function distToRect([x, y], r) {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** Where the ray from the rect's centre towards (tx, ty) leaves the rect. */
export function exitPoint(r, [tx, ty]) {
  const [cx, cy] = center(r);
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sx = dx === 0 ? Infinity : r.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : r.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

/** Liang-Barsky: does segment p-q pass through the interior of r? */
export function segmentHitsRect([px, py], [qx, qy], r) {
  const dx = qx - px;
  const dy = qy - py;
  let t0 = 0;
  let t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q > 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (
    clip(-dx, px - r.x) &&
    clip(dx, r.x + r.w - px) &&
    clip(-dy, py - r.y) &&
    clip(dy, r.y + r.h - py)
  ) {
    return t1 - t0 > 1e-6;
  }
  return false;
}

export function segmentsCross([ax, ay], [bx, by], [cx, cy], [dx, dy]) {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(ax, ay, bx, by, cx, cy) * o(ax, ay, bx, by, dx, dy) < 0 && o(cx, cy, dx, dy, ax, ay) * o(cx, cy, dx, dy, bx, by) < 0;
}

/** Deterministic 31-bit seed from a string (FNV-1a), never 0: rough.js treats 0 as Math.random. */
export function seedOf(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 2147483646) + 1;
}
