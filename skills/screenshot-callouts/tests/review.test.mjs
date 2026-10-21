// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Regression tests for the findings of the first code review and visual critique (2026-10-20).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { fixtureBox, fixtureImage, FIXTURE_CSS } from "../scripts/lib/fixture.mjs";
import { decode, encode, pixelAt } from "../scripts/lib/png.mjs";
import { renderSpec } from "../scripts/lib/render.mjs";
import { parseSpec } from "../scripts/lib/spec.mjs";
import { readRefs } from "../scripts/lib/targets.mjs";
import { captureCommand } from "../scripts/lib/capture.mjs";
import { checkProof } from "../scripts/lib/proof.mjs";

let dir;
let png;
let img;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sa-review-"));
  png = join(dir, "shot.png");
  img = await fixtureImage(2);
  writeFileSync(png, encode(img));
});
const css = (k) => ({ css: FIXTURE_CSS.boxes[k] });
const sha = (p) => readFileSync(p).toString("base64").length + ":" + readFileSync(p).subarray(0, 64).toString("hex");

describe("output paths never reach an input", () => {
  // Only where volumes fold case by default (macOS, Windows): elsewhere SHOT.PNG is another file.
  it.runIf(process.platform === "darwin" || process.platform === "win32")("refuses an output that differs from the input only in letter case", async () => {
    const before = sha(png);
    await expect(renderSpec({ image: png, dpr: 2, annotations: [{ kind: "box", target: css("create") }] }, { out: join(dir, "SHOT.PNG") })).rejects.toMatchObject({ code: "OVERWRITE_INPUT" });
    expect(sha(png)).toBe(before);
  });

  it("refuses an excalidraw path that is the input", async () => {
    const before = sha(png);
    await expect(renderSpec({ image: png, dpr: 2, annotations: [{ kind: "box", target: css("create") }] }, { out: join(dir, "e.png"), excalidraw: png })).rejects.toMatchObject({ code: "OVERWRITE_INPUT" });
    expect(sha(png)).toBe(before);
  });

  it("refuses a spec output path that leaves the spec's folder or changes type", async () => {
    const box = [{ kind: "box", target: css("create") }];
    await expect(renderSpec({ image: png, dpr: 2, excalidraw: png, annotations: box }, { specDir: dir, out: join(dir, "p1.png") })).rejects.toMatchObject({ code: "OUTPUT_PATH_POLICY" });
    await expect(renderSpec({ image: png, dpr: 2, out: "../escape.png", annotations: box }, { specDir: dir })).rejects.toMatchObject({ code: "OUTPUT_PATH_POLICY" });
  });

  it("refuses two outputs that are the same file", async () => {
    const same = join(dir, "same.png");
    await expect(renderSpec({ image: png, dpr: 2, annotations: [{ kind: "box", target: css("create") }] }, { out: same, viaExcalidraw: same })).rejects.toMatchObject({ code: "OUTPUT_COLLISION" });
  });

  it("writes the excalidraw export from renderSpec itself, so batch and capture get it", async () => {
    const ex = join(dir, "inline.excalidraw");
    const r = await renderSpec({ image: png, dpr: 2, excalidraw: ex, annotations: [{ kind: "box", target: css("create") }] }, { specDir: dir, out: join(dir, "inline.png") });
    expect(r.excalidraw.path).toBe(ex);
    expect(JSON.parse(readFileSync(ex, "utf8")).type).toBe("excalidraw");
  });

  it("never renames a rejected render onto the input", async () => {
    const rejectedNamed = join(dir, "in.rejected.png");
    writeFileSync(rejectedNamed, encode(img));
    const before = sha(rejectedNamed);
    const { resolveRejectedPath } = await import("../scripts/lib/files.mjs");
    const p = resolveRejectedPath(join(dir, "in.png"), [rejectedNamed]);
    expect(p).not.toBe(rejectedNamed);
    expect(sha(rejectedNamed)).toBe(before);
  });
});

describe("input with transparency", () => {
  it("passes the proof on a PNG with partly transparent pixels", async () => {
    const t = { ...img, data: Buffer.from(img.data) };
    for (let y = 0; y < 40; y++) for (let x = 0; x < t.width; x++) t.data[(y * t.width + x) * 4 + 3] = 120;
    const p = join(dir, "alpha.png");
    writeFileSync(p, encode(t));
    const r = await renderSpec({ image: p, dpr: 2, annotations: [{ kind: "box", target: css("create") }] }, { out: join(dir, "alpha.annotated.png") });
    expect(r.proofs.every((x) => x.ok)).toBe(true);
  });
});

