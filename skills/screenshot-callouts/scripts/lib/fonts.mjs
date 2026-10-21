// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Fonts are files we control, never whatever the system has. resvg reads TTF and OTF but not WOFF2,
// and scanning system fonts costs 1.6 s per render (measured) and differs per machine, which would
// move every label. So `setup` converts the pinned WOFF2 files that ship inside two npm packages
// (Inter from @fontsource/inter, Excalifont from @excalidraw/excalidraw) into TTF, once.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cacheDir, packageDir, SETUP_FIX } from "./cache.mjs";
import { missingDep } from "./errors.mjs";
import { sha256 } from "./png.mjs";

export const FAMILIES = Object.freeze({ clean: "Inter", sketch: "Excalifont" });

function sources() {
  const inter = join(packageDir("@fontsource/inter"), "files");
  const excali = join(packageDir("@excalidraw/excalidraw"), "dist", "prod", "fonts", "Excalifont");
  const pick = (dir, re) => readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f));
  return [
    // Latin only: it covers Latin-1 (German umlauts). A second same-named face would make the
    // family-to-face choice ambiguous, which is the trap the Excalifont probe below handles.
    ...pick(inter, /^inter-latin-(400|700)-normal\.woff2$/),
    ...pick(excali, /^Excalifont-Regular-[0-9a-f]+\.woff2$/),
  ];
}

const fontDir = () => join(cacheDir(), "fonts");
const manifestPath = () => join(fontDir(), "manifest.json");

/** Convert every pinned WOFF2 to TTF and record a sha256 per file. Idempotent. */
export async function setupFonts() {
  const { decompress } = await import("wawoff2");
  mkdirSync(fontDir(), { recursive: true });
  const { Resvg } = await import("@resvg/resvg-js");
  // The converted files are derived works under the SIL Open Font License 1.1, which travels with
  // them: Inter's licence file from its package, and a notice for Excalifont, whose npm package
  // ships no licence file (its licence is stated at https://plus.excalidraw.com/excalifont).
  copyFileSync(join(packageDir("@fontsource/inter"), "LICENSE"), join(fontDir(), "Inter-OFL.txt"));
  writeFileSync(
    join(fontDir(), "NOTICE.txt"),
    "Inter: SIL Open Font License 1.1, see Inter-OFL.txt (from @fontsource/inter).\n" +
      "Excalifont: SIL Open Font License 1.1, by Excalidraw, https://plus.excalidraw.com/excalifont (from @excalidraw/excalidraw).\n" +
      "The MIT licence of the @excalidraw/excalidraw package covers its code, not the Excalifont files.\n" +
      "Both were converted from WOFF2 to TTF, unmodified otherwise, for local rendering only.\n",
  );
  const manifest = {};
  for (const src of sources()) {
    const ttf = Buffer.from(await decompress(readFileSync(src)));
    const name = basename(src).replace(/\.woff2$/, ".ttf");
    const path = join(fontDir(), name);
    writeFileSync(path, ttf);
    // Excalidraw splits Excalifont into seven same-named subsets (Latin, Cyrillic, Greek...).
    // resvg resolves a family to ONE face, so a non-Latin subset would win and every label would
    // silently fall back to Inter. Keep only faces that can draw Latin text. Measured 2026-10-19.
    const probe = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="0" y="40" font-size="30" font-family="x">Ag</text></svg>`;
    const drawsLatin = new Resvg(probe, { font: { loadSystemFonts: false, fontFiles: [path], defaultFontFamily: "x" } }).getBBox();
    if (drawsLatin) manifest[name] = sha256(ttf);
  }
  writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir: fontDir(), files: Object.keys(manifest).length };
}

let cached;

/** The verified TTF paths. Refuses with exit 3 when setup has not run or a file changed. */
export function fontFiles() {
  if (cached) return cached;
  const fix = SETUP_FIX;
  if (!existsSync(manifestPath()) || !existsSync(join(fontDir(), "NOTICE.txt")) || !existsSync(join(fontDir(), "Inter-OFL.txt"))) {
    throw missingDep("FONTS_MISSING", "the converted fonts or their licence notices are not in the cache", { fix });
  }
  const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
  const files = Object.entries(manifest).map(([name, hash]) => {
    const p = join(fontDir(), name);
    if (!existsSync(p) || sha256(readFileSync(p)) !== hash) {
      throw missingDep("FONTS_MISSING", `font ${name} is missing or changed since setup`, { fix });
    }
    return p;
  });
  if (!files.some((f) => /inter/.test(f)) || !files.some((f) => /Excalifont/.test(f))) {
    throw missingDep("FONTS_MISSING", "the font cache lacks Inter or Excalifont", { fix });
  }
  cached = files;
  return files;
}

export function resvgFontOptions() {
  return { loadSystemFonts: false, fontFiles: fontFiles(), defaultFontFamily: FAMILIES.clean };
}

const XML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
/** The ONE escaping helper. Every string that enters SVG markup passes through it. */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESC[c]);

const measured = new Map();

/**
 * Width of one line of text in px, through resvg itself so measurement and rendering agree.
 * Height is the font's line box (size x lineHeight), not the ink, so labels with and without
 * descenders get the same height.
 */
export async function measureLine(text, { family, size, weight }) {
  const key = `${family}|${size}|${weight}|${text}`;
  if (measured.has(key)) return measured.get(key);
  const { Resvg } = await import("@resvg/resvg-js");
  // A leading and trailing "|" fixes the bbox to the advance width, then their own width is removed.
  const svgFor = (t) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="${size * 4}"><text x="0" y="${size * 2}" font-family="${esc(family)}" font-size="${size}" font-weight="${weight}" xml:space="preserve">${esc(t)}</text></svg>`;
  const bbox = (t) => new Resvg(svgFor(t), { font: resvgFontOptions() }).getBBox();
  const bars = bbox("||");
  const full = bbox(`|${text}|`);
  const width = full && bars ? Math.max(0, full.width - bars.width) : 0;
  measured.set(key, width);
  return width;
}
