// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// OCR text targets and flood-fill seed targets (slice P3).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fixtureBox, fixtureImage, FIXTURE_CSS } from "../scripts/lib/fixture.mjs";
import { measureLine } from "../scripts/lib/fonts.mjs";
import { encode } from "../scripts/lib/png.mjs";
import { parseSpec } from "../scripts/lib/spec.mjs";
import { availableBackend, findText, locateCommand, looksSecret, ocrWords } from "../scripts/lib/ocr.mjs";
import { seedBox } from "../scripts/lib/measure.mjs";
import { renderSpec, sidecarPath } from "../scripts/lib/render.mjs";

let dir;
let png;
let img;
let backend;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sa-ocr-"));
  png = join(dir, "settings.png");
  img = await fixtureImage(2);
  writeFileSync(png, encode(img));
  backend = await availableBackend();
});

const iou = (a, b) => {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter);
};

describe("secret heuristics", () => {
  it("flags key-like tokens and not ordinary UI words", () => {
    expect(looksSecret(FIXTURE_CSS.hiddenText)).toBe(true);
    expect(looksSecret("nightly-export")).toBe(false);
    expect(looksSecret("Create")).toBe(false);
    expect(looksSecret("someone@example.com")).toBe(true);
    expect(looksSecret("<someone@example.com>,")).toBe(true);
  });
  it("refuses a typed literal with a secret anywhere in it", () => {
    expect(() => parseSpec({ image: "x.png", annotations: [{ kind: "box", target: { text: "Owner someone@example.com" } }] })).toThrow(/SECRET_LITERAL/);
  });
});

