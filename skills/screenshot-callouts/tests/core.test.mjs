// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Unit tests for the spec, PNG, token and target layers (slice P1).
import { describe, expect, it } from "vitest";
import { parseSpec, jsonSchema, unsafePattern } from "../scripts/lib/spec.mjs";
import { decode, encode, readChunks, dprFromPhys, pixelRect } from "../scripts/lib/png.mjs";
import { tokens, contrast, inkOn, color } from "../scripts/lib/tokens.mjs";
import { resolveTarget, readRefs } from "../scripts/lib/targets.mjs";
import { esc } from "../scripts/lib/fonts.mjs";
import { crc32 } from "./helpers.mjs";

const minimal = (annotations, extra = {}) => ({ image: "x.png", annotations, ...extra });
const errOf = (fn) => {
  try { fn(); } catch (e) { return e; }
  throw new Error("expected a refusal");
};

describe("spec", () => {
  it("rejects an unknown annotation type naming its index", () => {
    const e = errOf(() => parseSpec(minimal([{ kind: "box", target: { box: [0, 0, 1, 1] } }, { kind: "bxo", target: { box: [0, 0, 1, 1] } }])));
    expect(e.code).toBe("UNKNOWN_KIND");
    expect(e.path).toBe("/annotations/1/kind");
    expect(e.candidates).toContain("box");
  });
  it("suggests the nearest field for a typo", () => {
    const e = errOf(() => parseSpec(minimal([{ kind: "callout", target: { box: [0, 0, 1, 1] }, lable: "x" }])));
    expect(e.code).toBe("UNKNOWN_FIELD");
    expect(e.candidates[0]).toBe("label");
  });
  it("needs exactly one target form", () => {
    const e = errOf(() => parseSpec(minimal([{ kind: "box", target: { box: [0, 0, 1, 1], css: [0, 0, 1, 1] } }])));
    expect(e.code).toBe("TARGET_INVALID");
  });
  it("requires a label on a callout", () => {
    const e = errOf(() => parseSpec(minimal([{ kind: "callout", target: { box: [0, 0, 1, 1] } }])));
    expect(e.path).toBe("/annotations/0/label");
  });
  it("refuses duplicate ids", () => {
    const a = { id: "x", kind: "box", target: { box: [0, 0, 1, 1] } };
    expect(errOf(() => parseSpec(minimal([a, a]))).detail).toMatch(/twice/);
  });
  it("assigns ids from the position when none are given", () => {
    const s = parseSpec(minimal([{ kind: "box", target: { box: [0, 0, 1, 1] } }]));
    expect(s.annotations[0].id).toBe("a1");
  });
  it("emits a JSON Schema with every kind", () => {
    const s = jsonSchema();
    expect(s.properties.annotations.items.anyOf.length).toBe(12);
  });
});

