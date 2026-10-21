#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# The copyright holder is named in the LICENSE file of this skill.
"""Rebuild the example picture for this skill from the invented selftest scene.

Purpose: show a BASE and a DONOR capture, each with one tooltip, and the merge that holds both.
    Everything in it is drawn by selftest.py from a seeded scene; no real screenshot is involved.
Usage:
    python3 make_illustration.py OUT.png
    python3 make_illustration.py          (inside the repository: docs/assets/screenshot-overlays-example.png)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import overlays  # noqa: E402 - sibling modules, path set above
import selftest  # noqa: E402

import numpy as np  # noqa: E402 - overlays has already checked the dependency
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

# Three levels up is the repository root, which holds docs/assets.
ASSETS = Path(__file__).resolve().parents[3] / "docs" / "assets"
SCALE = 0.6
GAP = 24
LABEL = 44


def main() -> int:
    if len(sys.argv) > 1:
        out = Path(sys.argv[1])
    elif ASSETS.is_dir():
        out = ASSETS / "screenshot-overlays-example.png"
    else:
        print("make_illustration: give an output path; docs/assets is not here", file=sys.stderr)
        return 2
    base, donor, want, box = selftest.pair()
    al = overlays.align(base, donor)
    hit = [b for b in overlays.components(base, donor, al) if b.x0 <= box[0] and b.y0 <= box[1] and b.x1 >= box[2] and b.y1 >= box[3]]
    if len(hit) != 1:
        print(f"make_illustration: expected one donor component, found {hit}", file=sys.stderr)
        return 4
    merged, _ = overlays.merge(base, donor, al, [(hit[0].x0, hit[0].y0, hit[0].x1, hit[0].y1)], False)
    if not selftest.outside_ring_equal(merged, want, base):
        print("make_illustration: the merge differs from the expected picture", file=sys.stderr)
        return 4
    panels = [
        ("BASE: tooltip over row 4", base),
        ("DONOR: tooltip on row 2, which is tinted", donor),
        ("Merged: BASE plus the DONOR tooltip", merged),
    ]
    tiles = [
        Image.fromarray(a[..., :3].astype(np.uint8)).resize(
            (round(a.shape[1] * SCALE), round(a.shape[0] * SCALE)), Image.LANCZOS
        )
        for _, a in panels
    ]
    width = sum(t.width for t in tiles) + GAP * (len(tiles) + 1)
    height = max(t.height for t in tiles) + LABEL + GAP
    sheet = Image.new("RGB", (width, height), (245, 245, 242))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=20)
    x = GAP
    for (label, _), tile in zip(panels, tiles):
        draw.text((x, 12), label, fill=(30, 30, 30), font=font)
        sheet.paste(tile, (x, LABEL))
        x += tile.width + GAP
    sheet.save(out)
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
