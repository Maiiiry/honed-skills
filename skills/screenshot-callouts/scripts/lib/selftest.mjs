// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// `--selftest`: the offline checks, on an invented scene, in a throwaway cache. Each case is one
// that a broken build would fail; two are mutants that the proof MUST reject. A missing optional
// backend (OCR) is a SKIP with its count, never a pass.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "sa-selftest-"));
  const prevCache = process.env.SCREENSHOT_CALLOUTS_CACHE;
  process.env.SCREENSHOT_CALLOUTS_CACHE = join(dir, "cache");
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, status: ok ? "ok" : "FAIL", detail });
    process.stderr.write(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}\n`);
  };
  const skip = (name, why) => {
    checks.push({ name, status: "skip", detail: why });
    process.stderr.write(`skip ${name} (${why})\n`);
  };
  try {
    const { setupFonts } = await import("./fonts.mjs");
    const fonts = await setupFonts();
    check("fonts convert from the pinned packages", fonts.files >= 3, `${fonts.files} faces`);

    const { fixtureImage, FIXTURE_CSS } = await import("./fixture.mjs");
    const { encode, decode, readChunks, pixelHash } = await import("./png.mjs");
    const { renderSpec } = await import("./render.mjs");
    const { checkProof } = await import("./proof.mjs");
    const png = join(dir, "scene.png");
    const original = await fixtureImage(2);
    writeFileSync(png, encode(original));
    const b = FIXTURE_CSS.boxes;
    const annotations = [
      { id: "nav", kind: "step", n: 1, target: { css: b.nav } },
      { id: "write", kind: "callout", target: { css: b.write }, label: "Turn this on" },
      { id: "create", kind: "box", n: 2, target: { css: b.create } },
      { id: "key", kind: "redact", target: { css: b.hidden } },
    ];
    const prevOcr = process.env.SCREENSHOT_CALLOUTS_OCR;
    process.env.SCREENSHOT_CALLOUTS_OCR = "none"; // the OCR cases below opt back in
    let clean;
    for (const style of ["clean", "sketch"]) {
      try {
        const r = await renderSpec({ image: png, dpr: 2, style, annotations }, { out: join(dir, `${style}.png`) });
        if (style === "clean") clean = r;
        check(`${style} render passes its proof`, r.proofs.every((p) => p.ok), `${r.proofs.length} proofs`);
      } catch (e) {
        check(`${style} render passes its proof`, false, e.code ?? e.message);
      }
    }
    if (clean) {
      check("output carries no secret text and no metadata", !JSON.stringify(clean).includes(FIXTURE_CSS.hiddenText) && readChunks(readFileSync(clean.output.path)).trailing === 0);
      const layout = structuredClone(clean.internal.layout);
      const it = layout.items.find((x) => x.id === "write");
      it.leader.to = [it.shape.x + it.shape.w / 2, it.shape.y + it.shape.h / 2];
      check("mutant: a leader ending inside its target fails the proof", !checkProof({ ...clean.internal, layout }).find((p) => p.name === "leader_tips").ok);
      const img = decode(readFileSync(clean.output.path));
      img.data[(1200 * img.width + 60) * 4] ^= 0x20;
      const bad = join(dir, "mutant.png");
      writeFileSync(bad, encode(img));
      check("mutant: one changed unmarked pixel fails the proof", !checkProof({ ...clean.internal, outputPath: bad }).find((p) => p.name === "untouched_outside_marks").ok);
      const { buildScene } = await import("./excalidraw.mjs");
      const scene = await buildScene(clean);
      const file = Object.values(scene.files)[0];
      const embedded = decode(Buffer.from(file.dataURL.split(",")[1], "base64"));
      check("excalidraw export embeds the redacted base, not the original", pixelHash(embedded) === clean.base_sha256 && pixelHash(embedded) !== pixelHash(original));
    }
    try {
      await renderSpec({ image: png, dpr: 2, annotations: [{ kind: "box", target: { box: [2100, 10, 300, 20] } }] }, { out: join(dir, "off.png") });
      check("an off-frame target refuses", false, "it rendered");
    } catch (e) {
      check("an off-frame target refuses", e.code === "TARGET_OFF_FRAME", e.code);
    }

    if (prevOcr === undefined) delete process.env.SCREENSHOT_CALLOUTS_OCR;
    else process.env.SCREENSHOT_CALLOUTS_OCR = prevOcr;
    const { availableBackend, findText, setupOcr } = await import("./ocr.mjs");
    await setupOcr().catch(() => undefined);
    const backend = await availableBackend();
    if (!backend) skip("OCR finds a phrase", "no Vision helper and no tesseract");
    else {
      try {
        const box = await findText({ img: original, cache: {} }, "Allow write access", {}, { id: "t" });
        check(`OCR finds a phrase (${backend})`, Math.abs(box.x - 520) < 12, `x=${Math.round(box.x)}`);
      } catch (e) {
        check(`OCR finds a phrase (${backend})`, false, e.code ?? e.message);
      }
    }
    // The browser and the Excalidraw bundle serve capture and --via-excalidraw only, so either one
    // missing is a SKIP with the reason, and a present one must actually work.
    const { launch } = await import("./browser.mjs");
    try {
      const browser = await launch();
      try {
        const page = await browser.newPage();
        await page.setContent("<p>ok</p>");
        check("a browser launches and renders a page", (await page.textContent("p")) === "ok");
      } finally {
        await browser.close();
      }
    } catch (e) {
      if (e.code === "BROWSER_MISSING") skip("a browser launches and renders a page", "no Chrome, Edge or bundled Chromium");
      else check("a browser launches and renders a page", false, e.code ?? e.message);
    }
    if (prevCache === undefined) delete process.env.SCREENSHOT_CALLOUTS_CACHE;
    else process.env.SCREENSHOT_CALLOUTS_CACHE = prevCache;
    const { cacheDir } = await import("./cache.mjs");
    const bundle = join(cacheDir(), "excalidraw", "bundle.js");
    if (!existsSync(bundle)) skip("the Excalidraw bundle matches its recorded hash", "setup has not built it");
    else {
      const { sha256 } = await import("./png.mjs");
      check("the Excalidraw bundle matches its recorded hash", sha256(readFileSync(bundle)) === readFileSync(`${bundle}.sha256`, "utf8").trim());
    }
  } finally {
    if (prevCache === undefined) delete process.env.SCREENSHOT_CALLOUTS_CACHE;
    else process.env.SCREENSHOT_CALLOUTS_CACHE = prevCache;
    rmSync(dir, { recursive: true, force: true });
  }
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const ran = checks.filter((c) => c.status !== "skip").length;
  const skipped = checks.length - ran;
  const summary = { ok: failed === 0, summary: `${ran - failed}/${ran} checks pass${skipped ? `, ${skipped} skipped` : ""}`, checks };
  process.stderr.write(`selftest: ${summary.summary}\n`);
  return failed ? { selftestFailed: true, summary } : summary;
}
