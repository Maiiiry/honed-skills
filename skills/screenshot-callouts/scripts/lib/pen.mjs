// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Two pens with one interface, so draw.mjs never branches on style. Every method returns SVG
// markup and draws its white halo first when asked: the halo is what keeps a red stroke readable
// on a dark sidebar and on a white form alike.
//
// The sketch pen is rough.js without a DOM. Its determinism traps, from reading the source:
// seed 0 means Math.random, a shared options object carries random state between calls, and
// arrow tips drift unless preserveVertices is set. So every call gets a fresh options object with
// a non-zero seed derived from the annotation id, and lines keep their vertices.

import rough from "roughjs";

const gen = rough.generator();
const f = (n) => Math.round(n * 100) / 100;

function haloAttrs(width, haloW) {
  return `stroke="#FFFFFF" stroke-opacity="0.92" stroke-width="${f(width + 2 * haloW)}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
}

export const cleanPen = {
  rect(r, o) {
    const geo = `x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" rx="${f(o.radius ?? 0)}"`;
    const halo = o.halo ? `<rect ${geo} ${haloAttrs(o.width, o.halo)}/>` : "";
    const fill = o.fill ? `fill="${o.fill}" fill-opacity="${o.fillOpacity ?? 1}"` : `fill="none"`;
    const stroke = o.width ? `stroke="${o.color}" stroke-width="${f(o.width)}"` : "";
    return `${halo}<rect ${geo} ${fill} ${stroke}${o.dash ? ` stroke-dasharray="${o.dash}"` : ""}/>`;
  },
  ellipse(r, o) {
    const geo = `cx="${f(r.x + r.w / 2)}" cy="${f(r.y + r.h / 2)}" rx="${f(r.w / 2)}" ry="${f(r.h / 2)}"`;
    const halo = o.halo ? `<ellipse ${geo} ${haloAttrs(o.width, o.halo)}/>` : "";
    return `${halo}<ellipse ${geo} fill="none" stroke="${o.color}" stroke-width="${f(o.width)}"/>`;
  },
  circle(cx, cy, rad, o) {
    const halo = o.halo ? `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rad + o.halo)}" fill="#FFFFFF"/>` : "";
    return `${halo}<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rad)}" fill="${o.fill}"/>`;
  },
  /** A straight shaft with a filled head; the shaft stops inside the head so no line pokes out. */
  arrow(from, to, o) {
    const [x0, y0] = from;
    const [x1, y1] = to;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    const head = o.head ? Math.min(o.headLen, len * 0.5) : 0;
    const sx = x1 - ux * head * 0.8;
    const sy = y1 - uy * head * 0.8;
    const shaft = `M${f(x0)} ${f(y0)} L${f(sx)} ${f(sy)}`;
    let headPath = "";
    if (head) {
      const a = o.headAngle;
      const p = (s) => [x1 - head * (ux * Math.cos(a) - s * uy * Math.sin(a)), y1 - head * (uy * Math.cos(a) + s * ux * Math.sin(a))];
      const [l, r] = [p(1), p(-1)];
      headPath = `M${f(x1)} ${f(y1)} L${f(l[0])} ${f(l[1])} L${f(r[0])} ${f(r[1])} Z`;
    }
    const dash = o.dash ? ` stroke-dasharray="${o.dash}"` : "";
    const halo = o.halo
      ? `<path d="${shaft}" ${haloAttrs(o.width, o.halo)}${dash}/>${headPath ? `<path d="${headPath}" ${haloAttrs(0, o.halo)}/>` : ""}`
      : "";
    return `${halo}<path d="${shaft}" stroke="${o.color}" stroke-width="${f(o.width)}" stroke-linecap="round" fill="none"${dash}/>${headPath ? `<path d="${headPath}" fill="${o.color}" stroke="${o.color}" stroke-width="${f(o.width * 0.5)}" stroke-linejoin="round"/>` : ""}`;
  },
  line(from, to, o) {
    return this.arrow(from, to, { ...o, head: false });
  },
  marker(r, o) {
    return `<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" rx="${f(o.radius)}" fill="${o.color}" fill-opacity="0.5" style="mix-blend-mode:multiply"/>`;
  },
};

/**
 * Small shapes get less roughness, or a 20 px icon box turns to scribble. The thresholds follow
 * Excalidraw's adjustRoughness (MIT, Copyright (c) 2020 Excalidraw), reimplemented here.
 */
export function adjustRoughness(base, w, h, unit) {
  const minSide = Math.min(w, h) / unit;
  const maxSide = Math.max(w, h) / unit;
  if (minSide >= 20 && maxSide >= 50) return base;
  return Math.min(base / (maxSide < 10 ? 3 : 2), 2.5);
}

function roughSvg(drawable, extra = "") {
  return gen
    .toPaths(drawable)
    .map((p) => `<path d="${p.d}" stroke="${p.stroke}" stroke-width="${f(p.strokeWidth)}" fill="${p.fill ?? "none"}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`)
    .join("");
}

function roughHalo(build, o) {
  if (!o.halo) return "";
  return roughSvg(build({ stroke: "#FFFFFF", strokeWidth: o.width + 2 * o.halo, fill: undefined }), ` stroke-opacity="0.92"`);
}

