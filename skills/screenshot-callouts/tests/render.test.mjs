// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Layout, render and proof (slice P1) against the invented fixture screen.
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fixtureImage, fixtureBox, FIXTURE_CSS } from "../scripts/lib/fixture.mjs";
import { encode, decode, pixelAt } from "../scripts/lib/png.mjs";
import { renderSpec } from "../scripts/lib/render.mjs";
import { checkProof } from "../scripts/lib/proof.mjs";
import { intersects } from "../scripts/lib/geometry.mjs";

let dir;
let png;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sa-render-"));
  png = join(dir, "settings.png");
  writeFileSync(png, encode(await fixtureImage(2)));
});

const spec = (annotations, extra = {}) => ({ image: png, dpr: 2, annotations, ...extra });
const css = (k) => ({ css: FIXTURE_CSS.boxes[k] });
const BASIC = [
  { id: "nav", kind: "step", n: 1, target: css("nav") },
  { id: "write", kind: "callout", target: css("write"), label: "Turn this on" },
  { id: "create", kind: "box", n: 2, target: css("create") },
  { id: "key", kind: "redact", target: css("hidden") },
];

describe("render", () => {
  it("refuses a spec image that is not a regular file, without reading it", async () => {
    if (process.platform === "win32") return;
    const r = await renderSpec({ image: "/dev/zero", dpr: 1, annotations: [{ kind: "box", target: { box: [1, 1, 2, 2] } }] }, { out: join(dir, "zero.png") }).catch((e) => e);
    expect(r.code).toBe("INPUT_MISSING");
  });

  it("leaves every target pixel untouched on a wide 1x screenshot, where the stroke is thick", async () => {
    // At 3840 px and dpr 1 the stroke and halo reach farther than the default pad.
    const W = 3840, H = 300, data = Buffer.alloc(W * H * 4, 255);
    for (let y = 140; y < 156; y++) for (let x = 1800; x < 1860; x++) data.set([20, 20, 20, 255], (y * W + x) * 4);
    const wide = join(dir, "wide.png");
    writeFileSync(wide, encode({ width: W, height: H, data }));
    const out = join(dir, "wide-out.png");
    await renderSpec({ image: wide, dpr: 1, annotations: [{ id: "b", kind: "box", target: { box: [1800, 140, 60, 16] } }] }, { out });
    const o = decode(readFileSync(out));
    let changed = 0;
    for (let y = 140; y < 156; y++) for (let x = 1800; x < 1860; x++) if (o.data[(y * W + x) * 4] !== 20) changed++;
    expect(changed).toBe(0);
  });

  for (const [kind, style] of [["ellipse", "clean"], ["underline", "clean"], ["underline", "sketch"], ["box", "sketch"], ["ellipse", "sketch"], ["spotlight", "clean"], ["spotlight", "sketch"], ["callout:label", "sketch"]]) {
    it(`leaves every pixel of a tight target untouched under a ${style} ${kind}`, async () => {
      // A wide 1x shot: the stroke reaches farther than any fixed offset, and sketch wobbles.
      const W = 2560, H = 400, data = Buffer.alloc(W * H * 4, 255);
      for (let y = 190; y < 207; y++) for (let x = 1200; x < 1305; x += 2) data.set([20, 20, 20, 255], (y * W + x) * 4);
      const img = join(dir, `tight-${kind.replace(":", "-")}-${style}.png`);
      writeFileSync(img, encode({ width: W, height: H, data }));
      const out = join(dir, `tight-${kind.replace(":", "-")}-${style}-out.png`);
      const [k, withLabel] = kind.split(":");
      await renderSpec({ image: img, dpr: 1, style, annotations: [{ id: "a1", kind: k, target: { box: [1200, 190, 105, 17] }, ...(withLabel ? { label: "Click" } : {}), ...(k === "step" ? { n: 1 } : {}) }] }, { out });
      const o = decode(readFileSync(out));
      let changed = 0;
      for (let y = 190; y < 207; y++) for (let x = 1200; x < 1305; x += 2) if (o.data[(y * W + x) * 4] > 60) changed++;
      expect(changed).toBe(0);
      // And the mark drew: some pixel outside the target changed.
      const i = decode(readFileSync(img));
      let drawn = 0;
      for (let k = 0; k < o.data.length; k += 4) if (o.data[k] !== i.data[k] || o.data[k + 1] !== i.data[k + 1]) drawn++;
      expect(drawn).toBeGreaterThan(50);
    });
  }

  it("keeps a long sketch ellipse off its target across seeds", async () => {
    const W = 2560, H = 400, data = Buffer.alloc(W * H * 4, 255);
    for (let y = 190; y < 207; y++) for (let x = 600; x < 1800; x += 2) data.set([20, 20, 20, 255], (y * W + x) * 4);
    const img = join(dir, "long-ellipse.png");
    writeFileSync(img, encode({ width: W, height: H, data }));
    for (const id of ["a1", "a5", "b", "c7", "z9"]) {
      const out = join(dir, `long-ellipse-${id}.png`);
      await renderSpec({ image: img, dpr: 1, style: "sketch", annotations: [{ id, kind: "ellipse", target: { box: [600, 190, 1200, 17] } }] }, { out });
      const o = decode(readFileSync(out));
      let changed = 0;
      for (let y = 190; y < 207; y++) for (let x = 600; x < 1800; x += 2) if (o.data[(y * W + x) * 4] > 60) changed++;
      expect(changed, id).toBe(0);
    }
  });

  it("passes a spotlight without its outline: the shade is its ink", async () => {
    for (const style of ["clean", "sketch"]) {
      const r = await renderSpec({ image: png, dpr: 2, style, annotations: [{ id: "s", kind: "spotlight", outline: false, target: { css: FIXTURE_CSS.boxes.create } }] }, { out: join(dir, `spot-nooutline-${style}.png`) });
      expect(r.ok, style).toBe(true);
    }
  });

  it("fails the proof when a mark draws nothing on the figure", async () => {
    // An underline below a target at the very bottom edge has no canvas left to land on.
    const W = 2560, H = 400, data = Buffer.alloc(W * H * 4, 255);
    const img = join(dir, "bottom.png");
    writeFileSync(img, encode({ width: W, height: H, data }));
    const r = await renderSpec({ image: img, dpr: 1, annotations: [{ id: "a1", kind: "underline", target: { box: [1200, 383, 105, 17] } }] }, { out: join(dir, "bottom-out.png") }).catch((e) => e);
    expect(r.code).toBe("PROOF_FAILED");
    expect(String(r.message)).toMatch(/no ink on the figure from "a1"/);
  });

  it("fits a strong magnifier in the frame margin it reserved", async () => {
    const W = 2560, H = 900, data = Buffer.alloc(W * H * 4, 255);
    for (let y = 300; y < 315; y++) for (let x = 600; x < 630; x += 2) data.set([20, 20, 20, 255], (y * W + x) * 4);
    const img = join(dir, "lens-frame.png");
    writeFileSync(img, encode({ width: W, height: H, data }));
    const r = await renderSpec({ image: img, dpr: 1, layout: "frame", annotations: [{ id: "m", kind: "magnify", factor: 6, target: { box: [600, 300, 30, 15] } }] }, { out: join(dir, "lens-frame-out.png") });
    expect(r.ok).toBe(true);
  });

  it("keeps a long sketch box's bow off its target", async () => {
    const W = 2560, H = 400, data = Buffer.alloc(W * H * 4, 255);
    for (let y = 190; y < 207; y++) for (let x = 600; x < 1800; x += 2) data.set([20, 20, 20, 255], (y * W + x) * 4);
    const img = join(dir, "long-sketch.png");
    writeFileSync(img, encode({ width: W, height: H, data }));
    for (const id of ["a1", "b", "c7"]) {
      const out = join(dir, `long-sketch-${id}.png`);
      await renderSpec({ image: img, dpr: 1, style: "sketch", annotations: [{ id, kind: "box", target: { box: [600, 190, 1200, 17] } }] }, { out });
      const o = decode(readFileSync(out));
      let changed = 0;
      for (let y = 190; y < 207; y++) for (let x = 600; x < 1800; x += 2) if (o.data[(y * W + x) * 4] > 60) changed++;
      expect(changed, id).toBe(0);
    }
  });

  it("keeps a box stroke off a target at the very top edge", async () => {
    // A nav item at y = 6: the canvas-edge clamp used to push the stroke back onto its text.
    const W = 1280, H = 300, data = Buffer.alloc(W * H * 4, 255);
    for (let y = 8; y < 20; y++) for (let x = 604; x < 676; x += 3) data.set([20, 20, 20, 255], (y * W + x) * 4);
    const edge = join(dir, "edge.png");
    writeFileSync(edge, encode({ width: W, height: H, data }));
    const r = await renderSpec({ image: edge, dpr: 1, annotations: [{ id: "n", kind: "box", target: { box: [600, 6, 80, 16] } }] }, { out: join(dir, "edge-out.png") });
    const it = r.internal.layout.items[0];
    const { tokens } = await import("../scripts/lib/tokens.mjs");
    const T = tokens(W, 1);
    expect(it.shape.y).toBeLessThanOrEqual(it.target.y - (T.stroke / 2 + T.halo + T.dpr) + 0.01);
  });

  it("keeps a box stroke outside its target when everything around it is busy", async () => {
    // Noise everywhere: no calm band anywhere, so the old search moved the stroke onto the text.
    const W = 400, H = 300, data = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) { const v = (i * 2654435761) >>> 24; data.set([v, 255 - v, (v * 7) & 255, 255], i * 4); }
    const busy = join(dir, "busy.png");
    writeFileSync(busy, encode({ width: W, height: H, data }));
    const r = await renderSpec({ image: busy, dpr: 2, annotations: [{ id: "b", kind: "box", target: { box: [150, 120, 100, 40] } }] }, { out: join(dir, "busy-out.png") });
    const it = r.internal.layout.items[0];
    expect(it.shape.x).toBeLessThanOrEqual(it.target.x);
    expect(it.shape.y).toBeLessThanOrEqual(it.target.y);
    expect(it.shape.x + it.shape.w).toBeGreaterThanOrEqual(it.target.x + it.target.w);
    expect(it.shape.y + it.shape.h).toBeGreaterThanOrEqual(it.target.y + it.target.h);
  });

  it("renders the fixture in clean style and passes the proof", async () => {
    const r = await renderSpec(spec(BASIC), { out: join(dir, "clean.png") });
    expect(r.ok).toBe(true);
    expect(r.proofs.every((p) => p.ok)).toBe(true);
    expect(readFileSync(join(dir, "clean.png")).length).toBeGreaterThan(1000);
  });

  it("renders the sketch style and passes the proof", async () => {
    const r = await renderSpec(spec(BASIC, { style: "sketch" }), { out: join(dir, "sketch.png") });
    expect(r.proofs.filter((p) => !p.ok)).toEqual([]);
  });

  it("redact fills the grown region with one colour", async () => {
    const r = await renderSpec(spec(BASIC), { out: join(dir, "redact.png") });
    const out = decode(readFileSync(r.output.path));
    const b = fixtureBox("hidden");
    const first = pixelAt(out, b.x, b.y).join();
    for (let y = b.y - 4; y < b.y + b.h + 4; y += 3) {
      for (let x = b.x - 4; x < b.x + b.w + 4; x += 3) expect(pixelAt(out, x, y).join()).toBe(first);
    }
  });

  it("never prints the redacted text and never writes over the input", async () => {
    const r = await renderSpec(spec(BASIC), { out: join(dir, "quiet.png") });
    expect(JSON.stringify(r)).not.toContain(FIXTURE_CSS.hiddenText);
    await expect(renderSpec(spec(BASIC), { out: png })).rejects.toMatchObject({ code: "OVERWRITE_INPUT" });
    const link = join(dir, "alias.png");
    symlinkSync(png, link);
    await expect(renderSpec(spec(BASIC), { out: link })).rejects.toMatchObject({ code: "OVERWRITE_INPUT" });
  });

  it("label never overlaps any target or other label", async () => {
    const many = Object.keys(FIXTURE_CSS.boxes)
      .filter((k) => k !== "hidden")
      .map((k) => ({ id: k, kind: "callout", target: css(k), label: `Label for ${k}` }));
    const r = await renderSpec(spec(many), { out: join(dir, "many.png") });
    const labels = r.annotations.map((a) => a.label_rect).filter(Boolean);
    const targets = r.annotations.map((a) => a.target.px);
    for (const [i, l] of labels.entries()) {
      for (const t of targets) expect(intersects(l, t)).toBe(false);
      for (const [j, m] of labels.entries()) if (i !== j) expect(intersects(l, m)).toBe(false);
    }
  });

  it("leader tip ends just outside the target edge", async () => {
    const r = await renderSpec(spec(BASIC), { out: join(dir, "tip.png") });
    const a = r.annotations.find((x) => x.id === "write");
    const t = a.shape;
    const [x, y] = a.leader.to;
    const dx = Math.max(t.x - x, 0, x - (t.x + t.w));
    const dy = Math.max(t.y - y, 0, y - (t.y + t.h));
    const dist = Math.hypot(dx, dy);
    expect(dist).toBeGreaterThan(2);
    expect(dist).toBeLessThan(20);
  });

  it("refuses a label that has no legal slot, with a hint", async () => {
    const long = "This label is far too long to fit anywhere next to a target that small";
    const crowded = [{ kind: "callout", target: { box: [0, 0, 2200, 1240] }, label: long }];
    await expect(renderSpec(spec(crowded), { out: join(dir, "no.png") })).rejects.toMatchObject({ code: "LABEL_NO_SLOT" });
  });

  it("escapes label markup instead of embedding a file", async () => {
    const r = await renderSpec(spec([{ kind: "callout", target: css("create"), label: '<image href="/etc/hosts"/> & <' }]), { out: join(dir, "esc.png") });
    expect(r.ok).toBe(true);
  });

  it("writes the hand-off JSON with steps and alt text", async () => {
    const r = await renderSpec(spec(BASIC), { out: join(dir, "handoff.png") });
    const side = JSON.parse(readFileSync(join(dir, "handoff.annotated.json"), "utf8"));
    expect(side.output.sha256).toBe(r.output.sha256);
    // Relative paths only: an absolute one would publish the author's home folder.
    expect(side.output.path).toBe("handoff.png");
    expect(JSON.stringify(side)).not.toContain(dir);
    expect(side.steps.map((s) => s.n)).toEqual([1, 2]);
    expect(side.alt_text).toMatch(/2 numbered steps/);
    expect(side.annotations.find((a) => a.id === "create").target.pct[0]).toBeCloseTo(796 / 1100, 3);
  });

  it("sketch output is pixel-identical for the same spec", async () => {
    const a = await renderSpec(spec(BASIC, { style: "sketch" }), { out: join(dir, "s1.png") });
    const b = await renderSpec(spec(BASIC, { style: "sketch" }), { out: join(dir, "s2.png") });
    expect(a.output.pixels_sha256).toBe(b.output.pixels_sha256);
  });

  it("adding a mark does not re-wobble the others", async () => {
    const a = await renderSpec(spec(BASIC.slice(2, 3), { style: "sketch" }), { out: join(dir, "w1.png") });
    const b = await renderSpec(spec([...BASIC.slice(2, 3), { id: "nav", kind: "box", target: css("nav") }], { style: "sketch" }), { out: join(dir, "w2.png") });
    const pa = decode(readFileSync(a.output.path));
    const pb = decode(readFileSync(b.output.path));
    const c = fixtureBox("create");
    for (let y = c.y - 20; y < c.y + c.h + 20; y += 2) {
      for (let x = c.x - 20; x < c.x + c.w + 20; x += 2) expect(pixelAt(pb, x, y).join()).toBe(pixelAt(pa, x, y).join());
    }
  });

  it("crops after drawing and keeps every mark inside", async () => {
    const r = await renderSpec(spec(BASIC.slice(1, 3), { crop: "auto" }), { out: join(dir, "crop.png") });
    expect(r.output.width).toBeLessThan(2200);
    expect(r.proofs.every((p) => p.ok)).toBe(true);
  });

  it("frame layout puts labels in an added margin", async () => {
    const r = await renderSpec(spec(BASIC.slice(1, 2), { layout: "frame" }), { out: join(dir, "frame.png") });
    expect(r.output.width).toBeGreaterThan(2200);
    expect(r.proofs.every((p) => p.ok)).toBe(true);
  });
});

