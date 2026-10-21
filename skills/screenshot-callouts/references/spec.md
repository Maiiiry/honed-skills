# The spec, version 1

The renderer validates the whole spec before it touches a pixel. Every error carries the JSON path,
the annotation id, `candidates` and a `fix`. `node <skill-dir>/scripts/annotate.mjs schema` prints
the shape and the numeric limits as JSON Schema, generated from the validator's own tables. Rules
across fields (the regex grammar, the secret-literal rule, the label charset, one spotlight) are
checked by the validator only, and `selector` is a capture-only form the schema leaves out. Paths
inside a spec resolve against the spec's folder.

## Related context

- [../SKILL.md](../SKILL.md): which target form to choose, the redaction rule, the refusal codes.
- [editorial.md](editorial.md): what to mark and how to word it.

## Top level

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `image` | string, required | | PNG to annotate, relative to the spec file |
| `annotations` | array, required, 1 to 30 | | the marks, drawn in this order |
| `out` | string | `<spec stem>.annotated.png` beside the spec | output path. From a spec it must end in `.png` and stay inside the spec's folder (`OUTPUT_PATH_POLICY`); any path is allowed with `--out`. Refused if it is an input or another output |
| `dpr` | number from 0.5 to 4 | refs dpr, else the PNG pHYs hint | device pixels per CSS px. Required for `css` targets. Leave it out with a refs file: a different value is `DPR_MISMATCH` |
| `refs` | string | | refs file (from `capture`, or an agent-browser `--annotate --json` result) |
| `style` | `clean` or `sketch` | `clean` | the pen |
| `accent` | `#RRGGBB` | `#D92D20` | colour of every mark without its own `color` |
| `layout` | `inline` or `frame` | `inline` | labels on the image, or in an added side margin |
| `crop` | `"auto"` or a target | none | applied AFTER drawing, in source coordinates. `auto` = every mark plus a margin |
| `excalidraw` | string | | also write an editable `.excalidraw` here (same folder rule as `out`) |
| `wobble` | integer, 1 or more | 1 | a seed for the sketch strokes: change it to redraw every mark's wobble. A higher value is not rougher |
| `version` | 1 | 1 | |
| `note` | string | | free text, ignored |

## Targets

A target is an object with exactly one form key, plus optional modifiers.

| Form | Value | Unit |
| --- | --- | --- |
| `box` | `[x, y, w, h]` | image px |
| `css` | `[x, y, w, h]` | CSS px, multiplied by `dpr` |
| `pct` | `[x, y, w, h]`, each 0 to 1 | fractions of the image |
| `point` | `[x, y]` | image px |
| `ref` | `"id"` | a box in the refs file, with its origin and dpr applied |
| `text` | `"Visible words"` or `{"regex": "..."}` | OCR word boxes, joined across one line |
| `seed` | `[x, y]` | flood fill from that pixel, L1 tolerance 30 |
| `selector` | CSS or Playwright selector | only through `capture`, which turns it into a `ref` |

