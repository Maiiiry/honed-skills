// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// One heuristic for "this text could be a credential, an id worth hiding, or an email address".
// It finds those two shapes only: a name, a phone number or a street address passes as plain
// text, so redaction of personal data stays the caller's choice, never this sweep's.
// The spec validator uses it to refuse a secret typed as a literal, OCR uses it to mask listings,
// and the post-render sweep uses it to find a key left visible.

const SECRET_PREFIX = /^(sk[-_]|pk[-_]live|ghp_|gho_|ghs_|github_pat_|xox[abposr]-|AKIA|ASIA|AIza|eyJ|glpat-|-----BEGIN)/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function looksSecret(text) {
  // OCR keeps the punctuation around a word: "<jane@example.com>," is still an address.
  const t = String(text).trim().replace(/^[<>()[\]{},;:"']+|[<>()[\]{},;:"'.]+$/g, "");
  if (SECRET_PREFIX.test(t) || EMAIL.test(t)) return true;
  if (t.length < 16 || /\s/.test(t)) return false;
  return /[A-Za-z]/.test(t) && /\d/.test(t) && /^[\w\-+/=.]+$/.test(t);
}

/** True when any whitespace-separated token of `text` looks secret: "Owner jane@example.com" does. */
export const containsSecret = (text) => String(text).split(/\s+/).some(looksSecret);

export const maskText = (t) => (looksSecret(t) ? `[secret-like, ${String(t).length} chars]` : t);