describe("secrets", () => {
  it("refuses a literal text target that looks like a secret", () => {
    expect(() => parseSpec({ image: "x.png", annotations: [{ kind: "redact", target: { text: FIXTURE_CSS.hiddenText } }] })).toThrow(/looks like a secret/);
  });

  it("surfaces the warning when blur could not be checked", async () => {
    const prev = process.env.SCREENSHOT_CALLOUTS_OCR;
    process.env.SCREENSHOT_CALLOUTS_OCR = "none";
    try {
      const r = await renderSpec({ image: png, dpr: 2, annotations: [{ kind: "blur", target: { css: [236, 84, 300, 24] } }] }, { out: join(dir, "blur.png") });
      expect(r.warnings.join(" ")).toMatch(/blur .* not checked/);
    } finally {
      if (prev === undefined) delete process.env.SCREENSHOT_CALLOUTS_OCR;
      else process.env.SCREENSHOT_CALLOUTS_OCR = prev;
    }
  });

  it("never echoes the words of a text-targeted redaction", async () => {
    const r = await renderSpec({ image: png, dpr: 2, annotations: [{ id: "r", kind: "redact", target: { text: "nightly-export" } }] }, { out: join(dir, "mask.png") }).catch((e) => e);
    expect(JSON.stringify(r.result ?? r)).not.toContain("nightly-export");
  });

  it("refuses an agent-browser refs box that falls outside the image at the given dpr", () => {
    const env = { path: "x.png", annotations: [{ ref: "e1", number: 1, role: "button", name: "Go", box: { x: 800, y: 10, width: 200, height: 20 } }] };
    expect(() => readRefs(env, { width: 2200, height: 1240 }, 4)).toThrow(/DPR_MISMATCH|outside/);
    expect(readRefs(env, { width: 2200, height: 1240 }, 2).refs.e1).toBeDefined();
    // agent-browser's --json mode wraps the same list in { success, data }.
    expect(readRefs({ success: true, data: env }, { width: 2200, height: 1240 }, 2).refs.e1).toBeDefined();
  });
});

describe("layout", () => {
  it("frame layout makes room for a magnifier", async () => {
    const r = await renderSpec({ image: png, dpr: 2, layout: "frame", annotations: [{ id: "m", kind: "magnify", target: css("create") }] }, { out: join(dir, "fm.png") });
    expect(r.proofs.every((x) => x.ok)).toBe(true);
  });

  it("keeps a box at the image edge fully inside the image", async () => {
    const r = await renderSpec({ image: png, dpr: 2, annotations: [{ id: "n", kind: "box", target: css("nav") }] }, { out: join(dir, "edge.png") });
    const s = r.internal.layout.items[0].shape;
    expect(s.x).toBeGreaterThanOrEqual(r.internal.T.stroke / 2);
  });

  it("puts a label level with a small target when the row has room", async () => {
    const r = await renderSpec({ image: png, dpr: 2, annotations: [{ id: "ip", kind: "callout", target: css("ip"), label: "Leave this off" }] }, { out: join(dir, "level.png") });
    const a = r.annotations[0];
    const labelCy = a.label_rect.y + a.label_rect.h / 2;
    const targetCy = a.target.px.y + a.target.px.h / 2;
    expect(Math.abs(labelCy - targetCy)).toBeLessThan(a.label_rect.h / 2);
  });
});