describe("png", () => {
  const img = { width: 3, height: 2, data: Buffer.alloc(24, 200), kept: [] };
  it("round-trips pixels exactly", () => {
    const back = decode(encode(img));
    expect(back.data.equals(img.data)).toBe(true);
  });
  it("drops text, time, EXIF and trailing bytes but keeps colour chunks", () => {
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
      return Buffer.concat([len, body, crc]);
    };
    const clean = encode(img);
    const ihdrEnd = 33;
    const dirty = Buffer.concat([
      clean.subarray(0, ihdrEnd),
      chunk("sRGB", Buffer.from([0])),
      chunk("tEXt", Buffer.from("Comment\0secret")),
      chunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0x")),
      chunk("eXIf", Buffer.from("MM\0*")),
      chunk("tIME", Buffer.alloc(7)),
      clean.subarray(ihdrEnd),
      Buffer.from("OLD IMAGE BYTES AFTER IEND"),
    ]);
    const rewritten = encode(decode(dirty), decode(dirty).kept);
    const { chunks, trailing } = readChunks(rewritten);
    const types = chunks.map((c) => c.type);
    expect(types).toContain("sRGB");
    for (const t of ["tEXt", "iTXt", "eXIf", "tIME"]) expect(types).not.toContain(t);
    expect(trailing).toBe(0);
  });
  const chunkOf = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  it("drops an ICC profile and keeps only the first chunk of a colour type", () => {
    const clean = encode(img);
    const dirty = Buffer.concat([clean.subarray(0, 33), chunkOf("iCCP", Buffer.from("Calibrated by somebody\0\0x")), chunkOf("sRGB", Buffer.from([0])), chunkOf("sRGB", Buffer.from([3])), clean.subarray(33)]);
    const types = readChunks(encode(decode(dirty), decode(dirty).kept)).chunks.map((c) => c.type);
    expect(types).not.toContain("iCCP");
    expect(types.filter((t) => t === "sRGB")).toHaveLength(1);
  });
  it("refuses a chunk whose checksum is wrong", () => {
    const bad = Buffer.from(encode(img));
    bad[bad.length - 1] ^= 0xff;
    expect(() => decode(bad)).toThrow(/checksum/);
  });
  it("refuses an image above the pixel cap before inflating it", () => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(9000, 0); ihdr.writeUInt32BE(9000, 4); ihdr[8] = 8; ihdr[9] = 6;
    const huge = Buffer.concat([encode(img).subarray(0, 8), chunkOf("IHDR", ihdr), chunkOf("IEND", Buffer.alloc(0))]);
    expect(() => decode(huge)).toThrow(/INPUT_TOO_LARGE/);
  });
  it("refuses image data that inflates past its declared scanlines", async () => {
    const { deflateSync } = await import("node:zlib");
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(30_000, 4); ihdr[8] = 8; ihdr[9] = 6;
    // 1 x 30,000 RGBA8 needs 150,000 bytes; twice that is a bomb, refused while inflating.
    const tall = Buffer.concat([encode(img).subarray(0, 8), chunkOf("IHDR", ihdr), chunkOf("IDAT", deflateSync(Buffer.alloc(300_000))), chunkOf("IEND", Buffer.alloc(0))]);
    expect(() => decode(tall)).toThrow(/does not inflate to its declared size/);
  });
  it("refuses a strip with a side above the cap, though its pixel count fits", () => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(40_000_000, 4); ihdr[8] = 16; ihdr[9] = 6;
    const strip = Buffer.concat([encode(img).subarray(0, 8), chunkOf("IHDR", ihdr), chunkOf("IEND", Buffer.alloc(0))]);
    expect(() => decode(strip)).toThrow(/INPUT_TOO_LARGE/);
  });
  it("refuses a bit depth the format does not allow, before inflating", () => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(6480, 0); ihdr.writeUInt32BE(6480, 4); ihdr[8] = 255; ihdr[9] = 6;
    const deep = Buffer.concat([encode(img).subarray(0, 8), chunkOf("IHDR", ihdr), chunkOf("IEND", Buffer.alloc(0))]);
    expect(() => decode(deep)).toThrow(/bit depth, colour type/);
  });
  it("refuses a zero side before inflating, whatever the width", () => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(20_000_000, 0); ihdr.writeUInt32BE(0, 4); ihdr[8] = 8; ihdr[9] = 6;
    const flat = Buffer.concat([encode(img).subarray(0, 8), chunkOf("IHDR", ihdr), chunkOf("IEND", Buffer.alloc(0))]);
    expect(() => decode(flat)).toThrow(/INPUT_FORMAT/);
  });
  it("reads dpr 2 from a 144 dpi pHYs and nothing from 96 dpi", () => {
    const phys = (dpi) => {
      const d = Buffer.alloc(9); const ppm = Math.round(dpi / 0.0254);
      d.writeUInt32BE(ppm, 0); d.writeUInt32BE(ppm, 4); d[8] = 1;
      return [{ type: "pHYs", data: d }];
    };
    expect(dprFromPhys(phys(144))).toBe(2);
    expect(dprFromPhys(phys(96))).toBeUndefined();
  });
  it("grows a redaction rect outward to whole pixels", () => {
    expect(pixelRect({ width: 100, height: 100 }, { x: 10.4, y: 10.6, w: 5.2, h: 5.2 }, 2)).toEqual({ x: 8, y: 8, w: 10, h: 10 });
  });
});

