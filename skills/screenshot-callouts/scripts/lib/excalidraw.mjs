// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// The editable hand-off. The screenshot becomes ONE locked image element (the redacted base, so
// a human editing the file can never uncover a secret) and every mark becomes a native element a
// human can move: rectangles, ellipses, bound arrows, text, number badges. Scene units are image
// px / dpr, so a 2x capture opens at its natural CSS size.
//
// Bindings are written in both dialects: { focus, gap } for the released 0.18.1 that renders
// headless here, and { fixedPoint, mode } for excalidraw.com, which runs master and reads both.
// Rendering goes through a local esbuild bundle of the pinned package: no CDN, and every network
// request from the page is aborted.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFresh } from "./files.mjs";
import { isAbsolute, join, relative } from "node:path";
import { cacheDir, packageDir, SETUP_FIX } from "./cache.mjs";
import { missingDep, refused } from "./errors.mjs";
import { seedOf } from "./geometry.mjs";
import { crop, decode, encode, sha256 } from "./png.mjs";
import { FAMILIES, measureLine } from "./fonts.mjs";
import { color, inkOn, PALETTE, toHex } from "./tokens.mjs";

const OFF = 1; // Excalidraw treats an exact 0 coordinate as unset in places; never write one.
const FONT = { sketch: 5, clean: 2 }; // Excalifont, Helvetica