Modifiers: `pad` (0 to 200 CSS px, grows the box), `nth` (1-based, reading order, for an ambiguous
`text`), `within` (a target that the match's centre must lie in, nested at most 2 deep). A `text` literal is at most 200 characters, and a `regex` is at most 200
characters. It quantifies single characters or classes only, never a group (so no `(ab)+` and no
`(a|b)*`), has no backreference, has at most 3 repeats of any kind (`*`, `+`, `?`, `{n,m}`), and no
`{n,m}` above 64. It runs in a separate thread that is stopped after 2 seconds (`REGEX_TIMEOUT`).

`box` is both a target form (above) and an annotation kind (below). The two are unrelated: a `box`
kind can take any target form.

## Annotation kinds

Common fields: `id` (letters, digits, `_ . : -`; default `a1`, `a2`, ...), `kind`, `target`, `color`
(a palette name `accent`, `ok`, `info`, `note`, or `#RRGGBB`), `pad` (0 to 200 CSS px; on a
`redact` it grows the solid fill, which is how to cover a glyph the OCR box missed), `note`.

| Kind | Required | Optional | Draws |
| --- | --- | --- | --- |
| `box` | `target` | `label`, `n`, `corner`, `side` | rounded rectangle, badge if `n` |
| `ellipse` | `target` | `label`, `n`, `corner`, `side` | ellipse grown sideways |
| `step` | `target`, `n` | `label`, `outline` (false: badge only), `corner`, `side` | box plus number badge |
| `callout` | `target`, `label` | `outline` (true: also box the target), `side`, `n`, `corner` | label with a leader to the target |
| `arrow` | `target`, `from` | `label`, `side` | arrow from `from` to the target; with `label`, the label sits by `from`. Without one, the shaft may cross no target and no line of text |
| `highlight` | `target` | `label`, `side` | highlighter, multiply blend, text stays readable |
| `underline` | `target` | `label`, `side` | line under the target |
| `spotlight` | `target` or `targets` (1 to 10) | `outline` | dims everything except the targets; at most one per figure |
| `redact` | `target` | `fill` | solid fill into the pixels |
| `blur` | `target` | `amount` (CSS px, max 40) | de-emphasis only; refused over a secret-like token |
| `magnify` | `target` | `factor` (1.25 to 6), `side` | enlarged lens of the redacted base, dashed leader |
| `text` | `target`, `label` | | free text centred on the target |

`side`: `auto`, `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`. `corner`: `tl`, `tr`, `bl`, `br`. A label
is at most 120 characters of Latin-1, plus curly quotes, the ellipsis and the euro sign (the bundled fonts draw nothing else). Explicit `\n` breaks a
line, and longer labels wrap at 42% of the width.

## Tokens

Sizes follow the image width `W` and `dpr`, so a document set looks the same at any capture size:

| Token | Formula |
| --- | --- |
| stroke | `max(3 x dpr, 0.28% x W)` |
| label font | `max(14 x dpr, 1.5% x W)`; sketch x 1.4 |
| badge radius | `max(13 x dpr, W / 80)` |
| arrowhead | 4.5 x stroke, 24 degree half-angle |
| leader gap | 5 x dpr outside the target edge |
| redaction growth | 2 x dpr outward, after rounding out to whole pixels |

## The hand-off file

`<stem>.annotated.json` (and the same object on stdout) holds the fields below. In the file, every
path is relative to the file's own folder, and a file outside that folder is named by its file name
only; on stdout, paths are absolute. `sidecar` is the path of this hand-off file. `input`, `output` (path, sha256,
`pixels_sha256`, size), `base_sha256` (the redacted base), `dpr`, `style`, `layout`, `crop`, one entry
per annotation (`target.px`, `target.pct`, `target.source`, `shape`, `label_rect`, `leader`, `badge`),
`steps` (n, id, label in order), `alt_text` (a draft to edit), `proofs` and `warnings`.

## Refs file, version 1

```json
{ "version": 1, "image_sha256": "...", "dpr": 2, "units": "css",
  "origin": { "kind": "viewport", "x": 0, "y": 0 },
  "size": { "width": 1440, "height": 900 },
  "url": "https://example.com",
  "refs": { "s1": { "selector": "#save", "box": { "x": 1, "y": 2, "width": 3, "height": 4 }, "matches": 1 } } }
```

`version`, `image_sha256`, `dpr` (0.5 to 4), `units`, `origin`, `size` and `refs` are
required, and each ref needs a `box` with finite numbers and no negative size. `selector`, `matches`
(1 when present) and `url` are optional; any other field, such as an agent-browser `name`, is ignored
and never copied into the hand-off file. `origin` is `viewport`, `fullPage` (x, y = minus the
scroll at measurement) or `element`. The renderer refuses a refs file whose hash differs from the
PNG, whose `size x dpr` differs from the PNG by more than 1 px, or a ref whose `matches` is not 1.

`capture` keys its refs `s1`, `s2` and so on, in the order the selectors appear in the spec, and
rewrites the spec to match, so you never type those keys. It records no page text: no element name,
no value. For a redaction it writes the box only, no `selector`. For the page it records only the
origin, or for a `file:` URL only the file name, so the refs file holds no path.

An agent-browser `screenshot --annotate --json` result is also accepted, bare or in its
`{ "data": ... }` envelope. It carries no size, hash or dpr, so the spec must give `dpr`, and the one
check left is that every box lands inside the image.

## Batch manifest

```json
{ "defaults": { "style": "clean", "dpr": 2 },
  "specs": ["step-1.json", { "spec": "step-2.json", "out": "figures/step-2.png" }],
  "sheet": "guide.sheet.png" }
```

`specs` is required: each entry is a spec path, or `{ "spec", "out" }`. `defaults` may set `style`,
`accent`, `dpr`, `layout` and `wobble`; a spec's own value wins. `sheet` writes one contact sheet,
and only when it is set. Paths resolve against the manifest's folder, and every `spec`, `out` and `sheet` must stay inside
it, with no symlink on the way; a missing output folder is created. Any other field is refused (`UNKNOWN_FIELD`). Before the first write, every entry's
outputs are checked against every entry's inputs and outputs and the sheet; one collision refuses the
whole batch. A spec that fails its own checks is named by its index and path.

