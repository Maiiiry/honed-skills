#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Purpose: annotate a screenshot from a JSON spec (steps, boxes, callouts, arrows, highlights,
//   spotlight, magnifier, solid redaction) in a clean or a hand-drawn rough.js style, prove the
//   result by reading it back, and hand off an editable Excalidraw file.
// Usage:
//   node scripts/annotate.mjs setup                         # once: fonts, Excalidraw bundle, OCR helper
//   node scripts/annotate.mjs render SPEC.json [--out OUT.png] [--excalidraw OUT.excalidraw] [--via-excalidraw OUT.png]
//   node scripts/annotate.mjs plan SPEC.json                # resolve and lay out, write nothing
//   node scripts/annotate.mjs schema                        # the spec as JSON Schema
//   node scripts/annotate.mjs locate IMG.png [--text "Save" | --regex RE | --all] [--nth N]
//   node scripts/annotate.mjs measure IMG.png --seed X,Y
//   node scripts/annotate.mjs capture --url URL --spec SPEC.json [--out OUT.png] [--viewport 1440x900] [--dpr 2]
//        [--full-page] [--click SELECTOR] [--wait-for SELECTOR] [--wait MS] [--color-scheme light|dark] [--channel chrome|msedge]
//        [--cdp URL [--signed-in]]
//   node scripts/annotate.mjs from-review RECEIPT.json --image IMG.png [--item N] [-o SPEC.json]
//   node scripts/annotate.mjs sheet A.annotated.json [B.annotated.json ...] -o SHEET.png [--zoom]
//   node scripts/annotate.mjs grid IMG.png -o GRID.png [--step 100]
//   node scripts/annotate.mjs batch MANIFEST.json
//   node scripts/annotate.mjs --selftest
// Output: one JSON line on stdout. Exit codes: 0 ok, 1 refused, 2 usage or spec error,
//   3 dependency missing (run setup), 4 proof or selftest failed, 5 crash (a bug: report it).
// Paths given on the command line resolve against the working directory; paths inside a spec or a
//   manifest resolve against that file's folder.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AnnotateError, EXIT, usage } from "./lib/errors.mjs";
import { readJsonFile } from "./lib/files.mjs";

// Flags that never take a value, so `--zoom -o SHEET.png` cannot read "-o" as the zoom value.
const BOOLEAN = new Set(["zoom", "full-page", "signed-in", "all"]);

function flags(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a.startsWith("--")) {
      const key = a === "-o" ? "out" : a.slice(2);
      if (BOOLEAN.has(key)) {
        opt[key] = true;
        continue;
      }
      // A missing value stays `true`, which every command refuses with "needs a value".
      const next = argv[i + 1];
      opt[key] = next === undefined || /^-[-a-z]/i.test(next) ? true : argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

const readJson = (p) => readJsonFile(p, "SPEC.json");

async function main(argv) {
  if (argv[0] === "--selftest") return (await import("./lib/selftest.mjs")).selftest();
  const [cmd, ...rest] = argv;
  const { pos, opt } = flags(rest);
  switch (cmd) {
    case "setup": {
      const { setup } = await import("./lib/setup.mjs");
      return setup(opt);
    }
    case "schema":
      return (await import("./lib/spec.mjs")).jsonSchema();
    case "render":
    case "plan": {
      if (!pos[0]) throw usage("USAGE", `${cmd} needs SPEC.json`);
      const specPath = resolve(pos[0]);
      const spec = readJson(specPath);
      for (const k of ["out", "excalidraw", "via-excalidraw"]) {
        if (opt[k] === true) throw usage("USAGE", `--${k} needs a file path`);
      }
      const { renderSpec } = await import("./lib/render.mjs");
      return renderSpec(spec, {
        out: opt.out,
        specDir: dirname(specPath),
        specPath,
        dryRun: cmd === "plan",
        excalidraw: opt.excalidraw && resolve(opt.excalidraw),
        viaExcalidraw: opt["via-excalidraw"] && resolve(opt["via-excalidraw"]),
      });
    }
    case "locate": {
      const { locateCommand } = await import("./lib/ocr.mjs");
      return locateCommand(pos[0], opt);
    }
    case "measure": {
      const { measureCommand } = await import("./lib/measure.mjs");
      return measureCommand(pos[0], opt);
    }
    case "capture": {
      const { captureCommand } = await import("./lib/capture.mjs");
      return captureCommand(opt);
    }
    case "from-review": {
      const { fromReviewCommand } = await import("./lib/review.mjs");
      return fromReviewCommand(pos[0], opt);
    }
    case "sheet": {
      const { sheetCommand } = await import("./lib/sheet.mjs");
      return sheetCommand(pos, opt);
    }
    case "grid": {
      const { gridCommand } = await import("./lib/sheet.mjs");
      return gridCommand(pos[0], opt);
    }
    case "batch": {
      const { batchCommand } = await import("./lib/batch.mjs");
      return batchCommand(pos[0], opt);
    }
    default:
      throw usage("USAGE", `unknown command "${cmd ?? ""}"`, {
        candidates: ["setup", "render", "plan", "schema", "locate", "measure", "capture", "from-review", "sheet", "grid", "batch", "--selftest"],
      });
  }
}

// process.exitCode, never process.exit(): exit() can cut off a stdout pipe mid-line, and the one
// JSON line is the whole interface.
main(process.argv.slice(2)).then(
  (result) => {
    if (result && result.selftestFailed) {
      process.stdout.write(`${JSON.stringify(result.summary)}\n`);
      process.exitCode = EXIT.PROOF;
      return;
    }
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
    // A batch reports its failed figures in the result; the exit status must say so too.
    if (result && result.ok === false) process.exitCode = EXIT.REFUSED;
  },
  (e) => {
    if (e instanceof AnnotateError) {
      const body = { ok: false, exit: e.exit, errors: [e.toJSON()] };
      if (e.result) body.result = e.result;
      process.stdout.write(`${JSON.stringify(body)}\n`);
      process.exitCode = e.exit;
      return;
    }
    // A package missing from node_modules is a skipped install, not a bug: exit 3 with the command.
    if (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      const skill = dirname(dirname(fileURLToPath(import.meta.url)));
      const pkg = /package '([^']+)'/.exec(String(e.message))?.[1] ?? "a dependency";
      const fix = `run: (cd "${skill}" && pnpm install --frozen-lockfile)`;
      process.stdout.write(`${JSON.stringify({ ok: false, exit: EXIT.DEPENDENCY, errors: [{ code: "DEPS_MISSING", detail: `${pkg} is not installed`, fix }] })}\n`);
      process.exitCode = EXIT.DEPENDENCY;
      return;
    }
    process.stdout.write(`${JSON.stringify({ ok: false, exit: EXIT.CRASH, errors: [{ code: "CRASH", detail: String(e?.message ?? e).split("\n")[0] }] })}\n`);
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exitCode = EXIT.CRASH;
  },
);