export async function buildScene(result) {
  const { layout, base, cropRect: c, T, style } = result.internal;
  const s = 1 / T.dpr;
  const X = (x) => Math.round(((x - c.x) * s + OFF) * 100) / 100;
  const Y = (y) => Math.round(((y - c.y) * s + OFF) * 100) / 100;
  const S = (v) => Math.round(v * s * 100) / 100;
  const sketch = style === "sketch";
  const cropped = c.x === 0 && c.y === 0 && c.w === base.width && c.h === base.height ? base : crop(base, c);
  const embedded = bakeHighlights(cropped, result.internal.layout.items, c);
  const pngBuf = encode(embedded);
  const fileId = createHash("sha1").update(pngBuf).digest("hex");
  const elements = [];
  const warnings = [];
  const group = ["annotations"];

  const el = (id, type, r, extra = {}) => {
    const e = {
      id,
      type,
      x: X(r.x),
      y: Y(r.y),
      width: S(r.w),
      height: S(r.h),
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: Math.max(1, Math.round(S(T.stroke) * 2) / 2),
      strokeStyle: "solid",
      roughness: sketch ? 1 : 0,
      opacity: 100,
      groupIds: group,
      frameId: null,
      roundness: null,
      seed: seedOf(id),
      version: 1,
      versionNonce: seedOf(`${id}#v`),
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      ...extra,
    };
    elements.push(e);
    return e;
  };
  const bind = (shape, other) => {
    shape.boundElements = [...(shape.boundElements ?? []), { id: other.id, type: other.type === "text" ? "text" : "arrow" }];
  };
  // Text is sized the way Excalidraw sizes it: an integer font size, height = lines x size x 1.25,
  // width = the widest line in the same font, centred on the canvas point (cx, cy). Measured in
  // scene units directly, so the linter's height and container checks hold exactly.
  const measureFont = { family: sketch ? FAMILIES.sketch : FAMILIES.clean, weight: sketch ? 400 : 700 };
  const text = async (id, str, [cx, cy], sizePx, ink, extra = {}) => {
    const fontSize = Math.max(8, Math.round(S(sizePx)));
    const lines = str.split("\n");
    const widths = await Promise.all(lines.map((l) => measureLine(l, { ...measureFont, size: fontSize })));
    const w = Math.ceil(Math.max(...widths));
    const h = lines.length * fontSize * 1.25;
    const e = el(id, "text", { x: 0, y: 0, w: 0, h: 0 }, {
      strokeColor: ink,
      text: str,
      originalText: str,
      fontSize,
      fontFamily: FONT[style],
      textAlign: "center",
      verticalAlign: "middle",
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
      ...extra,
    });
    Object.assign(e, { x: X(cx) - w / 2, y: Y(cy) - h / 2, width: w, height: h });
    return e;
  };

  el("screenshot", "image", { x: c.x, y: c.y, w: c.w, h: c.h }, { strokeColor: "transparent", fileId, status: "saved", scale: [1, 1], crop: null, locked: true, groupIds: [] });

  for (const it of layout.items) {
    const ink = toHex(color(it.color ?? result.internal.accent ?? PALETTE.accent));
    let anchor;
    const rect = (id, r, extra) => el(id, "rectangle", r, { strokeColor: ink, roundness: { type: 3 }, ...extra });
    switch (it.kind) {
      case "box":
      case "step":
        if (it.kind === "box" || it.outline !== false) anchor = rect(`${it.id}:shape`, it.shape);
        break;
      case "callout":
        if (it.outline) anchor = rect(`${it.id}:shape`, it.shape);
        break;
      case "ellipse":
        anchor = el(`${it.id}:shape`, "ellipse", it.shape, { strokeColor: ink });
        break;
      case "highlight":
        // Excalidraw has no multiply blend, and a translucent fill on top turns the text olive.
        // So the highlighter is baked into the embedded screenshot, under the text.
        warnings.push(`highlight "${it.id}" is baked into the screenshot: Excalidraw cannot draw it under text`);
        break;
      case "underline": {
        const y = it.shape.y + it.shape.h + 3 * T.dpr;
        el(`${it.id}:line`, "line", { x: it.shape.x, y, w: it.shape.w, h: 0 }, { strokeColor: ink, points: [[0, 0], [S(it.shape.w), 0]], startArrowhead: null, endArrowhead: null });
        break;
      }
      case "spotlight": {
        const u = it.cutouts.reduce((a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), x1: Math.max(a.x1, b.x + b.w), y1: Math.max(a.y1, b.y + b.h) }), { x: Infinity, y: Infinity, x1: -Infinity, y1: -Infinity });
        if (it.cutouts.length > 1) warnings.push(`spotlight "${it.id}": Excalidraw has no cut-out shape, so its ${it.cutouts.length} holes became one`);
        const shade = { strokeColor: "transparent", backgroundColor: PALETTE.dim, opacity: 58, roughness: 0, locked: true };
        // The shade covers the cropped image only; past it, it would grow the exported scene.
        const x0 = c.x;
        const y0 = c.y;
        const x1 = c.x + c.w;
        const y1 = c.y + c.h;
        const hy0 = Math.max(y0, u.y);
        const hy1 = Math.min(y1, u.y1);
        for (const [k, r] of Object.entries({
          top: { x: x0, y: y0, w: c.w, h: u.y - y0 },
          bottom: { x: x0, y: u.y1, w: c.w, h: y1 - u.y1 },
          left: { x: x0, y: hy0, w: u.x - x0, h: hy1 - hy0 },
          right: { x: u.x1, y: hy0, w: x1 - u.x1, h: hy1 - hy0 },
        })) if (r.w > 0 && r.h > 0) rect(`${it.id}:shade-${k}`, r, { ...shade, roundness: null });
        if (it.outline !== false) for (const [i, cut] of it.cutouts.entries()) rect(`${it.id}:cut-${i}`, cut);
        break;
      }
      case "blur":
        warnings.push(`blur "${it.id}" appears UNBLURRED in the .excalidraw file and in any --via-excalidraw PNG: blur is a pixel effect only the PNG has`);
        break;
      case "magnify": {
        const { rect: L, src } = it.lens;
        el(`${it.id}:lens`, "image", L, {
          strokeColor: "transparent",
          fileId,
          status: "saved",
          scale: [1, 1],
          crop: { x: src.x - c.x, y: src.y - c.y, width: src.w, height: src.h, naturalWidth: c.w, naturalHeight: c.h },
        });
        rect(`${it.id}:lens-border`, L);
        anchor = rect(`${it.id}:shape`, src, { strokeWidth: Math.max(1, S(T.stroke * 0.6)) });
        break;
      }
      default:
        break;
    }

    let start;
    // A free text item is written once, below, as plain text; it is not a label with a pill.
    if (it.labelBox && it.kind !== "magnify" && it.kind !== "text") {
      const lb = it.labelBox;
      const R = lb.rect;
      const size = lb.font.size;
      const mid = [R.x + R.w / 2, R.y + R.h / 2];
      if (sketch) {
        // The same seeded tilt as the PNG, so the edited file and its siblings match.
        const tilt = (((seedOf(`${it.id}|${it.kind}|${layout.seed ?? 1}`) % 400) / 100 - 2) * 0.9 * Math.PI) / 180;
        start = await text(`${it.id}:label`, lb.lines.join("\n"), mid, size, ink, { angle: Math.round(tilt * 1000) / 1000, textAlign: "left" });
      } else {
        start = rect(`${it.id}:label`, R, { strokeColor: "#ffffff", strokeWidth: 1, backgroundColor: ink, roundness: { type: 3 } });
        const t = await text(`${it.id}:label-text`, lb.lines.join("\n"), mid, size, toHex(inkOn(color(ink))), { containerId: start.id });
        bind(start, t);
      }
    }
    if (it.kind === "magnify") start = elements.find((e) => e.id === `${it.id}:lens-border`);
    if (it.kind === "arrow" && it.fromBox && !it.labelBox) {
      start = el(`${it.id}:from`, "rectangle", it.fromBox, { strokeColor: "transparent", locked: true });
    }

    if (it.leader) {
      if (!anchor) anchor = el(`${it.id}:anchor`, "rectangle", it.shape, { strokeColor: "transparent", locked: true });
      const [fx, fy] = it.leader.from;
      const [tx, ty] = it.leader.to;
      // Excalidraw snaps an exact 0.5 to 0.5001, which can flip the arrow's heading, so an exact
      // half is written as 0.5002 (the excalidraw skill beside this one does the same).
      const unhalf = (v) => (Math.abs(v - 0.5) < 1e-4 ? 0.5002 : Math.round(v * 10000) / 10000);
      const fixed = (r, [px, py]) => [unhalf(Math.min(1, Math.max(0, (px - r.x) / (r.w || 1)))), unhalf(Math.min(1, Math.max(0, (py - r.y) / (r.h || 1))))];
      const a = el(`${it.id}:leader`, "arrow", { x: fx, y: fy, w: Math.abs(tx - fx), h: Math.abs(ty - fy) }, {
        strokeColor: ink,
        strokeStyle: it.kind === "magnify" ? "dashed" : "solid",
        roundness: { type: 2 },
        points: [[0, 0], [S(tx - fx), S(ty - fy)]],
        startArrowhead: null,
        endArrowhead: it.leader.head ? "arrow" : null,
        elbowed: false,
        startBinding: start ? { elementId: start.id, focus: 0, gap: S(T.gap), fixedPoint: fixed(rectOf(start, c, T), [fx, fy]), mode: "orbit" } : null,
        endBinding: { elementId: anchor.id, focus: 0, gap: S(T.gap), fixedPoint: fixed(it.shape, [tx, ty]), mode: "orbit" },
      });
      bind(anchor, a);
      if (start) bind(start, a);
    }

    if (it.badge) {
      const { cx, cy, r } = it.badge;
      // The digit is free text grouped with its disc, not bound into it: Excalidraw pads text in an
      // ellipse to the inscribed box, which a 28 px badge cannot fit at a readable size. The group
      // also holds the shape the badge sits on, so a human moves mark and number together.
      const g = [`${it.id}:group`, ...group];
      const disc = el(`${it.id}:badge`, "ellipse", { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, { strokeColor: ink, backgroundColor: ink, fillStyle: "solid", strokeWidth: 1, groupIds: g });
      await text(`${it.id}:badge-n`, String(it.n), [cx, cy], r * 1.1, toHex(inkOn(color(ink))), { groupIds: g });
      if (anchor) anchor.groupIds = g;
      void disc;
    }
    if (it.kind === "text") {
      const R = it.labelBox.rect;
      await text(`${it.id}:text`, it.labelBox.lines.join("\n"), [R.x + R.w / 2, R.y + R.h / 2], it.labelBox.font.size, ink);
    }
  }

  return {
    type: "excalidraw",
    version: 2,
    source: "screenshot-callouts",
    elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
    files: { [fileId]: { mimeType: "image/png", id: fileId, dataURL: `data:image/png;base64,${pngBuf.toString("base64")}`, created: 1 } },
    warnings,
  };
}

