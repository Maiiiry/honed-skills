// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// `setup` derives everything the renderer needs from the pinned, lockfile-verified packages:
// TTF fonts, the offline Excalidraw bundle, and (on macOS) the Vision OCR helper. No network.

import { cacheDir } from "./cache.mjs";

export async function setup(opt = {}) {
  const report = { cache: cacheDir() };
  const warnings = [];
  const { setupFonts } = await import("./fonts.mjs");
  report.fonts = await setupFonts();
  try {
    const { setupBundle } = await import("./excalidraw.mjs");
    report.excalidraw = await setupBundle();
  } catch (e) {
    report.excalidraw = { skipped: String(e.message).split("\n")[0] };
    warnings.push(`Excalidraw render unavailable (--via-excalidraw): ${report.excalidraw.skipped}`);
  }
  if (!opt["no-ocr"]) {
    const { setupOcr } = await import("./ocr.mjs");
    report.ocr = await setupOcr();
    if (report.ocr.vision_error) warnings.push(`Vision OCR helper did not build: ${report.ocr.vision_error}`);
    if (!report.ocr.vision && !report.ocr.tesseract) warnings.push("no OCR backend: text targets and the secret sweep will not run");
  }
  return { ok: true, warnings, ...report };
}
