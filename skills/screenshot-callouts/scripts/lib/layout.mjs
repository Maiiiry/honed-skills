// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Where every mark goes. Label placement is a constraint search, not a guess:
//   - candidates on rings around the target (8 compass positions, several distances, alignments);
//   - hard blocks: outside the canvas, over ANY target, over a placed label, badge or lens, over a
//     redaction, or a leader that crosses any of those;
//   - a cost for distance, busy background, covered OCR text and diagonal approach;
//   - most-constrained label first, then a few improvement passes.
// A label with no legal slot refuses the render with a hint. It is never dropped or forced.

import { refused } from "./errors.mjs";
import { FAMILIES, measureLine } from "./fonts.mjs";
import { area, center, containsPoint, distToRect, exitPoint, grow, intersects, insideRect, segmentHitsRect } from "./geometry.mjs";
import { reach } from "./tokens.mjs";

const DIRS = { N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1] };
const LABELLED = new Set(["box", "ellipse", "step", "callout", "highlight", "underline", "arrow"]);

export function labelFont(style, T) {
  return style === "sketch"
    ? { family: FAMILIES.sketch, weight: 400, size: Math.round(T.font * 1.4) }
    : { family: FAMILIES.clean, weight: 700, size: Math.round(T.font) };
}

/** Greedy word wrap to `maxW`; explicit "\n" always breaks. */
async function wrap(text, font, maxW) {
  const lines = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && (await measureLine(next, font)) > maxW) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  const widths = await Promise.all(lines.map((l) => measureLine(l, font)));
  return { lines, width: Math.max(...widths) };
}

async function labelBox(text, style, T, canvasW) {
  const font = labelFont(style, T);
  const { lines, width } = await wrap(text, font, canvasW * 0.42);
  const padX = style === "sketch" ? T.labelPadX * 0.45 : T.labelPadX;
  const padY = style === "sketch" ? T.labelPadY * 0.6 : T.labelPadY;
  return { lines, font, w: width + 2 * padX, h: lines.length * font.size * T.lineHeight + 2 * padY, padX, padY };
}

/** Candidate rectangles for a label of size w x h around anchor box a. */
function candidates(a, w, h, T, side) {
  const out = [];
  const [cx, cy] = center(a);
  const dirs = side && side !== "auto" ? [side] : Object.keys(DIRS);
  for (const d of T.ringSteps) {
    for (const k of dirs) {
      const [ux, uy] = DIRS[k];
      const xs = ux > 0 ? [a.x + a.w + d * (uy ? 0.7 : 1)] : ux < 0 ? [a.x - d * (uy ? 0.7 : 1) - w] : [cx - w / 2, a.x, a.x + a.w - w];
      const ys = uy > 0 ? [a.y + a.h + d * (ux ? 0.7 : 1)] : uy < 0 ? [a.y - d * (ux ? 0.7 : 1) - h] : [cy - h / 2, a.y, a.y + a.h - h];
      for (const x of xs) for (const y of ys) out.push({ rect: { x, y, w, h }, dir: k, dist: d });
    }
  }
  return out;
}

/** Leader from label edge to a point `gap` outside the anchor's edge. */
export function leaderFor(labelRect, a, T) {
  const [lx, ly] = center(labelRect);
  const from = exitPoint(labelRect, center(a));
  const onEdge = exitPoint(a, [lx, ly]);
  const [ax, ay] = center(a);
  // Push out along the edge normal, not the radial direction: on a wide, flat target the radial
  // direction runs almost along the long edge and the tip would end up touching it.
  const eps = 0.5;
  const nx = Math.abs(onEdge[0] - a.x) < eps ? -1 : Math.abs(onEdge[0] - (a.x + a.w)) < eps ? 1 : 0;
  const ny = Math.abs(onEdge[1] - a.y) < eps ? -1 : Math.abs(onEdge[1] - (a.y + a.h)) < eps ? 1 : 0;
  const nl = Math.hypot(nx, ny) || 1;
  const to = [onEdge[0] + (nx / nl) * T.gap, onEdge[1] + (ny / nl) * T.gap];
  // A point target has no edge: stop `gap` short of the point itself.
  if (a.w === 0 && a.h === 0) {
    const vx = lx - ax;
    const vy = ly - ay;
    const l = Math.hypot(vx, vy) || 1;
    return { from, to: [ax + (vx / l) * T.gap, ay + (vy / l) * T.gap] };
  }
  return { from, to };
}

