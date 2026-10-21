// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Layout to SVG. The base image is embedded once, already redacted, and every effect that shows
// image content (blur, magnifier) samples THAT base, so no lens can show a secret again.
// Each item also records its footprint: the rectangles its ink can reach. The proof checks that
// every pixel outside all footprints is exactly the base, so a footprint that is too small fails
// loudly instead of hiding a stray mark.

import { esc } from "./fonts.mjs";
import { grow, seedOf, union } from "./geometry.mjs";
import { pens } from "./pen.mjs";
import { color, inkOn, PALETTE, reach, toHex } from "./tokens.mjs";

const DIM_OPACITY = 0.58;

const f = (n) => Math.round(n * 100) / 100;

function textLines(lb, x0, fill, extra = "") {
  const { font, lines, padY } = lb;
  const lh = font.size * 1.25;
  return lines
    .map((line, i) => {
      const baseline = lb.rect.y + padY + i * lh + lh / 2 + font.size * 0.36;
      return `<text x="${f(x0)}" y="${f(baseline)}" font-family="${font.family}" font-size="${font.size}" font-weight="${font.weight}" fill="${fill}" xml:space="preserve"${extra}>${esc(line)}</text>`;
    })
    .join("");
}

export function buildSvg({ layout, base64, T, style, accent, imageSize, tile }) {
  const pen = pens[style];
  const { canvas, items } = layout;
  const accentHex = accent ?? PALETTE.accent;
  const sketch = style === "sketch";
  const unit = T.dpr;
  const defs = [];
  const layers = { blur: [], marker: [], dim: [], shape: [], redact: [], leader: [], label: [], badge: [] };
  const footprints = [];
  let spotlightCutouts = null;
  let spotlightDim = null;
  // The base image is embedded ONCE, in <defs>, and every use of it (the base, each blur, each
  // lens) points at it: one copy per annotation would multiply the SVG string and the
  // rasteriser's decodes by the annotation count.
  const baseDef = `<image id="sc-base" x="${f(imageSize.dx)}" y="${f(imageSize.dy)}" width="${imageSize.w}" height="${imageSize.h}" href="data:image/png;base64,${base64}" image-rendering="optimizeSpeed"/>`;
  const imageEl = (extra = "") => `<use href="#sc-base"${extra}/>`;
  const jitter = sketch ? 6 * unit : 0;
  const strokeReach = T.stroke / 2 + T.halo + 2 + jitter;

  for (const it of items) {
    const ink = toHex(color(it.color ?? accentHex));
    const seed = seedOf(`${it.id}|${it.kind}|${layout.seed ?? 1}`);
    const common = { color: ink, width: T.stroke, halo: T.halo, seed, unit, headLen: T.head, headAngle: T.headAngle };
    const fp = [];
    // rough.js bows a long edge further from its line than a short one.
    const inkReach = (r) => strokeReach + (sketch ? 0.02 * Math.max(r.w, r.h) : 0);
    switch (it.kind) {
      case "box":
      case "step":
        if (it.kind === "box" || it.outline !== false) {
          layers.shape.push(pen.rect(it.shape, { ...common, radius: T.radius }));
          fp.push(grow(it.shape, inkReach(it.shape)));
        }
        break;
      case "callout":
        if (it.outline) {
          layers.shape.push(pen.rect(it.shape, { ...common, radius: T.radius }));
          fp.push(grow(it.shape, inkReach(it.shape)));
        }
        break;
      case "ellipse": {
        const e = it.shape; // laid out by shapeFor, so layout, drawing and proof share one rect
        layers.shape.push(pen.ellipse(e, common));
        fp.push(grow(e, inkReach(e)));
        break;
      }
      case "highlight":
        layers.marker.push(pen.marker(it.shape, { ...common, color: PALETTE.highlight, radius: 3 * unit }));
        fp.push(grow(it.shape, 2 + jitter));
        break;
      case "underline": {
        // Below the text by the stroke's whole reach, so neither halo nor wobble clips a descender.
        // Plus the sketch line's own bow (a quarter of a leader's), which can swing toward the text.
        const ulBow = sketch ? Math.min(it.shape.w * 0.08, T.stroke * 6) * 0.25 : 0;
        const y = it.shape.y + it.shape.h + reach(T, style) + ulBow;
        // An underline hugs its text: a quarter of a leader's bow, which the footprint counts.
        layers.shape.push(pen.line([it.shape.x, y], [it.shape.x + it.shape.w, y], { ...common, bowScale: 0.25 }));
        fp.push(grow({ x: it.shape.x, y, w: it.shape.w, h: 0 }, strokeReach + T.stroke + (sketch ? T.stroke * 1.5 : 0)));
        break;
      }
      case "spotlight": {
        // A mask, not an even-odd path: two overlapping holes in an even-odd path fill their
        // overlap again, which dimmed part of a spotlit area (caught by the proof).
        const id = `spot-${defs.length}`;
        const holes = it.cutouts.map((c) => `<rect x="${f(c.x)}" y="${f(c.y)}" width="${f(c.w)}" height="${f(c.h)}" rx="${f(T.radius)}" fill="#000"/>`).join("");
        defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${canvas.width}" height="${canvas.height}"><rect width="${canvas.width}" height="${canvas.height}" fill="#fff"/>${holes}</mask>`);
        layers.dim.push(`<rect width="${canvas.width}" height="${canvas.height}" fill="${PALETTE.dim}" fill-opacity="${DIM_OPACITY}" mask="url(#${id})"/>`);
        if (it.outline !== false) {
          for (const c of it.cutouts) {
            layers.shape.push(pen.rect(c, { ...common, radius: T.radius }));
            // The outline's ring, not its whole rect: the hole's interior stays checked.
            // It runs from the stroke's outer reach to the checked interior, which is shrunk below.
            const o = grow(c, inkReach(c));
            const k = 2 * inkReach(c) + T.radius * 0.6 + 2;
            fp.push({ x: o.x, y: o.y, w: o.w, h: k }, { x: o.x, y: o.y + o.h - k, w: o.w, h: k });
            fp.push({ x: o.x, y: o.y, w: k, h: o.h }, { x: o.x + o.w - k, y: o.y, w: k, h: o.h });
          }
        }
        // Outside the holes every pixel must be the base under the shade. A band around each hole
        // (its rounded, anti-aliased edge) is left out of both checks.
        spotlightDim = { shade: PALETTE.dim, opacity: DIM_OPACITY, keepOut: it.cutouts.map((c) => grow(c, inkReach(c) + T.radius + 2)) };
        // Inside each hole only the base may show. A rounded outline reaches further inward at its
        // corners than along its edges, so the checked interior shrinks by that inset as well.
        spotlightCutouts = (spotlightCutouts ?? []).concat(it.cutouts.map((c) => grow(c, -(inkReach(c) + T.radius * 0.6 + 2))));
        break;
      }
      case "redact": {
        const r = it.pixelRect;
        layers.redact.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${toHex(color(it.fill ?? PALETTE.redact))}" shape-rendering="crispEdges"/>`);
        fp.push(r);
        break;
      }
      case "blur": {
        // The blur itself is baked into the base pixels before this SVG is built (png.mjs
        // blurRect); here it only claims its footprint.
        fp.push(grow(it.shape, 1));
        break;
      }
      case "magnify": {
        // The lens embeds only its source area (plus a pixel of margin), for the same reason.
        const lensTile = (src) => {
          const t = tile ? tile(grow(src, 1)) : null;
          return t ? `<image x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" href="data:image/png;base64,${t.b64}"/>` : `<use href="#sc-base" x="${f(-imageSize.dx)}" y="${f(-imageSize.dy)}"/>`;
        };
        const { rect: L, src: S, factor } = it.lens;
        const id = `lens-${defs.length}`;
        defs.push(`<clipPath id="${id}"><rect x="${f(L.x)}" y="${f(L.y)}" width="${f(L.w)}" height="${f(L.h)}" rx="${f(T.radius)}"/></clipPath>`);
        const tx = L.x - (S.x - imageSize.dx) * factor;
        const ty = L.y - (S.y - imageSize.dy) * factor;
        layers.shape.push(
          `<g clip-path="url(#${id})"><g transform="translate(${f(tx)} ${f(ty)}) scale(${f(factor)})">${lensTile(S)}</g></g>`,
          pen.rect(L, { ...common, radius: T.radius }),
          pen.rect(S, { ...common, width: T.stroke * 0.6, radius: T.radius / 2 }),
        );
        fp.push(grow(L, inkReach(L)), grow(S, inkReach(S)));
        break;
      }
      default:
        break;
    }

    if (it.leader) {
      const dash = it.kind === "magnify" ? `${f(T.stroke * 2)} ${f(T.stroke * 1.6)}` : undefined;
      // Leaders bow half as far as free strokes: a wide bow swings the shaft over neighbouring text.
      layers.leader.push(pen.arrow(it.leader.from, it.leader.to, { ...common, head: it.leader.head, dash, seed: seed + 101, bowScale: 0.5 }));
      const bow = sketch ? Math.min(Math.hypot(it.leader.to[0] - it.leader.from[0], it.leader.to[1] - it.leader.from[1]) * 0.08, T.stroke * 6) * 0.5 : 0;
      fp.push(grow(union([pt(it.leader.from), pt(it.leader.to)]), strokeReach + T.head + bow));
    }

    if (it.labelBox && it.kind !== "magnify") {
      const lb = it.labelBox;
      const R = lb.rect;
      if (sketch) {
        const tilt = ((seed % 400) / 100 - 2) * 0.9;
        const [cx, cy] = [R.x + R.w / 2, R.y + R.h / 2];
        const haloW = lb.font.size * 0.22;
        layers.label.push(
          // A soft paper patch behind the hand lettering: a halo alone let a card border run
          // between the letters and read as a strike-through.
          `<g transform="rotate(${f(tilt)} ${f(cx)} ${f(cy)})"><rect x="${f(R.x)}" y="${f(R.y)}" width="${f(R.w)}" height="${f(R.h)}" rx="${f(R.h / 2)}" fill="#FFFFFF" fill-opacity="0.88"/>${textLines(lb, R.x + lb.padX, ink, ` stroke="#FFFFFF" stroke-width="${f(haloW)}" stroke-linejoin="round" paint-order="stroke"`)}${textLines(lb, R.x + lb.padX, ink, ` stroke="${ink}" stroke-width="${f(lb.font.size * 0.035)}" stroke-linejoin="round"`)}</g>`,
        );
        it.labelInk = { text: ink, bg: "#FFFFFF" };
        fp.push(grow(R, haloW + Math.abs(tilt) * R.w * 0.0175 + 2));
      } else {
        const ink2 = toHex(inkOn(color(ink)));
        const radius = lb.lines.length === 1 ? R.h / 2 : T.radius;
        layers.label.push(
          `<rect x="${f(R.x)}" y="${f(R.y)}" width="${f(R.w)}" height="${f(R.h)}" rx="${f(radius)}" fill="${ink}" stroke="#FFFFFF" stroke-width="${f(T.halo * 0.6)}" filter="url(#shadow)"/>`,
          textLines(lb, R.x + lb.padX, ink2),
        );
        it.labelInk = { text: ink2, bg: ink, pill: true };
        fp.push(grow(R, T.halo + 4 * unit));
      }
    }

    if (it.badge) {
      const { cx, cy, r } = it.badge;
      const size = r * 1.15;
      const family = sketch ? "Excalifont" : "Inter";
      const weight = sketch ? 400 : 700;
      layers.badge.push(
        pen.circle(cx, cy, r, { ...common, fill: ink, halo: T.halo * 0.7, width: T.stroke * 0.5, seed: seed + 211 }),
        `<text x="${f(cx)}" y="${f(cy + size * 0.36)}" text-anchor="middle" font-family="${family}" font-size="${f(size)}" font-weight="${weight}" fill="${toHex(inkOn(color(ink)))}">${esc(String(it.n))}</text>`,
      );
      it.badgeInk = { text: toHex(inkOn(color(ink))), bg: ink };
      fp.push(grow({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, T.halo + 2 + jitter / 2));
    }
    // A footprint with a non-finite number means the mark drew nothing, and the proofs, which
    // compare pixels outside footprints, would pass on an unmarked image: a bug, said out loud.
    if (fp.some((r) => ![r.x, r.y, r.w, r.h].every(Number.isFinite))) throw new Error(`mark "${it.id}" (${it.kind}) computed non-finite geometry`);
    footprints.push(...fp.map((r) => ({ ...r, owner: it.id })));
  }

  defs.push(`<filter id="shadow" x="-20%" y="-30%" width="140%" height="170%"><feDropShadow dx="0" dy="${f(unit)}" stdDeviation="${f(1.5 * unit)}" flood-color="#000000" flood-opacity="0.22"/></filter>`);
  // Redaction last: nothing may ever paint over it, even if a layout bug let a mark reach it.
  const order = ["blur", "marker", "dim", "shape", "leader", "label", "badge", "redact"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><defs>${baseDef}${defs.join("")}</defs>${imageEl()}${order.map((k) => layers[k].join("")).join("")}</svg>`;
  return { svg, footprints, spotlightCutouts, spotlightDim };
}

const pt = ([x, y]) => ({ x, y, w: 0, h: 0 });
