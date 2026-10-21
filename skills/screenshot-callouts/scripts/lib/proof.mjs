// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// The proof reads the written FILE back from disk and checks it against what the layout promised.
// It does not trust the renderer: a mutant that draws in the wrong place, leaves one pixel of a
// redaction, or ends an arrow on a badge must turn a check red. Each check returns
// { name, ok, detail }, and detail never contains pixel content or OCR text.

import { readFileSync } from "node:fs";
import { decode, readChunks } from "./png.mjs";
import { distToRect, grow, insideRect, intersects, segmentHitsRect } from "./geometry.mjs";
import { badgeBounds, leaderCrossesText } from "./layout.mjs";
import { greyIntegrals } from "./png.mjs";
import { color, contrast, PALETTE } from "./tokens.mjs";

const FORBIDDEN = ["tEXt", "zTXt", "iTXt", "eXIf", "tIME", "acTL", "fcTL", "fdAT"];

export function checkProof(internal) {
  const { outputPath, layout, base, cropRect, footprints, spotlightCutouts, spotlightDim, T } = internal;
  const proofs = [];
  const add = (name, ok, detail = "") => proofs.push({ name, ok: Boolean(ok), detail });

  let buf;
  let out;
  try {
    buf = readFileSync(outputPath);
    out = decode(buf);
  } catch (e) {
    add("readback", false, `cannot read the written file: ${e.code ?? e.message}`);
    return proofs;
  }
  add("readback", out.width === cropRect.w && out.height === cropRect.h, `${out.width}x${out.height}, expected ${cropRect.w}x${cropRect.h}`);

  const { chunks, trailing } = readChunks(buf);
  const bad = chunks.filter((c) => FORBIDDEN.includes(c.type)).map((c) => c.type);
  add("metadata_clean", !bad.length && trailing === 0, bad.length ? `found ${bad.join(", ")}` : trailing ? `${trailing} bytes after IEND` : "no text, time, EXIF or animation chunks");

  // Output pixel at canvas coordinate (x, y), or undefined when cropped away.
  const ox = cropRect.x;
  const oy = cropRect.y;
  const at = (x, y) => {
    const px = x - ox;
    const py = y - oy;
    if (px < 0 || py < 0 || px >= out.width || py >= out.height) return undefined;
    const i = (py * out.width + px) * 4;
    return (out.data[i] << 16) | (out.data[i + 1] << 8) | out.data[i + 2];
  };

  // Every redaction pixel that survived the crop must be exactly the requested fill.
  const redactions = layout.items.filter((it) => it.kind === "redact");
  // A redaction that checks zero pixels while it overlaps the output proves nothing, so it fails.
  let uniform = true;
  let redactPixels = 0;
  for (const it of redactions) {
    const r = it.pixelRect;
    const [fr, fg, fb] = color(it.fill ?? PALETTE.redact);
    const want = (fr << 16) | (fg << 8) | fb;
    let seen = 0;
    for (let y = r.y; y < r.y + r.h && uniform; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const v = at(x, y);
        if (v === undefined) continue;
        seen++;
        if (v !== want) { uniform = false; break; }
      }
    }
    redactPixels += seen;
    if (!uniform) { add("redaction_uniform", false, `redaction "${it.id}" is not entirely its fill colour`); break; }
    if (!seen && intersects(r, cropRect)) { uniform = false; add("redaction_uniform", false, `redaction "${it.id}" checked no pixel`); break; }
  }
  if (uniform) add("redaction_uniform", true, `${redactions.length} region(s), ${redactPixels} pixels, each exactly its fill`);

  // Every pixel outside all footprints must equal the (redacted) base, and under a spotlight's
  // shade the base blended with the shade. Mask values: 0 base, 2 shaded base, 1 not checked.
  const W = base.width;
  const H = base.height;
  const mask = new Uint8Array(W * H);
  const paint = (r, v) => {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(W, Math.ceil(r.x + r.w));
    const y1 = Math.min(H, Math.ceil(r.y + r.h));
    for (let y = y0; y < y1; y++) mask.fill(v, y * W + x0, y * W + x1);
  };
  if (spotlightCutouts) {
    mask.fill(spotlightDim ? 2 : 1);
    for (const c of spotlightDim?.keepOut ?? []) paint(c, 1);
    for (const c of spotlightCutouts) paint(c, 0);
  }
  for (const r of footprints) paint(r, 1);
  const shade = spotlightDim ? color(spotlightDim.shade) : [0, 0, 0];
  const a = spotlightDim?.opacity ?? 0;
  let changed = 0;
  let checked = 0;
  let shadedOff = 0;
  let shaded = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = mask[y * W + x];
      if (m === 1) continue;
      const v = at(x, y);
      if (v === undefined) continue;
      const i = (y * W + x) * 4;
      if (m === 0) {
        checked++;
        if (v !== ((base.data[i] << 16) | (base.data[i + 1] << 8) | base.data[i + 2])) changed++;
        continue;
      }
      // Shaded: rounding in the rasteriser allows 2 levels per channel, and nothing more.
      shaded++;
      const got = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
      for (let c = 0; c < 3; c++) {
        if (Math.abs(got[c] - (base.data[i + c] * (1 - a) + shade[c] * a)) > 2) { shadedOff++; break; }
      }
    }
  }
  // Under a spotlight on small targets the only unmarked pixels may be shaded ones, which the
  // shade check below covers; the figure still needs one checked pixel of either kind.
  add("untouched_outside_marks", changed === 0 && checked + shaded > 0, checked + shaded ? `${changed} of ${checked} unmarked pixels differ from the base` : "no unmarked pixel was checked");
  // Every visible mark put ink on the figure: a mark whose geometry fell off the canvas (an
  // underline below a target at the bottom edge) or was cropped away leaves an image that passes
  // every check above while marking nothing. Redactions and blurs are part of the base itself.
  const drew = new Map();
  // A spotlight without its outline draws only the shade, which spotlight_shade_exact proves.
  for (const it of layout.items) if (it.kind !== "redact" && it.kind !== "blur" && !(it.kind === "spotlight" && it.outline === false)) drew.set(it.id, false);
  for (const r of footprints) {
    if (!drew.has(r.owner) || drew.get(r.owner)) continue;
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(W, Math.ceil(r.x + r.w));
    const y1 = Math.min(H, Math.ceil(r.y + r.h));
    scan: for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = at(x, y);
        if (v === undefined) continue;
        const i = (y * W + x) * 4;
        if (v !== ((base.data[i] << 16) | (base.data[i + 1] << 8) | base.data[i + 2])) {
          drew.set(r.owner, true);
          break scan;
        }
      }
    }
  }
  const blank = [...drew].filter(([, ok]) => !ok).map(([id]) => id);
  add("every_mark_drew", blank.length === 0, blank.length ? `no ink on the figure from ${blank.map((id) => `"${id}"`).join(", ")}` : `${drew.size} marks drew`);
  if (spotlightDim) add("spotlight_shade_exact", shadedOff === 0 && shaded > 0, shaded ? `${shadedOff} of ${shaded} shaded pixels differ from the shaded base` : "no shaded pixel was checked");

  // Geometry, recomputed from the layout rather than trusted.
  const items = layout.items;
  const frame = { x: 0, y: 0, w: layout.canvas.width, h: layout.canvas.height };
  const targets = items.filter((it) => !["redact", "text"].includes(it.kind)).flatMap((it) => (it.cutouts ?? [it.shape]).map((r) => ({ id: it.id, r })));
  const labels = items.filter((it) => it.labelBox || it.lens).map((it) => ({ id: it.id, r: it.lens ? it.lens.rect : it.labelBox.rect, free: it.kind === "text" }));
  const badges = items.filter((it) => it.badge).map((it) => ({ id: it.id, r: badgeBounds(it.badge) }));
  const reds = redactions.map((it) => it.pixelRect);

  const outsideFrame = labels.filter((l) => !insideRect(frame, l.r, 1));
  add("labels_in_frame", !outsideFrame.length, outsideFrame.length ? `outside: ${outsideFrame.map((l) => l.id).join(", ")}` : `${labels.length} label(s) inside`);

  const clashes = [];
  for (const l of labels) {
    for (const t of targets) if (!l.free && intersects(l.r, t.r)) clashes.push(`${l.id} covers target ${t.id}`);
    for (const m of labels) if (m !== l && intersects(l.r, m.r)) clashes.push(`${l.id} overlaps label ${m.id}`);
    for (const b of badges) if (intersects(l.r, b.r)) clashes.push(`${l.id} covers badge ${b.id}`);
    for (const r of reds) if (intersects(l.r, r)) clashes.push(`${l.id} covers a redaction`);
  }
  add("labels_clear", !clashes.length, clashes.slice(0, 5).join("; ") || "no label covers a target, label, badge or redaction");

  const tipErrors = [];
  for (const it of items.filter((x) => x.leader)) {
    const own = it.shape;
    const tip = it.leader.to;
    const d = own.w === 0 && own.h === 0 ? Math.hypot(tip[0] - own.x, tip[1] - own.y) : distToRect(tip, own);
    if (d < T.gap * 0.4 || d > T.gap * 2.5) tipErrors.push(`${it.id} tip is ${d.toFixed(1)} px from its target`);
    for (const b of badges) if (intersects(grow(b.r, T.halo), { x: tip[0], y: tip[1], w: 0.01, h: 0.01 })) tipErrors.push(`${it.id} tip lands on badge ${b.id}`);
    for (const t of targets) {
      if (t.id === it.id) continue;
      if (segmentHitsRect(it.leader.from, it.leader.to, t.r)) tipErrors.push(`${it.id} leader crosses target ${t.id}`);
    }
    for (const r of reds) if (segmentHitsRect(it.leader.from, it.leader.to, r)) tipErrors.push(`${it.id} leader crosses a redaction`);
  }
  add("leader_tips", !tipErrors.length, tipErrors.slice(0, 5).join("; ") || "every leader ends just outside its own target");

  // A placed leader is a segment; a label lying on another mark's leader hides where it points.
  const onLeader = [];
  for (const l of labels) {
    for (const it of items) {
      if (it.id === l.id || !it.leader) continue;
      if (segmentHitsRect(it.leader.from, it.leader.to, l.r)) onLeader.push(`${l.id} covers the leader of ${it.id}`);
    }
  }
  add("labels_off_leaders", !onLeader.length, onLeader.slice(0, 5).join("; ") || "no label covers another mark's leader");

  // Measured on the base: a leader whose middle runs through text erases letters under its halo.
  const baseGrey = greyIntegrals(base);
  const throughText = items.filter((it) => it.leader && leaderCrossesText(it.leader.from, it.leader.to, T, baseGrey)).map((it) => it.id);
  add("leaders_clear_of_text", !throughText.length, throughText.length ? `leader of ${throughText.join(", ")} runs through text` : "no leader runs through text");

  // Contrast is measured on the written pixels, not on the colours the renderer meant to use.
  // The text must really be there (enough pixels of its ink), and on a pill its background is the
  // commonest colour inside the pill; on a sketch label it is the white halo drawn under the text.
  const low = [];
  const rgbAt = (x, y) => {
    const v = at(x, y);
    return v === undefined ? undefined : [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  for (const it of items) {
    const parts = [["label", it.labelInk, it.labelBox?.rect], ["badge", it.badgeInk, it.badge && badgeBounds(it.badge)]];
    for (const [what, pair, rect] of parts) {
      if (!pair || !rect) continue;
      const ink = color(pair.text);
      const counts = new Map();
      let inkPixels = 0;
      const inset = Math.min(rect.w, rect.h) * 0.2;
      for (let y = Math.ceil(rect.y + inset); y < rect.y + rect.h - inset; y++) {
        for (let x = Math.ceil(rect.x + inset); x < rect.x + rect.w - inset; x++) {
          const p = rgbAt(x, y);
          if (!p) continue;
          if (Math.abs(p[0] - ink[0]) + Math.abs(p[1] - ink[1]) + Math.abs(p[2] - ink[2]) < 60) inkPixels++;
          const k = (p[0] << 16) | (p[1] << 8) | p[2];
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
      if (inkPixels < 12) { low.push(`${it.id} ${what}: its text is not visible in the output`); continue; }
      let bg = color(pair.bg);
      if (it.labelInk?.pill && what === "label" && counts.size) {
        const k = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        bg = [(k >> 16) & 255, (k >> 8) & 255, k & 255];
      }
      const c = contrast(ink, bg);
      if (c < 4.5) low.push(`${it.id} ${what} ${c.toFixed(2)}:1`);
    }
  }
  add("text_contrast", !low.length, low.join("; ") || "all label and badge text present and at least 4.5:1");

  // Ink past the canvas edge is never drawn, so only the on-canvas part of a footprint must fit.
  const onCanvas = (r) => {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    return { owner: r.owner, x: x0, y: y0, w: Math.min(frame.w, r.x + r.w) - x0, h: Math.min(frame.h, r.y + r.h) - y0 };
  };
  // A crop through a redaction is safe (less of the fill shows), so redactions are exempt.
  const redactIds = new Set(redactions.map((it) => it.id));
  const cut = footprints.filter((r) => !redactIds.has(r.owner)).map(onCanvas).filter((r) => r.w > 0 && r.h > 0 && !insideRect(cropRect, grow(r, -1), 1));
  add("marks_inside_crop", !cut.length, cut.length ? `crop cuts through ${[...new Set(cut.map((r) => r.owner))].join(", ")}` : "every mark is inside the output");
  return proofs;
}