describe("ocr", () => {
  const ctx = () => ({ img, dpr: 2, cache: {}, imagePath: png });

  // Vision only: tesseract reads no button text on this screen (see the tesseract case below).
  it("finds 'Create key' on the ink of the button label", async (t) => {
    if (backend !== "vision") return t.skip();
    const w = await measureLine("Create key", { family: "Inter", size: 14, weight: 700 });
    const ink = { x: 812 * 2, y: (443 - 10.5) * 2, w: w * 2, h: 10.5 * 2 };
    const box = await findText(ctx(), "Create key", {}, { id: "t" });
    expect(iou(box, ink)).toBeGreaterThan(0.5);
  });

  // Tesseract 5.5.3 reads no text at all inside this fixture's buttons, in any page-segmentation
  // mode, cropped or not (measured 2026-10-19), while Vision reads all of it. So the tesseract case
  // targets a form label, and SKILL.md names the limit.
  it("finds a form label with the tesseract backend too", async (t) => {
    const prev = process.env.SCREENSHOT_CALLOUTS_OCR;
    process.env.SCREENSHOT_CALLOUTS_OCR = "tesseract";
    try {
      if ((await availableBackend()) !== "tesseract") return t.skip();
      const w = await measureLine("Allow write access", { family: "Inter", size: 14, weight: 400 });
      const ink = { x: 260 * 2, y: (345 - 10.5) * 2, w: w * 2, h: 13.5 * 2 };
      const box = await findText(ctx(), "Allow write access", {}, { id: "t" });
      expect(iou(box, ink)).toBeGreaterThan(0.5);
    } finally {
      if (prev === undefined) delete process.env.SCREENSHOT_CALLOUTS_OCR;
      else process.env.SCREENSHOT_CALLOUTS_OCR = prev;
    }
  });

  it("refuses an ambiguous phrase and names how to choose", async (t) => {
    if (!backend) return t.skip();
    await expect(findText(ctx(), "key", {}, { id: "k" })).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS", fix: expect.stringMatching(/nth|within/) });
    const second = await findText(ctx(), "key", { nth: 2 }, { id: "k" });
    expect(second.y).toBeGreaterThan(fixtureBox("create").y - 10);
  });

  it("finds a secret by pattern without the spec ever holding it", async (t) => {
    if (!backend) return t.skip();
    const box = await findText(ctx(), { regex: "^PLACEHOLDER" }, {}, { id: "s" });
    const field = fixtureBox("hidden");
    expect(box.x).toBeGreaterThan(field.x);
    expect(box.x + box.w).toBeLessThan(field.x + field.w);
  });

  it("never names a secret-like word among the candidates", async (t) => {
    if (!backend) return t.skip();
    const err = await findText(ctx(), "PLACEHOLDER-VALUE-0000-1112", {}, { id: "m" }).catch((e) => e);
    expect(JSON.stringify(err.candidates ?? [])).not.toContain(FIXTURE_CSS.hiddenText);
  });

  it("locate masks secret-like words", async (t) => {
    if (!backend) return t.skip();
    const out = await locateCommand(png, { all: true, dpr: "2" });
    expect(JSON.stringify(out)).not.toContain(FIXTURE_CSS.hiddenText);
    expect(out.words.some((w) => w.secret_like)).toBe(true);
  });

  it("refuses blur over a secret-like word", async (t) => {
    if (!backend) return t.skip();
    await expect(
      renderSpec({ image: png, dpr: 2, annotations: [{ id: "b", kind: "blur", target: { css: FIXTURE_CSS.boxes.hidden } }] }, { out: join(dir, "b.png") }),
    ).rejects.toMatchObject({ code: "BLUR_ON_SECRET" });
  });

  it("redacts a pattern target out to its whole field", async (t) => {
    if (!backend) return t.skip();
    const r = await renderSpec({ image: png, dpr: 2, annotations: [{ id: "r", kind: "redact", target: { text: { regex: "^PLACEHOLDER" } } }] }, { out: join(dir, "r.png") });
    const red = r.internal.layout.items[0].pixelRect;
    const field = fixtureBox("hidden");
    expect(red.x).toBeLessThanOrEqual(field.x + 2);
    expect(red.x + red.w).toBeGreaterThanOrEqual(field.x + field.w - 2);
  });

  it("finds a word after a separator once, not twice", async () => {
    // "|" normalizes to nothing, so a span starting on it used to match "submit" a second time.
    const w = (text, x) => ({ text, x, y: 10, w: text.length * 8, h: 14, conf: 95, line: "v1" });
    const ctx = { img: { width: 400, height: 40 }, cache: { words: [w("past", 10), w("|", 50), w("submit", 62)] } };
    const box = await findText(ctx, "submit");
    expect(box.x).toBe(62);
  });

  it("names no words of a redacted text in a mark on the same text", async (t) => {
    if (!backend) return t.skip();
    const spec = { image: png, dpr: 2, annotations: [{ id: "r", kind: "redact", target: { text: "nightly-export" } }, { id: "b", kind: "box", target: { text: "nightly-export" } }] };
    // A dry run: the box sits under the redaction's fill, so a full render fails every_mark_drew.
    const r = await renderSpec(spec, { out: join(dir, "samewords.png"), dryRun: true });
    expect(JSON.stringify(r)).not.toContain("nightly-export");
  });

  it("warns when a secret-like token stays visible outside every redaction", async (t) => {
    if (!backend) return t.skip();
    const r = await renderSpec({ image: png, dpr: 2, annotations: [{ kind: "box", target: { css: FIXTURE_CSS.boxes.create } }] }, { out: join(dir, "w.png") });
    expect(r.warnings.join(" ")).toMatch(/looks like a secret/);
    expect(JSON.stringify(r)).not.toContain(FIXTURE_CSS.hiddenText);
  });

  it("uses each backend's words in image pixels", async (t) => {
    if (!backend) return t.skip();
    const words = await ocrWords(ctx());
    expect(words.length).toBeGreaterThan(10);
    for (const w of words) {
      expect(w.x).toBeGreaterThanOrEqual(-2);
      expect(w.x + w.w).toBeLessThanOrEqual(img.width + 2);
    }
  });
});

describe("seed flood fill", () => {
  it("returns the button's bounding box from a point inside it", () => {
    const b = fixtureBox("create");
    const box = seedBox(img, b.x + 6, b.y + b.h / 2, { id: "s" });
    expect(Math.abs(box.x - b.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.w - b.w)).toBeLessThanOrEqual(4);
    expect(Math.abs(box.h - b.h)).toBeLessThanOrEqual(4);
  });

  it("refuses a region that leaks to the image edge", () => {
    expect(() => seedBox(img, 1500, 1150, { id: "bg" })).toThrow(/SEED_LEAK/);
  });
});

describe("the SKILL.md example", () => {
  it("plans against the invented screen it describes", async (t) => {
    if (backend !== "vision") return t.skip();
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync(join(import.meta.dirname, "..", "SKILL.md"), "utf8");
    const block = /```json\n([\s\S]*?)```/.exec(doc)[1].replace(/^ {3}/gm, "");
    const spec = { ...JSON.parse(block), image: png };
    const r = await renderSpec(spec, { out: join(dir, "doc-example.png"), dryRun: true });
    const nav = r.annotations.find((a) => a.id === "nav");
    expect(nav.target.px.y).toBeGreaterThan(200); // the sidebar item at y 124 css, not the heading at 96
  });
});