export const sketchPen = {
  opts(o, extra = {}) {
    // A fresh object on every call: rough.js caches its random state on the options object.
    // rough.js offsets are absolute pixels, so on a 2x capture the same roughness looks half as
    // rough. Scaling maxRandomnessOffset by dpr keeps the hand-drawn look constant.
    return {
      seed: o.seed,
      roughness: adjustRoughness(o.roughness ?? 1.3, o.w ?? 100, o.h ?? 100, o.unit ?? 1),
      maxRandomnessOffset: 2 * (o.unit ?? 1),
      // rough.js bows an edge by about bowing x maxRandomnessOffset x length / 200, so a 1200 px
      // edge bowed 14 px, past the clearance layout keeps from the target. Capped at the bow of a
      // 100 px edge, a long box wobbles like a short one.
      bowing: Math.min(1.2, 120 / Math.max(1, o.w ?? 100, o.h ?? 100)),
      stroke: o.color,
      strokeWidth: o.width,
      preserveVertices: true,
      ...extra,
    };
  },
  rect(r, o) {
    const build = (over) => gen.rectangle(r.x, r.y, r.w, r.h, this.opts({ ...o, w: r.w, h: r.h }, over));
    if (o.fill) return roughSvg(build({ fill: o.fill, fillStyle: "solid", stroke: o.width ? o.color : "none" }), o.fillOpacity ? ` fill-opacity="${o.fillOpacity}"` : "");
    return roughHalo(build, o) + roughSvg(build({}));
  },
  ellipse(r, o) {
    // curveFitting 1: rough.js otherwise varies the radii in proportion to the size, which on a
    // long ellipse swung the curve onto the target (measured: 8 of 30 seeds).
    const build = (over) => gen.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h, this.opts({ ...o, w: r.w, h: r.h }, { curveFitting: 1, ...over }));
    return roughHalo(build, o) + roughSvg(build({}));
  },
  circle(cx, cy, rad, o) {
    const build = (over) => gen.circle(cx, cy, rad * 2, this.opts({ ...o, w: rad * 2, h: rad * 2, roughness: 0.8 }, over));
    const halo = o.halo ? `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rad + o.halo)}" fill="#FFFFFF"/>` : "";
    return halo + roughSvg(build({ fill: o.fill, fillStyle: "solid", stroke: o.fill, strokeWidth: o.width ?? 2 }));
  },
  /** A gently bowed shaft and an open V head, like Excalidraw's own arrows. */
  arrow(from, to, o) {
    const [x0, y0] = from;
    const [x1, y1] = to;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    const bow = (o.seed % 2 ? 1 : -1) * Math.min(len * 0.08, o.width * 6) * (o.bowScale ?? 1);
    const mid = [(x0 + x1) / 2 - uy * bow, (y0 + y1) / 2 + ux * bow];
    const shaftBuild = (over) => gen.curve([[x0, y0], mid, [x1, y1]], this.opts({ ...o, w: len, h: len }, over));
    let out = roughHalo(shaftBuild, o) + roughSvg(shaftBuild({}), o.dash ? ` stroke-dasharray="${o.dash}"` : "");
    if (o.head) {
      // The head follows the curve's end tangent (mid -> tip), not the chord.
      const tl = Math.hypot(x1 - mid[0], y1 - mid[1]) || 1;
      const tx = (x1 - mid[0]) / tl;
      const ty = (y1 - mid[1]) / tl;
      const head = Math.min(o.headLen, len * 0.5);
      const a = o.headAngle * 1.1;
      for (const s of [1, -1]) {
        const p = [x1 - head * (tx * Math.cos(a) - s * ty * Math.sin(a)), y1 - head * (ty * Math.cos(a) + s * tx * Math.sin(a))];
        const build = (over) => gen.line(x1, y1, p[0], p[1], this.opts({ ...o, seed: o.seed + (s > 0 ? 7 : 13), w: head, h: head, roughness: 0.7 }, over));
        out += roughHalo(build, o) + roughSvg(build({}));
      }
    }
    return out;
  },
  line(from, to, o) {
    return this.arrow(from, to, { ...o, head: false });
  },
  marker(r, o) {
    const d = gen.rectangle(r.x, r.y, r.w, r.h, this.opts({ ...o, w: r.w, h: r.h, roughness: 1.4 }, {
      stroke: "none",
      fill: o.color,
      fillStyle: "zigzag",
      hachureGap: Math.max(2, r.h * 0.16),
      fillWeight: Math.max(2, r.h * 0.3),
      hachureAngle: -12,
    }));
    // The zigzag's fill weight grows with the height, so its strokes reach past the rect. Clipped
    // to the rect, the marker stays inside the footprint the proof checks around it.
    const id = `hl-${Math.round(r.x)}-${Math.round(r.y)}-${Math.round(r.w)}-${Math.round(r.h)}`;
    return `<clipPath id="${id}"><rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" rx="${f(o.radius ?? 0)}"/></clipPath><g clip-path="url(#${id})" style="mix-blend-mode:multiply" opacity="0.55">${roughSvg(d)}</g>`;
  },
};

export const pens = { clean: cleanPen, sketch: sketchPen };
