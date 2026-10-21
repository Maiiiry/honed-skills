// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// The spec is the contract between whoever decides what to mark (an agent, or a human through
// human-review) and the renderer. It is validated in full before any pixel is
// touched, and every error names the JSON path and offers the nearest valid word.

import { didYouMean, usage } from "./errors.mjs";
import { looksSecret, containsSecret } from "./secrets.mjs";
import { color } from "./tokens.mjs";

export const TARGET_FORMS = Object.freeze({
  box: "[x, y, w, h] in image pixels",
  css: "[x, y, w, h] in CSS pixels, multiplied by dpr",
  pct: "[x, y, w, h] as fractions 0..1 of the image (the form human-review returns)",
  point: "[x, y] in image pixels",
  ref: "id of a box in the refs file written at capture",
  text: 'visible text found by OCR: "Save", or {"regex": "^sk_"} for a secret you must not type',
  seed: "[x, y] in image pixels inside a flat-coloured element; flood fill finds its edges",
});
const TARGET_MODIFIERS = ["pad", "nth", "within"];
const own = (table, key) => typeof key === "string" && Object.hasOwn(table, key);
const MAX_PAD = 200; // CSS px; padding is for grazing a missed glyph, not for moving a mark
const MAX_REGEX = 200;
// Labels are drawn in the Latin subsets of Inter and Excalifont. Anything else would render as an
// empty box and still pass every check, so it is refused up front.
const LABEL_CHARS = /^[\u0020-\u007E\u00A0-\u00FF\u2018\u2019\u201C\u201D\u2026\u20AC\n]*$/;

