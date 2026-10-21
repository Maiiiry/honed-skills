#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Purpose: rebuild the README picture from the invented settings screen the tests use: the same
//   spec in the clean style and in the sketch style, side by side. Nothing in it is real. Three
//   marks and one redaction: the most a figure should carry (a redaction is not a mark).
// Usage: node scripts/make_illustration.mjs OUT.png   (after setup)
//   Without OUT it writes docs/assets/ only inside the skills repository it came from.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureImage, FIXTURE_CSS } from "./lib/fixture.mjs";
import { esc, resvgFontOptions } from "./lib/fonts.mjs";
import { decode, encode } from "./lib/png.mjs";
import { renderSpec } from "./lib/render.mjs";

// The skill folder sits at <root>/skills/<name>/, so three levels up is the repository root.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Installed elsewhere (say ~/.claude/skills/), three levels up is a home folder, not the repo.
const inRepo = existsSync(join(ROOT, "skills", "screenshot-callouts")) && existsSync(join(ROOT, "docs", "assets"));
if (!process.argv[2] && !inRepo) {
  process.stdout.write(`${JSON.stringify({ ok: false, errors: [{ code: "USAGE", detail: "name the output: make_illustration.mjs OUT.png" }] })}\n`);
  process.exit(2);
}
const OUT = resolve(process.argv[2] ?? join(ROOT, "docs", "assets", "screenshot-callouts-example.png"));

const b = FIXTURE_CSS.boxes;
const annotations = [
  { id: "nav", kind: "step", n: 1, target: { css: b.nav } },
  { id: "write", kind: "callout", target: { css: b.write }, label: "Turn this on" },
  { id: "create", kind: "step", n: 2, target: { css: b.create } },
  { id: "key", kind: "redact", target: { css: b.hidden } },
];

const dir = mkdtempSync(join(tmpdir(), "sc-illustration-"));
try {
  const png = join(dir, "screen.png");
  writeFileSync(png, encode(await fixtureImage(2)));
  const panels = [];
  for (const style of ["clean", "sketch"]) {
    const r = await renderSpec({ image: png, dpr: 2, style, annotations }, { out: join(dir, `${style}.png`) });
    panels.push({ style, b64: readFileSync(r.output.path).toString("base64"), w: r.output.width, h: r.output.height });
  }
  const scale = 0.5;
  const gap = 32;
  const head = 56;
  const pw = panels[0].w * scale;
  const ph = panels[0].h * scale;
  const W = Math.round(pw * 2 + gap * 3);
  const H = Math.round(ph + head + gap);
  const parts = panels.map((p, i) => {
    const x = gap + i * (pw + gap);
    return `<text x="${x}" y="38" font-family="Inter" font-weight="700" font-size="22" fill="#1d2330">${esc(p.style === "clean" ? "style: clean" : "style: sketch (rough.js)")}</text>
<rect x="${x - 1}" y="${head - 1}" width="${pw + 2}" height="${ph + 2}" fill="#d0d5dd"/>
<image x="${x}" y="${head}" width="${pw}" height="${ph}" href="data:image/png;base64,${p.b64}"/>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#ffffff"/>${parts.join("")}</svg>`;
  const { Resvg } = await import("@resvg/resvg-js");
  const raster = new Resvg(svg, { font: resvgFontOptions(), fitTo: { mode: "original" } }).render();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, encode({ width: raster.width, height: raster.height, data: Buffer.from(raster.pixels), kept: [] }));
  const check = decode(readFileSync(OUT));
  process.stdout.write(`${JSON.stringify({ ok: true, out: OUT, width: check.width, height: check.height })}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