/** An obstacle is a rect, or a `seg` (a drawn arrow shaft) that no label may sit on. */
function blocked(rect, obstacles, own) {
  return obstacles.some((o) => o.owner !== own && (o.seg ? segmentHitsRect(o.seg[0], o.seg[1], rect) : intersects(rect, o.rect)));
}

/** `passable` obstacles (spotlight holes) keep labels out but let a leader in to reach its target. */
function leaderBlocked(from, to, obstacles, own, ownLabel) {
  return obstacles.some((o) => o.owner !== own && !o.passable && !o.seg && o.rect !== ownLabel && segmentHitsRect(from, to, o.rect));
}

/**
 * Does a leader run through text? Small windows are sampled along its middle; text is dense in
 * edges, a crossed border line is one thin streak (the
 * case where a shaft through "Restrict to IP allowlist" erased letters).
 */
export function leaderCrossesText(from, to, T, grey) {
  if (!grey) return false;
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  // As wide as the drawn shaft with its halo: a narrower window saw the gap between two words
  // as clear while the halo still clipped the letters on both sides. Windows overlap by half, so a
  // single row of text always falls inside one. A thin border line scores about 0.08, text above 0.12.
  // Floored in image pixels and capped per pixel of length, so the sample count can never
  // outgrow the leader whatever the tokens are.
  const size = Math.max(4, T.stroke + 2 * T.halo + 4 * T.dpr);
  const n = Math.max(2, Math.ceil(len / (size / 2)));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (t < 0.08 || t > 0.9) continue;
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t;
    if (grey.stats({ x: x - size / 2, y: y - size / 2, w: size, h: size }).edges > 0.12) return true;
  }
  return false;
}

/**
 * Lower is better. Two terms carry most of the judgement:
 *   - the label AND a band around it should be calm, so a label never sits beside another
 *     control that it could be read as pointing at (measured: without the band, "Turn this on"
 *     landed next to the wrong toggle);
 *   - a straight approach (N, E, S, W) keeps the label on its target's row or column.
 */
function costOf(c, a, T, ctx) {
  const { std, edges } = ctx.grey.stats(c.rect);
  const band = ctx.grey.stats(grow(c.rect, T.font * 0.9));
  const around = band.std;
  const leaderLen = distToRect(center(c.rect), a);
  // Level with the target: a label beside a small control but a row above it reads as belonging
  // to the control on that row (a "Leave this off" label once pointed a row away).
  const [lx, ly] = center(c.rect);
  const [ax, ay] = center(a);
  const offRow = c.dir === "E" || c.dir === "W" ? Math.abs(ly - ay) / T.font : c.dir === "N" || c.dir === "S" ? (Math.abs(lx - ax) / T.font) * 0.25 : 1.5;
  let cost = (c.dist / T.font) * 0.35 + (std / 24) * 1.4 + (around / 24) * 1.6 + edges * 120 + band.edges * 30 + (c.dir.length === 2 ? 1.2 : 0) + (leaderLen / T.font) * 0.1 + offRow * 0.8;
  if (ctx.words) {
    for (const w of ctx.words) if (intersects(c.rect, w)) cost += 2.5;
  }
  return cost;
}

/**
 * @param items   annotations with resolved canvas boxes: { id, kind, target, label?, n?, side?, ... }
 * @param ctx     { canvas, T, style, grey, words, frame }
 */
