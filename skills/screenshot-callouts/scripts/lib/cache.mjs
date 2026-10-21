// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Where `setup` puts what it derives from the pinned packages: TTF fonts, the Excalidraw bundle and
// the compiled OCR helper. Everything here can be deleted and rebuilt with `annotate.mjs setup`.

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** The setup command with this install's absolute script path, so a fix string pastes as is. */
export const SETUP_FIX = `run: node "${join(dirname(fileURLToPath(import.meta.url)), "..", "annotate.mjs")}" setup`;

export function cacheDir() {
  return process.env.SCREENSHOT_CALLOUTS_CACHE || join(homedir(), ".cache", "screenshot-callouts");
}

/** Root folder of an installed package, found through its package.json. */
export function packageDir(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // Some packages do not export package.json; walk up from the main entry instead.
    let dir = dirname(require.resolve(name));
    while (!dir.endsWith(join("node_modules", ...name.split("/")))) {
      const up = dirname(dir);
      if (up === dir) throw new Error(`cannot locate package ${name}`);
      dir = up;
    }
    return dir;
  }
}
