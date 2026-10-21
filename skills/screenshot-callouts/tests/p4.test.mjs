// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// capture, from-review, sheet, grid and batch (slice P4).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { fixtureImage, FIXTURE_CSS } from "../scripts/lib/fixture.mjs";
import { decode, encode } from "../scripts/lib/png.mjs";
import { fromReviewCommand, specFromReview } from "../scripts/lib/review.mjs";
import { gridCommand, sheetCommand } from "../scripts/lib/sheet.mjs";
import { batchCommand } from "../scripts/lib/batch.mjs";
import { captureCommand } from "../scripts/lib/capture.mjs";
import { renderSpec } from "../scripts/lib/render.mjs";

let dir;
let png;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sa-p4-"));
  png = join(dir, "settings.png");
  writeFileSync(png, encode(await fixtureImage(2)));
});

describe("from-review", () => {
  const batch = {
    status: "feedback",
    pages: [
      {
        kind: "media",
        name: "settings.png",
        source: "/abs/settings.png",
        marks: [
          { number: 1, tool: "ellipse", note: "this toggle", box: { x: 0.78, y: 0.53, w: 0.04, h: 0.04 } },
          { number: 2, tool: "rect", note: "", box: { x: 0.72, y: 0.68, w: 0.1, h: 0.06 } },
          { number: 3, tool: "arrow", note: "click here", box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
        ],
      },
    ],
  };
  it("maps ellipse, rect and arrow marks onto the same fractional boxes", () => {
    const { spec, warnings } = specFromReview(batch, {});
    expect(spec.image).toBe("/abs/settings.png");
    expect(spec.annotations.map((a) => a.kind)).toEqual(["ellipse", "box", "box"]);
    expect(spec.annotations[0]).toMatchObject({ target: { pct: [0.78, 0.53, 0.04, 0.04] }, label: "this toggle" });
    expect(spec.annotations[1].label).toBeUndefined();
    expect(warnings.join(" ")).toMatch(/direction/);
  });
  it("writes no absolute path into a spec file, and never overwrites the receipt's screenshot", () => {
    const receipt = join(dir, "receipt.json");
    writeFileSync(receipt, JSON.stringify({ ...batch, pages: [{ ...batch.pages[0], source: png }] }));
    const r = fromReviewCommand(receipt, { out: join(dir, "from-review.json") });
    expect(r.spec.image).toBe("settings.png");
    expect(r.spec.note).not.toMatch(/session/);
    expect(() => fromReviewCommand(receipt, { out: png })).toThrow(/OVERWRITE_INPUT/);
    const sub = join(dir, "specs", "fig.json");
    const r2 = fromReviewCommand(receipt, { out: sub, image: png });
    expect(r2.spec.image).toBe("settings.png");
    expect(r2.warnings.join(" ")).toMatch(/outside the spec's folder/);
  });
});

describe("grid and sheet", () => {
  it("draws a labelled coordinate grid at the image size", async () => {
    const out = join(dir, "grid.png");
    const r = await gridCommand(png, { out, step: "200" });
    const g = decode(readFileSync(out));
    expect([g.width, g.height]).toEqual([2200, 1240]);
    expect(r.lines).toBeGreaterThan(10);
  });

  it("lays out a contact sheet with one zoom per target", async () => {
    const a = await renderSpec({ image: png, dpr: 2, annotations: [{ kind: "box", target: { css: FIXTURE_CSS.boxes.create } }, { kind: "callout", target: { css: FIXTURE_CSS.boxes.write }, label: "On" }] }, { out: join(dir, "s1.png") });
    const out = join(dir, "sheet.png");
    const r = await sheetCommand([a.sidecar], { out, zoom: true });
    expect(r.figures).toBe(1);
    expect(r.zooms).toBe(2);
    expect(existsSync(out)).toBe(true);
  });

  it("keeps a thin image's thumbnail small, so the sheet stays small", async () => {
    // Scaled to the sheet's width, a 1 x 20,000 strip would make a sheet 22 million pixels tall.
    writeFileSync(join(dir, "thin.png"), encode({ width: 1, height: 20_000, data: Buffer.alloc(80_000, 255) }));
    writeFileSync(join(dir, "thin.annotated.json"), JSON.stringify({ output: { path: "thin.png" }, annotations: [] }));
    const out = join(dir, "thin-sheet.png");
    await sheetCommand([join(dir, "thin.annotated.json")], { out });
    expect(decode(readFileSync(out)).height).toBeLessThan(2000);
  });
});

describe("batch", () => {
  it("renders several specs with shared defaults and one sheet", async () => {
    const s1 = join(dir, "b1.json");
    const s2 = join(dir, "b2.json");
    writeFileSync(s1, JSON.stringify({ image: png, annotations: [{ kind: "box", target: { css: FIXTURE_CSS.boxes.create } }], out: join(dir, "b1.png") }));
    writeFileSync(s2, JSON.stringify({ image: png, annotations: [{ kind: "box", target: { css: FIXTURE_CSS.boxes.nav } }], out: join(dir, "b2.png") }));
    const manifest = join(dir, "m.json");
    writeFileSync(manifest, JSON.stringify({ defaults: { dpr: 2, style: "sketch" }, specs: [s1, s2], sheet: join(dir, "batch-sheet.png") }));
    const r = await batchCommand(manifest, {});
    expect(r.ok).toBe(true);
    expect(r.rendered.map((x) => x.style)).toEqual(["sketch", "sketch"]);
    expect(existsSync(join(dir, "batch-sheet.png"))).toBe(true);
  });
  it("refuses a manifest above 200 specs before planning any of them", async () => {
    const m = join(dir, "huge-manifest.json");
    writeFileSync(m, JSON.stringify({ specs: Array.from({ length: 201 }, (_, i) => ({ spec: "a.json", out: `o${i}.png` })) }));
    await expect(batchCommand(m, {})).rejects.toMatchObject({ code: "BATCH_TOO_LARGE" });
  });

  it("refuses a later entry that would overwrite an earlier entry's output", async () => {
    const s1 = join(dir, "c1.json");
    const s2 = join(dir, "c2.json");
    const box = (k) => [{ kind: "box", target: { css: FIXTURE_CSS.boxes[k] } }];
    writeFileSync(s1, JSON.stringify({ image: png, dpr: 2, annotations: box("create"), out: "same.png" }));
    writeFileSync(s2, JSON.stringify({ image: png, dpr: 2, annotations: box("nav"), out: "same.png" }));
    const manifest = join(dir, "m2.json");
    writeFileSync(manifest, JSON.stringify({ specs: [s1, s2] }));
    // Refused as a whole, before the first entry writes anything.
    const bad = join(dir, "m3.json");
    writeFileSync(bad, JSON.stringify({ specs: [s1], contact: "x.png" }));
    await expect(batchCommand(bad, {})).rejects.toMatchObject({ code: "UNKNOWN_FIELD" });
    const broken = join(dir, "c3.json");
    writeFileSync(broken, JSON.stringify({ image: png, annotations: [{ kind: "boxx", target: { box: [0, 0, 1, 1] } }] }));
    const named = join(dir, "m4.json");
    writeFileSync(named, JSON.stringify({ specs: [broken] }));
    await expect(batchCommand(named, {})).rejects.toMatchObject({ path: expect.stringMatching(/^\/specs\/0\/annotations/) });
    const emptyEntry = join(dir, "m5.json");
    writeFileSync(emptyEntry, JSON.stringify({ specs: [{ out: "a.png" }] }));
    await expect(batchCommand(emptyEntry, {})).rejects.toMatchObject({ path: "/specs/0" });
    await expect(batchCommand(manifest, {})).rejects.toMatchObject({ code: "OUTPUT_COLLISION" });
    expect(existsSync(join(dir, "same.png"))).toBe(false);
  });
});

const PAGE = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#f5f6f8;font:14px sans-serif}
.el{position:absolute;display:flex;align-items:center;justify-content:center}
#create{left:796px;top:421px;width:104px;height:33px;background:#2350d8;color:#fff;border-radius:6px}
#cancel{left:690px;top:421px;width:96px;height:33px;background:#fff;border:1px solid #2350d8;box-sizing:border-box}
#hidden{left:260px;top:270px;width:640px;height:34px;background:#eee}
.dup{left:10px;width:50px;height:20px;background:#ddd}
#below{left:20px;top:1400px;width:80px;height:30px;background:#fc0}
#covered{left:400px;top:500px;width:80px;height:30px;background:#0cf}
#cover{left:380px;top:480px;width:140px;height:80px;background:#333;z-index:2}
</style>
<div class="el" id="create">Create key</div><div class="el" id="cancel">Cancel</div>
<div class="el" id="hidden">PLACEHOLDER-VALUE-0000-1111</div>
<div class="el dup" style="top:10px">a</div><div class="el dup" style="top:40px">b</div>
<div class="el" id="gone" style="display:none">Gone</div><div id="host" style="position:absolute;left:300px;top:40px"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<button id="inner" style="width:90px;height:30px">Inner</button>';</script><div id="panel" style="position:absolute;left:20px;top:200px;width:200px;height:60px;overflow:auto"><div id="p1" style="height:30px;background:#eee">one</div><div style="height:400px"></div><div id="p2" style="height:30px;background:#ddd">two</div></div><div class="el" id="spin" style="left:600px;top:500px;width:40px;height:40px;background:#c00;animation:sp 1s linear infinite">S</div><style>@keyframes sp{to{transform:rotate(360deg)}}</style><div class="el" id="below">Below</div><div class="el" id="covered">Hidden</div><div class="el" id="cover"></div>`;

describe.runIf(process.env.SA_BROWSER_TESTS !== "0")("capture (needs a local Chrome or Edge)", () => {
  let url;
  beforeAll(() => {
    const p = join(dir, "page.html");
    writeFileSync(p, PAGE);
    url = pathToFileURL(p).href;
  });
  const specWith = (annotations) => {
    const p = join(dir, `cap-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify({ image: "shot.png", annotations }));
    return p;
  };

  it("refuses no visible target on common layouts, and redacts text that overflows its box", async () => {
    // html,body at 100% height with body overflow-x hidden: body's overflow belongs to the viewport.
    const page2 = `<!doctype html><meta charset="utf-8"><style>html,body{height:100%;margin:0}body{overflow-x:hidden;font:14px sans-serif}
#low{position:absolute;left:20px;top:1200px;width:120px;height:30px;background:#2350d8;color:#fff}
#fixed{position:fixed;right:10px;bottom:10px;width:80px;height:24px;background:#0a0}
#card{width:200px;height:60px;overflow:auto;margin-top:40px}#pop{position:absolute;left:420px;top:160px;width:90px;height:30px;background:#fc0}
#cell{width:60px;white-space:nowrap;overflow:visible;margin:20px;font:16px monospace}</style>
<div id="card"><div style="height:200px">x</div><div id="pop">Menu</div></div><div id="fixed">Live</div><div id="low">Low</div>
<div id="cell">PLACEHOLDER-OVERFLOWING-TOKEN-0000</div>
<div id="ell" style="position:absolute;left:980px;top:100px;width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:16px monospace">PLACEHOLDER-CLIPPED-TOKEN-0000-1111-2222</div>
<sec-field id="sf" style="display:block;width:60px;position:absolute;left:20px;top:420px"></sec-field>
<button id="off" style="position:absolute;left:300px;top:420px;width:90px;height:30px;pointer-events:none">Off</button>
<div id="side" style="position:fixed;left:700px;top:200px;width:150px;height:60px;overflow:auto"><div id="f1" style="height:30px;background:#eee">one</div><div style="height:400px"></div><div id="f2" style="height:30px">two</div></div>
<div id="axis" style="position:absolute;left:20px;top:480px;width:60px;height:20px;white-space:nowrap;overflow-x:visible;overflow-y:clip;font:16px monospace">PLACEHOLDER-AXIS-TOKEN-0000-1111</div>
<div style="position:absolute;left:20px;top:540px;width:400px;height:40px"><div id="esc" style="width:60px;height:20px;overflow:hidden"><span style="position:absolute;left:0;top:0;white-space:nowrap;font:16px monospace">PLACEHOLDER-ESCAPED-TOKEN-0000</span></div></div>
<div style="position:absolute;left:500px;top:400px;width:300px;height:120px;overflow:hidden"><nav id="drawer" style="position:absolute;left:0;top:0;width:200px;height:100px;transform:translateX(-100%);background:#eee">Drawer</nav></div>
<div style="position:absolute;left:820px;top:400px;width:120px;height:60px;overflow:hidden"><span id="badge" style="position:absolute;left:10px;top:-40px;width:40px;height:20px;background:#c00">9</span></div>
<style>.veil{position:relative}.veil::after{content:"";position:absolute;inset:0;background:#fff}</style><div class="veil" style="position:absolute;left:820px;top:480px;width:120px;height:40px"><button id="veiled" style="width:100px;height:30px">Go</button></div>
<x-cell id="xc" style="display:block;position:absolute;left:560px;top:300px">PLACEHOLDER-SLOTTED-TOKEN-0000-1111</x-cell>
<p style="position:absolute;left:600px;top:560px;width:180px;font:14px sans-serif;margin:0">Read the guide about <a id="wrap" href="#">API keys and their rotation</a> first.</p>
<script>customElements.define("x-cell", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<div class="v" style="width:60px;white-space:nowrap;font:16px monospace"><slot></slot></div>'; } });</script>
<div id="vis" style="position:absolute;left:300px;top:20px;width:60px;visibility:visible"><span style="visibility:visible;white-space:nowrap;font:16px monospace">PLACEHOLDER-VISIBLE-TOKEN-0000</span></div>
<div id="ghost" style="position:absolute;left:300px;top:200px;width:90px;height:30px;background:#c00;opacity:0;pointer-events:none">Menu</div>
<div style="position:absolute;left:180px;top:120px;width:120px;height:40px"><button id="scrimmed" style="width:100px;height:30px">Save</button><div style="position:absolute;inset:0;background:#fff;pointer-events:none"></div></div>
<div id="pop-host" style="position:absolute;left:20px;top:330px;width:40px;height:20px"><div id="pp" popover="manual" style="position:fixed;left:200px;top:340px;margin:0;font:16px monospace">PLACEHOLDER-POPOVER-TOKEN</div></div>
<div id="obs" style="position:absolute;left:20px;top:360px;width:60px;white-space:nowrap;font:16px monospace">PLACEHOLDER-OBSERVED-TOKEN-0000</div>
<div style="position:absolute;left:900px;top:560px;width:80px;height:40px"><canvas id="cv" width="80" height="40"></canvas><div id="overcv" style="position:absolute;left:0;top:0;width:80px;height:40px;opacity:0">X</div></div>
<button id="nostyle" style="position:absolute;left:180px;top:20px;width:80px;height:24px">Plain</button>
<script>document.getElementById("pp").showPopover();
new MutationObserver(() => { const e = document.getElementById("obs"); if (e.style.opacity === "0") e.style.removeProperty("opacity"); }).observe(document.getElementById("obs"), { attributes: true });
(function f(n) { const g = document.getElementById("cv").getContext("2d"); g.fillStyle = "#" + ((n * 99991) % 0xffffff).toString(16).padStart(6, "0"); g.fillRect(0, 0, 80, 40); requestAnimationFrame(() => f(n + 1)); })(1);
document.getElementById("nostyle").removeAttribute("style"); document.getElementById("nostyle").setAttribute("data-x", "1");</script>
<pop-host id="ph" style="display:block;position:absolute;left:20px;top:300px;width:30px;height:16px;background:#ddd"></pop-host>
<script>Object.defineProperty(window, "__scProbe", { configurable: true, get: () => [], set: () => {} });
customElements.define("pop-host", class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: "open" }); r.innerHTML = '<div popover="manual" style="position:fixed;left:200px;top:300px;margin:0;font:16px monospace">PLACEHOLDER-SHADOW-POPOVER</div>'; r.firstElementChild.showPopover(); } });</script>
<closed-pop id="cp" style="display:block;position:absolute;left:400px;top:20px;width:30px;height:16px;background:#ddd"></closed-pop>
<script>customElements.define("closed-pop", class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: "closed" }); r.innerHTML = '<div popover="manual" style="position:fixed;left:450px;top:60px;margin:0;font:16px monospace">PLACEHOLDER-CLOSED-POPOVER</div>'; r.firstElementChild.showPopover(); } });</script>
<div id="anim" style="position:absolute;left:600px;top:240px;width:20px;height:20px;overflow:visible"><svg width="240" height="20" style="overflow:visible"><rect width="240" height="20" fill="#000"><animate attributeName="fill" values="#000;#333;#000" dur="0.3s" repeatCount="indefinite"/></rect></svg></div>
<svg style="position:absolute;left:1000px;top:560px" width="40" height="40"><rect width="40" height="40" fill="#0a0"><animate attributeName="fill" values="#0a0;#060;#0a0" dur="0.25s" repeatCount="indefinite"/></rect></svg>
<script>customElements.define("sec-field", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<span style="white-space:nowrap;font:16px monospace">PLACEHOLDER-SHADOW-TOKEN-0000</span>'; } });</script>`;
    const p2 = join(dir, "page2.html");
    writeFileSync(p2, page2);
    const url2 = pathToFileURL(p2).href;
    for (const [id, sel, full] of [["low", "#low", true], ["fixed", "#fixed", false], ["pop", "#pop", false]]) {
      const r = await captureCommand({ url: url2, spec: specWith([{ id, kind: "box", target: { selector: sel } }]), viewport: "1100x620", dpr: "2", ...(full ? { "full-page": true } : {}), out: join(dir, `lay-${id}.png`) });
      expect(r.ok, id).toBe(true);
    }
    const r = await captureCommand({ url: url2, spec: specWith([{ id: "k", kind: "redact", target: { selector: "#cell" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "overflow.png") });
    const box = JSON.parse(readFileSync(r.refs, "utf8")).refs.s1.box;
    expect(box.width).toBeGreaterThan(200); // the ink, not the 60 px cell
    // Text an ellipsis cell clips away is covered too (never less than what paints), and the
    // redaction is clamped to the frame instead of being refused at the right edge.
    const re = await captureCommand({ url: url2, spec: specWith([{ id: "e", kind: "redact", target: { selector: "#ell" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "ell.png") });
    const eb = JSON.parse(readFileSync(re.refs, "utf8")).refs.s1.box;
    expect(eb.width).toBeGreaterThanOrEqual(100);
    expect(eb.x + eb.width).toBeLessThanOrEqual(1100);
    // Text inside a web component's shadow root counts as the host's ink.
    const rs = await captureCommand({ url: url2, spec: specWith([{ id: "s", kind: "redact", target: { selector: "#sf" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "sf.png") });
    expect(JSON.parse(readFileSync(rs.refs, "utf8")).refs.s1.box.width).toBeGreaterThan(200);
    // A box that clips only one axis leaves the other axis's overflow visible, so it is covered.
    const ra = await captureCommand({ url: url2, spec: specWith([{ id: "x", kind: "redact", target: { selector: "#axis" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "axis.png") });
    expect(JSON.parse(readFileSync(ra.refs, "utf8")).refs.s1.box.width).toBeGreaterThan(200);
    // An absolute child escapes a static clipping box: its whole text is covered.
    const rx = await captureCommand({ url: url2, spec: specWith([{ id: "z", kind: "redact", target: { selector: "#esc" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "esc.png") });
    expect(JSON.parse(readFileSync(rx.refs, "utf8")).refs.s1.box.width).toBeGreaterThan(200);
    // Slotted light-DOM text that overflows a shadow wrapper is measured from pixels, so it is covered.
    const rsl = await captureCommand({ url: url2, spec: specWith([{ id: "sl", kind: "redact", target: { selector: "x-cell .v" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "slot.png") });
    expect(JSON.parse(readFileSync(rsl.refs, "utf8")).refs.s1.box.width).toBeGreaterThan(200);
    // A link that wraps across two lines is not "covered" by its own paragraph.
    expect((await captureCommand({ url: url2, spec: specWith([{ id: "w", kind: "box", target: { selector: "#wrap" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "wrap.png") })).ok).toBe(true);
    // A descendant that insists on visibility:visible is still found: the probe uses opacity.
    const rv = await captureCommand({ url: url2, spec: specWith([{ id: "v", kind: "redact", target: { selector: "#vis" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "vis.png") });
    expect(JSON.parse(readFileSync(rv.refs, "utf8")).refs.s1.box.width).toBeGreaterThan(200);
    // A top-layer popover inside a redaction ignores its ancestor's opacity: it is faded on its own.
    const rp = await captureCommand({ url: url2, spec: specWith([{ id: "p", kind: "redact", target: { selector: "#pop-host" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "popover.png") });
    expect(JSON.parse(readFileSync(rp.refs, "utf8")).refs.s1.box.width).toBeGreaterThan(200);
    // A page observer cannot undo the probe: page scripts are frozen while it runs.
    const ro = await captureCommand({ url: url2, spec: specWith([{ id: "o", kind: "redact", target: { selector: "#obs" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "observed.png") });
    expect(JSON.parse(readFileSync(ro.refs, "utf8")).refs.s1.box.width).toBeGreaterThan(200);
    // A hidden target over an animating canvas is still refused: the canvas is frozen too.
    await expect(captureCommand({ url: url2, spec: specWith([{ id: "c", kind: "box", target: { selector: "#overcv" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "overcv.png") })).rejects.toMatchObject({ code: "TARGET_COVERED" });
    // A selector the probe's own style change would break still restores and passes.
    expect((await captureCommand({ url: url2, spec: specWith([{ id: "n", kind: "box", target: { selector: "#nostyle:not([style])" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "nostyle.png") })).ok).toBe(true);
    // A redaction and a box on the same field: the box is not "covered" by the redaction's mask.
    const pair = specWith([{ id: "k", kind: "redact", target: { selector: "#cell" } }, { id: "kb", kind: "callout", target: { selector: "#cell" }, label: "Your key goes here" }]);
    const rpair = await captureCommand({ url: url2, spec: pair, viewport: "1100x620", dpr: "2", out: join(dir, "pair.png") });
    expect(rpair.ok).toBe(true);
    // The mark on the redacted field keeps its box only: its selector would say where the secret sat.
    expect(readFileSync(rpair.refs, "utf8")).not.toContain("#cell");
    // A mark beside a redaction, inside its pad: the fill covers it, so its selector goes too.
    const padded = specWith([{ id: "k", kind: "redact", target: { selector: "#obs", pad: 60 } }, { id: "kb", kind: "box", target: { selector: "#sf" } }]);
    const rpad = await captureCommand({ url: url2, spec: padded, viewport: "1100x620", dpr: "2", out: join(dir, "padded.png") });
    expect(readFileSync(rpad.refs, "utf8")).not.toContain("#sf");
    // A popover inside a shadow host's OWN shadow root is faded with the host, and a page global
    // the probe never uses cannot fool it.
    const rph = await captureCommand({ url: url2, spec: specWith([{ id: "ph", kind: "redact", target: { selector: "#ph" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "pophost.png") });
    expect(JSON.parse(readFileSync(rph.refs, "utf8")).refs.s1.box.width).toBeGreaterThan(150);
    // A popover inside a CLOSED shadow root is found through the browser's top-layer list.
    const rcp = await captureCommand({ url: url2, spec: specWith([{ id: "cp", kind: "redact", target: { selector: "#cp" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "closedpop.png") });
    const cpb = JSON.parse(readFileSync(rcp.refs, "utf8")).refs.s1.box;
    expect(cpb.x + cpb.width).toBeGreaterThan(600);
    // An animated child that overflows its redaction is the element's ink; animation elsewhere
    // (the green square far away) does not stretch the redaction.
    const ran = await captureCommand({ url: url2, spec: specWith([{ id: "an", kind: "redact", target: { selector: "#anim" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "anim.png") });
    const anb = JSON.parse(readFileSync(ran.refs, "utf8")).refs.s1.box;
    expect(anb.width).toBeGreaterThan(200);
    expect(anb.x + anb.width).toBeLessThan(1000);
    // A pointer-events:none control is not "covered".
    expect((await captureCommand({ url: url2, spec: specWith([{ id: "o", kind: "box", target: { selector: "#off" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "off-pe.png") })).ok).toBe(true);
    // A target that is clipped away or under its ancestor's veil is refused, never accepted.
    for (const sel of ["#drawer", "#badge", "#veiled", "#ghost", "#scrimmed"]) {
      await expect(captureCommand({ url: url2, spec: specWith([{ id: "h", kind: "box", target: { selector: sel } }]), viewport: "1100x620", dpr: "2", out: join(dir, `hid-${sel.slice(1)}.png`) }), sel).rejects.toMatchObject({ code: expect.stringMatching(/TARGET_COVERED|TARGET_OFF_FRAME/) });
    }
    // A fixed scroll panel clips its own content, in a full-page shot too.
    const fixedPanel = specWith([{ id: "a", kind: "box", target: { selector: "#f1" } }, { id: "b", kind: "box", target: { selector: "#f2" } }]);
    await expect(captureCommand({ url: url2, spec: fixedPanel, viewport: "1100x620", dpr: "2", "full-page": true, out: join(dir, "fixedpanel.png") })).rejects.toMatchObject({ code: expect.stringMatching(/TARGET_OFF_FRAME|TARGET_COVERED/) });
  }, 300_000); // about thirty captures in one test

  it("measures under a strict CSP, through an opacity transition, and frames a sparse crop", async () => {
    // style-src without 'unsafe-inline': setAttribute("style") is refused, the CSSOM is not.
    const page3 = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="style-src 'self'">
<body><main id="panel"><p id="tp">Plain text paragraph that is the only content of a big panel.</p><button id="tb">Save</button></main></body>`;
    const p3 = join(dir, "page3.html");
    writeFileSync(p3, page3);
    const url3 = pathToFileURL(p3).href;
    const spec3 = specWith([{ id: "b", kind: "box", target: { selector: "#tb" } }, { id: "k", kind: "redact", target: { selector: "#tp" } }]);
    const r = await captureCommand({ url: url3, spec: spec3, viewport: "1100x620", dpr: "2", out: join(dir, "csp.png") });
    expect(r.ok).toBe(true);
    const crop = join(dir, "crop3.json");
    writeFileSync(crop, JSON.stringify({ image: "x.png", crop: { selector: "#panel", pad: 40 }, annotations: [{ id: "b", kind: "box", target: { selector: "#tb" } }] }));
    expect((await captureCommand({ url: url3, spec: crop, viewport: "1100x620", dpr: "2", out: join(dir, "crop3.png") })).ok).toBe(true);
  }, 120_000);

  it("refuses a card under a banner that leaves a strip, and clears a banner with --click", async () => {
    const page5 = `<!doctype html><meta charset="utf-8"><style>#card{position:absolute;left:40px;top:40px;width:600px;height:400px;background:#2350d8}
#banner{position:fixed;left:0;top:42px;width:100%;height:600px;background:#fff;z-index:9}#ok{margin:20px}</style>
<div id="card">Card</div><div id="banner"><button id="ok" onclick="this.parentNode.remove()">Accept</button></div>`;
    const p5 = join(dir, "page5.html");
    writeFileSync(p5, page5);
    const url5 = pathToFileURL(p5).href;
    const card = specWith([{ id: "c", kind: "box", target: { selector: "#card" } }]);
    await expect(captureCommand({ url: url5, spec: card, viewport: "1100x620", dpr: "2", out: join(dir, "strip.png") })).rejects.toMatchObject({ code: "TARGET_COVERED" });
    expect((await captureCommand({ url: url5, spec: card, viewport: "1100x620", dpr: "2", click: "#ok", out: join(dir, "clicked.png") })).ok).toBe(true);
    // A wider strip (15% of the card) is refused too: a solid patch that fills under 60% of the box.
    const page7 = `<!doctype html><meta charset="utf-8"><style>#card{position:absolute;left:40px;top:40px;width:600px;height:400px;background:#2350d8}
#banner{position:fixed;left:0;top:100px;width:100%;height:520px;background:#fff;z-index:9}</style>
<div id="card">Card</div><div id="banner"><button class="ok">Accept</button><button class="ok">Accept</button></div>`;
    const p7 = join(dir, "page7.html");
    writeFileSync(p7, page7);
    const url7 = pathToFileURL(p7).href;
    await expect(captureCommand({ url: url7, spec: card, viewport: "1100x620", dpr: "2", out: join(dir, "strip15.png") })).rejects.toMatchObject({ code: "TARGET_COVERED" });
    // Content smaller than its box with nothing on top (an image in a wide wrapper) is shown.
    const page8 = `<!doctype html><meta charset="utf-8"><div id="wrap" style="position:absolute;left:20px;top:20px;width:1000px;height:300px"><div style="width:300px;height:200px;background:#2350d8"></div></div>
<div id="later" style="display:none;position:fixed;inset:0;background:#fff"><button id="go" onclick="this.parentNode.remove()">OK</button></div>
<div style="height:30000px"></div><script>setTimeout(() => (document.getElementById("later").style.display = "block"), 600);</script>`;
    const p8 = join(dir, "page8.html");
    writeFileSync(p8, page8);
    const url8 = pathToFileURL(p8).href;
    const wrap = specWith([{ id: "w", kind: "box", target: { selector: "#wrap" } }]);
    // A banner shown 600 ms after load is waited for, then clicked.
    expect((await captureCommand({ url: url8, spec: wrap, viewport: "1100x620", dpr: "2", click: "#go", out: join(dir, "wrap8.png") })).ok).toBe(true);
    // A full-page shot above the pixel cap is refused before any shot, with capture fixes.
    await expect(captureCommand({ url: url8, spec: wrap, viewport: "1100x620", dpr: "2", "full-page": true, click: "#go", out: join(dir, "huge.png") })).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
    // A scroll-spy rewrites the URL hash as the tool scrolls: the same document, so it captures.
    const page10 = `<!doctype html><meta charset="utf-8"><div style="height:1400px"></div><div id="low" style="width:200px;height:60px;background:#2350d8">Low</div><div style="height:400px"></div>
<script>addEventListener("scroll", () => history.replaceState(null, "", "#y" + Math.round(scrollY)));</script>`;
    const p10 = join(dir, "page10.html");
    writeFileSync(p10, page10);
    expect((await captureCommand({ url: pathToFileURL(p10).href, spec: specWith([{ id: "l", kind: "box", target: { selector: "#low" } }]), viewport: "1100x620", dpr: "2", "full-page": true, out: join(dir, "spy.png") })).ok).toBe(true);
    // A page that opens itself in a loop: every window it opens is closed at once.
    const page11 = `<!doctype html><meta charset="utf-8"><div id="card" style="position:absolute;left:40px;top:40px;width:300px;height:200px;background:#2350d8">Card</div>
<script>setInterval(() => window.open(location.href), 20);</script>`;
    const p11 = join(dir, "page11.html");
    writeFileSync(p11, page11);
    const t0 = Date.now();
    expect((await captureCommand({ url: pathToFileURL(p11).href, spec: card, viewport: "1100x620", dpr: "2", wait: "1500", out: join(dir, "popups.png") })).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(60_000);
    // A consent manager that reloads after Accept: the click waits for the new page and measures it.
    const page9 = `<!doctype html><meta charset="utf-8"><div id="card" style="position:absolute;left:40px;top:40px;width:300px;height:200px;background:#2350d8">Card</div>
<script>if (!sessionStorage.ok) document.write('<div id="b" style="position:fixed;inset:0;background:#fff"><button id="acc" onclick="sessionStorage.ok=1;setTimeout(()=>location.reload(),300)">Accept</button></div>');</script>`;
    const p9 = join(dir, "page9.html");
    writeFileSync(p9, page9);
    expect((await captureCommand({ url: pathToFileURL(p9).href, spec: card, viewport: "1100x620", dpr: "2", click: "#acc", out: join(dir, "reload.png") })).ok).toBe(true);
    // --click refuses a selector with two visible matches instead of clicking the first.
    await expect(captureCommand({ url: url7, spec: card, viewport: "1100x620", dpr: "2", click: ".ok", out: join(dir, "click2.png") })).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });
  }, 240_000); // about a dozen captures in one test

  it("covers translucent overflow over an animation, and a popover slotted into the target", async () => {
    const page6 = `<!doctype html><meta charset="utf-8"><style>body{margin:0}</style>
<svg style="position:absolute;left:0;top:90px" width="700" height="60"><rect width="700" height="60" fill="#468"><animate attributeName="fill" values="#468;#579;#468" dur="0.3s" repeatCount="indefinite"/></rect></svg>
<div id="tr" style="position:absolute;left:20px;top:110px;width:60px;white-space:nowrap;color:rgba(255,255,255,.5);font:16px monospace">PLACEHOLDER-TRANSLUCENT-TOKEN-0000</div>
<slot-wrap id="sw" style="display:block;position:absolute;left:20px;top:300px"><div id="sp" popover="manual" style="position:fixed;left:700px;top:20px;margin:0;font:16px monospace">PLACEHOLDER-SLOTTED-POPOVER</div></slot-wrap>
<script>customElements.define("slot-wrap", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<div class="w" style="width:40px;height:16px;background:#ddd"><slot></slot></div>'; } });
document.getElementById("sp").showPopover();</script>`;
    const p6 = join(dir, "page6.html");
    writeFileSync(p6, page6);
    const url6 = pathToFileURL(p6).href;
    const rt = await captureCommand({ url: url6, spec: specWith([{ id: "t", kind: "redact", target: { selector: "#tr" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "translucent.png") });
    expect(JSON.parse(readFileSync(rt.refs, "utf8")).refs.s1.box.width).toBeGreaterThan(200);
    const rw = await captureCommand({ url: url6, spec: specWith([{ id: "w", kind: "redact", target: { selector: "slot-wrap .w" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "slotpop.png") });
    const wb = JSON.parse(readFileSync(rw.refs, "utf8")).refs.s1.box;
    expect(wb.x + wb.width).toBeGreaterThan(900);
  }, 120_000);

  it("clicks on a page that redirected to another origin on load", async () => {
    // 127.0.0.1 redirects to localhost: two origins, like http to https or a bare host to www.
    const html = `<!doctype html><meta charset="utf-8"><style>#card{position:absolute;left:40px;top:40px;width:300px;height:200px;background:#2350d8}
#banner{position:fixed;inset:0;background:#fff}</style><div id="card">Card</div><div id="banner"><button id="ok" onclick="this.parentNode.remove()">Accept</button></div>`;
    let clickedAway = false;
    const server = createServer((req, res) => {
      if (req.url === "/hop") {
        // The click target appears only after a redirect to the other origin has been started.
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<!doctype html><div id="card" style="width:300px;height:200px;background:#2350d8">Card</div><script>setTimeout(() => (location.href = "http://127.0.0.1:${server.address().port}/away"), 300);</script>`);
      }
      if (req.url === "/away") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<!doctype html><button id="acc" onclick="fetch('/clicked')">Accept</button>`);
      }
      if (req.url === "/clicked") {
        clickedAway = true;
        res.writeHead(204);
        return res.end();
      }
      if (req.url === "/delay") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<!doctype html><div id="card" style="width:300px;height:200px;background:#2350d8">Card</div><script>setTimeout(() => (location.href = "http://127.0.0.1:${server.address().port}/away"), 500);</script>`);
      }
      if (req.headers.host?.startsWith("127.0.0.1") && req.url === "/") {
        res.writeHead(302, { location: `http://localhost:${server.address().port}/` });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const card = specWith([{ id: "c", kind: "box", target: { selector: "#card" } }]);
      const r = await captureCommand({ url: `http://127.0.0.1:${server.address().port}/`, spec: card, viewport: "1100x620", dpr: "2", click: "#ok", out: join(dir, "redirected.png") });
      expect(r.ok).toBe(true);
      // A redirect during the --click wait: the control on the other site is never clicked.
      await expect(captureCommand({ url: `http://localhost:${server.address().port}/hop`, spec: card, viewport: "1100x620", dpr: "2", click: "#acc", out: join(dir, "hop.png") })).rejects.toMatchObject({ code: "PAGE_LOAD" });
      expect(clickedAway).toBe(false);
      // A redirect to another origin on a timer, during --wait, is refused, not captured.
      await expect(captureCommand({ url: `http://localhost:${server.address().port}/delay`, spec: card, viewport: "1100x620", dpr: "2", wait: "1500", out: join(dir, "delayed.png") })).rejects.toMatchObject({ code: "PAGE_LOAD" });
    } finally {
      server.close();
    }
  }, 120_000);

  it("fades a target that has an opacity transition", async () => {
    const page4 = `<!doctype html><meta charset="utf-8"><style>#t{position:absolute;left:40px;top:40px;width:120px;height:36px;background:#2350d8;color:#fff;transition:all .4s}</style><button id="t">Go</button>`;
    const p4 = join(dir, "page4.html");
    writeFileSync(p4, page4);
    const r = await captureCommand({ url: pathToFileURL(p4).href, spec: specWith([{ id: "t", kind: "box", target: { selector: "#t" } }]), viewport: "1100x620", dpr: "2", out: join(dir, "trans.png") });
    expect(r.ok).toBe(true);
  }, 120_000);

  it("measures selectors within 1 px of the DOM rect times dpr", async () => {
    const spec = specWith([
      { id: "create", kind: "box", target: { selector: "#create" } },
      { id: "key", kind: "redact", target: { selector: "#hidden" } },
    ]);
    const r = await captureCommand({ url, spec, viewport: "1100x620", dpr: "2", out: join(dir, "cap.png") });
    expect(r.ok).toBe(true);
    const refs = JSON.parse(readFileSync(r.refs, "utf8"));
    expect(refs.dpr).toBe(2);
    // Nothing capture writes may name a folder above its own: only file names.
    for (const f of [r.refs, r.spec, r.render.sidecar]) expect(readFileSync(f, "utf8")).not.toContain(dir);
    const resolved = JSON.parse(readFileSync(r.spec, "utf8"));
    expect(resolved.image).toBe("cap.capture.png");
    // A figure with a mask records no element names: a name can hold the words the mask hides.
    expect(Object.values(refs.refs).some((x) => x.name)).toBe(false);
    expect(r.render.alt_text).not.toMatch(/\bs\d\b/);
    const t = r.render.annotations.find((a) => a.id === "create").target.px;
    expect(Math.abs(t.x - 1592)).toBeLessThanOrEqual(1);
    expect(Math.abs(t.w - 208)).toBeLessThanOrEqual(1);
  }, 120_000);

  it("masks redactions at capture so the raw shot never holds them", async () => {
    const spec = specWith([{ id: "key", kind: "redact", target: { selector: "#hidden" } }]);
    const r = await captureCommand({ url, spec, viewport: "1100x620", dpr: "2", out: join(dir, "mask.png") });
    const raw = decode(readFileSync(r.capture));
    const i = ((270 * 2 + 30) * raw.width + 260 * 2 + 300) * 4;
    expect([raw.data[i], raw.data[i + 1], raw.data[i + 2]]).toEqual([0x1f, 0x23, 0x28]);
  }, 120_000);

  it("refuses an ambiguous selector", async () => {
    const spec = specWith([{ kind: "box", target: { selector: ".dup" } }]);
    await expect(captureCommand({ url, spec, viewport: "1100x620", dpr: "2", out: join(dir, "amb.png") })).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });
  }, 120_000);

  it("refuses a target that is covered by another element", async () => {
    const spec = specWith([{ kind: "box", target: { selector: "#covered" } }]);
    await expect(captureCommand({ url, spec, viewport: "1100x620", dpr: "2", out: join(dir, "cov.png") })).rejects.toMatchObject({ code: "TARGET_COVERED" });
    const hidden = specWith([{ id: "h", kind: "box", target: { selector: "#gone" } }]);
    await expect(captureCommand({ url, spec: hidden, viewport: "1100x620", dpr: "2", out: join(dir, "gone.png") })).rejects.toMatchObject({ code: "TARGET_NO_BOX" });
    // A control inside an open shadow root is not "covered" by its own host.
    const shadow = specWith([{ id: "sh", kind: "box", target: { selector: "#inner" } }]);
    expect((await captureCommand({ url, spec: shadow, viewport: "1100x620", dpr: "2", out: join(dir, "shadow.png") })).ok).toBe(true);
    const host = specWith([{ id: "ho", kind: "box", target: { selector: "#host" } }]);
    expect((await captureCommand({ url, spec: host, viewport: "1100x620", dpr: "2", out: join(dir, "host.png") })).ok).toBe(true);
    // Two targets one scroll panel cannot show together are refused, in a full-page shot too.
    const panel = specWith([{ id: "a", kind: "box", target: { selector: "#p1" } }, { id: "b", kind: "box", target: { selector: "#p2" } }]);
    await expect(captureCommand({ url, spec: panel, viewport: "1100x620", dpr: "2", "full-page": true, out: join(dir, "panel.png") })).rejects.toMatchObject({ code: expect.stringMatching(/TARGET_OFF_FRAME|TARGET_COVERED/) });
    // An endless animation is cancelled before measuring, so the capture completes.
    const spin = specWith([{ id: "s", kind: "box", target: { selector: "#spin" } }]);
    const rs = await captureCommand({ url, spec: spin, viewport: "1100x620", dpr: "2", out: join(dir, "spin.png") });
    expect(rs.ok).toBe(true);
  }, 120_000);

  it("refuses targets that cannot share one viewport, and full-page fixes it", async () => {
    const spec = specWith([{ id: "c", kind: "box", target: { selector: "#create" } }, { id: "b", kind: "box", target: { selector: "#below" } }]);
    await expect(captureCommand({ url, spec, viewport: "1100x620", dpr: "2", out: join(dir, "off.png") })).rejects.toMatchObject({ code: "TARGET_OFF_FRAME" });
    const r = await captureCommand({ url, spec, viewport: "1100x620", dpr: "2", "full-page": true, out: join(dir, "full.png") });
    const b = r.render.annotations.find((a) => a.id === "b").target.px;
    expect(Math.abs(b.y - 2800)).toBeLessThanOrEqual(1);
  }, 120_000);
});