describe("proof", () => {
  it("checks the shaded area of a spotlight against the shaded base", async () => {
    const r = await renderSpec({ image: png, dpr: 2, annotations: [{ id: "s", kind: "spotlight", targets: [css("create")] }] }, { out: join(dir, "spot.png") });
    expect(r.proofs.find((p) => p.name === "spotlight_shade_exact").ok).toBe(true);
    const out = decode(readFileSync(r.output.path));
    // Undo the shade on one pixel in the corner, far from every mark.
    const i = (10 * out.width + 10) * 4;
    const b = r.internal.base;
    for (let c = 0; c < 3; c++) out.data[i + c] = b.data[(10 * b.width + 10) * 4 + c];
    const bad = join(dir, "spot-bad.png");
    writeFileSync(bad, encode(out));
    expect(checkProof({ ...r.internal, outputPath: bad }).find((p) => p.name === "spotlight_shade_exact").ok).toBe(false);
  });

  it("fails when a leader runs through a row of text", async () => {
    const r = await renderSpec({ image: png, dpr: 2, annotations: [{ id: "w", kind: "callout", target: css("write"), label: "Turn this on" }] }, { out: join(dir, "lt.png") });
    expect(r.proofs.find((p) => p.name === "leaders_clear_of_text").ok).toBe(true);
    const layout = structuredClone(r.internal.layout);
    const it = layout.items[0];
    // Drag the leader straight along the "Allow write access" text row.
    it.leader.from = [500, 690];
    it.leader.to = [860, 690];
    expect(checkProof({ ...r.internal, layout }).find((p) => p.name === "leaders_clear_of_text").ok).toBe(false);
  });

  it("redaction_uniform compares against the requested fill and skips cropped pixels", async () => {
    const r = await renderSpec({ image: png, dpr: 2, crop: { css: [400, 200, 600, 300] }, annotations: [{ id: "k", kind: "redact", target: css("hidden") }, { kind: "box", target: css("create") }] }, { out: join(dir, "cropred.png") });
    expect(r.proofs.find((p) => p.name === "redaction_uniform").ok).toBe(true);
    const out = decode(readFileSync(r.output.path));
    const b = fixtureBox("hidden");
    const bad = { ...out, data: Buffer.from(out.data) };
    const pix = ((b.y + 10 - r.crop.y) * bad.width + 600 - r.crop.x) * 4;
    for (let i = 0; i < 3; i++) bad.data[pix + i] = 200;
    const p2 = join(dir, "cropred-bad.png");
    writeFileSync(p2, encode(bad));
    expect(checkProof({ ...r.internal, outputPath: p2 }).find((p) => p.name === "redaction_uniform").ok).toBe(false);
  });

  it("text_contrast reads real pixels: a label repainted pale fails", async () => {
    const r = await renderSpec({ image: png, dpr: 2, annotations: [{ id: "c", kind: "callout", target: css("write"), label: "Turn this on" }] }, { out: join(dir, "con.png") });
    const out = decode(readFileSync(r.output.path));
    const L = r.internal.layout.items[0].labelBox.rect;
    for (let y = Math.ceil(L.y); y < L.y + L.h; y++) {
      for (let x = Math.ceil(L.x); x < L.x + L.w; x++) {
        const i = (y * out.width + x) * 4;
        if (out.data[i] > 200 && out.data[i + 1] > 200) { out.data[i] = 235; out.data[i + 1] = 150; out.data[i + 2] = 140; }
      }
    }
    const p2 = join(dir, "con-bad.png");
    writeFileSync(p2, encode(out));
    expect(checkProof({ ...r.internal, outputPath: p2 }).find((p) => p.name === "text_contrast").ok).toBe(false);
  });
});

describe.runIf(process.env.SA_BROWSER_TESTS !== "0")("capture safety", () => {
  let url;
  beforeAll(() => {
    const p = join(dir, "page.html");
    writeFileSync(p, `<!doctype html><style>body{margin:0}#k{position:absolute;left:40px;top:40px;width:300px;height:40px;background:#e00}#b{position:absolute;left:400px;top:40px;width:80px;height:30px;background:#06c}</style><div id="k"></div><div id="b"></div>`);
    url = pathToFileURL(p).href;
  });

  it("refuses a redaction that is not a selector", async () => {
    const spec = join(dir, "cap1.json");
    writeFileSync(spec, JSON.stringify({ image: "x.png", annotations: [{ kind: "redact", target: { css: [40, 40, 300, 40] } }] }));
    await expect(captureCommand({ url, spec, viewport: "600x200", dpr: "2", out: join(dir, "cap1.png") })).rejects.toMatchObject({ code: "CAPTURE_REDACT_NEEDS_SELECTOR" });
    expect(existsSync(join(dir, "cap1.capture.png"))).toBe(false);
  }, 120_000);

  it("never overwrites the spec it was given", async () => {
    const spec = join(dir, "foo.spec.json");
    const body = JSON.stringify({ image: "x.png", annotations: [{ kind: "box", target: { selector: "#b" } }] });
    writeFileSync(spec, body);
    await captureCommand({ url, spec, viewport: "600x200", dpr: "2", out: join(dir, "foo.png") });
    expect(readFileSync(spec, "utf8")).toBe(body);
  }, 120_000);
});

void pixelAt;

describe("capture spec handling", () => {
  it("numbers selector refs internally, so an id like crop cannot collide", async () => {
    const { extractSelectors } = await import("../scripts/lib/capture.mjs");
    const r = extractSelectors({
      crop: { selector: "#panel" },
      annotations: [
        { id: "crop", kind: "box", target: { selector: "#a" } },
        { id: "x", kind: "redact", target: { selector: "#secret" } },
      ],
    });
    expect(Object.keys(r.selectors)).toEqual(["s1", "s2", "s3"]);
    expect(new Set(Object.values(r.labels)).size).toBe(3);
    expect([...r.redactRefs]).toEqual(["s2"]);
  });
  it("refuses a refs file without an image hash", () => {
    expect(() => readRefs({ version: 1, dpr: 2, units: "css", origin: { x: 0, y: 0 }, size: { width: 1100, height: 620 }, refs: {} }, { width: 2200, height: 1240, sha: "a" })).toThrow(/REFS_INVALID/);
  });
});

