# What to mark, and how to word it

These are distilled from published style guides and from the prior art read for this skill. The
renderer enforces the geometry. These rules are about judgement, so they stay here.

## Related context

- [../SKILL.md](../SKILL.md): the tool and the redaction rule.
- [spec.md](spec.md): the fields that carry these choices.

## Before you mark anything

- **Do not use a screenshot for text, code or logs.** A code block is searchable, copyable and
  accessible. If a picture is truly needed, render the snippet as a small HTML page at 26 px or more,
  from the real values, and capture that.
- **Crop tight, but never through text, a row or a table.** Use `crop: "auto"` or a target.
- **Hide what the reader must not see before capture.** Toasts, side panels, branch names, other
  people's data. `capture` fills redactions before its shot is written.
- **Count in the DOM before you claim something is absent.** It may be below the fold.
- **Record the capture date** next to the figure in a guide. UIs change monthly.

## How many marks

- A finding (a bug, a review comment): 1 box and 1 note.
- Instructions: one mark per step, at most 3 per figure, 2 on a phone shot. Split the figure if you
  need more. A numbered badge in the image matches a numbered step in the text. A redaction is not a
  mark: it explains nothing, so it does not count toward the limit.
- Never box a whole navigation bar or page. Mark the one item inside it.
- Mark a whole element, never part of one: an ellipse around half a field cuts through its border.
- Every mark carries a label or a number. An unlabelled underline asks a question it does not answer.
- A spotlight lights exactly what the label explains. Lighting a neighbour makes it compete.
- A spotlight dims the page, it does not hide it. Redact secrets in a spotlit figure too.

## Words

- 1 to 6 words, sentence case, facts not judgements: "Updated date is missing", not "Terrible".
- For something absent, box where it should be and write "X is missing".
- Do not repeat the caption inside the image. The caption explains, the image points.
- The alt text in the hand-off file is a draft. Name the screen in it before you publish.

## Colour

- One accent per document set. Red for "look here" is the common default (GitLab `#EE2604`, Adobe
  `#EB1000`, ours `#D92D20`).
- Green only for "this is correct" next to a wrong one. Blue when red would read as an error.
  Grey for secondary remarks. Never colour for decoration.
- Every stroke and label carries a white halo, so it reads on a dark sidebar and a white form alike
  (Adobe adds a white shadow for the same reason). WCAG 2.x SC 1.4.11 asks 3:1 for graphics; label
  text here is held to 4.5:1.

## Style choice

- `clean` for anything a customer reads.
- `sketch` for internal notes, reviews and chat, where "drawn on" signals "informal".
- Hand off as `.excalidraw` when a person will keep editing.

## Redaction

Solid fill only, whatever the request says. Blur and mosaic can be reversed on text. Depix and
Bishop Fox's Unredacter recover pixelated text; McPherson, Shokri and Shmatikov, "Defeating Image
Obfuscation with Deep Learning" (arXiv 1609.00408), defeated blur and mosaic alike. Google's
developer documentation style guide (Images) asks for "a solid-color overlay with 100% opacity".
A file can also carry the old pixels past its end: aCropalypse (CVE-2023-21036, CVE-2023-28303).

## Sources

Google developer documentation style guide (Images); GitLab documentation style guide (Images);
Adobe Experience League authoring guide (Screenshots); Dynatrace style guide (screenshot
annotations); github/awesome-copilot `image-annotations`; `alexanderop/app-screenshots`;
`commte/shot-annotate`; `k-yoneda0614/annotate-shot`. All read 2026-10-19.
