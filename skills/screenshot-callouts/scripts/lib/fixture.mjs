// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// An invented settings screen, drawn from SVG so the tests and the selftest need no binary file and
// no real product. Every element's box is known exactly, in CSS px, which is the ground truth the
// target resolution and the proof are checked against. The value in the "Secret" field is a plain
// placeholder, not credential-shaped, so nothing here looks like a real key.

import { esc, resvgFontOptions } from "./fonts.mjs";

export const FIXTURE_CSS = Object.freeze({
  width: 1100,
  height: 620,
  boxes: {
    nav: [0, 102, 200, 34],
    name: [260, 202, 640, 34],
    hidden: [260, 270, 640, 34],
    write: [862, 329, 38, 22],
    ip: [862, 372, 38, 22],
    cancel: [690, 421, 96, 33],
    create: [796, 421, 104, 33],
  },
  hiddenText: "PLACEHOLDER-VALUE-0000-1111",
});

export function fixtureSvg(dpr = 2) {
  const { width: W, height: H, boxes: b } = FIXTURE_CSS;
  const r = (k, fill, stroke = "none", rx = 6) => {
    const [x, y, w, h] = b[k];
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}"/>`;
  };
  const t = (x, y, s, size = 14, weight = 400, fill = "#1d2330") =>
    `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(s)}</text>`;
  const toggle = (k, on) => {
    const [x, y, w, h] = b[k];
    const cx = on ? x + w - 11 : x + 11;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="11" fill="${on ? "#2350d8" : "#c9ced8"}"/><circle cx="${cx}" cy="${y + 11}" r="8" fill="#fff"/>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * dpr}" height="${H * dpr}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#f5f6f8"/>
<rect width="${W}" height="52" fill="#1f2a44"/>${t(20, 32, "Acme Console", 16, 700, "#fff")}${t(150, 32, "Projects", 14, 400, "#dfe3ea")}${t(230, 32, "Billing", 14, 400, "#dfe3ea")}
<rect x="0" y="52" width="200" height="568" fill="#fff"/><rect x="200" y="52" width="1" height="568" fill="#e3e6eb"/>
${t(20, 90, "General", 14, 400, "#47506a")}${r("nav", "#eef3ff", "none", 0)}<rect x="0" y="102" width="3" height="34" fill="#2350d8"/>${t(20, 124, "API keys", 14, 700, "#2350d8")}
${t(20, 158, "Members", 14, 400, "#47506a")}${t(20, 192, "Webhooks", 14, 400, "#47506a")}
${t(236, 96, "API keys", 22, 700)}${t(236, 120, "Keys let scripts call the Acme API.", 14, 400, "#6b7488")}
<rect x="236" y="150" width="688" height="330" rx="8" fill="#fff" stroke="#e3e6eb"/>
${t(260, 192, "Key name", 14, 700)}${r("name", "#fff", "#c9ced8")}${t(270, 224, "nightly-export")}
${t(260, 262, "Secret", 14, 700)}${r("hidden", "#f5f6f8", "#e3e6eb")}${t(270, 292, FIXTURE_CSS.hiddenText, 14, 400, "#1d2330")}
${t(260, 345, "Allow write access")}${toggle("write", true)}
${t(260, 388, "Restrict to IP allowlist")}${toggle("ip", false)}
${r("cancel", "#fff", "#2350d8")}${t(712, 443, "Cancel", 14, 700, "#2350d8")}
${r("create", "#2350d8")}${t(812, 443, "Create key", 14, 700, "#fff")}
</svg>`;
}

/** The fixture as RGBA pixels at the given device pixel ratio. */
export async function fixtureImage(dpr = 2) {
  const { Resvg } = await import("@resvg/resvg-js");
  const out = new Resvg(fixtureSvg(dpr), { font: resvgFontOptions() }).render();
  return { width: out.width, height: out.height, data: Buffer.from(out.pixels), kept: [], dprHint: undefined };
}

/** Fixture boxes in image pixels. */
export function fixtureBox(key, dpr = 2) {
  const [x, y, w, h] = FIXTURE_CSS.boxes[key];
  return { x: x * dpr, y: y * dpr, w: w * dpr, h: h * dpr };
}