export async function layout(items, ctx) {
  const { canvas, T, style } = ctx;
  const frame = { x: T.margin, y: T.margin, w: canvas.width - 2 * T.margin, h: canvas.height - 2 * T.margin };
  const out = items.map((it) => {
    const copy = { ...it };
    copy.shape = shapeFor(copy, T, canvas, ctx.grey, style); // also sets copy.cutouts for a spotlight
    return copy;
  });

  // Static obstacles: every target and every redaction.
  const obstacles = [];
  for (const it of out) {
    if (it.kind === "redact") obstacles.push({ owner: "redact", rect: grow(it.shape, T.gap) });
    else if (it.kind === "spotlight") for (const c of it.cutouts) obstacles.push({ owner: it.id, rect: grow(c, T.breathing), passable: true });
    else if (it.kind !== "text") obstacles.push({ owner: it.id, rect: grow(it.shape, T.breathing) });
  }

  // Badges first: they sit on a corner of their own shape and only move inward.
  for (const it of out) {
    if (it.n === undefined || !["box", "ellipse", "step", "callout", "highlight"].includes(it.kind)) continue;
    it.badge = placeBadge(it, T, canvas, obstacles, ctx.grey);
    obstacles.push({ owner: `badge:${it.id}`, rect: grow(badgeRect(it.badge), T.gap / 2), badgeOf: it.id });
  }

  // Free text sits where it is told; it only has to fit.
  for (const it of out.filter((x) => x.kind === "text")) {
    const lb = await labelBox(it.label, style, T, ctx.imgW ?? canvas.width);
    const [cx, cy] = center(it.target);
    const rect = clampInto({ x: cx - lb.w / 2, y: cy - lb.h / 2, w: lb.w, h: lb.h }, frame);
    it.labelBox = { ...lb, rect };
    obstacles.push({ owner: `label:${it.id}`, rect: grow(rect, T.gap) });
  }

  const wanting = [];
  for (const it of out) {
    if (it.kind === "magnify") {
      const lens = lensSize(it, canvas);
      wanting.push({ it, w: lens.w, h: lens.h, lens });
    } else if (it.label && LABELLED.has(it.kind)) {
      const lb = await labelBox(it.label, style, T, ctx.imgW ?? canvas.width);
      wanting.push({ it, w: lb.w, h: lb.h, lb });
    } else if (it.kind === "arrow") {
      // An unlabelled arrow runs where the spec says. It still may not cross anything.
      it.leader = { ...leaderFor(it.fromBox, it.shape, T), head: true };
      if (it.fromBox.w === 0 && it.fromBox.h === 0) it.leader.from = center(it.fromBox);
      if (leaderBlocked(it.leader.from, it.leader.to, obstacles, it.id)) {
        throw refused("ARROW_CROSSES", `the arrow "${it.id}" crosses another target, badge or redaction`, { id: it.id, fix: "move its from point, or give it a label and let the layout place it" });
      }
      if (leaderCrossesText(it.leader.from, it.leader.to, T, ctx.grey)) {
        throw refused("ARROW_CROSSES_TEXT", `the arrow "${it.id}" runs through a line of text, and its halo would erase letters`, { id: it.id, fix: "start it from blank space beside the text, or give it a label" });
      }
      // Its shaft is fixed, so every label placed later must keep off it.
      obstacles.push({ owner: it.id, seg: [it.leader.from, it.leader.to] });
    }
  }

  if (ctx.layoutMode === "frame") await frameLayout(wanting, ctx, obstacles);
  else await ringLayout(wanting, ctx, obstacles, frame);
  return { canvas, items: out };
}

