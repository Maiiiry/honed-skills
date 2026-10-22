#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# The copyright holder is named in the LICENSE file of this skill.
"""Draw the example picture for this skill: one notification card and its thread, all invented.

Purpose: show the card pattern from references/patterns.md (state pill, even field grid, long text
    folded into a full-width box, one button) and a thread timeline beside it. Every name, number
    and date in it is made up here; nothing is a capture of a real workspace.
Usage:
    python3 make_illustration.py OUT.png
    python3 make_illustration.py          (inside the repository: docs/assets/blockkit-forge-example.png)
Needs Pillow 10.1 or later (for a sized default font). Only this script needs it.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ASSETS = Path(__file__).resolve().parents[3] / "docs" / "assets"
W, H = 1400, 600
BG, PANEL, LINE = (26, 29, 33), (34, 37, 41), (60, 64, 70)
TEXT, MUTED, LINK = (230, 232, 235), (160, 165, 172), (88, 166, 255)
MENTION_BG, MENTION = (29, 64, 99), (120, 185, 255)
PILL = {"In Process": ((60, 38, 92), (200, 160, 255))}

# The invented case. Nothing here comes from anywhere real.
CASE = {
    "header": "Northwind Ltd: Migrate the nightly reporting jobs",
    "context": "TCK-4821  ·  EMEA  ·  Created  Tue Oct 20, 2026, 09:14 UTC",  # last run italic
    "status": "In Process",
    "fields": [
        ("Requester", "@Alex Doe", True),
        ("Manager (cc)", "@Sam Lee", True),
        ("Owner", "@Kim Park", True),
        ("Priority", "Medium", False),
        ("Category", "Integrations", False),
        ("Due", "Fri Oct 30, 2026", False),
    ],
    "request": "We run 40 reporting jobs every night and want to move them to the new scheduler…",
}
# Each thread note is a list of segments: (kind, text). Kinds: text, person, code, time, arrow, body.
THREAD = [
    ("status", [("text", "Status"), ("code", "New"), ("arrow", ""), ("code", "In Process"),
                ("person", "@Kim Park"), ("time", "Wed Oct 21, 2026, 08:02 UTC")]),
    ("comment", [("person", "@Kim Park"), ("time", "Wed Oct 21, 2026, 10:40 UTC"),
                 ("body", "Call booked for Thursday. Please bring the job list.")]),
    ("reply", [("person", "@Alex Doe"), ("text", "replying to"), ("person", "@Kim Park"),
               ("time", "Wed Oct 21, 2026, 11:05 UTC"), ("body", "Attached. The two at 02:00 matter most.")]),
]
ICON = {"status": (88, 166, 255), "comment": (120, 200, 140), "reply": (230, 180, 90)}


def font(size: int) -> ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


def text(d: ImageDraw.ImageDraw, xy, s: str, size: int, fill=TEXT, bold: bool = False) -> int:
    f = font(size)
    d.text(xy, s, font=f, fill=fill, stroke_width=1 if bold else 0, stroke_fill=fill)
    return int(d.textlength(s, font=f))


def mention(d: ImageDraw.ImageDraw, xy, s: str, size: int) -> int:
    x, y = xy
    width = int(d.textlength(s, font=font(size)))
    d.rounded_rectangle((x - 3, y - 2, x + width + 3, y + size + 4), 4, fill=MENTION_BG)
    text(d, (x, y), s, size, MENTION)
    return width + 6


IMAGE: list[Image.Image] = []


def card(d: ImageDraw.ImageDraw, x: int, y: int, w: int) -> None:
    text(d, (x, y), CASE["header"], 22, bold=True)
    head, stamp = CASE["context"].rsplit("  ", 1)
    width = text(d, (x, y + 40), head + "  ", 16, MUTED)
    italic(IMAGE[0], (x + width, y + 40), stamp, 16)
    bg, fg = PILL[CASE["status"]]
    pw = int(d.textlength(CASE["status"], font=font(18))) + 18
    d.rounded_rectangle((x, y + 72, x + pw, y + 102), 6, fill=bg)
    text(d, (x + 9, y + 77), CASE["status"], 18, fg)
    for i, (label, value, is_person) in enumerate(CASE["fields"]):
        fx, fy = x + (i % 2) * (w // 2), y + 122 + (i // 2) * 62
        text(d, (fx, fy), label, 17, bold=True)
        (mention if is_person else lambda dd, xy, s, sz: text(dd, xy, s, sz))(
            d, (fx, fy + 26), value, 17
        )
    by = y + 322
    d.rounded_rectangle((x, by, x + w, by + 78), 12, outline=LINE, width=2, fill=PANEL)
    text(d, (x + 18, by + 14), "Request", 18, bold=True)
    text(d, (x + 18, by + 44), CASE["request"], 15, MUTED)
    text(d, (x + w - 28, by + 28), "›", 22, MUTED)
    d.rounded_rectangle((x, by + 100, x + 196, by + 138), 6, outline=LINE, width=2)
    text(d, (x + 16, by + 109), "Open in the record", 17, bold=True)
    d.line((x, by + 162, x + w, by + 162), fill=LINE, width=2)


def italic(image: Image.Image, xy, s: str, size: int, fill=MUTED) -> int:
    """The default font has no italic face, so the run is drawn upright and sheared."""
    f = font(size)
    width = int(ImageDraw.Draw(image).textlength(s, font=f)) + 8
    tile = Image.new("RGBA", (width, size + 8), (0, 0, 0, 0))
    ImageDraw.Draw(tile).text((4, 0), s, font=f, fill=fill)
    shear = 0.22
    tile = tile.transform(tile.size, Image.AFFINE, (1, shear, -shear * tile.size[1] / 2, 0, 1, 0))
    image.paste(tile, (int(xy[0]), int(xy[1])), tile)
    return width


def code(d: ImageDraw.ImageDraw, xy, s: str, size: int) -> int:
    x, y = xy
    width = int(d.textlength(s, font=font(size)))
    d.rounded_rectangle((x - 2, y - 2, x + width + 6, y + size + 4), 4, fill=(48, 52, 58), outline=LINE)
    text(d, (x + 2, y), s, size, (236, 150, 120))
    return width + 10


def arrow(d: ImageDraw.ImageDraw, x: int, y: int) -> int:
    d.line((x, y, x + 18, y), fill=MUTED, width=2)
    d.polygon([(x + 18, y - 5), (x + 26, y), (x + 18, y + 5)], fill=MUTED)
    return 32


def thread(image: Image.Image, d: ImageDraw.ImageDraw, x: int, y: int) -> None:
    text(d, (x, y), "Thread", 22, bold=True)
    yy = y + 52
    for kind, segments in THREAD:
        d.ellipse((x, yy + 2, x + 14, yy + 16), fill=ICON[kind])
        cx = x + 26
        body = []
        for seg, value in segments:
            if seg == "person":
                cx += mention(d, (cx, yy), value, 15) + 8
            elif seg == "code":
                cx += code(d, (cx, yy), value, 15) + 4
            elif seg == "arrow":
                cx += arrow(d, cx, yy + 9)
            elif seg == "time":
                cx += italic(image, (cx, yy), value, 15) + 8
            elif seg == "body":
                body.append(value)
            else:
                cx += text(d, (cx, yy), value, 15) + 8
        yy += 32
        for line in body:
            d.line((x + 26, yy - 2, x + 26, yy + 22), fill=LINE, width=3)
            text(d, (x + 38, yy), line, 15)
            yy += 32
        yy += 22
    for i, line in enumerate(("The cc tag was in the post, so it pinged. The other tags were added",
                              "by an edit right after it, which did not ping in our test.")):
        text(d, (x, yy + 4 + i * 22), line, 14, MUTED)


def main() -> int:
    if len(sys.argv) > 1:
        out = Path(sys.argv[1])
    elif ASSETS.is_dir():
        out = ASSETS / "blockkit-forge-example.png"
    else:
        print("make_illustration: give an output path; docs/assets is not here", file=sys.stderr)
        return 2
    image = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(image)
    IMAGE.append(image)
    d.rounded_rectangle((20, 20, 760, H - 20), 14, fill=PANEL)
    card(d, 48, 48, 690)
    d.rounded_rectangle((784, 20, W - 20, H - 20), 14, fill=PANEL)
    thread(image, d, 808, 48)
    image.save(out)
    print(f"wrote {out} ({W}x{H})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
