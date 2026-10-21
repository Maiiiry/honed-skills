// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Text targets for screenshots that have no DOM. Two backends: macOS Vision (accurate on Retina UI
// text) through a small Swift helper compiled once by `setup`, and tesseract everywhere else.
// Both report word boxes in image pixels with a top-left origin.
//
// Secrets: a token that looks like a key is never printed. Not in candidates, not in errors, not
// by `locate`. The agent targets a secret by pattern ({"regex": "^sk_"}) so it never has to type
// one into a spec or a transcript.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cacheDir, SETUP_FIX } from "./cache.mjs";
import { didYouMean, missingDep, refused, usage } from "./errors.mjs";
import { decode, encode, MAX_INPUT_PIXELS } from "./png.mjs";
import { containsSecret, looksSecret, maskText as mask } from "./secrets.mjs";
import { unsafePattern } from "./spec.mjs";
import { readInputFile, removeQuietly } from "./files.mjs";

export { looksSecret };

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SWIFT_SRC = join(HERE, "..", "vision-ocr.swift");

async function visionPath() {
  if (process.platform !== "darwin" || !existsSync(SWIFT_SRC)) return undefined;
  let compiler = "";
  try {
    compiler = (await run("swiftc", ["--version"], { timeout: 20_000 })).stdout;
  } catch {
    return undefined;
  }
  const key = createHash("sha256").update(readFileSync(SWIFT_SRC)).update(compiler).digest("hex").slice(0, 16);
  return join(cacheDir(), "bin", `vision-ocr-${key}`);
}