/** Multiply each highlighter rect into a copy of the pixels, as the PNG renderer's blend does. */
function bakeHighlights(img, items, c) {
  const hs = items.filter((it) => it.kind === "highlight");
  if (!hs.length) return img;
  const out = { ...img, data: Buffer.from(img.data) };
  const [hr, hg, hb] = color(PALETTE.highlight);
  for (const it of hs) {
    const x0 = Math.max(0, Math.floor(it.shape.x - c.x));
    const y0 = Math.max(0, Math.floor(it.shape.y - c.y));
    const x1 = Math.min(out.width, Math.ceil(it.shape.x + it.shape.w - c.x));
    const y1 = Math.min(out.height, Math.ceil(it.shape.y + it.shape.h - c.y));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * out.width + x) * 4;
        out.data[i] = Math.round((out.data[i] * (255 * 0.5 + hr * 0.5)) / 255);
        out.data[i + 1] = Math.round((out.data[i + 1] * (255 * 0.5 + hg * 0.5)) / 255);
        out.data[i + 2] = Math.round((out.data[i + 2] * (255 * 0.5 + hb * 0.5)) / 255);
      }
    }
  }
  return out;
}

function rectOf(e, c, T) {
  return { x: (e.x - OFF) * T.dpr + c.x, y: (e.y - OFF) * T.dpr + c.y, w: e.width * T.dpr, h: e.height * T.dpr };
}

const bundlePath = () => join(cacheDir(), "excalidraw", "bundle.js");

