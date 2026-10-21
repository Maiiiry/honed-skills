// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Size and colour tokens. Sizes are relative to the image width with a floor in CSS px x dpr, so
// every figure in a document set gets the same visual weight whatever its capture size. The ratios
// come from published style guides and prior art: stroke about 0.28% of width (GitLab 3 pt at
// <= 1000 px, commte 8 px at 2880), text about 1.5% of width, badge radius about W/80.

export const PALETTE = Object.freeze({
  accent: "#D92D20", // red: "look here". White text on it is 4.9:1.
  ok: "#2B8A3E", // green: only for "this is correct" next to a wrong one
  info: "#1864AB", // blue: neutral pointer when red would read as an error
  note: "#495057", // grey: secondary remarks
  highlight: "#FFD43B", // highlighter yellow, drawn with multiply blend
  redact: "#1F2328", // solid redaction fill
  halo: "#FFFFFF",
  dim: "#0B0D10", // spotlight shade
});

export function tokens(width, dpr) {
  const d = dpr ?? 1;
  // Sizes follow the image width, but only up to a multiple of the UI's own scale: a wide
  // monitor at 100% does not have larger text, and a badge sized from 2560 px alone covered
  // the neighbouring tabs of a 14 px nav bar.
  const stroke = Math.max(3 * d, Math.min(0.0028 * width, 5 * d));
  const font = Math.max(14 * d, Math.min(0.015 * width, 20 * d));
  return Object.freeze({
    dpr: d,
    stroke,
    halo: stroke * 0.9, // extra width on each side of a stroke, in white
    font,
    lineHeight: 1.25,
    badgeR: Math.max(13 * d, Math.min(width / 80, 18 * d)),
    head: stroke * 4.5,
    headAngle: (24 * Math.PI) / 180,
    pad: 6 * d, // gap between a target and the shape drawn around it
    radius: 8 * d,
    gap: 5 * d, // a leader tip stops this far outside its target
    breathing: 6 * d, // labels keep this far from any target
    margin: 16 * d, // labels keep this far from the image edge
    labelPadX: font * 0.55,
    labelPadY: font * 0.32,
    ringSteps: [16 * d, 36 * d, 72 * d, 120 * d],
    redactGrow: 2 * d,
    cropPad: 24 * d,
  });
}

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** WCAG 2.x relative luminance. */
export function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** White or near-black, whichever reads better on `bg`. One of them always clears 4.5:1. */
export function inkOn(bg) {
  const white = [255, 255, 255];
  const black = [0, 0, 0];
  return contrast(white, bg) >= contrast(black, bg) ? white : black;
}

/** Resolve a colour name or hex to RGB; undefined means "not a colour". */
export function color(name) {
  return parseHex(PALETTE[name] ?? name);
}

/**
 * How far a mark's stroke paints from its centre line: half the stroke, its white halo, a
 * device pixel of anti-aliasing and, in the sketch style, the pen's wobble. One copy, so layout
 * (which keeps targets clear of it) and drawing (which offsets an underline by it) agree.
 */
export function reach(T, style) {
  // The sketch wobble allowance is measured, not the pen's worst case: 2 px keeps a tight target
  // clean, while 6 px pushed a list row's box onto the rows above and below it.
  return T.stroke / 2 + T.halo + T.dpr + (style === "sketch" ? 2 * T.dpr : 0);
}