describe("every kind, both styles", () => {
  const KINDS = {
    box: { kind: "box", target: css("create"), n: 3, label: "Save" },
    ellipse: { kind: "ellipse", target: css("name"), label: "Name it" },
    step: { kind: "step", n: 1, target: css("nav") },
    callout: { kind: "callout", target: css("write"), label: "Turn this on", outline: true },
    arrow: { kind: "arrow", from: { point: [1500, 520] }, target: css("ip"), label: "Leave off" },
    highlight: { kind: "highlight", target: { css: [266, 210, 110, 18] } },
    underline: { kind: "underline", target: { css: [260, 337, 128, 16] } },
    spotlight: { kind: "spotlight", targets: [css("create"), css("cancel")] },
    redact: { kind: "redact", target: css("hidden") },
    blur: { kind: "blur", target: { css: [236, 84, 300, 24] }, amount: 4 },
    magnify: { kind: "magnify", target: css("create"), factor: 2 },
    text: { kind: "text", target: { css: [600, 540, 10, 10] }, label: "Free note" },
  };
  for (const style of ["clean", "sketch"]) {
    for (const [name, a] of Object.entries(KINDS)) {
      it(`${name} renders in ${style} and passes the proof`, async () => {
        const r = await renderSpec(spec([{ id: name, ...a }], { style }), { out: join(dir, `kind-${style}-${name}.png`) });
        expect(r.proofs.filter((p) => !p.ok)).toEqual([]);
      });
    }
  }
});