describe("tokens", () => {
  it("offers no spelling suggestions for a very long name, at once", async () => {
    const { didYouMean } = await import("../scripts/lib/errors.mjs");
    const t0 = Date.now();
    expect(didYouMean("b".repeat(100_000), ["a".repeat(100_000)])).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(didYouMean("Sve", ["Save", "Cancel"])).toEqual(["Save"]);
  });
  it("refuses a dpr below 0.5 and a within nested three deep", () => {
    expect(() => parseSpec({ image: "x.png", dpr: 1e-9, annotations: [{ kind: "box", target: { box: [1, 1, 2, 2] } }] })).toThrow(/0\.5 to 4/);
    const w = (inner) => ({ text: "Key", within: inner });
    expect(() => parseSpec({ image: "x.png", annotations: [{ kind: "box", target: w(w(w({ box: [0, 0, 9, 9] }))) }] })).toThrow(/within can nest/);
  });
  it("scales stroke and font with width and dpr", () => {
    expect(tokens(1000, 1).stroke).toBeCloseTo(3);
    expect(tokens(2200, 2).stroke).toBeCloseTo(6.16, 1);
    // Capped at 20 CSS px of text: a wide monitor at 100% does not have larger UI text.
    expect(tokens(4000, 1).font).toBeCloseTo(20);
    expect(tokens(2560, 2).font).toBeCloseTo(38.4);
    expect(tokens(800, 2).font).toBe(28);
  });
  it("picks label ink that clears 4.5:1 on any accent", () => {
    for (const hex of ["#D92D20", "#FFD43B", "#777777", "#1864AB", "#00FF00"]) {
      expect(contrast(inkOn(color(hex)), color(hex))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("targets", () => {
  const img = { width: 2200, height: 1240 };
  const ctx = (extra = {}) => ({ img, dpr: 2, ...extra });
  const t = (target) => parseSpec(minimal([{ kind: "box", target }])).annotations[0].target;
  it("css target multiplies by dpr into image pixels", async () => {
    expect(await resolveTarget(t({ css: [796, 421, 104, 33] }), ctx())).toMatchObject({ x: 1592, y: 842, w: 208, h: 66 });
  });
  it("refuses a css target when dpr is unknown", async () => {
    await expect(resolveTarget(t({ css: [1, 1, 1, 1] }), ctx({ dpr: undefined }))).rejects.toMatchObject({ code: "DPR_UNKNOWN" });
  });
  it("pct target maps figure fractions onto the image", async () => {
    expect(await resolveTarget(t({ pct: [0.5, 0.25, 0.1, 0.1] }), ctx())).toMatchObject({ x: 1100, y: 310, w: 220, h: 124 });
  });
  it("off-frame target refuses with its id", async () => {
    await expect(resolveTarget(t({ box: [2100, 10, 200, 20] }), ctx(), { id: "late" })).rejects.toMatchObject({ code: "TARGET_OFF_FRAME", id: "late" });
  });
  it("ref resolves through the sidecar with origin and dpr", async () => {
    const refs = readRefs(
      { version: 1, image_sha256: "abc", dpr: 2, units: "css", origin: { kind: "fullPage", x: 0, y: -100 }, size: { width: 1100, height: 620 }, refs: { create: { selector: "#create", box: { x: 796, y: 321, width: 104, height: 33 }, matches: 1 } } },
      { width: 2200, height: 1240, sha: "abc" },
    );
    expect(await resolveTarget(t({ ref: "create" }), ctx({ refs }))).toMatchObject({ x: 1592, y: 842, w: 208, h: 66 });
  });
  it("refuses a sidecar written for a different image", () => {
    expect(errOf(() => readRefs({ version: 1, image_sha256: "abc", dpr: 2, units: "css", origin: { kind: "viewport", x: 0, y: 0 }, size: { width: 1100, height: 620 }, refs: {} }, { width: 2200, height: 1240, sha: "zzz" })).code).toBe("REFS_MISMATCH");
  });
  it("refuses a sidecar whose size times dpr is not the image size", () => {
    expect(errOf(() => readRefs({ version: 1, image_sha256: "abc", dpr: 2, units: "css", origin: { kind: "viewport", x: 0, y: 0 }, size: { width: 1000, height: 620 }, refs: {} }, { width: 2200, height: 1240, sha: "abc" })).code).toBe("DPR_MISMATCH");
  });
  it("names the nearest ref when one is missing", async () => {
    const refs = readRefs({ version: 1, image_sha256: "a", dpr: 2, units: "css", origin: { kind: "viewport", x: 0, y: 0 }, size: { width: 1100, height: 620 }, refs: { create: { box: { x: 0, y: 0, width: 1, height: 1 }, matches: 1 } } }, { width: 2200, height: 1240, sha: "a" });
    await expect(resolveTarget(t({ ref: "craete" }), ctx({ refs }))).rejects.toMatchObject({ code: "TARGET_MISSING", candidates: ["create"] });
  });
});

describe("svg safety", () => {
  it("escapes markup in labels", () => {
    expect(esc('<image href="/etc/hosts"/> & <')).toBe("&lt;image href=&quot;/etc/hosts&quot;/&gt; &amp; &lt;");
  });
});

describe("regex grammar", () => {
  it("refuses every pattern that can backtrack catastrophically", () => {
    for (const p of ["((a+))+$", "(a|aa)+$", "(a|a)+$", "(x*)*y", "(ab){2,}", "(a)\\1", "a*b*c*d*e", `^${"a{0,50}".repeat(20)}b$`, "a{0,500}b"]) expect(unsafePattern(p), p).toBeTruthy();
  });
  it("stops a pattern that still backtracks, by its deadline", async () => {
    const { regexTestAll } = await import("../scripts/lib/ocr.mjs");
    await expect(regexTestAll(`${".{0,20}".repeat(8)}!`, ["x".repeat(200)])).rejects.toMatchObject({ code: "REGEX_TIMEOUT" });
    expect(await regexTestAll("^sk_", ["sk_live_1", "other"])).toEqual([true, false]);
  }, 20_000);
  it("accepts the prefix patterns the docs use", () => {
    for (const p of ["^sk_", "^ghp_[A-Za-z0-9]+$", "^[0-9]{4} [0-9]{4}", "(?:live|test)_key"]) expect(unsafePattern(p), p).toBeUndefined();
  });
});

describe("documentation", () => {
  it("lists every error code the scripts can throw in SKILL.md", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "..");
    const files = [join(root, "scripts", "annotate.mjs"), ...readdirSync(join(root, "scripts", "lib")).map((f) => join(root, "scripts", "lib", f))];
    const codes = new Set();
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/(?:usage|refused|missingDep|AnnotateError)\("([A-Z_]+)"/g)) codes.add(m[1]);
    const doc = readFileSync(join(root, "SKILL.md"), "utf8");
    expect([...codes].filter((c) => !doc.includes(`\`${c}\``))).toEqual([]);
  });
});
