// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Every target form becomes one box in image pixels here, and nowhere else. A target that cannot
// be found, matches twice, or lies outside the frame refuses the whole render: a mark drawn in the
// wrong place reads as a correct one, which is worse than no mark.

import { didYouMean, refused, usage } from "./errors.mjs";

/**
 * Validate a refs file against the image it claims to describe. Two shapes are accepted:
 * the versioned contract (written by `capture`, or by any capture script that follows
 * references/spec.md) and the agent-browser
 * `screenshot --annotate --json` envelope, whose boxes are CSS px with no dpr of their own.
 */
export function readRefs(raw, image, specDpr) {
  // agent-browser wraps its result as { success, data: { annotations } } in --json mode.
  if (raw && !Array.isArray(raw.annotations) && Array.isArray(raw.data?.annotations)) raw = raw.data;
  if (raw && Array.isArray(raw.annotations)) {
    const dpr = specDpr;
    if (!dpr) throw usage("DPR_UNKNOWN", "an agent-browser refs file carries no dpr", { path: "/dpr", fix: "set dpr in the spec (2 for a Retina capture)" });
    const refs = {};
    for (const a of raw.annotations) {
      const key = String(a.ref ?? a.number).replace(/^@/, "");
      const b = a.box;
      if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 0 || b.height < 0) {
        throw usage("REFS_INVALID", `ref "${key}" needs a box with finite x, y and a width and height of 0 or more`);
      }
      if (Object.hasOwn(refs, key)) throw usage("REFS_INVALID", `ref "${key}" appears twice`);
      refs[key] = { box: a.box, matches: 1 };
      // This format carries no size and no image hash, so the one check left is that every box
      // still lands inside the image at the spec's dpr. A wrong dpr fails it for any box past
      // the middle of the screen.
      const right = (a.box.x + a.box.width) * dpr;
      const bottom = (a.box.y + a.box.height) * dpr;
      if (right > image.width + 1 || bottom > image.height + 1) {
        throw refused("DPR_MISMATCH", `ref "${key}" falls outside the ${image.width}x${image.height} image at dpr ${dpr}`, {
          path: "/dpr",
          fix: "set dpr to the capture's device pixel ratio, or re-capture with refs written by `capture`",
        });
      }
    }
    return { dpr, origin: { x: 0, y: 0 }, refs };
  }
  if (!raw || raw.version !== 1 || raw.units !== "css" || !raw.refs || !raw.origin || !raw.size || typeof raw.image_sha256 !== "string" || !(raw.dpr > 0)) {
    throw usage("REFS_INVALID", "the refs file is not a version 1 refs file (version, units, dpr, origin, size, image_sha256, refs)", { fix: "regenerate it with `annotate.mjs capture`; the fields are in references/spec.md" });
  }
  const finite = (...v) => v.every((n) => Number.isFinite(n));
  if (!finite(raw.size.width, raw.size.height, raw.origin.x, raw.origin.y) || raw.size.width <= 0 || raw.size.height <= 0 || raw.dpr > 4 || raw.dpr < 0.5) {
    throw usage("REFS_INVALID", "the refs file needs a positive size, a finite origin and a dpr of at most 4");
  }
  for (const [key, r] of Object.entries(raw.refs)) {
    const b = r?.box;
    if (!b || !finite(b.x, b.y, b.width, b.height) || b.width < 0 || b.height < 0) throw usage("REFS_INVALID", `ref "${key}" needs a box with finite x, y and a width and height of 0 or more`);
    if (r.matches !== undefined && r.matches !== 1) throw refused("TARGET_AMBIGUOUS", `ref "${key}" matched ${r.matches} elements when it was measured`, { fix: "make the selector unique and re-capture" });
  }
  // The hash is required, so a refs file can never be paired with a different capture of the same size.
  if (image.sha && raw.image_sha256 !== image.sha) {
    throw refused("REFS_MISMATCH", "the refs file was written for a different image", { fix: "re-capture: the PNG changed after its boxes were measured" });
  }
  const expectW = Math.round(raw.size.width * raw.dpr);
  const expectH = Math.round(raw.size.height * raw.dpr);
  if (Math.abs(expectW - image.width) > 1 || Math.abs(expectH - image.height) > 1) {
    throw refused("DPR_MISMATCH", `refs say ${raw.size.width}x${raw.size.height} CSS px at dpr ${raw.dpr} = ${expectW}x${expectH}, the image is ${image.width}x${image.height}`, {
      fix: "browser zoom must be 100% and dpr set at launch; re-capture",
    });
  }
  return { dpr: raw.dpr, origin: raw.origin, refs: raw.refs };
}