const SIDES = ["auto", "N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const CORNERS = ["tl", "tr", "bl", "br"];

/** Allowed fields per kind, beyond the common ones. `true` marks a required field. */
export const KINDS = Object.freeze({
  box: { label: false, n: false, corner: false, side: false },
  ellipse: { label: false, n: false, corner: false, side: false },
  step: { n: true, label: false, outline: false, corner: false, side: false },
  callout: { label: true, outline: false, side: false, n: false, corner: false },
  arrow: { from: true, label: false, side: false },
  highlight: { label: false, side: false },
  underline: { label: false, side: false },
  spotlight: { targets: false, outline: false },
  redact: { fill: false },
  blur: { amount: false },
  magnify: { factor: false, side: false },
  text: { label: true },
});
const COMMON = ["id", "kind", "target", "color", "pad", "note"];
const TOP = ["version", "image", "out", "dpr", "refs", "style", "accent", "layout", "crop", "excalidraw", "annotations", "wobble", "note"];

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isQuad = (v) => Array.isArray(v) && v.length === 4 && v.every(isNum) && v[2] >= 0 && v[3] >= 0;
const isPair = (v) => Array.isArray(v) && v.length === 2 && v.every(isNum);

function unknownField(field, allowed, path) {
  const near = didYouMean(field, allowed);
  return usage("UNKNOWN_FIELD", `unknown field "${field}"`, {
    path,
    candidates: near.length ? near : allowed,
    fix: near.length ? `rename it to "${near[0]}"` : "remove it",
  });
}

/**
 * Why a pattern is refused, or undefined. A pattern runs synchronously against every OCR word, so
 * the grammar is narrowed to what cannot backtrack catastrophically: no quantified group (which
 * covers `(a+)+`, `((a+))+` and `(a|aa)+`), no backreference, at most 3 repeats of any kind, and
 * no `{n,m}` above 64, so adjacent bounded repeats cannot multiply into a hang either.
 * The grammar refuses the known catastrophic shapes; whatever slips through is bounded by the 2 s
 * worker deadline in ocr.mjs regexTestAll.
 */
export function unsafePattern(src) {
  if (typeof src !== "string" || !src) return "a non-empty pattern";
  if (src.length > MAX_REGEX) return `a pattern of at most ${MAX_REGEX} characters`;
  let repeats = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      if (/[1-9k]/.test(src[i + 1] ?? "")) return "a pattern without backreferences";
      i++;
      continue;
    }
    if (c === "[") {
      for (i++; i < src.length && src[i] !== "]"; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "(" && src[i + 1] === "?") {
      i++; // `(?:` and lookarounds: the `?` opens a group kind, it is not a repeat
      continue;
    }
    if (c === ")" && /[*+?{]/.test(src[i + 1] ?? "")) return "a pattern without a repeated group: quantify single characters or classes only";
    if (c === "*" || c === "+" || c === "?" || c === "{") {
      repeats++;
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (c === "{" && m && m[2] && (m[3] === "" || Number(m[3]) > 64)) return "a pattern whose {n,m} repeats stay at most 64";
    }
  }
  if (repeats > 3) return "a pattern with at most 3 repeats (*, +, ? or {n,m})";
  try {
    new RegExp(src, "i");
  } catch {
    return "a valid regular expression";
  }
  return undefined;
}

export function parseTarget(t, path, depth = 0) {
  if (!t || typeof t !== "object" || Array.isArray(t)) {
    throw usage("TARGET_INVALID", "a target is an object with exactly one form key", { path, candidates: Object.keys(TARGET_FORMS) });
  }
  const forms = Object.keys(t).filter((k) => own(TARGET_FORMS, k));
  for (const k of Object.keys(t)) {
    if (!own(TARGET_FORMS, k) && !TARGET_MODIFIERS.includes(k)) throw unknownField(k, [...Object.keys(TARGET_FORMS), ...TARGET_MODIFIERS], `${path}/${k}`);
  }
  if (forms.length !== 1) {
    throw usage("TARGET_INVALID", `a target needs exactly one form, found ${forms.length}`, { path, candidates: Object.keys(TARGET_FORMS) });
  }
  const form = forms[0];
  const v = t[form];
  const bad = (what) => usage("TARGET_INVALID", `"${form}" must be ${what}`, { path: `${path}/${form}`, fix: TARGET_FORMS[form] });
  if (["box", "css", "pct"].includes(form) && !isQuad(v)) throw bad("[x, y, w, h] with w and h >= 0");
  if (form === "pct" && !v.every((n) => n >= 0 && n <= 1)) throw bad("four fractions between 0 and 1");
  if (["point", "seed"].includes(form) && !isPair(v)) throw bad("[x, y]");
  if (form === "ref" && (typeof v !== "string" || !v)) throw bad("a non-empty id string");
  if (form === "text") {
    const okString = typeof v === "string" && v.trim();
    const okRegex = v && typeof v === "object" && typeof v.regex === "string";
    if (!okString && !okRegex) throw bad('a non-empty string or {"regex": "..."}');
    // A secret typed into a spec has already leaked into the transcript, the file and the shell
    // history. The detail names its length only.
    if (okString && v.length > MAX_REGEX) throw bad(`a text of at most ${MAX_REGEX} characters`);
    if (okString && containsSecret(v)) {
      throw usage("SECRET_LITERAL", `this ${v.length}-character text looks like a secret; never type one into a spec`, {
        path: `${path}/text`,
        fix: 'target it by a pattern of its visible prefix, e.g. {"regex": "^sk_"}, or by a box',
      });
    }
    if (okRegex) {
      const why = unsafePattern(v.regex);
      if (why) throw bad(why);
    }
  }
  // Negative padding would shrink a redaction to nothing and still report success.
  if (t.pad !== undefined && !(isNum(t.pad) && t.pad >= 0 && t.pad <= MAX_PAD)) throw usage("TARGET_INVALID", `pad is 0..${MAX_PAD} CSS px`, { path: `${path}/pad` });
  if (t.nth !== undefined && !(Number.isInteger(t.nth) && t.nth >= 1)) throw usage("TARGET_INVALID", "nth counts from 1", { path: `${path}/nth` });
  // Two levels of "within" are plenty to pick one of several matches; deeper nesting only costs a
  // full text search per level, and a spec from somebody else could nest thousands.
  if (t.within !== undefined && depth >= 2) throw usage("SPEC_INVALID", "within can nest at most 2 levels", { path: `${path}/within` });
  const within = t.within === undefined ? undefined : parseTarget(t.within, `${path}/within`, depth + 1);
  return { form, value: v, pad: t.pad ?? 0, nth: t.nth, within };
}

function parseAnnotation(a, i, ids) {
  const path = `/annotations/${i}`;
  if (!a || typeof a !== "object") throw usage("SPEC_INVALID", "an annotation is an object", { path });
  if (!own(KINDS, a.kind)) {
    const near = didYouMean(a.kind ?? "", Object.keys(KINDS));
    throw usage("UNKNOWN_KIND", `unknown kind "${a.kind}"`, { path: `${path}/kind`, candidates: near.length ? near : Object.keys(KINDS) });
  }
  const fields = KINDS[a.kind];
  const allowed = [...COMMON, ...Object.keys(fields)];
  for (const k of Object.keys(a)) if (!allowed.includes(k)) throw unknownField(k, allowed, `${path}/${k}`);
  for (const [k, req] of Object.entries(fields)) {
    if (req && a[k] === undefined) throw usage("SPEC_INVALID", `kind "${a.kind}" needs "${k}"`, { path: `${path}/${k}` });
  }
  const id = a.id ?? `a${i + 1}`;
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) throw usage("SPEC_INVALID", "id uses letters, digits and _ . : -", { path: `${path}/id` });
  if (ids.has(id)) throw usage("SPEC_INVALID", `id "${id}" is used twice`, { path: `${path}/id` });
  ids.add(id);

  const needsTarget = a.kind !== "spotlight" || a.targets === undefined;
  if (needsTarget && a.target === undefined) throw usage("SPEC_INVALID", `kind "${a.kind}" needs "target"`, { path: `${path}/target`, id });
  if (a.pad !== undefined && !(isNum(a.pad) && a.pad >= 0 && a.pad <= MAX_PAD)) throw usage("SPEC_INVALID", `pad is 0..${MAX_PAD} CSS px`, { path: `${path}/pad`, id });
  const out = { id, kind: a.kind, index: i, pad: a.pad };
  if (a.target !== undefined) out.target = parseTarget(a.target, `${path}/target`);
  if (a.targets !== undefined) {
    // Capped like annotations: each target can cost an OCR lookup.
    if (!Array.isArray(a.targets) || !a.targets.length || a.targets.length > 10) throw usage("SPEC_INVALID", "targets is an array of 1 to 10 targets", { path: `${path}/targets`, id });
    out.targets = a.targets.map((t, j) => parseTarget(t, `${path}/targets/${j}`));
  }
  if (a.from !== undefined) out.from = parseTarget(a.from, `${path}/from`);
  if (a.color !== undefined) {
    if (!color(a.color)) throw usage("SPEC_INVALID", "color is a palette name or #RRGGBB", { path: `${path}/color`, id, candidates: ["accent", "ok", "info", "note"] });
    out.color = a.color;
  }
  if (a.label !== undefined) {
    if (typeof a.label !== "string" || !a.label.trim()) throw usage("SPEC_INVALID", "label is non-empty text", { path: `${path}/label`, id });
    if (a.label.length > 120) throw usage("SPEC_INVALID", "label is over 120 characters; a figure label is 1 to 6 words", { path: `${path}/label`, id, fix: "move the detail into the caption" });
    if (!LABEL_CHARS.test(a.label)) throw usage("SPEC_INVALID", "label has characters the bundled Latin fonts cannot draw", { path: `${path}/label`, id, fix: "use Latin-1 text; other scripts would render as empty boxes" });
    out.label = a.label;
  }
  if (a.n !== undefined) {
    if (!(Number.isInteger(a.n) && a.n >= 0 && a.n <= 99)) throw usage("SPEC_INVALID", "n is a whole number 0..99", { path: `${path}/n`, id });
    out.n = a.n;
  }
  if (a.side !== undefined) {
    if (!SIDES.includes(a.side)) throw usage("SPEC_INVALID", `side is one of ${SIDES.join(", ")}`, { path: `${path}/side`, id });
    out.side = a.side;
  }
  if (a.corner !== undefined) {
    if (!CORNERS.includes(a.corner)) throw usage("SPEC_INVALID", `corner is one of ${CORNERS.join(", ")}`, { path: `${path}/corner`, id });
    out.corner = a.corner;
  }
  if (a.outline !== undefined) {
    if (typeof a.outline !== "boolean") throw usage("SPEC_INVALID", "outline is true or false", { path: `${path}/outline`, id });
    out.outline = a.outline;
  }
  if (a.fill !== undefined) {
    if (!color(a.fill)) throw usage("SPEC_INVALID", "fill is #RRGGBB", { path: `${path}/fill`, id });
    out.fill = a.fill;
  }
  if (a.factor !== undefined) {
    if (!(isNum(a.factor) && a.factor >= 1.25 && a.factor <= 6)) throw usage("SPEC_INVALID", "factor is 1.25..6", { path: `${path}/factor`, id });
    out.factor = a.factor;
  }
  if (a.amount !== undefined) {
    if (!(isNum(a.amount) && a.amount > 0 && a.amount <= 40)) throw usage("SPEC_INVALID", "amount is a blur radius 0..40 CSS px", { path: `${path}/amount`, id });
    out.amount = a.amount;
  }
  return out;
}

