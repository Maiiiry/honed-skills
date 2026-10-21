// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Every file this tool writes goes through here. Two rules, each from a reproduced defect:
//   - never onto an input. Paths are compared as FILES (device and inode), not as strings,
//     because a case-insensitive volume makes `Shot.PNG` the same file as `shot.png`;
//   - always fresh: write a temp file beside the target, then rename, so a crash never leaves a
//     half-written file and no old bytes survive past IEND (aCropalypse). The temp name is random
//     and opened exclusively, so a planted symlink at a predictable name cannot redirect the write.

import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { refused, usage } from "./errors.mjs";

// macOS and Windows volumes are case-insensitive by default, so two paths that do not exist yet
// are compared case-folded there: `Fig.png` and `fig.png` would become one file.
const FOLD = process.platform === "darwin" || process.platform === "win32";

/**
 * A path resolved through symlinks as far as it exists: the nearest existing ancestor is resolved
 * and the missing parts are appended. `link/new/x.png`, with `link` a symlink and `new` not yet
 * created, therefore resolves to where it will really be written.
 */
export function realPath(p) {
  let head = resolve(p);
  const tail = [];
  for (;;) {
    try {
      return resolve(realpathSync(head), ...tail.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(p);
      tail.push(basename(head));
      head = up;
    }
  }
}

const canonical = realPath;

export function sameFile(a, b) {
  const pa = resolve(a);
  const pb = resolve(b);
  if (pa === pb) return true;
  if (existsSync(pa) && existsSync(pb)) {
    const sa = statSync(pa);
    const sb = statSync(pb);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  }
  // Not written yet: compare through symlinked folders, so `link/x.png` and `real/x.png` collide.
  const ca = canonical(pa);
  const cb = canonical(pb);
  return ca === cb || (FOLD && ca.toLowerCase() === cb.toLowerCase());
}

/**
 * A user-named file, read whole only when it is a regular file of at most `max` bytes. A spec
 * from somebody else can name /dev/zero, which reads forever, or a FIFO, which never ends;
 * opened without blocking and checked on the open descriptor, neither is read at all.
 */
function readBounded(path, max, field) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    throw usage("INPUT_MISSING", `${field} cannot be read: ${e.code ?? "error"}`, { path: field });
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw usage("INPUT_MISSING", `${field} is not a regular file`, { path: field });
    if (st.size > max) throw refused("INPUT_TOO_LARGE", `${field} is larger than ${max} bytes`, { path: field, fix: "use a smaller file" });
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/**
 * The identities of a path, for a linear collision check: its real path (case-folded where the
 * volume folds case) and, when it exists, its device and inode. Two paths name one file exactly
 * when they share a key, the same answer sameFile gives pair by pair.
 */
export function fileKeys(p) {
  const abs = resolve(p);
  const c = canonical(abs);
  const keys = [`p:${FOLD ? c.toLowerCase() : c}`];
  if (existsSync(abs)) {
    const st = statSync(abs);
    keys.push(`i:${st.dev}:${st.ino}`);
  }
  return keys;
}

/** Read an input file a user named; a missing one is a usage error (exit 2), not a crash. */
export function readInputFile(path, field = "file") {
  if (!path || path === true) throw usage("USAGE", `${field} needs a file path`, { path: field });
  return readBounded(path, 256 * 2 ** 20, field);
}

/**
 * Read a JSON file a user supplied. A missing file or bad JSON is a usage error (exit 2), and the
 * message never quotes the file: a parse error that echoes the first characters of a file named
 * by somebody else's spec would print whatever that file holds.
 */
export function readJsonFile(path, field = "file") {
  const text = readBounded(path, 16 * 2 ** 20, field).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw usage("SPEC_INVALID", `${field} is not valid JSON`, { path: field, fix: "check it with a JSON linter" });
  }
}

export function assertNotInput(path, inputs, field = "/out") {
  for (const input of inputs) {
    if (input && sameFile(path, input)) {
      throw refused("OVERWRITE_INPUT", `${field} names a file this run reads`, { path: field, fix: "write next to it; inputs are evidence and stay untouched" });
    }
  }
}

/** A fresh, exclusively created temp file beside `path`. */
export function writeTemp(path, data) {
  // The output's folder is created when missing: a path from a spec or manifest has already passed
  // specOutputPath, and one from the command line is the user's own choice.
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    throw usage("INPUT_MISSING", `cannot create the folder for ${basename(path)}: ${e.code ?? "error"}`, { path: "/out" });
  }
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, data, { flag: "wx" });
  return tmp;
}

export function removeQuietly(path) {
  try { unlinkSync(path); } catch { /* already gone */ }
}

/** Write `data` to `path` through a temp file, refusing any path that is one of `inputs`. */
export function writeFresh(path, data, inputs = [], field = "/out") {
  assertNotInput(path, inputs, field);
  const tmp = writeTemp(path, data);
  try {
    renameSync(tmp, path);
  } catch (e) {
    removeQuietly(tmp);
    throw e;
  }
  return path;
}

/** `<stem>.rejected.png`, or a numbered variant when that name is an input. */
export function resolveRejectedPath(outPath, inputs) {
  const stem = outPath.replace(/\.png$/i, "");
  for (let n = 0; n < 100; n++) {
    const p = `${stem}.rejected${n ? `-${n}` : ""}.png`;
    if (!inputs.some((i) => i && sameFile(p, i))) return p;
  }
  throw refused("OVERWRITE_INPUT", "no free name for the rejected render", { fix: "choose another --out" });
}

/**
 * An output path that came from a spec or a manifest, not from the command line. It must keep the
 * expected extension and stay inside the spec's folder, so a spec handed over by someone else
 * cannot aim a write at an unrelated file.
 */
function linkBelow(baseDir, p) {
  let cur = resolve(baseDir);
  for (const part of relative(cur, resolve(p)).split(sep)) {
    if (!part) continue;
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      return false; // missing from here down: nothing below can be a link yet
    }
  }
  return false;
}

export function specOutputPath(baseDir, value, ext, field) {
  const p = resolve(baseDir, value);
  // Real paths on both sides, so a symlinked subfolder that leads out of the folder is outside,
  // also when the folders below it do not exist yet.
  const rel = relative(realPath(baseDir), realPath(p));
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  // No symlink at all between the folder and the file, live or dangling: a link that dangles now
  // can come alive once an earlier write of the same run creates its target, and lead out then.
  if (!p.toLowerCase().endsWith(ext) || !inside || linkBelow(baseDir, p)) {
    throw refused("OUTPUT_PATH_POLICY", `${field} must end in ${ext} and stay inside its folder, with no symlink on the way`, { path: field, fix: "pass the path on the command line instead, where it is your choice" });
  }
  return p;
}
