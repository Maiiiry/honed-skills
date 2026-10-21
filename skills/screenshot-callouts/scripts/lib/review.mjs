// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// A human circles things roughly in human-review; this turns that batch into a spec, so the
// tool redraws the marks cleanly on the same fractional boxes. human-review returns a normalised
// box per mark, so an arrow's direction and a freehand path do not survive the trip: an arrow
// becomes a box around its extent, and the result says so.

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { usage } from "./errors.mjs";
import { readJsonFile, writeFresh } from "./files.mjs";

const KIND_OF = { ellipse: "ellipse", rect: "box", free: "ellipse", arrow: "box", text: "highlight" };

const clip = (s) => (s.length > 120 ? `${s.slice(0, 116).trimEnd()}...` : s);

export function specFromReview(batch, { item, image } = {}) {
  const pages = (batch?.pages ?? []).filter((p) => p.kind === "media" && p.marks?.length);
  if (!pages.length) throw usage("REVIEW_EMPTY", "the batch has no media page with marks", { fix: "pass the batch human-review returned after Send" });
  const page = item === undefined ? pages[0] : pages.find((p, i) => String(i + 1) === String(item) || p.name === item);
  if (!page) throw usage("REVIEW_ITEM", `no media page "${item}" with marks`, { candidates: pages.map((p, i) => `${i + 1}: ${p.name}`) });
  const warnings = [];
  const annotations = page.marks.map((m) => {
    const kind = KIND_OF[m.tool] ?? "box";
    if (m.tool === "arrow") warnings.push(`mark ${m.number}: human-review keeps an arrow's box but not its direction, so it became a box; point it with a callout if needed`);
    const a = { id: `mark-${m.number}`, kind, target: { pct: [m.box.x, m.box.y, m.box.w, m.box.h] } };
    if (m.note && m.note.trim()) a.label = clip(m.note.trim());
    return a;
  });
  return { spec: { image: image ?? page.source, style: "clean", note: `from human-review, page ${page.name}`, annotations }, warnings, source: page.source };
}

export function fromReviewCommand(path, opt) {
  if (!path) throw usage("USAGE", "from-review needs RECEIPT.json");
  if (opt.out === true) throw usage("USAGE", "-o needs a file path");
  if (opt.image === true) throw usage("USAGE", "--image needs a file path");
  // --image is a command-line path (relative to the working directory); the spec stores it
  // relative to the spec's own folder, where render will look for it.
  const outPath = opt.out ? resolve(opt.out) : undefined;
  // --image follows the same rule as the receipt's path below: relative only inside the spec's
  // folder, else the file name, so a spec never spells out the folders above it.
  let image;
  if (opt.image && outPath) {
    const rel = relative(dirname(outPath), resolve(opt.image));
    image = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : basename(opt.image);
  } else if (opt.image) image = resolve(opt.image);
  const { spec, warnings, source } = specFromReview(readJsonFile(path, "RECEIPT.json"), { item: opt.item, image });
  // Without --image the receipt's own path is used. It is absolute, and a spec is a file people
  // share, so the spec keeps it relative when it lies inside the spec's folder and by file name
  // otherwise, with a warning.
  if (image && outPath && image === basename(opt.image) && relative(dirname(outPath), resolve(opt.image)).startsWith("..")) {
    warnings.push(`the screenshot lies outside the spec's folder, so the spec names it "${image}" only: move the spec beside it`);
  }
  if (!image && outPath && typeof source === "string") {
    const rel = relative(dirname(outPath), resolve(source));
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) spec.image = rel;
    else {
      spec.image = basename(source);
      warnings.push(`the screenshot lies outside the spec's folder, so the spec names it "${basename(source)}" only: pass --image, or move the spec beside it`);
    }
  }
  const imagePath = opt.image ? resolve(opt.image) : typeof source === "string" ? resolve(source) : undefined;
  const out = outPath ? writeFresh(outPath, `${JSON.stringify(spec, null, 2)}\n`, [path, imagePath], "-o") : null;
  return { ok: true, spec, warnings, written: out };
}