export function parseSpec(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw usage("SPEC_INVALID", "the spec is a JSON object", { path: "" });
  for (const k of Object.keys(raw)) if (!TOP.includes(k)) throw unknownField(k, TOP, `/${k}`);
  if (raw.version !== undefined && raw.version !== 1) throw usage("SPEC_INVALID", "version is 1", { path: "/version" });
  if (typeof raw.image !== "string" || !raw.image) throw usage("SPEC_INVALID", "image is the path of the PNG to annotate", { path: "/image" });
  for (const k of ["out", "refs", "excalidraw"]) {
    if (raw[k] !== undefined && (typeof raw[k] !== "string" || !raw[k])) throw usage("SPEC_INVALID", `${k} is a file path`, { path: `/${k}` });
  }
  // A floor too: every mark is sized in dpr units, so a dpr of 1e-9 would make the layout sample
  // a leader billions of times.
  if (raw.dpr !== undefined && !(isNum(raw.dpr) && raw.dpr >= 0.5 && raw.dpr <= 4)) throw usage("SPEC_INVALID", "dpr is a number from 0.5 to 4", { path: "/dpr" });
  if (raw.wobble !== undefined && !(Number.isInteger(raw.wobble) && raw.wobble >= 1)) throw usage("SPEC_INVALID", "wobble is a whole number from 1", { path: "/wobble" });
  const style = raw.style ?? "clean";
  if (!["clean", "sketch"].includes(style)) throw usage("SPEC_INVALID", 'style is "clean" or "sketch"', { path: "/style", candidates: ["clean", "sketch"] });
  const layout = raw.layout ?? "inline";
  if (!["inline", "frame"].includes(layout)) throw usage("SPEC_INVALID", 'layout is "inline" or "frame"', { path: "/layout" });
  if (raw.accent !== undefined && !color(raw.accent)) throw usage("SPEC_INVALID", "accent is #RRGGBB", { path: "/accent" });
  if (!Array.isArray(raw.annotations) || !raw.annotations.length) throw usage("SPEC_INVALID", "annotations is a non-empty array", { path: "/annotations" });
  if (raw.annotations.length > 30) throw usage("SPEC_INVALID", "more than 30 annotations; split the figure", { path: "/annotations" });
  let crop;
  if (raw.crop !== undefined && raw.crop !== "auto") crop = parseTarget(raw.crop, "/crop");
  const ids = new Set();
  const annotations = raw.annotations.map((a, i) => parseAnnotation(a, i, ids));
  // Two spotlights would dim each other's holes; one spotlight takes several targets instead.
  if (annotations.filter((a) => a.kind === "spotlight").length > 1) {
    throw usage("SPEC_INVALID", "at most one spotlight per figure", { path: "/annotations", fix: 'give one spotlight a "targets" array' });
  }
  return {
    version: 1,
    image: raw.image,
    out: raw.out,
    dpr: raw.dpr,
    refs: raw.refs,
    style,
    accent: raw.accent,
    layout,
    crop: raw.crop === "auto" ? "auto" : crop,
    excalidraw: raw.excalidraw,
    wobble: raw.wobble ?? 1,
    annotations,
  };
}