function inside(img, b, slack = 1) {
  return b.x >= -slack && b.y >= -slack && b.x + b.w <= img.width + slack && b.y + b.h <= img.height + slack;
}

function clampBox(img, b) {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  const cx = Math.min(x, img.width);
  const cy = Math.min(y, img.height);
  return { ...b, x: cx, y: cy, w: Math.max(0, Math.min(img.width, b.x + b.w) - cx), h: Math.max(0, Math.min(img.height, b.y + b.h) - cy) };
}

/**
 * @param target  parsed target from spec.mjs
 * @param ctx     { img, dpr, refs, ocr, measure }
 * @param who     { id, path } for error messages
 * @returns       { x, y, w, h, source }
 */
export async function resolveTarget(target, ctx, who = {}) {
  const { img } = ctx;
  const v = target.value;
  let box;
  let source;
  switch (target.form) {
    case "box":
      box = { x: v[0], y: v[1], w: v[2], h: v[3] };
      source = "box";
      break;
    case "css": {
      if (!ctx.dpr) {
        throw usage("DPR_UNKNOWN", "a css target needs the image's device pixel ratio", { ...who, path: "/dpr", fix: "set dpr in the spec, or use box/pct/ref" });
      }
      const d = ctx.dpr;
      box = { x: v[0] * d, y: v[1] * d, w: v[2] * d, h: v[3] * d };
      source = "css";
      break;
    }
    case "pct":
      box = { x: v[0] * img.width, y: v[1] * img.height, w: v[2] * img.width, h: v[3] * img.height };
      source = "pct";
      break;
    case "point":
      box = { x: v[0], y: v[1], w: 0, h: 0 };
      source = "point";
      break;
    case "ref": {
      const refs = ctx.refs?.refs;
      if (!refs) throw usage("REFS_MISSING", "a ref target needs a refs file", { ...who, path: "/refs", fix: 'set "refs" to the refs file written with the screenshot' });
      const r = Object.hasOwn(refs, v) ? refs[v] : undefined;
      if (!r) {
        const keys = Object.keys(refs);
        const near = didYouMean(v, keys);
        throw refused("TARGET_MISSING", `ref "${v}" is not in the refs file`, { ...who, candidates: near.length ? near : keys.slice(0, 20) });
      }
      if (r.matches !== undefined && r.matches !== 1) {
        throw refused("TARGET_AMBIGUOUS", `ref "${v}" matched ${r.matches} elements when it was measured`, { ...who, fix: "make the selector unique and re-capture" });
      }
      const d = ctx.refs.dpr;
      const o = ctx.refs.origin;
      box = { x: (r.box.x - o.x) * d, y: (r.box.y - o.y) * d, w: r.box.width * d, h: r.box.height * d };
      // The source names the key only, never a `name` from the refs file: an element's name can be
      // exactly the text a redaction hides.
      source = who.masked ? "ref (masked)" : `ref ${v}`;
      break;
    }
    case "text": {
      const { findText } = await import("./ocr.mjs");
      const within = target.within ? await resolveTarget(target.within, ctx, who) : undefined;
      box = await findText(ctx, v, { nth: target.nth, within }, who);
      source = who.masked ? "text (masked)" : typeof v === "string" ? `text "${v}"` : "text pattern";
      break;
    }
    case "seed": {
      const { seedBox } = await import("./measure.mjs");
      box = seedBox(ctx.img, v[0], v[1], who);
      source = `seed ${v[0]},${v[1]}`;
      break;
    }
    default:
      throw usage("TARGET_INVALID", `unknown target form ${target.form}`, who);
  }
  if (!inside(img, box)) {
    throw refused("TARGET_OFF_FRAME", `the target lies outside the ${img.width}x${img.height} image`, {
      ...who,
      detail: undefined,
      fix: "the element was not on screen when captured: scroll it into view, use a taller viewport, or crop differently",
      candidates: [`resolved box ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)}`],
    });
  }
  const grow = (target.pad ?? 0) * (ctx.dpr ?? 1);
  const grown = clampBox(img, { x: box.x - grow, y: box.y - grow, w: box.w + 2 * grow, h: box.h + 2 * grow });
  return { ...grown, source };
}
