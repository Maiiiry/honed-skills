// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// One error type for every refusal, so the CLI can print the same JSON shape for all of them and an
// agent can correct the spec from `path`, `fix` and `candidates` without reading the code.

export const EXIT = Object.freeze({ OK: 0, REFUSED: 1, USAGE: 2, DEPENDENCY: 3, PROOF: 4, CRASH: 5 });

export class AnnotateError extends Error {
  /**
   * @param {string} code    stable machine code, listed in SKILL.md under "When it refuses"
   * @param {string} detail  one sentence for a human or an agent
   * @param {object} [more]  { exit, path, id, candidates, fix }
   */
  constructor(code, detail, more = {}) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
    this.exit = more.exit ?? EXIT.REFUSED;
    this.path = more.path;
    this.id = more.id;
    this.candidates = more.candidates;
    this.fix = more.fix;
  }

  toJSON() {
    const out = { code: this.code, detail: this.detail };
    for (const k of ["path", "id", "candidates", "fix"]) if (this[k] !== undefined) out[k] = this[k];
    return out;
  }
}

export const usage = (code, detail, more = {}) => new AnnotateError(code, detail, { ...more, exit: EXIT.USAGE });
export const refused = (code, detail, more = {}) => new AnnotateError(code, detail, { ...more, exit: EXIT.REFUSED });
export const missingDep = (code, detail, more = {}) =>
  new AnnotateError(code, detail, { ...more, exit: EXIT.DEPENDENCY });

/** Levenshtein distance, for did-you-mean suggestions on unknown kinds and fields. */
export function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

export function didYouMean(word, options) {
  // Suggestions are for typos in short names: the edit distance is quadratic in the lengths, so
  // a long name from somebody else's spec gets no suggestions rather than a stall.
  if (String(word).length > 64) return [];
  const ranked = options
    .slice(0, 500)
    .filter((o) => String(o).length <= 64)
    .map((o) => [o, editDistance(String(word).toLowerCase(), o.toLowerCase())])
    .filter(([, d]) => d <= Math.max(2, Math.floor(String(word).length / 3)))
    .sort((x, y) => x[1] - y[1]);
  return ranked.map(([o]) => o);
}
