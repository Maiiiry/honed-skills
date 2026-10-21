// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Review aids. `sheet` puts every finished figure on one page with a zoomed crop of each target,
// because defects hide when figures are checked one at a time and small marks vanish at
// thumbnail size. `grid` draws labelled coordinates over an image: the last resort for choosing a
// box by eye, when there is no DOM, no readable text and no flat element to seed.

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { refused, usage } from "./errors.mjs";
import { readInputFile, readJsonFile, realPath, writeFresh } from "./files.mjs";
import { esc, resvgFontOptions } from "./fonts.mjs";
import { crop, decode, encode, MAX_INPUT_PIXELS, MAX_SIDE, shrink } from "./png.mjs";

async function rasterise(svg) {
  const { Resvg } = await import("@resvg/resvg-js");
  const r = new Resvg(svg, { font: resvgFontOptions(), fitTo: { mode: "original" } }).render();
  return { width: r.width, height: r.height, data: Buffer.from(r.pixels), kept: [] };
}

export async function sheetCommand(sidecars, opt) {
  if (!sidecars.length || !opt.out || opt.out === true) throw usage("USAGE", "sheet needs A.annotated.json [B ...] -o SHEET.png");
  const inputs = [...sidecars];
  const W = 1800;
  const thumbW = 1100;
  const zoomH = 220;
  const THUMB_MAX_H = 1600;
  let y = 24;
  let zooms = 0;
  const parts = [];
  for (const path of sidecars) {
    const side = readJsonFile(path, path);
    if (!side || typeof side !== "object" || typeof side.output?.path !== "string" || side.output.path.length > 1024) {
      throw usage("SPEC_INVALID", `${path}: not a hand-off file (it needs output.path)`, { path: "/output/path" });
    }
    // The hand-off file names its image relative to itself, so a moved folder still works.
    const img = resolve(dirname(resolve(path)), String(side.output?.path ?? ""));
    // A hand-off file from somebody else may name any path; read only an image beside it, through
    // real paths, so a symlinked file or folder cannot lead out.
    const rel = relative(realPath(dirname(resolve(path))), realPath(img));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw usage("SPEC_INVALID", `${path}: its image lies outside its own folder`, { path: "/output/path" });
    inputs.push(img);
    const buf = readInputFile(img, side.output?.path ?? "image");
    const pic = decode(buf);
    const { width, height } = pic;
    // A thumbnail is at most THUMB_MAX_H tall: scaling a thin strip to the sheet's width would
    // otherwise make a sheet millions of pixels tall from one small, valid image.
    const k = Math.min(thumbW / width, THUMB_MAX_H / height);
    const tw = Math.max(1, Math.round(width * k));
    const th = Math.max(1, Math.round(height * k));
    // Every image on the sheet is embedded at the size it is shown, scaled and cropped here: one
    // full copy per zoom made the rasteriser decode the whole figure once per mark.
    const png64 = (p) => encode(p).toString("base64");
    parts.push(`<text x="24" y="${y + 18}" font-family="Inter" font-weight="700" font-size="18" fill="#111">${esc(basename(side.output.path))}  ${width}x${height}</text>`);
    y += 30;
    parts.push(`<image x="24" y="${y}" width="${tw}" height="${th}" href="data:image/png;base64,${png64(k < 1 ? shrink(pic, tw, th) : pic)}"/>`);
    let zy = y;
    if (opt.zoom) {
      // The hand-off file may be somebody else's: its marks are checked like a spec's.
      const anns = side.annotations ?? [];
      if (!Array.isArray(anns) || anns.length > 30) throw usage("SPEC_INVALID", `${path}: annotations must be a list of at most 30`, { path: "/annotations" });
      for (const a of anns) {
        const t = a?.target?.px;
        if (!t || ![t.x, t.y, t.w, t.h].every(Number.isFinite)) throw usage("SPEC_INVALID", `${path}: a mark has no numeric box`, { path: "/annotations" });
        const pad = Math.max(t.w, t.h) * 0.4 + 24;
        const x0 = Math.max(0, Math.floor(t.x - pad));
        const y0 = Math.max(0, Math.floor(t.y - pad));
        const x1 = Math.min(width, Math.ceil(t.x + t.w + pad));
        const y1 = Math.min(height, Math.ceil(t.y + t.h + pad));
        if (x1 - x0 < 1 || y1 - y0 < 1) continue; // outside the figure: nothing to zoom
        const src = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        const zw = Math.min(W - thumbW - 72, src.w * (zoomH / src.h));
        const zh = src.h * (zw / src.w);
        parts.push(
          `<image x="${thumbW + 48}" y="${zy}" width="${zw}" height="${zh}" href="data:image/png;base64,${png64(shrink(crop(pic, src), zw, zh))}"/>`,
          `<text x="${thumbW + 48}" y="${zy + zh + 16}" font-family="Inter" font-size="14" fill="#444">${esc(String(a.id ?? "").slice(0, 64))} (${esc(String(a.kind ?? "").slice(0, 24))})</text>`,
        );
        zy += zh + 30;
        zooms++;
      }
    }
    y = Math.max(y + th, zy) + 36;
  }
  // Checked before rasterising, against the caps every image here is read back under.
  if (!Number.isFinite(y) || W * Math.ceil(y) > MAX_INPUT_PIXELS || Math.ceil(y) > MAX_SIDE) {
    throw refused("INPUT_TOO_LARGE", `the sheet would be ${W}x${Math.ceil(y)} px, above the size limit`, { fix: "make several sheets with fewer figures each, or drop --zoom" });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.ceil(y)}" viewBox="0 0 ${W} ${Math.ceil(y)}"><rect width="100%" height="100%" fill="#ffffff"/>${parts.join("")}</svg>`;
  const out = writeFresh(resolve(opt.out), encode(await rasterise(svg)), inputs, "-o");
  return { ok: true, out, figures: sidecars.length, zooms };
}

export async function gridCommand(imagePath, opt) {
  if (!imagePath || !opt.out || opt.out === true) throw usage("USAGE", "grid needs IMG.png -o GRID.png [--step 100]");
  const buf = readInputFile(imagePath, "IMG.png");
  const { width, height } = decode(buf);
  const step = Number(opt.step ?? 100);
  if (!Number.isInteger(step) || step < 10 || step > Math.max(width, height)) {
    throw usage("USAGE", `--step must be a whole number from 10 to ${Math.max(width, height)}`, { path: "--step" });
  }
  const size = Math.max(12, Math.round(width / 120));
  const lines = [];
  for (let x = step; x < width; x += step) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"/><text x="${x + 3}" y="${size + 2}">${x}</text>`);
  for (let y = step; y < height; y += step) lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"/><text x="3" y="${y - 3}">${y}</text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${buf.toString("base64")}"/><g stroke="#ff00aa" stroke-opacity="0.55" stroke-width="1" font-family="Inter" font-size="${size}" fill="#ff00aa" paint-order="stroke">${lines.join("")}</g></svg>`;
  const out = writeFresh(resolve(opt.out), encode(await rasterise(svg)), [imagePath], "-o");
  return {
    ok: true,
    out,
    step,
    lines: lines.length,
    note: "coordinates are image pixels; read a box off the grid only when no DOM, text or seed target exists",
    warning: "the grid is a full copy of the input, unredacted; delete it once the box is chosen",
  };
}
