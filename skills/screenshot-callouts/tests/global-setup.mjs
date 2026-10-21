// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sa-cache-"));
  process.env.SCREENSHOT_CALLOUTS_CACHE = dir;
  const { setupFonts } = await import("../scripts/lib/fonts.mjs");
  await setupFonts();
  const { setupOcr } = await import("../scripts/lib/ocr.mjs");
  await setupOcr();
  return () => rmSync(dir, { recursive: true, force: true });
}