describe("round 3", () => {
  it("names no hidden field in a redaction's source", async () => {
    const env = { annotations: [{ ref: "e1", box: { x: 260, y: 270, width: 640, height: 34 }, name: "jane@example.test" }] };
    const refsFile = join(dir, "ab-refs.json");
    writeFileSync(refsFile, JSON.stringify(env));
    const r = await renderSpec({ image: png, dpr: 2, refs: refsFile, annotations: [{ id: "k", kind: "redact", target: { ref: "e1" } }] }, { out: join(dir, "ab.png") });
    expect(JSON.stringify(r)).not.toContain("jane@example.test");
    expect(readFileSync(r.sidecar, "utf8")).not.toContain("jane@example.test");
  });
  it("refuses an agent-browser box with a negative size", () => {
    expect(() => readRefs({ annotations: [{ ref: "e1", box: { x: 50, y: 50, width: -20, height: 10 } }] }, { width: 2200, height: 1240 }, 2)).toThrow(/REFS_INVALID/);
  });
  it("frames a figure at a fractional dpr", async () => {
    const r = await renderSpec({ image: png, dpr: 1.1, layout: "frame", annotations: [{ id: "c", kind: "callout", target: { box: [1592, 842, 208, 66] }, label: "Create" }] }, { out: join(dir, "frac.png") });
    expect(r.proofs.every((p) => p.ok)).toBe(true);
  });
});

describe("round 4", () => {
  it("treats two not-yet-written paths through a symlinked folder as one file", async () => {
    const { mkdirSync, symlinkSync } = await import("node:fs");
    const { sameFile } = await import("../scripts/lib/files.mjs");
    mkdirSync(join(dir, "real"), { recursive: true });
    symlinkSync(join(dir, "real"), join(dir, "alias"));
    expect(sameFile(join(dir, "real", "x.png"), join(dir, "alias", "x.png"))).toBe(true);
  });
  it("refuses an empty --text instead of listing every word", async () => {
    const { locateCommand } = await import("../scripts/lib/ocr.mjs");
    await expect(locateCommand(png, { text: "" })).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("round 6", () => {
  it("refuses a spec output under a symlink that leads out, even below a missing folder", async () => {
    const { mkdirSync, symlinkSync } = await import("node:fs");
    const { specOutputPath, sameFile } = await import("../scripts/lib/files.mjs");
    const base = join(dir, "r6-spec");
    const outside = join(dir, "r6-outside");
    mkdirSync(base, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(base, "link"));
    expect(() => specOutputPath(base, "link/new/figure.png", ".png", "/out")).toThrow(/OUTPUT_PATH_POLICY/);
    expect(sameFile(join(base, "link", "new", "a.png"), join(outside, "new", "a.png"))).toBe(true);
    expect(specOutputPath(base, "new/figure.png", ".png", "/out")).toBe(join(base, "new", "figure.png"));
  });
});

describe("round 7", () => {
  it("refuses an output through a dangling symlink that a first write could bring to life", async () => {
    const { mkdirSync, symlinkSync } = await import("node:fs");
    const { specOutputPath } = await import("../scripts/lib/files.mjs");
    const base = join(dir, "r7-spec");
    mkdirSync(base, { recursive: true });
    mkdirSync(join(dir, "r7-outside"), { recursive: true });
    symlinkSync("m/../../r7-outside", join(base, "dl"));
    expect(specOutputPath(base, "m/fig.png", ".png", "/out")).toBe(join(base, "m", "fig.png"));
    expect(() => specOutputPath(base, "dl/evil.excalidraw", ".excalidraw", "/excalidraw")).toThrow(/OUTPUT_PATH_POLICY/);
  });
});

describe("round 8", () => {
  it("keeps a sketch highlight inside its footprint at button and field size", async () => {
    for (const k of ["create", "hidden"]) {
      const r = await renderSpec({ image: png, dpr: 2, style: "sketch", annotations: [{ kind: "highlight", target: css(k) }] }, { out: join(dir, `hl-${k}.png`) });
      expect(r.proofs.every((p) => p.ok)).toBe(true);
    }
  });
});