async function ringLayout(wanting, ctx, obstacles, frame) {
  const { T } = ctx;
  const anchorOf = (it) => (it.kind === "arrow" && it.fromBox ? it.fromBox : it.shape);
  const valid = (w, c, placed) => {
    const a = anchorOf(w.it);
    if (!insideRect(frame, c.rect)) return false;
    const all = [...obstacles, ...placed];
    if (blocked(c.rect, all.filter((o) => !o.seg), null)) return false;
    // A placed leader is a segment: no later label may sit on it.
    if (all.some((o) => o.seg && segmentHitsRect(o.seg[0], o.seg[1], grow(c.rect, T.gap)))) return false;
    // A labelled arrow's label sits by its `from`, but its leader runs to the target.
    const { from, to } = leaderFor(c.rect, w.it.kind === "arrow" ? w.it.shape : a, T);
    // A leader too short to carry its head reads as a dash, not a pointer.
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) < T.head * 2.2) return false;
    if (leaderCrossesText(from, to, T, ctx.grey)) return false;
    return !leaderBlocked(from, to, all.filter((o) => !o.seg), w.it.id, c.rect);
  };
  for (const w of wanting) {
    w.cands = candidates(anchorOf(w.it), w.w, w.h, T, w.it.side);
    w.free = w.cands.filter((c) => valid(w, c, [])).length;
  }
  wanting.sort((a, b) => a.free - b.free || a.it.index - b.it.index);

  const placedObs = new Map();
  // A label with a line through it (a card border along its baseline) reads as struck through.
  // Prefer slots free of such lines; fall back to the calmest when none is.
  const lined = (c) => ctx.grey.stats(c.rect).edges > 0.05;
  const best = (w) => {
    const others = [...placedObs.entries()].filter(([k]) => k !== w.it.id).map(([, v]) => v).flat();
    const strict = w.cands.some((c) => !lined(c) && valid(w, c, others));
    let pick;
    for (const c of w.cands) {
      if (strict && lined(c)) continue;
      if (!valid(w, c, others)) continue;
      const cost = costOf(c, anchorOf(w.it), T, ctx);
      if (!pick || cost < pick.cost) pick = { ...c, cost };
    }
    return pick;
  };
  const commit = (w, c) => {
    w.choice = c;
    const obs = [{ owner: `label:${w.it.id}`, rect: grow(c.rect, T.gap) }];
    const { from, to } = leaderFor(c.rect, w.it.kind === "arrow" ? w.it.shape : anchorOf(w.it), T);
    obs.push({ owner: `leader:${w.it.id}`, seg: [from, to] });
    placedObs.set(w.it.id, obs);
  };
  for (const w of wanting) {
    const c = best(w);
    if (!c) {
      throw refused("LABEL_NO_SLOT", `no free place for the ${w.lens ? "magnifier" : "label"} of "${w.it.id}"`, {
        id: w.it.id,
        fix: w.lens ? "lower factor, or crop the screenshot less tightly" : 'shorten the label, set "side", or use layout "frame"; in a dense table or list, mark it with kind "step" or "box" and put the words in the caption',
      });
    }
    commit(w, c);
  }
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const w of wanting) {
      const c = best(w);
      if (c && c.cost + 1e-9 < w.choice.cost) {
        commit(w, c);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const w of wanting) applyChoice(w, w.choice.rect, T);
}

async function frameLayout(wanting, ctx, obstacles) {
  const { T, canvas, frameInfo } = ctx;
  const sides = { left: [], right: [] };
  for (const w of wanting) {
    const [cx] = center(w.it.shape);
    (cx < frameInfo.dx + frameInfo.imgW / 2 ? sides.left : sides.right).push(w);
  }
  for (const [side, list] of Object.entries(sides)) {
    list.sort((a, b) => center(a.it.shape)[1] - center(b.it.shape)[1]);
    let y = T.margin;
    const xFor = (w) => (side === "left" ? frameInfo.dx - T.ringSteps[1] - w.w : frameInfo.dx + frameInfo.imgW + T.ringSteps[1]);
    for (const w of list) {
      const want = center(w.it.shape)[1] - w.h / 2;
      y = Math.max(y, want);
      w.rect = { x: xFor(w), y, w: w.w, h: w.h };
      y += w.h + T.gap * 2;
    }
    const overflow = y - (canvas.height - T.margin);
    if (overflow > 0) for (const w of list) w.rect.y -= overflow;
    for (const w of list) {
      if (w.rect.y < T.margin) throw refused("LABEL_NO_SLOT", `the frame margin cannot hold every label on the ${side}`, { id: w.it.id, fix: "use fewer labels or split the figure" });
      // A lens or label wider than the margin it was sized for would reach into the screenshot.
      if (w.rect.x < T.margin * 0.5 || w.rect.x + w.w > canvas.width - T.margin * 0.5) {
        throw refused("LABEL_NO_SLOT", `"${w.it.id}" does not fit the ${side} margin`, { id: w.it.id, fix: 'shorten the label, lower the magnifier factor, or use layout "inline"' });
      }
      applyChoice(w, w.rect, T);
      // Margin leaders point, however short; a magnifier's dashed leader stays headless.
      if (!w.lens) w.it.leader.head = true;
      const l = w.it.leader;
      if (leaderCrossesText(l.from, l.to, T, ctx.grey)) {
        throw refused("LABEL_NO_SLOT", `the leader of "${w.it.id}" would run through text on its way in from the ${side} margin`, { id: w.it.id, fix: 'mark it with kind "step" or "box" and put the words in the caption, or split the figure' });
      }
      if (leaderBlocked(l.from, l.to, obstacles, w.it.id, w.rect)) {
        throw refused("LABEL_NO_SLOT", `the leader of "${w.it.id}" would cross another mark on its way in from the ${side} margin`, { id: w.it.id, fix: 'mark it with kind "step" or "box" and put the words in the caption, or split the figure' });
      }
    }
  }
}