/** Bundle the pinned Excalidraw package once, so rendering never fetches code from a CDN. */
export async function setupBundle() {
  const esbuild = await import("esbuild");
  const { mkdirSync, writeFileSync: write } = await import("node:fs");
  mkdirSync(join(cacheDir(), "excalidraw"), { recursive: true });
  const entry = join(cacheDir(), "excalidraw", "entry.mjs");
  // The pinned package by absolute path: resolving the bare name would walk up from the cache
  // folder and could bundle a stray ~/node_modules copy instead.
  write(entry, `export { exportToBlob } from ${JSON.stringify(join(packageDir("@excalidraw/excalidraw"), "dist", "prod", "index.js"))};\n`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    globalName: "ExcalidrawLib",
    minify: true,
    outfile: bundlePath(),
    nodePaths: [join(packageDir("@excalidraw/excalidraw"), "..", "..")],
    define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"' },
    loader: { ".woff2": "empty", ".css": "empty" },
    logLevel: "error",
  });
  const hash = sha256(readFileSync(bundlePath()));
  write(`${bundlePath()}.sha256`, `${hash}\n`);
  return { bundle: bundlePath(), sha256: hash };
}

/** Render a scene through Excalidraw itself, offline, and re-encode the PNG through our encoder. */
export async function renderScene(scene, outPng, scale, inputs = [], expect = undefined) {
  const fix = SETUP_FIX;
  if (!existsSync(bundlePath())) throw missingDep("EXCALIDRAW_BUNDLE_MISSING", "the local Excalidraw bundle has not been built", { fix });
  const bundle = readFileSync(bundlePath());
  if (!existsSync(`${bundlePath()}.sha256`) || sha256(bundle) !== readFileSync(`${bundlePath()}.sha256`, "utf8").trim()) throw missingDep("EXCALIDRAW_BUNDLE_MISSING", "the Excalidraw bundle changed since setup", { fix });
  const fonts = join(packageDir("@excalidraw/excalidraw"), "dist", "prod");
  const { launch } = await import("./browser.mjs");
  const browser = await launch();
  try {
    const context = await browser.newContext();
    const blocked = [];
    await context.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === "annotate.invalid") {
        if (u.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><script>window.EXCALIDRAW_ASSET_PATH="https://annotate.invalid/assets/"</script><script src="/bundle.js"></script>' });
        if (u.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
        let file;
        try {
          file = join(fonts, decodeURIComponent(u.pathname.replace(/^\/assets\//, "")));
        } catch {
          return route.abort();
        }
        const rel = relative(join(fonts, "fonts"), file);
        const inFonts = rel && !rel.startsWith("..") && !isAbsolute(rel);
        if (u.pathname.startsWith("/assets/fonts/") && inFonts && existsSync(file)) return route.fulfill({ contentType: "font/woff2", body: readFileSync(file) });
      }
      blocked.push(u.origin);
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto("https://annotate.invalid/");
    const b64 = await page.evaluate(async ({ s, k }) => {
      const blob = await window.ExcalidrawLib.exportToBlob({
        elements: s.elements,
        files: s.files,
        appState: { ...s.appState, exportBackground: true },
        exportPadding: 0,
        mimeType: "image/png",
        getDimensions: (w, h) => ({ width: w * k, height: h * k, scale: k }),
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (const x of bytes) bin += String.fromCharCode(x);
      return btoa(bin);
    }, { s: scene, k: scale });
    const img = decode(Buffer.from(b64, "base64"));
    // This PNG gets no pixel proof (Excalidraw draws its own strokes), so its size is the one
    // promise checked: a mismatch means an element reached past the screenshot.
    if (expect && (Math.abs(img.width - expect.width) > 1 || Math.abs(img.height - expect.height) > 1)) {
      throw refused("EXCALIDRAW_SIZE", `Excalidraw rendered ${img.width}x${img.height}, the figure is ${expect.width}x${expect.height}`, { fix: "report it: an element of the scene lies outside the screenshot" });
    }
    const buf = encode(img);
    writeFresh(outPng, buf, inputs, "--via-excalidraw");
    return { path: outPng, sha256: sha256(buf), width: img.width, height: img.height, blocked_requests: [...new Set(blocked)] };
  } finally {
    await browser.close();
  }
}

/** Write the .excalidraw file and, when asked, a PNG rendered by Excalidraw itself. */
export async function exportExcalidraw(result, { out, png, inputs = [] } = {}) {
  const scene = await buildScene(result);
  const { warnings, ...file } = scene;
  const report = { warnings };
  const protect = [...inputs, result.output?.path].filter(Boolean);
  if (out) {
    writeFresh(out, JSON.stringify(file), protect, "/excalidraw");
    report.path = out;
    report.sha256 = sha256(readFileSync(out));
    report.elements = file.elements.length;
  }
  if (png) report.png = await renderScene(file, png, result.internal.T.dpr, [...protect, out].filter(Boolean), result.output);
  return report;
}
