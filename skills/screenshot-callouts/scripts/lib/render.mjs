// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// The render pipeline, in the order that keeps a secret safe:
//   1. validate the spec and resolve every target to image pixels (refuse on any doubt);
//   2. fill every redaction into the base bitmap, so nothing later can show the original;
//   3. lay out, draw SVG over that base, rasterise with resvg, crop;
//   4. write a fresh file (temp, then rename), read it back, prove it, write the hand-off JSON.

import { existsSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { refused, usage, EXIT, AnnotateError } from "./errors.mjs";
import { assertNotInput, fileKeys, readInputFile, readJsonFile, removeQuietly, resolveRejectedPath, specOutputPath, writeFresh, writeTemp } from "./files.mjs";
import { resvgFontOptions } from "./fonts.mjs";
import { grow, union } from "./geometry.mjs";
import { frameMargins, layout } from "./layout.mjs";
import { blurRect, borderColor, cloneImage, crop, decode, encode, extend, fillRect, flatten, greyIntegrals, pixelHash, pixelRect, sha256, MAX_INPUT_PIXELS, MAX_SIDE } from "./png.mjs";
import { checkProof } from "./proof.mjs";
import { parseSpec } from "./spec.mjs";
import { readRefs, resolveTarget } from "./targets.mjs";
import { color, PALETTE, tokens } from "./tokens.mjs";
import { buildSvg } from "./draw.mjs";

/**
 * The hand-off file names every file relative to its own folder: an absolute path would publish
 * the author's home directory with every figure, and a relative one survives moving the folder.
 * A file outside that folder is named by its file name only: `../../Desktop/Screenshot <date>.png`
 * would spell the private layout back out. Its sha256 still identifies it.
 */
function handoff(result, dir) {
  const name = (v) => {
    const rel = relative(dir, v);
    return rel.startsWith("..") || isAbsolute(rel) ? basename(v) : rel || ".";
  };
  const walk = (v, key) => {
    if (typeof v === "string" && (key === "path" || key === "sidecar") && isAbsolute(v)) return name(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(result);
}

/** Failed proofs after which the render may hold hidden pixels or metadata, so it is deleted. */
const LEAK_PROOFS = ["no_secret_beside_redaction", "redaction_uniform", "metadata_clean"];

export function sidecarPath(out) {
  return join(dirname(out), `${basename(out).replace(/\.png$/i, "").replace(/\.annotated$/, "")}.annotated.json`);
}

function describeTarget(it) {
  const s = it.target?.source ?? "";
  if (it.kind === "redact") return "a redacted area";
  if (s.startsWith('text "')) return s.replace(/^text /, "");
  // A ref key such as s1 means nothing to a reader, and no page text is carried to name it.
  return "the marked area";
}

function altText(items, style) {
  const steps = items.filter((it) => it.n !== undefined).sort((a, b) => a.n - b.n);
  const parts = [];
  if (steps.length) parts.push(`${steps.length} numbered step${steps.length > 1 ? "s" : ""}: ${steps.map((s) => `${s.n} ${s.label ?? describeTarget(s)}`).join(", ")}`);
  for (const it of items.filter((x) => x.n === undefined && x.label)) parts.push(`"${it.label}" points at ${describeTarget(it)}`);
  const red = items.filter((x) => x.kind === "redact").length;
  if (red) parts.push(`${red} area${red > 1 ? "s" : ""} redacted`);
  return `Screenshot${style === "sketch" ? " with hand-drawn marks" : ""}: ${parts.join("; ")}. Edit this draft to name the screen.`;
}

/**
 * @param rawSpec  spec object (parsed JSON)
 * @param opts     { out, specDir, specPath, dryRun, excalidraw, viaExcalidraw, inputs }
 *                 `out`, `excalidraw` and `viaExcalidraw` are already absolute (the CLI resolves
 *                 them against the working directory); the spec's own `out` and `excalidraw` are
 *                 resolved against the spec's folder and must stay inside it.
 */
/**
 * Every path a render reads and writes, from the spec and the options alone: no file is opened.
 * render uses it, and batch uses it to check all entries against each other before any write.
 */
export function planPaths(rawSpec, opts = {}) {
  const spec = parseSpec(rawSpec);
  const baseDir = opts.specDir ?? process.cwd();
  const imagePath = resolve(baseDir, spec.image);
  const refsPath = spec.refs ? resolve(baseDir, spec.refs) : undefined;
  const inputs = [imagePath, refsPath, opts.specPath, ...(opts.inputs ?? [])].filter(Boolean);
  // The default output is named after the SPEC and written beside it, so two specs on one
  // screenshot never share an output, and a handed-over spec never writes beside an image that
  // lies outside its folder. Without a spec file (a library call), it goes beside the image.
  const defaultOut = opts.specPath
    ? join(dirname(opts.specPath), `${basename(opts.specPath).replace(/\.json$/i, "")}.annotated.png`)
    : join(dirname(imagePath), `${basename(imagePath).replace(/\.png$/i, "")}.annotated.png`);
  const outPath = opts.out ? resolve(opts.out) : spec.out ? specOutputPath(baseDir, spec.out, ".png", "/out") : defaultOut;
  const exPath = opts.excalidraw ? resolve(opts.excalidraw) : spec.excalidraw ? specOutputPath(baseDir, spec.excalidraw, ".excalidraw", "/excalidraw") : undefined;
  const viaPath = opts.viaExcalidraw ? resolve(opts.viaExcalidraw) : undefined;
  // `.rejected.png` is listed too: a failed proof writes it, so it must not land on another file.
  const outputs = [
    ["/out", outPath],
    ["/out (hand-off file)", sidecarPath(outPath)],
    ["/out (rejected render)", `${outPath.replace(/\.png$/i, "")}.rejected.png`],
    ["/excalidraw", exPath],
    ["--via-excalidraw", viaPath],
  ].filter(([, p]) => p);
  return { spec, baseDir, imagePath, refsPath, inputs, outPath, exPath, viaPath, outputs };
}

/** Refuse when any output is an input or another output. */
export function assertOutputsFree(outputs, inputs) {
  // Keyed, not pairwise: a manifest of n entries would otherwise cost n squared path walks.
  const read = new Set(inputs.filter(Boolean).flatMap(fileKeys));
  const seen = new Set();
  for (const [field, p] of outputs) {
    const keys = fileKeys(p);
    if (keys.some((k) => read.has(k))) throw refused("OVERWRITE_INPUT", `${field} names a file this run reads`, { path: field, fix: "write next to it; inputs are evidence and stay untouched" });
    if (keys.some((k) => seen.has(k))) throw refused("OUTPUT_COLLISION", `${field} is the same file as another output`, { path: field });
    for (const k of keys) seen.add(k);
  }
}

export async function renderSpec(rawSpec, opts = {}) {
  const { spec, imagePath, refsPath, inputs, outPath, exPath, viaPath, outputs } = planPaths(rawSpec, opts);
  if (!existsSync(imagePath)) throw usage("INPUT_MISSING", `image not found: ${spec.image}`, { path: "/image" });
  const inputBuf = readInputFile(imagePath, "/image");
  const img = decode(inputBuf);
  const inputSha = sha256(inputBuf);
  const warnings = [];
  if (flatten(img)) warnings.push("the input has transparent pixels; they were composited onto white");
  // Every output is checked against every input AND against every other output, so the hand-off
  // file can never overwrite the export, nor the export the image.
  assertOutputsFree(outputs, inputs);

  const refs = refsPath ? readRefs(readJsonFile(refsPath, "/refs"), { width: img.width, height: img.height, sha: inputSha }, spec.dpr) : undefined;
  if (refs && spec.dpr && refs.dpr !== spec.dpr) {
    throw refused("DPR_MISMATCH", `the spec says dpr ${spec.dpr}, the refs file was measured at dpr ${refs.dpr}`, { path: "/dpr", fix: "remove dpr from the spec; the refs file knows it" });
  }
  const dpr = spec.dpr ?? refs?.dpr ?? img.dprHint;
  if (spec.dpr && img.dprHint && spec.dpr !== img.dprHint) warnings.push(`spec dpr ${spec.dpr} differs from the PNG density hint ${img.dprHint}`);
  if (!dpr) warnings.push("dpr unknown: sizes assume 1x. Set dpr for a Retina capture.");
  const T = tokens(img.width, dpr);
  // quiet: a figure with any redaction offers no OCR lines in any error, because a miss on one
  // annotation would otherwise list the words another annotation is about to hide.
  const ctx = { img, dpr, refs, cache: {}, quiet: spec.annotations.some((a) => a.kind === "redact") };

  const items = [];
  for (const a of spec.annotations) {
    const who = { id: a.id, path: `/annotations/${a.index}/target`, masked: a.kind === "redact" };
    const it = { ...a };
    if (a.target) it.target = await resolveTarget(a.target, ctx, who);
    if (a.targets) {
      it.targets = [];
      for (const [j, t] of a.targets.entries()) it.targets.push(await resolveTarget(t, ctx, { id: a.id, path: `/annotations/${a.index}/targets/${j}` }));
    }
    if (a.from) it.fromBox = await resolveTarget(a.from, ctx, { id: a.id, path: `/annotations/${a.index}/from` });
    if (!it.target && it.targets) it.target = union(it.targets);
    items.push(it);
  }
  await guardBlur(items, ctx, T, warnings);

  // Redact first, into the pixels. Every artifact after this point embeds `safe`.
  const safe = cloneImage(img);
  for (const it of items.filter((x) => x.kind === "redact")) {
    if (it.target.source?.startsWith("text")) it.target = await fieldAround(img, it.target, T);
    // The annotation's own pad grows the redaction too: it is how a caller covers a missed glyph.
    it.pixelRect = pixelRect(img, it.target, Math.ceil(T.redactGrow + (it.pad ?? 0) * T.dpr));
    if (it.pixelRect.w < 1 || it.pixelRect.h < 1) throw refused("REDACT_EMPTY", `redaction "${it.id}" covers no pixels`, { id: it.id });
    fillRect(safe, it.pixelRect, color(it.fill ?? PALETTE.redact));
  }
  // A mark on text a redaction hides would name that text in the hand-off file and the alt text:
  // any text source that overlaps a redaction keeps its form and drops its words.
  const hidden = items.filter((x) => x.kind === "redact").map((x) => x.pixelRect);
  const overlaps = (b) => hidden.some((r) => b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y);
  const scrub = (b) => (b && b.source?.startsWith('text "') && overlaps(b) ? { ...b, source: "text (masked)" } : b);
  for (const it of items.filter((x) => x.kind !== "redact")) {
    it.target = scrub(it.target);
    if (it.targets) it.targets = it.targets.map(scrub);
    it.fromBox = scrub(it.fromBox);
  }

  let canvasImg = safe;
  let dx = 0;
  let dy = 0;
  if (spec.layout === "frame") {
    const m = await frameMargins(items, spec.style, T, img.width, img.height);
    // Whole pixels: a fractional dpr (1.1, 1.3) gives fractional tokens, and a bitmap offset or
    // canvas size must be an integer, or the read-back size disagrees with the crop.
    dx = Math.ceil(m.left);
    dy = Math.ceil(T.ringSteps[0]); // a matching band above and below, so the frame reads as a frame, not a crop
    const fw = img.width + dx + Math.ceil(m.right);
    const fh = img.height + 2 * dy;
    // Checked before the canvas exists, and against the caps the read-back decode applies: a
    // wider limit here would only fail after the whole render.
    if (fw * fh > MAX_INPUT_PIXELS || fw > MAX_SIDE || fh > MAX_SIDE) throw refused("INPUT_TOO_LARGE", `the framed canvas would be ${fw}x${fh}, above the size limit`, { fix: 'crop the input, or use layout "inline"' });
    canvasImg = extend(safe, fw, fh, dx, dy, borderColor(safe));
    // A 1 px neutral frame, so the screenshot's edge stays visible when its own background has
    // the margin's colour (where the image's edges otherwise disappear). It is part of the base, not a mark.
    const e = Math.max(1, Math.round(T.dpr));
    const grey = [208, 213, 221];
    fillRect(canvasImg, { x: dx - e, y: dy - e, w: img.width + 2 * e, h: e }, grey);
    fillRect(canvasImg, { x: dx - e, y: dy + img.height, w: img.width + 2 * e, h: e }, grey);
    fillRect(canvasImg, { x: dx - e, y: dy, w: e, h: img.height }, grey);
    fillRect(canvasImg, { x: dx + img.width, y: dy, w: e, h: img.height }, grey);
    const move = (r) => ({ ...r, x: r.x + dx, y: r.y + dy });
    for (const it of items) {
      for (const k of ["target", "fromBox"]) if (it[k]) it[k] = move(it[k]);
      if (it.targets) it.targets = it.targets.map(move);
      if (it.pixelRect) it.pixelRect = move(it.pixelRect);
    }
  }
  const canvas = { width: canvasImg.width, height: canvasImg.height };
  // The cap holds for the canvas too: frame margins grow it past the input it was checked on.
  if (canvas.width * canvas.height > MAX_INPUT_PIXELS || canvas.width > MAX_SIDE || canvas.height > MAX_SIDE) {
    throw refused("INPUT_TOO_LARGE", `the framed canvas would be ${canvas.width}x${canvas.height}`, { fix: 'crop the input, or use layout "inline"' });
  }
  const L = await layout(items, {
    canvas,
    T,
    style: spec.style,
    grey: greyIntegrals(canvasImg),
    // OCR word boxes are in image pixels; the frame moved the image by (dx, dy).
    words: ctx.cache.words?.map((w) => ({ ...w, x: w.x + dx, y: w.y + dy })),
    layoutMode: spec.layout,
    frameInfo: { dx, imgW: img.width },
    imgW: img.width,
  });
  L.seed = spec.wobble;

  // Blurs are baked into a copy of the canvas, in pixels: no SVG filter, so no full-size buffer
  // per blur in the rasteriser. The copy keeps `safe` as the unblurred, redacted base.
  const blurs = L.items.filter((it) => it.kind === "blur");
  if (blurs.length) {
    if (canvasImg === safe) canvasImg = cloneImage(safe);
    for (const it of blurs) blurRect(canvasImg, it.shape, (it.amount ?? 6) * T.dpr);
  }
  const { svg, footprints, spotlightCutouts, spotlightDim } = buildSvg({
    layout: L,
    base64: encode(canvasImg).toString("base64"),
    T,
    style: spec.style,
    accent: spec.accent,
    imageSize: { dx: 0, dy: 0, w: canvas.width, h: canvas.height },
    // A blur or a lens embeds a crop of the canvas, in whole pixels inside it.
    tile: (r) => {
      const x = Math.max(0, Math.floor(r.x));
      const y = Math.max(0, Math.floor(r.y));
      const w = Math.min(canvasImg.width, Math.ceil(r.x + r.w)) - x;
      const h = Math.min(canvasImg.height, Math.ceil(r.y + r.h)) - y;
      if (w < 1 || h < 1) return null;
      return { x, y, w, h, b64: encode(crop(canvasImg, { x, y, w, h })).toString("base64") };
    },
  });

  const cropRect = await cropFor(spec, items, footprints, canvas, T, ctx, dx, dy);
  const result = {
    ok: false,
    tool: "screenshot-callouts 1.0.0",
    input: { path: imagePath, sha256: inputSha, width: img.width, height: img.height },
    base_sha256: pixelHash(safe),
    dpr: dpr ?? null,
    style: spec.style,
    layout: spec.layout,
    crop: cropRect,
    annotations: items.map((it) => summarize(it, L, cropRect)),
    warnings,
  };
  result.steps = items.filter((it) => it.n !== undefined).sort((a, b) => a.n - b.n).map((it) => ({ n: it.n, id: it.id, label: it.label ?? null }));
  result.alt_text = altText(items, spec.style);
  if (opts.dryRun) return { ...result, ok: true, dry_run: true };

  const { Resvg } = await import("@resvg/resvg-js");
  const raster = new Resvg(svg, { font: resvgFontOptions(), fitTo: { mode: "original" } }).render();
  const full = { width: raster.width, height: raster.height, data: Buffer.from(raster.pixels), kept: img.kept };
  const final = cropRect.x === 0 && cropRect.y === 0 && cropRect.w === full.width && cropRect.h === full.height ? full : crop(full, cropRect);
  const outBuf = encode(final, img.kept);

  // The image is proved at a temp path and moved to the output path only when every check, the
  // secret sweep included, has passed. A failure never leaves an unproven file at the output path.
  const tmpOut = writeTemp(outPath, outBuf);
  const internal = { outputPath: tmpOut, layout: L, base: canvasImg, cropRect, footprints, spotlightCutouts, spotlightDim, T, svg, style: spec.style, accent: spec.accent };
  Object.defineProperty(result, "internal", { value: internal, enumerable: false });
  // Whatever throws between here and the rename, the unproven temp file is removed.
  let settled = false;
  try {
    const proofs = checkProof(internal);
    result.proofs = proofs;
    const written = readFileSync(tmpOut);
    result.output = { path: outPath, sha256: sha256(written), pixels_sha256: pixelHash(decode(written)), width: final.width, height: final.height };

    // A uniform redaction proves nothing about the same key shown again in a toast or a title.
    // A secret-like token right beside a redaction is its unredacted tail, so that one fails.
    try {
      const { availableBackend, secretSweep } = await import("./ocr.mjs");
      if (await availableBackend()) {
        const allowed = L.items.filter((x) => x.kind === "redact").map((x) => ({ ...x.pixelRect, x: x.pixelRect.x - cropRect.x, y: x.pixelRect.y - cropRect.y }));
        const near = (s) => allowed.some((r) => s.x < r.x + r.w + T.font * 2 && r.x < s.x + s.w + T.font * 2 && s.y < r.y + r.h + T.font * 2 && r.y < s.y + s.h + T.font * 2);
        const hits = await secretSweep(decode(written), allowed);
        const adjacent = hits.filter(near);
        proofs.push({ name: "no_secret_beside_redaction", ok: !adjacent.length, detail: adjacent.length ? `${adjacent.length} secret-like token(s) touch a redaction: grow it, or target by a box` : "no secret-like token next to a redaction" });
        for (const s of hits.filter((x) => !near(x))) {
          warnings.push(`a ${s.chars}-character token that looks like a secret is visible at ${s.x},${s.y} (${s.w}x${s.h}): redact it, or confirm it is fake`);
        }
      } else warnings.push("secret sweep skipped: no OCR backend");
    } catch (e) {
      if (e.code !== "OCR_UNAVAILABLE") throw e;
      warnings.push("secret sweep skipped: no OCR backend");
    }

    if (proofs.some((p) => !p.ok)) {
      const failed = proofs.filter((p) => !p.ok).map((p) => `${p.name}: ${p.detail}`).join(" | ");
      // A render that may show secret pixels or carry metadata is deleted, not kept for
      // inspection: a kept copy next to the output is one `git add` away from publishing it.
      const leaks = proofs.some((p) => !p.ok && LEAK_PROOFS.includes(p.name));
      let fix = "fix the spec or report the bug";
      if (leaks) {
        result.output.path = null;
        fix = "the render may show what a redaction hides, so it was deleted; grow the redaction or report the bug";
      } else {
        const rejected = resolveRejectedPath(outPath, inputs);
        renameSync(tmpOut, rejected);
        settled = true;
        result.output.path = rejected;
        internal.outputPath = rejected;
        fix = `the image was kept as ${basename(rejected)} for inspection; ${fix}`;
      }
      const err = new AnnotateError("PROOF_FAILED", failed, { exit: EXIT.PROOF, fix });
      err.result = result;
      throw err;
    }
    assertNotInput(outPath, inputs, "/out");
    renameSync(tmpOut, outPath);
    settled = true;
  } finally {
    if (!settled) removeQuietly(tmpOut);
  }
  internal.outputPath = outPath;
  // The hand-off file is written as soon as the PNG is in place, so a failed export below never
  // leaves the new PNG beside an older run's hand-off file. It is rewritten with the export.
  result.ok = true;
  result.sidecar = sidecarPath(outPath);
  const writeHandoff = () => writeFresh(result.sidecar, `${JSON.stringify(handoff(result, dirname(result.sidecar)), null, 2)}\n`, inputs, "/out");
  writeHandoff();
  if (exPath || viaPath) {
    const { exportExcalidraw } = await import("./excalidraw.mjs");
    try {
      result.excalidraw = await exportExcalidraw(result, { out: exPath, png: viaPath, inputs });
    } catch (e) {
      if (e instanceof AnnotateError) e.result = result;
      throw e;
    }
    writeHandoff();
  }
  return result;
}

async function cropFor(spec, items, footprints, canvas, T, ctx, dx, dy) {
  const all = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  if (!spec.crop) return all;
  let want;
  if (spec.crop === "auto") {
    want = grow(union([...footprints, ...items.map((it) => it.target).filter(Boolean)]), T.cropPad);
  } else {
    const r = await resolveTarget(spec.crop, ctx, { path: "/crop" });
    want = { ...r, x: r.x + dx, y: r.y + dy };
  }
  const x0 = Math.max(0, Math.floor(want.x));
  const y0 = Math.max(0, Math.floor(want.y));
  const x1 = Math.min(canvas.width, Math.ceil(want.x + want.w));
  const y1 = Math.min(canvas.height, Math.ceil(want.y + want.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function inOut(r, c) {
  return r && { x: Math.round(r.x - c.x), y: Math.round(r.y - c.y), w: Math.round(r.w), h: Math.round(r.h) };
}

function summarize(it, L, c) {
  const item = L.items.find((x) => x.id === it.id);
  const t = inOut(item.target, c);
  return {
    id: it.id,
    kind: it.kind,
    n: it.n,
    label: it.label,
    target: { px: t, pct: [t.x / c.w, t.y / c.h, t.w / c.w, t.h / c.h].map((v) => Math.round(v * 10000) / 10000), source: it.target?.source },
    shape: inOut(item.shape, c),
    label_rect: inOut(item.labelBox?.rect ?? item.lens?.rect, c),
    leader: item.leader && { from: item.leader.from.map((v, i) => Math.round(v - (i ? c.y : c.x))), to: item.leader.to.map((v, i) => Math.round(v - (i ? c.y : c.x))) },
    badge: item.badge && { cx: Math.round(item.badge.cx - c.x), cy: Math.round(item.badge.cy - c.y), r: Math.round(item.badge.r) },
  };
}

/**
 * An OCR box is the ink of the words, and one missed glyph would stay readable. So a redaction
 * found by text grows to the field the text sits in: flood fill from just beside the words, and
 * keep the smallest region that contains them. Without such a field, pad the ink instead.
 */
async function fieldAround(img, box, T) {
  const { seedBox } = await import("./measure.mjs");
  const cy = box.y + box.h / 2;
  const seeds = [[box.x - 3 * T.dpr, cy], [box.x + box.w + 3 * T.dpr, cy], [box.x + box.w / 2, box.y - 3 * T.dpr]];
  let best;
  for (const [x, y] of seeds) {
    try {
      const f = seedBox(img, x, y);
      const holds = f.x <= box.x && f.y <= box.y && f.x + f.w >= box.x + box.w && f.y + f.h >= box.y + box.h;
      if (holds && (!best || f.w * f.h < best.w * best.h)) best = f;
    } catch {
      // that seed hit text or background; try the next
    }
  }
  const pad = 4 * T.dpr;
  return best ? { ...best, source: box.source } : { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad, source: box.source };
}

/** Blur is "obscure", never "secure". Refuse it on anything that looks like a credential. */
async function guardBlur(items, ctx, T, warnings) {
  const blurs = items.filter((x) => x.kind === "blur");
  if (!blurs.length) return;
  let words;
  try {
    const { ocrWords } = await import("./ocr.mjs");
    words = await ocrWords(ctx);
  } catch (e) {
    // Only a missing backend is a warning. A backend that crashed is a failure to check, and
    // passing a blur over an unchecked secret is exactly what this guard exists to stop.
    if (e.code !== "OCR_UNAVAILABLE") throw e;
    for (const b of blurs) warnings.push(`blur "${b.id}" was not checked for secrets: no OCR backend. Use redact for anything sensitive`);
    return;
  }
  const { looksSecret } = await import("./ocr.mjs");
  for (const b of blurs) {
    // The drawn area, including an annotation-level pad, not only the target.
    const pad = (b.pad ?? 0) * (T.dpr ?? 1);
    const r = grow(b.target, pad);
    const hit = words.some((w) => looksSecret(w.text) && w.x < r.x + r.w && r.x < w.x + w.w && w.y < r.y + r.h && r.y < w.y + w.h);
    if (hit) {
      throw refused("BLUR_ON_SECRET", `"${b.id}" blurs text that looks like a key or token; blur and pixelation are reversible on text`, {
        id: b.id,
        fix: 'use kind "redact" (a solid fill), whatever the request called it',
      });
    }
  }
}