function applyChoice(w, rect, T) {
  if (w.lens) {
    w.it.lens = { rect, src: w.it.shape, factor: w.lens.factor };
    w.it.leader = { ...leaderFor(rect, w.it.shape, T), head: false };
    return;
  }
  w.it.labelBox = { ...w.lb, rect };
  const anchor = w.it.kind === "arrow" && w.it.fromBox ? w.it.fromBox : w.it.shape;
  if (w.it.kind === "arrow") {
    w.it.leader = { ...leaderFor(rect, w.it.shape, T), head: true };
  } else {
    const l = leaderFor(rect, anchor, T);
    w.it.leader = { ...l, head: Math.hypot(l.to[0] - l.from[0], l.to[1] - l.from[1]) > T.head * 2 };
  }
}

function clampInto(r, frame) {
  return {
    ...r,
    x: Math.min(Math.max(r.x, frame.x), frame.x + frame.w - r.w),
    y: Math.min(Math.max(r.y, frame.y), frame.y + frame.h - r.h),
  };
}

/**
 * Padding per side, not one number. A uniform pad pushes the stroke into whatever sits next to the
 * target: the label above a field ("Kev name", as a visual review read it) or the divider beside a sidebar
 * item. For each side, take the largest pad up to `want` whose stroke band lands on calm pixels,
 * skipping the target's own border line; when no pad is calm, take the calmest.
 */
function calmPad(t, want, T, grey, style) {
  const sw = reach(T, style);
  // Never closer than the stroke's own reach: on a wide 1x screenshot the stroke and halo are
  // thicker than the default pad, and the halo would paint over the text it marks.
  want = Math.max(want, sw);
  if (!grey) return grow(t, want);
  const own = 2 * T.dpr; // the target's own border, which every band would otherwise include
  const step = Math.max(1, T.dpr);
  const band = (side, d) => {
    const lo = Math.max(own, d - sw);
    const hi = Math.max(lo, d + sw);
    if (side === "top") return { x: t.x, y: t.y - hi, w: t.w, h: hi - lo };
    if (side === "bottom") return { x: t.x, y: t.y + t.h + lo, w: t.w, h: hi - lo };
    if (side === "left") return { x: t.x - hi, y: t.y, w: hi - lo, h: t.h };
    return { x: t.x + t.w + lo, y: t.y, w: hi - lo, h: t.h };
  };
  const pick = {};
  for (const side of ["top", "bottom", "left", "right"]) {
    let best = { d: want, e: Infinity };
    // Never inside the target: a stroke there crosses the very text it marks and reads as a
    // strikethrough (measured on a list of links). The floor keeps the whole stroke outside the
    // target's edge; when nothing out there is calm, the calmest band out there wins.
    for (let d = want; d >= sw; d -= step) {
      const e = busiest(band(side, d), grey);
      if (e < 0.02) { best = { d, e }; break; }
      if (e < best.e) best = { d, e };
    }
    pick[side] = best.d;
  }
  return { x: t.x - pick.left, y: t.y - pick.top, w: t.w + pick.left + pick.right, h: t.h + pick.top + pick.bottom };
}

/**
 * The busiest stretch of a long thin band. An average over a 1280 px side hid one descender
 * ("Kev name": the halo clipped the y of "Key"), so the band is cut into short windows.
 */
function busiest(r, grey) {
  // A band with no area measures nothing, so it is never "calm".
  if (r.w <= 0 || r.h <= 0) return Infinity;
  const long = Math.max(r.w, r.h);
  const thick = Math.max(1, Math.min(r.w, r.h));
  const win = Math.max(thick * 2, 8);
  let worst = 0;
  for (let o = 0; o < long; o += win / 2) {
    const sub = r.w >= r.h ? { x: r.x + o, y: r.y, w: Math.min(win, r.x + r.w - (r.x + o)), h: r.h } : { x: r.x, y: r.y + o, w: r.w, h: Math.min(win, r.y + r.h - (r.y + o)) };
    if (sub.w <= 0 || sub.h <= 0) continue;
    worst = Math.max(worst, grey.stats(sub).edges);
  }
  return worst;
}