describe("proof falsification", () => {
  it("fails when a redaction is not uniform", async () => {
    const r = await renderSpec(spec(BASIC), { out: join(dir, "mut1.png") });
    const img = decode(readFileSync(r.output.path));
    const b = fixtureBox("hidden");
    const i = ((b.y + 10) * img.width + b.x + 10) * 4;
    img.data[i] ^= 0x40;
    const bad = join(dir, "mut1-bad.png");
    writeFileSync(bad, encode(img));
    const proofs = checkProof({ ...r.internal, outputPath: bad });
    expect(proofs.find((p) => p.name === "redaction_uniform").ok).toBe(false);
  });

  it("fails when a leader ends on the badge instead of the target", async () => {
    const r = await renderSpec(spec([{ id: "s", kind: "step", n: 1, target: css("create"), label: "Then save" }]), { out: join(dir, "mut2.png") });
    const layout = structuredClone(r.internal.layout);
    const item = layout.items.find((x) => x.id === "s");
    item.leader.to = [item.badge.cx, item.badge.cy - item.badge.r - 2];
    const proofs = checkProof({ ...r.internal, layout });
    expect(proofs.find((p) => p.name === "leader_tips").ok).toBe(false);
  });

  it("fails when a pixel outside every mark changed", async () => {
    const r = await renderSpec(spec(BASIC), { out: join(dir, "mut3.png") });
    const img = decode(readFileSync(r.output.path));
    const i = (1200 * img.width + 100) * 4;
    img.data[i] ^= 0x10;
    const bad = join(dir, "mut3-bad.png");
    writeFileSync(bad, encode(img));
    const proofs = checkProof({ ...r.internal, outputPath: bad });
    expect(proofs.find((p) => p.name === "untouched_outside_marks").ok).toBe(false);
  });
});

describe("default output", () => {
  it("is named after the spec and written beside it", async () => {
    const specPath = join(dir, "step-two.json");
    const r = await renderSpec(spec(BASIC), { specPath, specDir: dir });
    expect(r.output.path).toBe(join(dir, "step-two.annotated.png"));
  });
});

describe("output folders", () => {
  it("creates a missing output folder instead of crashing", async () => {
    const r = await renderSpec(spec(BASIC), { out: join(dir, "new", "deeper", "fig.png") });
    expect(r.ok).toBe(true);
  });
});