/**
 * A JSON Schema of the spec, generated from the same tables the validator uses. It carries the
 * shape and the numeric limits; a few cross-field rules (one spotlight, the label character set,
 * a secret-looking literal) are enforced by the validator only.
 */
export function jsonSchema() {
  const quad = { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 };
  const pair = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 };
  const formSchema = { box: quad, css: quad, pct: quad, point: pair, seed: pair, ref: { type: "string" }, text: { anyOf: [{ type: "string" }, { type: "object", properties: { regex: { type: "string" } }, required: ["regex"] }] } };
  const target = {
    type: "object",
    description: Object.entries(TARGET_FORMS).map(([k, v]) => `${k}: ${v}`).join("; "),
    properties: { ...formSchema, pad: { type: "number", minimum: 0, maximum: MAX_PAD }, nth: { type: "integer", minimum: 1 }, within: { $ref: "#/$defs/target" } },
    oneOf: Object.keys(TARGET_FORMS).map((k) => ({ required: [k] })),
    additionalProperties: false,
  };
  const FIELD_SCHEMA = {
    label: { type: "string", minLength: 1, maxLength: 120 },
    n: { type: "integer", minimum: 0, maximum: 99 },
    corner: { enum: CORNERS },
    side: { enum: SIDES },
    outline: { type: "boolean" },
    from: { $ref: "#/$defs/target" },
    targets: { type: "array", minItems: 1, maxItems: 10, items: { $ref: "#/$defs/target" } },
    fill: { type: "string" },
    amount: { type: "number", exclusiveMinimum: 0, maximum: 40 },
    factor: { type: "number", minimum: 1.25, maximum: 6 },
  };
  const ann = Object.entries(KINDS).map(([kind, fields]) => ({
    type: "object",
    properties: {
      kind: { const: kind },
      id: { type: "string" },
      target: { $ref: "#/$defs/target" },
      color: { type: "string" },
      pad: { type: "number", minimum: 0, maximum: MAX_PAD },
      note: { type: "string" },
      ...Object.fromEntries(Object.keys(fields).map((k) => [k, FIELD_SCHEMA[k]])),
    },
    required: ["kind", ...Object.entries(fields).filter(([, r]) => r).map(([k]) => k), ...(kind === "spotlight" ? [] : ["target"])],
    additionalProperties: false,
  }));
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "screenshot-callouts spec v1",
    type: "object",
    required: ["image", "annotations"],
    additionalProperties: false,
    properties: {
      version: { const: 1 },
      image: { type: "string" },
      out: { type: "string" },
      dpr: { type: "number", exclusiveMinimum: 0, maximum: 4 },
      refs: { type: "string" },
      style: { enum: ["clean", "sketch"] },
      accent: { type: "string" },
      layout: { enum: ["inline", "frame"] },
      crop: { anyOf: [{ const: "auto" }, { $ref: "#/$defs/target" }] },
      excalidraw: { type: "string" },
      wobble: { type: "integer", minimum: 1 },
      note: { type: "string" },
      annotations: { type: "array", items: { anyOf: ann }, minItems: 1, maxItems: 30 },
    },
    $defs: { target },
  };
}
