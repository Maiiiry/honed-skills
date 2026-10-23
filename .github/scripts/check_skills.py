"""Purpose: check every skill folder against the rules in CONTRIBUTING.md that a script can check.
Usage:   python3 .github/scripts/check_skills.py [repo root]   (exits 1 and lists every violation)

Checked: a SKILL.md with `name` and `description` frontmatter, `name` equal to the folder name, a
`description` of at most 1,024 characters (the Agent Skills specification's limit; claude.ai refuses a
longer one on upload), a LICENSE in the folder, no `allowed-tools` key, no `!`command`` injection
anywhere in SKILL.md, and no binary asset inside the skill folder.

Warned, not failed: a SKILL.md over 500 lines, the specification's recommendation for the main file.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

BINARY = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".mp4", ".mov", ".woff", ".woff2"}
# The `!`command`` form runs when an agent loads the skill. `$(...)` in a shell example does not.
SUBSTITUTION = re.compile(r"!`[^`]+`")
DESCRIPTION_MAX = 1024
LINES_MAX = 500


def frontmatter(text: str) -> dict[str, str] | None:
    """Top-level keys. Indented lines belong to the key above them, folded with spaces: a `>` or `|`
    block scalar (three skills here write `description: >-`, whose first line alone is two
    characters) and a plain or quoted scalar continued on the next lines alike."""
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    if end < 0:
        return None
    keys: dict[str, str] = {}
    last: str | None = None
    for line in text[4:end].splitlines():
        if line and not line.startswith((" ", "\t")) and ":" in line:
            key, value = line.split(":", 1)
            last, value = key.strip(), value.strip()
            keys[last] = "" if value[:1] in (">", "|") else value
        elif last and line.strip():
            keys[last] = f"{keys[last]} {line.strip()}".strip()
    return keys


def check(root: Path) -> list[str]:
    problems: list[str] = []
    skills = sorted(p for p in (root / "skills").iterdir() if p.is_dir())
    if not skills:
        return ["no skill folders found under skills/"]
    for skill in skills:
        md = skill / "SKILL.md"
        if not md.is_file():
            problems.append(f"{skill.name}: no SKILL.md")
            continue
        text = md.read_text(encoding="utf-8")
        meta = frontmatter(text)
        if meta is None:
            problems.append(f"{skill.name}: SKILL.md has no frontmatter")
            continue
        for key in ("name", "description"):
            if not meta.get(key):
                problems.append(f"{skill.name}: frontmatter has no {key}")
        if meta.get("name") and meta["name"] != skill.name:
            problems.append(f"{skill.name}: frontmatter name is {meta['name']!r}")
        if len(meta.get("description", "")) > DESCRIPTION_MAX:
            problems.append(f"{skill.name}: description is {len(meta['description'])} characters, "
                            f"over the specification's 1,024")
        if "allowed-tools" in meta:
            problems.append(f"{skill.name}: declares allowed-tools")
        body = text[text.find("\n---\n", 4) + 5 :]
        for line_no, line in enumerate(body.splitlines(), 1):
            if SUBSTITUTION.search(line):
                problems.append(f"{skill.name}: shell substitution in SKILL.md body line {line_no}")
        if not (skill / "LICENSE").is_file():
            problems.append(f"{skill.name}: no LICENSE in the skill folder")
        for f in skill.rglob("*"):
            if f.suffix.lower() in BINARY:
                problems.append(f"{skill.name}: binary asset {f.relative_to(skill)}; use docs/assets/")
    return problems


def warn(root: Path) -> list[str]:
    """What the specification recommends rather than requires: reported, never a failure."""
    warnings = []
    for md in sorted((root / "skills").glob("*/SKILL.md")):
        lines = md.read_text(encoding="utf-8").count("\n")
        if lines > LINES_MAX:
            warnings.append(f"{md.parent.name}: SKILL.md is {lines} lines, over the recommended {LINES_MAX} lines")
    return warnings


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
    problems = check(root)
    for w in warn(root):
        print(f"warning: {w}")
    for p in problems:
        print(p)
    print(f"checked {sum(1 for p in (root / 'skills').iterdir() if p.is_dir())} skills, "
          f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
