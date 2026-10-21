// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Excalidraw export (slice P2).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fixtureImage, FIXTURE_CSS } from "../scripts/lib/fixture.mjs";
import { decode, encode, pixelHash } from "../scripts/lib/png.mjs";
import { renderSpec } from "../scripts/lib/render.mjs";
import { buildScene, exportExcalidraw } from "../scripts/lib/excalidraw.mjs";

let dir;
let png;
let original;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sa-ex-"));
  png = join(dir, "settings.png");
  original = await fixtureImage(2);
  writeFileSync(png, encode(original));
});

const css = (k) => ({ css: FIXTURE_CSS.boxes[k] });
const SPEC = (style) => ({
  image: png,
  dpr: 2,
  style,
  annotations: [
    { id: "nav", kind: "step", n: 1, target: css("nav") },
    { id: "write", kind: "callout", target: css("write"), label: "Turn this on" },
    { id: "create", kind: "box", n: 2, target: css("create") },
    { id: "key", kind: "redact", target: css("hidden") },
  ],
});

describe("excalidraw export", () => {
  it("embeds the redacted base, never the original", async () => {
    const r = await renderSpec(SPEC("clean"), { out: join(dir, "a.png") });
    const scene = await buildScene(r);
    const files = Object.values(scene.files);
    expect(files).toHaveLength(1);
    const embedded = decode(Buffer.from(files[0].dataURL.split(",")[1], "base64"));
    expect(pixelHash(embedded)).toBe(r.base_sha256);
    expect(pixelHash(embedded)).not.toBe(pixelHash(original));
  });

  it("locks the screenshot and uses scene units of image px / dpr", async () => {
    const r = await renderSpec(SPEC("clean"), { out: join(dir, "b.png") });
    const scene = await buildScene(r);
    const img = scene.elements.find((e) => e.type === "image");
    expect(img.locked).toBe(true);
    expect(img.width).toBeCloseTo(1100);
    const fileId = img.fileId;
    expect(scene.files[fileId].id).toBe(fileId);
  });

  it("binds arrows both ways to their targets", async () => {
    const r = await renderSpec(SPEC("sketch"), { out: join(dir, "c.png") });
    const scene = await buildScene(r);
    const byId = new Map(scene.elements.map((e) => [e.id, e]));
    const arrows = scene.elements.filter((e) => e.type === "arrow");
    expect(arrows.length).toBeGreaterThan(0);
    for (const a of arrows) {
      const target = byId.get(a.endBinding.elementId);
      expect(target).toBeDefined();
      expect(target.boundElements.some((b) => b.id === a.id)).toBe(true);
      expect(a.points[0]).toEqual([0, 0]);
    }
  });

  it("uses Excalifont and artist roughness for sketch, architect for clean", async () => {
    const s = await buildScene(await renderSpec(SPEC("sketch"), { out: join(dir, "d.png") }));
    const c = await buildScene(await renderSpec(SPEC("clean"), { out: join(dir, "e.png") }));
    expect(s.elements.filter((e) => e.type === "text").every((t) => t.fontFamily === 5)).toBe(true);
    expect(s.elements.find((e) => e.type === "rectangle" && e.strokeColor !== "transparent").roughness).toBe(1);
    expect(c.elements.find((e) => e.type === "rectangle" && e.strokeColor !== "transparent").roughness).toBe(0);
  });

  it("never writes an exactly-zero coordinate", async () => {
    const scene = await buildScene(await renderSpec(SPEC("clean"), { out: join(dir, "f.png") }));
    for (const e of scene.elements) {
      expect(e.x).not.toBe(0);
      expect(e.y).not.toBe(0);
    }
  });

  // The excalidraw skill's linter: EXLINT names it, else the sibling skill folder in this
  // collection. Absent both, the test is skipped and says so.
  const exlint = [process.env.EXLINT, join(import.meta.dirname, "..", "..", "excalidraw", "scripts", "exlint.py")].find((p) => p && existsSync(p)) ?? "";
  it.skipIf(!existsSync(exlint))("passes the excalidraw skill's linter", async () => {
    const r = await renderSpec(SPEC("sketch"), { out: join(dir, "g.png") });
    const out = join(dir, "g.excalidraw");
    await exportExcalidraw(r, { out });
    let res;
    try {
      res = execFileSync("python3", [exlint, out], { encoding: "utf8" });
    } catch (e) {
      res = e.stdout;
    }
    // exlint is a diagram linter. Its one rule that a screenshot annotation breaks on purpose is
    // node-overlap between a mark and the number badge on its own corner. Every other error fails.
    const errors = res.split("\n").filter((l) => l.startsWith("error"));
    const unexpected = errors.filter((l) => !/node-overlap\s+(\S+):shape\/\1:badge\b/.test(l));
    expect(res).toMatch(/elements:/);
    expect(unexpected).toEqual([]);
  });
});