/** The rectangle a mark is drawn on: the target, padded for boxes and ellipses. */
function shapeFor(it, T, canvas, grey, style) {
  const t = it.target;
  const pad = (it.pad ?? 0) * T.dpr;
  if (it.kind === "redact") return t;
  if (it.kind === "spotlight") {
    // The hole's outline and halo stay off the target: the shared reach, plus what a rounded
    // corner cuts in on the diagonal.
    it.cutouts = (it.targets ?? [t]).map((c) => grow(c, Math.max(T.pad, reach(T, style)) + pad + 0.3 * T.radius));
    return it.cutouts[0];
  }
  // The magnifier's source frame is padded like a box, so it sits outside the element.
  if (it.kind === "magnify") return calmPad(t, T.pad * 0.6 + pad, T, grey, style);
  if (["highlight", "underline", "blur", "text"].includes(it.kind)) return grow(t, (it.kind === "highlight" ? T.dpr * 2 : 0) + pad);
  if (it.kind === "arrow" && t.w === 0 && t.h === 0) return t;
  // The ellipse's own bounding rect, so the layout keeps labels off the curve that is drawn.
  // It grows mostly sideways: an ellipse that grows upward cuts through the label above a field.
  // It circumscribes the target grown by the stroke's reach (corners included): a curve drawn
  // tighter passed through the corners of any target wider than a few letters, and its halo
  // erased the tops of the letters it circled.
  if (it.kind === "ellipse") {
    // Through the grown target's corners, both axes scaled by sqrt 2. Bounding the sideways
    // growth instead made the curve 40 px tall above and below a wide row, onto the rows next to
    // it; growing sideways only reaches empty space, or the canvas edge on a very wide row.
    const g = grow(t, reach(T, style) + pad);
    const w = g.w * Math.SQRT2;
    const h = g.h * Math.SQRT2;
    return { x: g.x + g.w / 2 - w / 2, y: g.y + g.h / 2 - h / 2, w, h };
  }
  const g = calmPad(t, T.pad + pad, T, grey, style);
  // Keep the whole stroke and its halo on the canvas: a box on an element at x = 0 otherwise
  // loses its left edge.
  // The clamp may move the stroke into the target only where the target is blank under it (the
  // padding of a sidebar row). Over the target's own ink (a nav item's text at y = 6) the stroke
  // stays outside, off the canvas if need be: a clipped edge is the lesser harm than erased text.
  const inset = T.stroke / 2 + T.halo + 4 * T.dpr;
  const sw = reach(T, style);
  // The outer 4 device px of the target are its own border or accent bar, not its text.
  const rim = 4 * T.dpr;
  const blank = (r) => !grey || r.w <= 0 || r.h <= 0 || busiest(r, grey) < 0.02;
  const side = (clamped, free, band) => (blank(band) ? clamped : free);
  const cx0 = Math.max(inset, g.x);
  const cy0 = Math.max(inset, g.y);
  const cx1 = Math.min(canvas.width - inset, g.x + g.w);
  const cy1 = Math.min(canvas.height - inset, g.y + g.h);
  const x0 = cx0 + sw <= t.x ? cx0 : side(cx0, Math.min(cx0, t.x - sw), { x: t.x + rim, y: t.y, w: cx0 + sw - t.x - rim, h: t.h });
  const y0 = cy0 + sw <= t.y ? cy0 : side(cy0, Math.min(cy0, t.y - sw), { x: t.x, y: t.y + rim, w: t.w, h: cy0 + sw - t.y - rim });
  const x1 = cx1 - sw >= t.x + t.w ? cx1 : side(cx1, Math.max(cx1, t.x + t.w + sw), { x: cx1 - sw, y: t.y, w: t.x + t.w - rim - (cx1 - sw), h: t.h });
  const y1 = cy1 - sw >= t.y + t.h ? cy1 : side(cy1, Math.max(cy1, t.y + t.h + sw), { x: t.x, y: cy1 - sw, w: t.w, h: t.y + t.h - rim - (cy1 - sw) });
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function badgeRect(b) {
  return { x: b.cx - b.r, y: b.cy - b.r, w: 2 * b.r, h: 2 * b.r };
}

/**
 * A badge sits on a corner of its shape. An explicit `corner` wins; otherwise the corner over the
 * calmest background, so the badge does not sit on a neighbour's text. The part of the badge that
 * lies inside the shape is ignored, because the shape's own content is what the badge marks.
 */
function placeBadge(it, T, canvas, obstacles, grey) {
  const s = it.shape;
  const r = T.badgeR;
  const corners = { tl: [s.x, s.y], tr: [s.x + s.w, s.y], br: [s.x + s.w, s.y + s.h], bl: [s.x, s.y + s.h] };

  const order = it.corner ? [it.corner] : ["tl", "tr", "br", "bl"];
  // Only enough to keep the badge and its halo on the canvas: a full label margin pushed the
  // badge of a nav item at the top edge onto the item's own text.
  const m = T.halo + T.dpr;
  const t = it.target;
  let pick;
  for (const [rank, k] of order.entries()) {
    let [cx, cy] = corners[k];
    cx = Math.min(Math.max(cx, r + m), canvas.width - r - m);
    cy = Math.min(Math.max(cy, r + m), canvas.height - r - m);
    const rect = badgeRect({ cx, cy, r });
    if (blocked(rect, obstacles, it.id)) continue;
    const outside = [
      { x: rect.x, y: rect.y, w: rect.w, h: Math.max(0, s.y - rect.y) },
      { x: rect.x, y: s.y + s.h, w: rect.w, h: Math.max(0, rect.y + rect.h - (s.y + s.h)) },
      { x: rect.x, y: rect.y, w: Math.max(0, s.x - rect.x), h: rect.h },
      { x: s.x + s.w, y: rect.y, w: Math.max(0, rect.x + rect.w - (s.x + s.w)), h: rect.h },
    ].filter((q) => q.w > 1 && q.h > 1);
    let busy = outside.reduce((n, q) => n + grey.stats(q).std, 0);
    // A badge over the target's own ink hides what it numbers: that corner costs extra.
    const ix = Math.max(rect.x, t.x);
    const iy = Math.max(rect.y, t.y);
    const iw = Math.min(rect.x + rect.w, t.x + t.w) - ix;
    const ih = Math.min(rect.y + rect.h, t.y + t.h) - iy;
    if (iw > 1 && ih > 1) busy += 3 * grey.stats({ x: ix, y: iy, w: iw, h: ih }).std;
    const cost = busy + rank * 4;
    if (!pick || cost < pick.cost) pick = { cx, cy, r, corner: k, cost };
  }
  if (pick) return { cx: pick.cx, cy: pick.cy, r: pick.r, corner: pick.corner };
  throw refused("BADGE_NO_SLOT", `no corner of "${it.id}" has room for its number badge`, { id: it.id, fix: 'set "corner" to another corner, or move neighbouring marks' });
}

function lensSize(it, canvas) {
  const want = it.factor ?? 2;
  const cap = Math.min(canvas.width, canvas.height) * 0.38;
  const s = it.shape;
  const factor = Math.max(1.25, Math.min(want, cap / Math.max(1, Math.max(s.w, s.h))));
  return { w: s.w * factor, h: s.h * factor, factor };
}

export function badgeBounds(b) {
  return badgeRect(b);
}

/**
 * Frame layout widens the canvas. Each side gets room for its widest label plus the leader stub;
 * a side with no label gets no margin.
 */
export async function frameMargins(items, style, T, imgW, imgH) {
  const m = { left: 0, right: 0 };
  for (const it of items) {
    let w;
    if (it.kind === "magnify") {
      // The lens goes in the margin too, sized from an upper bound of what the layout will give
      // it: the padded shape (calmPad grows at most this much) on the framed canvas, whose width
      // is not known yet, so only its height caps the lens. A margin a little too wide is harmless;
      // one too narrow pushed the lens into the screenshot.
      // The same floor calmPad applies: never closer than the stroke's reach.
      const shape = grow(it.target, Math.max(T.pad * 0.6 + (it.pad ?? 0) * T.dpr, reach(T, style)) + 2 * T.dpr);
      w = lensSize({ ...it, shape }, { width: Infinity, height: imgH + 2 * Math.ceil(T.ringSteps[0]) }).w;
    } else if (it.label && LABELLED.has(it.kind)) {
      w = (await labelBox(it.label, style, T, imgW)).w;
    } else continue;
    const side = center(it.target)[0] < imgW / 2 ? "left" : "right";
    m[side] = Math.max(m[side], Math.ceil(w + T.ringSteps[1] + 2 * T.margin));
  }
  return m;
}