export async function setupOcr() {
  const out = { vision: null, tesseract: null };
  const bin = await visionPath();
  if (bin) {
    // Compile beside the target and rename, so an interrupted build never leaves a half binary
    // under the cached name. A failed build is reported; tesseract may still serve.
    const tmp = `${bin}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      if (!existsSync(bin)) {
        mkdirSync(dirname(bin), { recursive: true });
        await run("swiftc", ["-O", "-o", tmp, "--", SWIFT_SRC], { timeout: 300_000 });
        renameSync(tmp, bin);
      }
      out.vision = bin;
    } catch (e) {
      removeQuietly(tmp);
      out.vision_error = String(e.stderr || e.message).split("\n")[0];
    }
  }
  try {
    out.tesseract = (await run("tesseract", ["--version"], { timeout: 20_000 })).stdout.split("\n")[0];
  } catch {
    // tesseract is optional where Vision exists
  }
  return out;
}

/** "vision", "tesseract" or undefined. SCREENSHOT_CALLOUTS_OCR=none forces undefined. */
export async function availableBackend() {
  const want = process.env.SCREENSHOT_CALLOUTS_OCR;
  if (want !== undefined && want !== "" && !["vision", "tesseract", "none"].includes(want)) {
    throw usage("USAGE", `SCREENSHOT_CALLOUTS_OCR is vision, tesseract or none, not "${want.slice(0, 20)}"`, { candidates: ["vision", "tesseract", "none"] });
  }
  if (want === "none") return undefined;
  const bin = await visionPath();
  if (want !== "tesseract" && bin && existsSync(bin)) return "vision";
  // On a Mac that can build the Vision helper but has not, falling back to tesseract would read
  // no button text and report TARGET_MISSING; "run setup" is the true answer there.
  if (want !== "tesseract" && bin) return undefined;
  try {
    await run("tesseract", ["--version"], { timeout: 20_000 });
    return "tesseract";
  } catch {
    return undefined;
  }
}

async function runVision(png) {
  const { stdout } = await run(await visionPath(), [png], { timeout: 120_000, maxBuffer: 64 << 20 });
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [line, conf, x, y, w, h, ...rest] = row.split("\t");
      return { line: `v${line}`, conf: Number(conf), x: Number(x), y: Number(y), w: Number(w), h: Number(h), text: rest.join("\t") };
    });
}

async function runTesseract(png, img) {
  // Small UI text reads far better at 2x. Boxes are divided back by the factor.
  let file = png;
  let k = 1;
  // Only when the doubled image still fits: Tesseract refuses a side above 32,767 px, and the
  // rasteriser would allocate the doubled canvas whole.
  if (img.width < 1600 && img.height * 2 <= 32_000 && img.width * img.height * 4 <= MAX_INPUT_PIXELS) {
    const { Resvg } = await import("@resvg/resvg-js");
    k = 2;
    const b64 = readFileSync(png).toString("base64");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width * k}" height="${img.height * k}"><image width="${img.width * k}" height="${img.height * k}" href="data:image/png;base64,${b64}"/></svg>`;
    file = `${png}.x2.png`;
    writeFileSync(file, new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
  }
  const { stdout } = await run("tesseract", ["--psm", "11", file, "stdout", "tsv"], { timeout: 120_000, maxBuffer: 64 << 20 });
  const rows = stdout.split("\n").slice(1).filter(Boolean).map((r) => r.split("\t"));
  return rows
    .filter((c) => c[0] === "5" && c[11] && c[11].trim())
    .map((c) => ({ line: `t${c[2]}.${c[3]}.${c[4]}`, conf: Number(c[10]) / 100, x: Number(c[6]) / k, y: Number(c[7]) / k, w: Number(c[8]) / k, h: Number(c[9]) / k, text: c[11].trim() }));
}

/** Words of ctx.img, cached on ctx.cache. */
/**
 * OCR runs once per image: the promise itself is cached, so targets resolved at the same time share
 * one run instead of each starting its own process.
 */
export function ocrWords(ctx) {
  if (ctx.cache?.words) return Promise.resolve(ctx.cache.words);
  ctx.cache ??= {};
  ctx.cache.wordsPromise ??= runOcr(ctx).catch((e) => {
    ctx.cache.wordsPromise = undefined;
    throw e;
  });
  return ctx.cache.wordsPromise;
}

async function runOcr(ctx) {
  const backend = await availableBackend();
  if (!backend) {
    if (process.env.SCREENSHOT_CALLOUTS_OCR === "none") {
      throw missingDep("OCR_UNAVAILABLE", "OCR is turned off by SCREENSHOT_CALLOUTS_OCR=none", { fix: "unset SCREENSHOT_CALLOUTS_OCR, or use a box, css, ref or seed target" });
    }
    // On a Mac that can build the Vision helper, setup is the answer and tesseract is skipped on
    // purpose (it reads no button text); elsewhere tesseract is.
    const mac = Boolean(await visionPath());
    throw missingDep("OCR_UNAVAILABLE", mac ? "the Vision OCR helper is not built" : "no OCR backend: text targets need macOS Vision or tesseract", {
      fix: mac
        ? `${SETUP_FIX} (or set SCREENSHOT_CALLOUTS_OCR=tesseract to use tesseract instead)`
        : "install tesseract (apt install tesseract-ocr, brew install tesseract), or use a box, css, ref or seed target",
    });
  }
  const dir = mkdtempSync(join(tmpdir(), "sa-ocr-"));
  try {
    const png = join(dir, "in.png");
    writeFileSync(png, encode(ctx.img));
    const words = backend === "vision" ? await runVision(png) : await runTesseract(png, ctx.img);
    if (ctx.cache) {
      ctx.cache.words = words;
      ctx.cache.backend = backend;
    }
    return words;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const norm = (s) => String(s).toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
// A loop, not Math.min(...): a spread of tens of thousands of words can pass the engine's
// argument limit.
const unionOf = (ws) => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const w of ws) {
    x0 = Math.min(x0, w.x);
    y0 = Math.min(y0, w.y);
    x1 = Math.max(x1, w.x + w.w);
    y1 = Math.max(y1, w.y + w.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

function lines(words) {
  const map = new Map();
  for (const w of words) {
    if (!map.has(w.line)) map.set(w.line, []);
    map.get(w.line).push(w);
  }
  return [...map.values()].map((ws) => ws.sort((a, b) => a.x - b.x));
}

/** Every span of consecutive words on one line that matches the query. */
// A pattern from a spec runs in a worker with a deadline. The grammar in spec.mjs refuses the
// known catastrophic shapes, but no lint over regexes is complete, and a regex blocks the thread it
// runs on: only a separate thread that can be terminated bounds the time.
const REGEX_DEADLINE_MS = 2000;
const REGEX_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const re = new RegExp(workerData.pattern, "i");
parentPort.postMessage(workerData.texts.map((t) => re.test(t)));
`;

export async function regexTestAll(pattern, texts) {
  if (!texts.length) return [];
  const { Worker } = await import("node:worker_threads");
  const w = new Worker(REGEX_WORKER, { eval: true, workerData: { pattern, texts } });
  let timer;
  try {
    return await new Promise((done, fail) => {
      timer = setTimeout(() => fail(refused("REGEX_TIMEOUT", `the pattern ran longer than ${REGEX_DEADLINE_MS} ms`, { fix: "anchor it with ^ and use fewer repeats, or target by a box" })), REGEX_DEADLINE_MS);
      w.once("message", done);
      w.once("error", () => fail(usage("TARGET_INVALID", "the pattern is not a valid regular expression")));
    });
  } finally {
    clearTimeout(timer);
    await w.terminate();
  }
}

async function matches(words, query) {
  const out = [];
  if (typeof query === "string") {
    const q = norm(query);
    for (const ws of lines(words)) {
      for (let i = 0; i < ws.length; i++) {
        // A span starts and ends on a real word: a separator ("|", ">", a bullet) normalizes to
        // nothing, so "| submit" would otherwise match "submit" a second time, 20 px to the left.
        if (!norm(ws[i].text)) continue;
        let joined = "";
        for (let j = i; j < ws.length && joined.length < q.length; j++) {
          joined += norm(ws[j].text);
          if (joined === q && norm(ws[j].text)) out.push(ws.slice(i, j + 1));
        }
      }
    }
  } else {
    const single = await regexTestAll(query.regex, words.map((w) => w.text));
    words.forEach((w, i) => single[i] && out.push([w]));
    if (!out.length) {
      const spans = [];
      for (const ws of lines(words)) {
        for (let i = 0; i < ws.length; i++) {
          for (let j = i + 1; j < Math.min(ws.length, i + 6); j++) spans.push(ws.slice(i, j + 1));
        }
      }
      const hit = await regexTestAll(query.regex, spans.map((sp) => sp.map((w) => w.text).join(" ")));
      spans.forEach((sp, i) => hit[i] && out.push(sp));
    }
  }
  return out
    .map((ws) => ({ ws, box: unionOf(ws) }))
    .sort((a, b) => (Math.abs(a.box.y - b.box.y) > a.box.h / 2 ? a.box.y - b.box.y : a.box.x - b.box.x));
}

/**
 * A pattern usually matches the first token of a secret, and OCR can split one secret into several
 * tokens or wrap it onto the next line. Grow the match through every adjacent secret-like token on
 * its own line and on the line below, so a redaction never leaves the tail readable.
 */
function extendSecret(words, m) {
  const ws = [...m.ws];
  const taken = new Set(ws);
  // Secret-like words are found once, and the box grows in place: a dense screen of keys would
  // otherwise cost a full rescan, a union and a list search per word per pass.
  const pool = words.filter((w) => !taken.has(w) && looksSecret(w.text));
  const h = ws.reduce((a, w) => Math.max(a, w.h), 0);
  const b = unionOf(ws);
  let grew = true;
  while (grew) {
    grew = false;
    for (const w of pool) {
      if (taken.has(w)) continue;
      const sameRow = Math.abs(w.y + w.h / 2 - (b.y + b.h / 2)) < h * 0.6 && w.x - (b.x + b.w) < h * 1.5 && b.x - (w.x + w.w) < h * 1.5;
      const nextRow = w.y > b.y + b.h * 0.5 && w.y - (b.y + b.h) < h * 1.2 && w.x < b.x + b.w && w.x + w.w > b.x - h * 4;
      if (sameRow || nextRow) {
        ws.push(w);
        taken.add(w);
        const x1 = Math.max(b.x + b.w, w.x + w.w);
        const y1 = Math.max(b.y + b.h, w.y + w.h);
        b.x = Math.min(b.x, w.x);
        b.y = Math.min(b.y, w.y);
        b.w = x1 - b.x;
        b.h = y1 - b.y;
        grew = true;
      }
    }
  }
  return { ws, box: unionOf(ws) };
}

/**
 * @param who  { id, path, masked }: `masked` (set for redactions) keeps the query out of every
 *             message, because the words a redaction targets are exactly what must not be echoed.
 */
export async function findText(ctx, query, { nth, within } = {}, who = {}) {
  const words = await ocrWords(ctx);
  let found = await matches(words, query);
  // Narrowed and counted on the raw matches; only the one picked is grown to its secret's full
  // extent below, so a pattern that matches every word costs one extension, not one per match.
  const extend = typeof query !== "string" || who.masked;
  if (within) {
    found = found.filter(({ box }) => {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      return cx >= within.x && cx <= within.x + within.w && cy >= within.y && cy <= within.y + within.h;
    });
  }
  const { masked, ...whoOut } = who;
  who = whoOut;
  const label = masked ? "the redaction's text" : typeof query === "string" ? `"${query}"` : "the pattern";
  if (!found.length) {
    // Visible lines are offered only for a plain-word search outside a redaction. For a redaction
    // or a pattern, the line next to the secret can hold the secret's remainder, so none is shown.
    let candidates;
    if (typeof query === "string" && !masked && !ctx.quiet) {
      const visible = [...new Set(lines(words).map((ws) => ws.map((w) => mask(w.text)).join(" ")))].filter((v) => !v.includes("[secret-like"));
      const near = didYouMean(query, visible);
      candidates = (near.length ? near : visible).slice(0, 12);
    }
    throw refused("TARGET_MISSING", `OCR found no text matching ${label}`, {
      ...who,
      candidates,
      fix: masked || typeof query !== "string" ? "check the pattern with `locate IMG.png --all`, or use a box/seed target" : "use the exact visible words, a regex, or a box/seed target",
    });
  }
  if (found.length > 1 && !nth) {
    throw refused("TARGET_AMBIGUOUS", `${label} appears ${found.length} times`, {
      ...who,
      candidates: found.map((m, i) => `nth ${i + 1}: at ${Math.round(m.box.x)},${Math.round(m.box.y)}`),
      fix: 'add "nth" (reading order) or "within" (a region) to the target',
    });
  }
  const pick = found[(nth ?? 1) - 1];
  if (!pick) throw refused("TARGET_MISSING", `${label} has only ${found.length} match(es), nth ${nth} asked`, who);
  return extend ? extendSecret(words, pick).box : pick.box;
}

/** Secret-like tokens visible in `img` and outside every rect in `allowed`. Boxes only, no text. */
export async function secretSweep(img, allowed) {
  const words = await ocrWords({ img, cache: {} });
  const inside = (w, r) => w.x >= r.x - 2 && w.y >= r.y - 2 && w.x + w.w <= r.x + r.w + 2 && w.y + w.h <= r.y + r.h + 2;
  return words.filter((w) => looksSecret(w.text) && !allowed.some((r) => inside(w, r))).map((w) => ({ x: Math.round(w.x), y: Math.round(w.y), w: Math.round(w.w), h: Math.round(w.h), chars: w.text.length }));
}

export async function locateCommand(imagePath, opt) {
  if (!imagePath) throw usage("USAGE", "locate needs IMG.png");
  // `true` is a flag without its value; "" is an empty shell variable. Either would fall through
  // to the full listing and print every word on the screen.
  for (const k of ["text", "regex", "nth", "seed"]) if (opt[k] === true || (typeof opt[k] === "string" && !opt[k].trim())) throw usage("USAGE", `--${k} needs a value`, { path: `--${k}` });
  if (typeof opt.text === "string" && opt.text.length > 200) throw usage("USAGE", "--text is at most 200 characters", { path: "--text" });
  if (opt.text && containsSecret(opt.text)) {
    throw usage("SECRET_LITERAL", "--text looks like a key or token; it would be echoed in every message", { path: "--text", fix: 'use --regex with its prefix, such as --regex "^sk_"' });
  }
  if (opt.nth !== undefined && !(Number.isInteger(Number(opt.nth)) && Number(opt.nth) >= 1)) throw usage("USAGE", "--nth is a whole number from 1", { path: "--nth" });
  if (opt.regex && unsafePattern(opt.regex)) throw usage("TARGET_INVALID", `--regex must be ${unsafePattern(opt.regex)}`, { path: "--regex" });
  const img = decode(readInputFile(imagePath, "IMG.png"));
  const ctx = { img, cache: {} };
  const words = await ocrWords(ctx);
  const result = { ok: true, backend: ctx.cache.backend, image: { width: img.width, height: img.height } };
  if (opt.text || opt.regex) {
    const q = opt.regex ? { regex: opt.regex } : opt.text;
    const box = await findText(ctx, q, { nth: opt.nth ? Number(opt.nth) : undefined }, { id: "locate" });
    const r = [Math.round(box.x), Math.round(box.y), Math.round(box.w), Math.round(box.h)];
    return { ...result, box: r, target: { box: r } };
  }
  result.words = words.map((w) => ({
    text: mask(w.text),
    secret_like: looksSecret(w.text) || undefined,
    box: [Math.round(w.x), Math.round(w.y), Math.round(w.w), Math.round(w.h)],
    conf: Math.round(w.conf * 100) / 100,
  }));
  return result;
}
