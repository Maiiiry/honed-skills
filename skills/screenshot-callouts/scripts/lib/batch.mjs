// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Re-render a whole guide in one call: shared defaults (style, accent, dpr, layout, wobble) so every figure in a
// document set uses one token set, and one contact sheet at the end for review. A failed figure
// is reported, never skipped silently, and the batch is not ok while any figure failed.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AnnotateError, usage } from "./errors.mjs";
import { readJsonFile, specOutputPath } from "./files.mjs";
import { assertOutputsFree, planPaths, renderSpec } from "./render.mjs";
import { sheetCommand } from "./sheet.mjs";

const SHARED = ["style", "accent", "dpr", "layout", "wobble"];

// A guide has tens of figures; a cap bounds every per-entry cost of a manifest from somebody else.
const MAX_SPECS = 200;

export async function batchCommand(manifestPath, opt) {
  if (!manifestPath) throw usage("USAGE", "batch needs MANIFEST.json");
  const base = dirname(resolve(manifestPath));
  const m = readJsonFile(manifestPath, "MANIFEST.json");
  if (!m || typeof m !== "object" || Array.isArray(m)) throw usage("SPEC_INVALID", "the manifest is a JSON object", { path: "" });
  const TOP = ["defaults", "specs", "sheet", "note"];
  for (const k of Object.keys(m ?? {})) {
    if (!TOP.includes(k)) throw usage("UNKNOWN_FIELD", `the manifest has no field "${k}"`, { path: `/${k}`, candidates: TOP });
  }
  const defaults = m.defaults ?? {};
  for (const k of Object.keys(defaults)) if (!SHARED.includes(k)) throw usage("UNKNOWN_FIELD", `defaults cannot set "${k}"`, { path: `/defaults/${k}`, candidates: SHARED });
  if (!Array.isArray(m.specs) || m.specs.length === 0) throw usage("BATCH_EMPTY", "the manifest lists no specs", { path: "/specs" });
  if (m.specs.length > MAX_SPECS) throw usage("BATCH_TOO_LARGE", `the manifest lists ${m.specs.length} specs, above ${MAX_SPECS}`, { path: "/specs", fix: "split it into several manifests" });
  // Plan every entry first, then check all outputs against all inputs and each other, the contact
  // sheet included, before the first write: an entry that wrote first could otherwise replace a
  // file a later entry reads, and be caught only when that later entry runs.
  const plans = m.specs.map((entry, i) => {
    const name = typeof entry === "string" ? entry : entry?.spec;
    try {
      if (typeof name !== "string" || !name) throw usage("SPEC_INVALID", "each entry is a spec path or { spec, out }", { path: "" });
      if (typeof entry === "object") {
        for (const k of Object.keys(entry)) if (!["spec", "out"].includes(k)) throw usage("UNKNOWN_FIELD", `an entry has no field "${k}"`, { path: `/${k}`, candidates: ["spec", "out"] });
      }
      // A spec entry stays inside the manifest's folder too: a manifest from somebody else must not
      // pull in a spec from elsewhere and write beside it.
      const specPath = specOutputPath(base, name, ".json", "");
      const spec = { ...defaults, ...readJsonFile(specPath, name) };
      // A manifest's `out` is a path somebody else may have written, so it obeys the spec rule.
      if (typeof entry === "object" && entry.out !== undefined && (typeof entry.out !== "string" || !entry.out)) throw usage("SPEC_INVALID", "out is a file path", { path: "/out" });
      const out = typeof entry === "object" && entry.out ? specOutputPath(base, entry.out, ".png", "/out") : undefined;
      const opts = { specDir: dirname(specPath), specPath, out, inputs: [resolve(manifestPath)] };
      return { name, spec, opts, paths: planPaths(spec, opts) };
    } catch (e) {
      // Name the entry: a path inside one of twenty specs says nothing about which spec.
      if (e instanceof AnnotateError) {
        e.detail = `specs[${i}] (${name ?? "?"}): ${e.detail}`;
        e.message = `${e.code}: ${e.detail}`;
        // Every path thrown above is relative to the entry, so the prefix is added exactly once.
        e.path = `/specs/${i}${e.path?.startsWith("/") ? e.path : ""}`;
      }
      throw e;
    }
  });
  const sheetPath = m.sheet ? specOutputPath(base, m.sheet, ".png", "/sheet") : undefined;
  const allInputs = plans.flatMap((p) => p.paths.inputs);
  const allOutputs = [...plans.flatMap((p, i) => p.paths.outputs.map(([f, path]) => [`/specs/${i} ${f}`, path])), ...(sheetPath ? [["/sheet", sheetPath]] : [])];
  assertOutputsFree(allOutputs, allInputs);

  const rendered = [];
  const failed = [];
  for (const p of plans) {
    try {
      const r = await renderSpec(p.spec, p.opts);
      rendered.push({ spec: p.opts.specPath, out: r.output.path, sidecar: r.sidecar, style: r.style, warnings: r.warnings });
    } catch (e) {
      failed.push({ spec: p.name, error: e instanceof AnnotateError ? e.toJSON() : { code: "CRASH", detail: String(e?.message ?? e) } });
    }
  }
  const result = { ok: failed.length === 0, rendered, failed };
  if (sheetPath && rendered.length) {
    try {
      result.sheet = await sheetCommand(rendered.map((r) => r.sidecar), { out: sheetPath, zoom: opt.zoom ?? true });
    } catch (e) {
      // The figures are written; a failed sheet must not hide them, whatever kind of error it is.
      const err = e instanceof AnnotateError ? e : usage("INPUT_MISSING", `the contact sheet could not be written: ${e?.code ?? e?.message ?? e}`, { path: "/sheet" });
      err.result = result;
      throw err;
    }
  }
  return result;
}
