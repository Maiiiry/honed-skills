#!/usr/bin/env python3
"""Check that a .excalidraw scene kept every label and edge of the Mermaid flowchart it came from.

Purpose: a diagram redrawn from Mermaid can silently drop a node, an edge label or a whole edge, and
it still opens and looks finished. This reads the Mermaid source, reads the scene, and lists what
was kept, what is missing, and which arrows have no source edge. That list is the fidelity ledger.

Usage:
  python3 exfidelity.py SOURCE.mmd OUT.excalidraw [--json]
  python3 exfidelity.py --selftest

Exit 0 every label and edge kept, 1 something lost or an arrow with no source edge, 2 the source
cannot be read: not a flowchart or graph, a line no rule here understands, or no label at all.
Fail closed is the point: a line this parser skipped could be the edge that went missing.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from collections import Counter
from pathlib import Path

HEADER = re.compile(r"^(flowchart|graph|flowchart-elk)(\s+(TB|TD|BT|RL|LR))?\s*$", re.I)
IDENT = re.compile(r"\w+(?:-\w+)*")
EDGE_ID = re.compile(r"(\w+)@(?=[-=.<ox~])")
# Shape delimiters, longest opener first. A trapezoid opener may close with either slash.
SHAPES = [("(((", (")))",)), ("((", ("))",)), ("([", ("])",)), ("[[", ("]]",)),
          ("[(", (")]",)), ("{{", ("}}",)), ("[/", ("/]", "\\]")), ("[\\", ("\\]", "/]")),
          ("[", ("]",)), ("(", (")",)), ("{", ("}",)), (">", ("]",))]
# A link with no text, or with its text in pipes after it.
LINK = re.compile(r"(?P<l>[<ox])?(?P<body>-{2,}|={2,}|-\.+-)(?P<r>[>ox])?(?=[\s|\w\"]|$)")
INVISIBLE = re.compile(r"~{3,}")
# A link with its text inside: -- text -->, == text ==>, -. text .->
# Spaces around the text are optional (`A --text--> B`), but the text may not start with a
# second dash, `=`, `.` or `>` (that is a plain link) or with `o ` or `x ` (a circle or cross head).
TEXT_LINK = re.compile(r"(?P<l>[<ox])?(?P<open>--|==|-\.)(?![-=.>])(?![ox]\s)\s*"
                       r"(?P<text>\"[^\"]*\"|.+?)\s*"
                       r"(?P<close>-{2,}|={2,}|\.+-)(?P<r>[>ox])?(?=[\s\w\"]|$)")
# A keyword statement, but not a node that happens to be named `style` or `click`: the keyword
# must not be followed by a link.
IGNORED = re.compile(r"^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)"
                     r"(\s*:|\s+(?![-=.<~]|[ox]-))")


class Unparsed(Exception):
    """A line no rule understands. Raised, never skipped."""


# ---------------------------------------------------------------- normalising

def normalise(text: str) -> str:
    """One comparable form for a Mermaid label and an Excalidraw text: entities decoded (Mermaid
    writes them as #quot; and #35;), <br> and newlines as spaces, Markdown markers and quotes
    dropped, whitespace collapsed, lower case. Excalidraw wraps a long label onto several lines,
    so a newline has to compare equal to a space."""
    text = re.sub(r"#(\w+);", lambda m: html.unescape(
        f"&#{m.group(1)};" if m.group(1).isdigit() else f"&{m.group(1)};"), text)
    text = html.unescape(text)
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.I)
    text = re.sub(r"[`*_\"]", "", text)
    return " ".join(text.split()).lower()


# ---------------------------------------------------------------- Mermaid

def statements(source: str) -> list[tuple[int, str]]:
    """Split into statements on newlines and `;` outside quotes, so a quoted label that spans
    lines (a Markdown string) stays one statement. Comments, directives and frontmatter go."""
    lines = source.splitlines()
    if lines and lines[0].strip() == "---":
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        if end is None:
            raise Unparsed("line 1: frontmatter opened with --- and never closed")
        lines = [""] * (end + 1) + lines[end + 1:]
    out, buf, quoted, start = [], [], False, 1
    for number, line in enumerate(lines, 1):
        stripped = line.strip()
        if not quoted and (stripped.startswith("%%") or not stripped):
            continue
        if not buf:
            start = number
        for ch in line:
            if ch == '"':
                quoted = not quoted
            if ch == ";" and not quoted:
                if "".join(buf).strip():
                    out.append((start, "".join(buf).strip()))
                buf, start = [], number
                continue
            buf.append(ch)
        if quoted:
            buf.append("\n")
            continue
        if "".join(buf).strip():
            out.append((start, "".join(buf).strip()))
        buf = []
    if quoted:
        raise Unparsed(f"line {start}: a quote is never closed")
    return out


def read_quoted_or_until(text: str, pos: int, closers: tuple[str, ...]) -> tuple[str, int]:
    """The label body from pos up to the closer, quote-aware. Returns (label, index after it)."""
    if pos < len(text) and text[pos] == '"':
        end = text.find('"', pos + 1)
        if end < 0:
            raise Unparsed("a quoted label is never closed")
        label, pos = text[pos + 1:end], end + 1
        for closer in closers:
            if text.startswith(closer, pos):
                return label, pos + len(closer)
        raise Unparsed(f"a quoted label is not followed by {closers[0]}")
    best = None
    for closer in closers:
        at = text.find(closer, pos)
        if at >= 0 and (best is None or at < best[0]):
            best = (at, closer)
    if best is None:
        raise Unparsed(f"a shape opened and {closers[0]} never closes it")
    return text[pos:best[0]], best[0] + len(best[1])


def shape_data_label(body: str) -> str | None:
    """The label out of `@{ shape: rect, label: "Text" }`."""
    m = re.search(r"\blabel\s*:\s*(\"(?P<q>[^\"]*)\"|(?P<u>[^,}]*))", body)
    if not m:
        return None
    return (m.group("q") if m.group("q") is not None else m.group("u")).strip()


def read_node(text: str, pos: int, nodes: dict, order: list) -> tuple[str, int]:
    """One node: an id, then an optional shape with a label, or @{...}, then optional :::class."""
    m = IDENT.match(text, pos)
    if not m:
        raise Unparsed(f"expected a node id at {text[pos:pos + 20]!r}")
    nid, pos = m.group(0), m.end()
    if nid not in nodes:
        nodes[nid] = None
        order.append(nid)
    if text.startswith("@{", pos):
        close = find_brace(text, pos + 1)
        label = shape_data_label(text[pos + 2:close])
        if label is not None:
            nodes[nid] = label
        pos = close + 1
    else:
        for opener, closers in SHAPES:
            if text.startswith(opener, pos):
                label, pos = read_quoted_or_until(text, pos + len(opener), closers)
                nodes[nid] = label
                break
    if text.startswith(":::", pos):
        m = re.compile(r":::" + IDENT.pattern).match(text, pos)
        if not m:
            raise Unparsed("a ::: class with no name")
        pos = m.end()
    return nid, pos


def find_brace(text: str, open_at: int) -> int:
    quoted = False
    for i in range(open_at + 1, len(text)):
        if text[i] == '"':
            quoted = not quoted
        elif text[i] == "}" and not quoted:
            return i
    raise Unparsed("@{ is never closed")


def skip_space(text: str, pos: int) -> int:
    while pos < len(text) and text[pos].isspace():
        pos += 1
    return pos


def read_group(text: str, pos: int, nodes: dict, order: list) -> tuple[list[str], int]:
    """`A & B & C`: one or more nodes joined by &."""
    group = []
    while True:
        nid, pos = read_node(text, skip_space(text, pos), nodes, order)
        group.append(nid)
        after = skip_space(text, pos)
        if text.startswith("&", after):
            pos = after + 1
            continue
        return group, pos


def read_link(text: str, pos: int):
    """(label or None, visible, both-ways, directed, index after) or None when no link starts."""
    m = EDGE_ID.match(text, pos)
    if m:
        pos = m.end()
    m = INVISIBLE.match(text, pos)
    if m:
        return None, False, False, False, m.end()
    m = TEXT_LINK.match(text, pos)
    if m:
        label = m.group("text").strip().strip('"')
        both = m.group("l") == "<" and m.group("r") == ">"
        return label, True, both, m.group("r") is not None, m.end()
    m = LINK.match(text, pos)
    if not m:
        return None
    both = m.group("l") == "<" and m.group("r") == ">"
    # Any head keeps the direction: `--o` and `--x` point at their target like `-->` does.
    directed = m.group("r") is not None
    end = m.end()
    after = skip_space(text, end)
    label = None
    if text.startswith("|", after):
        close = text.find("|", after + 1)
        if close < 0:
            raise Unparsed("a |label| is never closed")
        label = text[after + 1:close].strip().strip('"')
        end = close + 1
    return label, True, both, directed, end


def parse_mermaid(source: str) -> dict:
    """{nodes: {id: label}, edges: [(a, b, label, directed)], subgraphs: [label]}."""
    stmts = statements(source)
    if not stmts:
        raise Unparsed("the source is empty")
    number, first = stmts[0]
    if not HEADER.match(first):
        kind = first.split()[0] if first.split() else first
        raise Unparsed(f"line {number}: {kind!r} is unsupported; only flowchart and graph are read")
    nodes: dict[str, str | None] = {}
    order: list[str] = []
    edges: list[tuple[str, str, str | None, bool]] = []
    edge_ids: set[str] = set()
    subgraphs: list[str] = []
    depth = 0
    in_acc_block = False
    for number, stmt in stmts[1:]:
        if in_acc_block:
            if stmt.endswith("}"):
                in_acc_block = False
            continue
        if re.match(r"^accDescr\s*\{", stmt):
            in_acc_block = not stmt.endswith("}")
            continue
        if IGNORED.match(stmt):
            continue
        if stmt == "end":
            depth -= 1
            if depth < 0:
                raise Unparsed(f"line {number}: `end` with no open subgraph")
            continue
        m = re.match(r"^subgraph\s+(.+)$", stmt)
        if m:
            depth += 1
            rest = m.group(1).strip()
            sm = re.match(r"^(" + IDENT.pattern + r")\s*\[(.*)\]$", rest, re.S)
            if sm:
                subgraphs.append(sm.group(2).strip().strip('"'))
            else:
                subgraphs.append(rest.strip('"'))
            continue
        em = re.match(r"^(\w+)@\{(.*)\}$", stmt, re.S)
        if em and em.group(1) in edge_ids:
            continue                           # edge metadata such as { animate: true }
        try:
            pos = 0
            for m in EDGE_ID.finditer(stmt):
                edge_ids.add(m.group(1))
            group, pos = read_group(stmt, pos, nodes, order)
            while True:
                pos = skip_space(stmt, pos)
                if pos >= len(stmt):
                    break
                link = read_link(stmt, pos)
                if link is None:
                    raise Unparsed(f"cannot read {stmt[pos:pos + 30]!r}")
                label, visible, both, directed, pos = link
                target, pos = read_group(stmt, skip_space(stmt, pos), nodes, order)
                if visible:
                    for a in group:
                        for b in target:
                            edges.append((a, b, label, directed or both))
                            if both:
                                edges.append((b, a, None, True))
                group = target
        except Unparsed as exc:
            raise Unparsed(f"line {number}: {exc}: {stmt!r}") from None
    if depth:
        raise Unparsed("a subgraph is never closed with `end`")
    labels = {nid: (nodes[nid] if nodes[nid] is not None else nid) for nid in order}
    return {"nodes": labels, "edges": edges, "subgraphs": subgraphs}


# ---------------------------------------------------------------- the scene

def name_of(text: str) -> str:
    """A shape or arrow label without its bracketed type or technology lines, normalised. exdraw
    writes `Orders API` plus `[Container: Python]`; the source only knows `Orders API`."""
    kept = [line for line in text.split("\n")
            if not (line.strip().startswith("[") and line.strip().endswith("]"))]
    return normalise("\n".join(kept))


def read_scene(scene: object) -> dict:
    """The scene, validated: a wrong shape is unreadable (exit 2), never a crash."""
    elements = scene.get("elements") if isinstance(scene, dict) else None
    if not isinstance(elements, list) or not all(isinstance(e, dict) for e in elements):
        raise Unparsed("the scene is not an object with an `elements` list of objects")
    elements = [e for e in elements if not e.get("isDeleted")]
    arrow_ids = {e.get("id") for e in elements if e.get("type") == "arrow"}
    texts, shape_name, arrow_label = [], {}, {}
    for e in elements:
        if e.get("type") != "text":
            continue
        raw = str(e.get("text") or "")
        texts.append(normalise(raw))
        owner = e.get("containerId")
        if owner in arrow_ids:
            arrow_label[owner] = name_of(raw)
        elif owner:
            shape_name[owner] = name_of(raw)
    arrows = []
    for e in elements:
        if e.get("type") != "arrow":
            continue
        ends = [e[side].get("elementId") if isinstance(e.get(side), dict) else None
                for side in ("startBinding", "endBinding")]
        arrows.append({"id": e.get("id"), "start": ends[0], "end": ends[1],
                       "label": arrow_label.get(e.get("id"), "")})
    return {"texts": texts, "shape_name": shape_name, "arrows": arrows}


def contains_words(haystack: str, needle: str) -> bool:
    """needle occurs in haystack on word boundaries, so `orders` is in `submits orders` and not in
    `reorders`. Used for edge and subgraph labels only; a node needs an exact shape label."""
    pattern = r"(?<!\w)" + re.escape(needle) + r"(?!\w)"
    return bool(needle) and re.search(pattern, haystack) is not None


def check(source: dict, scene: dict) -> dict:
    """Nodes map one-to-one onto shapes by EXACT bound label; an edge needs an arrow between the
    two mapped shapes, carrying its label; a subgraph title needs one text. Anything that maps to
    more than one candidate is reported as ambiguous and fails, never passes."""
    node_labels = {nid: normalise(text) for nid, text in source["nodes"].items()}
    edge_labels = [normalise(lbl) for _, _, lbl, _ in source["edges"] if lbl]
    sub_labels = [normalise(text) for text in source["subgraphs"] if text]
    total = len(node_labels) + len(edge_labels) + len(sub_labels)
    if not any(node_labels.values()) and not any(edge_labels) and not any(sub_labels):
        raise Unparsed("no label read from the source; refusing a vacuous pass")
    kept, missing, ambiguous = [], [], []

    by_label: dict[str, list[str]] = {}
    for nid, norm in node_labels.items():
        by_label.setdefault(norm, []).append(nid)
    shapes_named: dict[str, list[str]] = {}
    for sid, name in scene["shape_name"].items():
        shapes_named.setdefault(name, []).append(sid)
    node_shape: dict[str, str] = {}
    for norm, nids in by_label.items():
        sids = shapes_named.get(norm, []) if norm else []
        for nid in nids:
            entry = {"kind": "node", "ref": nid, "label": norm}
            if len(nids) == 1 and len(sids) == 1:
                node_shape[nid] = sids[0]
                kept.append(entry)
            elif not sids:
                missing.append(entry)
            else:
                ambiguous.append(dict(entry, candidates=sorted(sids)))

    used: set[str] = set()
    kept_edges, missing_edges = [], []
    for a, b, lbl, directed in source["edges"]:
        sa, sb, norm = node_shape.get(a), node_shape.get(b), normalise(lbl or "")
        entry = {"from": a, "to": b, "directed": directed}
        candidates = [ar for ar in scene["arrows"] if ar["id"] not in used and sa and sb and (
            (ar["start"] == sa and ar["end"] == sb)
            or (not directed and ar["start"] == sb and ar["end"] == sa))]
        hit = next((ar for ar in candidates if norm and contains_words(ar["label"], norm)),
                   candidates[0] if candidates else None)
        if hit:
            used.add(hit["id"])
            kept_edges.append(dict(entry, arrow=hit["id"]))
        else:
            missing_edges.append(entry)
        if norm:
            label_entry = {"kind": "edge", "ref": f"{a}->{b}", "label": norm}
            # Compared with the matched arrow's OWN label, so two swapped labels both fail.
            ok = hit is not None and contains_words(hit["label"], norm)
            (kept if ok else missing).append(label_entry)

    for norm in sub_labels:
        entry = {"kind": "subgraph", "ref": norm, "label": norm}
        exact = [t for t in scene["texts"] if name_of(t) == norm]
        loose = [t for t in scene["texts"] if contains_words(t, norm)]
        if exact or len(loose) == 1:
            kept.append(entry)
        elif loose:
            ambiguous.append(dict(entry, candidates=sorted(set(loose))))
        else:
            missing.append(entry)

    extra = [ar["id"] for ar in scene["arrows"] if ar["id"] not in used]
    ok = not missing and not ambiguous and not missing_edges and not extra
    return {"verdict": "pass" if ok else "fail",
            "counts": {"labels": total, "labels_kept": len(kept),
                       "labels_ambiguous": len(ambiguous),
                       "edges": len(source["edges"]), "edges_kept": len(kept_edges),
                       "arrows": len(scene["arrows"]), "arrows_without_source": len(extra)},
            "kept": {"labels": kept, "edges": kept_edges},
            "missing": {"labels": missing, "edges": missing_edges},
            "ambiguous": ambiguous,
            "arrows_without_source": extra}


def run(source_text: str, scene: dict) -> tuple[int, dict]:
    try:
        report = check(parse_mermaid(source_text), read_scene(scene))
    except Unparsed as exc:
        return 2, {"verdict": "unreadable", "error": str(exc)}
    return (0 if report["verdict"] == "pass" else 1), report


# ---------------------------------------------------------------- self-test

def selftest() -> int:
    failures: list[str] = []
    checked = [0]

    def parses(name: str, src: str, nodes=None, edges=None, subgraphs=None) -> None:
        checked[0] += 1
        try:
            got = parse_mermaid(src)
        except Unparsed as exc:
            failures.append(f"{name}: raised {exc}")
            return
        # Values hoisted out of the f-strings: a nested quote inside one opens a span a bounded
        # static parser cannot close (see exlint.py, case()).
        pairs = sorted((a, b) for a, b, _, _ in got["edges"])
        got_nodes, got_subgraphs = got["nodes"], got["subgraphs"]
        if nodes is not None and got_nodes != nodes:
            failures.append(f"{name}: nodes {got_nodes} != {nodes}")
        if edges is not None and pairs != sorted(edges):
            failures.append(f"{name}: edges {pairs} != {sorted(edges)}")
        if subgraphs is not None and got_subgraphs != subgraphs:
            failures.append(f"{name}: subgraphs {got_subgraphs} != {subgraphs}")

    def refuses(name: str, src: str) -> None:
        checked[0] += 1
        try:
            parse_mermaid(src)
        except Unparsed:
            return
        failures.append(f"{name}: parsed, but must exit 2")

    def label_of(src: str, nid: str) -> str:
        return normalise(parse_mermaid(src)["nodes"][nid])

    parses("plain chain", "flowchart LR\n  A --> B --> C", edges=[("A", "B"), ("B", "C")])
    parses("ampersand fan", "graph TD\nA & B --> C & D",
           edges=[("A", "C"), ("A", "D"), ("B", "C"), ("B", "D")])
    parses("both ways expands", "flowchart LR\nA <--> B", edges=[("A", "B"), ("B", "A")])
    parses("invisible link is no edge", "flowchart LR\nA ~~~ B", edges=[])
    parses("shape data", 'flowchart LR\nA@{ shape: cyl, label: "Orders DB" } --> B',
           nodes={"A": "Orders DB", "B": "B"}, edges=[("A", "B")])
    parses("class suffix", "flowchart LR\nA[Start]:::hot --> B:::cold\nclassDef hot fill:#f00",
           nodes={"A": "Start", "B": "B"}, edges=[("A", "B")])
    parses("click, style and linkStyle", 'flowchart LR\nA --> B\nclick A "https://x.test"\n'
           "style A fill:#fff\nlinkStyle 0 stroke:#f00", edges=[("A", "B")])
    parses("frontmatter", "---\ntitle: Shop\nconfig:\n  theme: base\n---\nflowchart LR\nA --> B",
           edges=[("A", "B")])
    parses("edge ids", "flowchart LR\nA e1@--> B\ne1@{ animate: true }", edges=[("A", "B")])
    parses("pipe label", "flowchart LR\nA -->|reads| B", edges=[("A", "B")])
    parses("text label", "flowchart LR\nA -- writes to --> B\nB == hot ==> C\nC -. maybe .-> D",
           edges=[("A", "B"), ("B", "C"), ("C", "D")])
    parses("quotes with brackets", 'flowchart LR\nA["list [a] (b)"] --> B',
           nodes={"A": "list [a] (b)", "B": "B"})
    parses("subgraph titles", "flowchart TB\nsubgraph one [Front end]\n  A --> B\nend\n"
           "subgraph Back end\n  C\nend", subgraphs=["Front end", "Back end"])
    parses("semicolons and comments", "graph LR;\n%% a comment\nA-->B;B-->C;",
           edges=[("A", "B"), ("B", "C")])
    parses("shapes", "flowchart LR\nA((Hub)) --> B{Decide} --> C[(Store)] --> D>Flag]"
           " --> E{{Prep}} --> F[/In/] --> G([Pill]) --> H[[Sub]]",
           nodes={"A": "Hub", "B": "Decide", "C": "Store", "D": "Flag", "E": "Prep",
                  "F": "In", "G": "Pill", "H": "Sub"})
    parses("text glued to the link", "flowchart LR\nA --text--> B\nB ==hot==> C\nC -.maybe.-> D",
           nodes={"A": "A", "B": "B", "C": "C", "D": "D"},
           edges=[("A", "B"), ("B", "C"), ("C", "D")])
    parses("class suffix glued to a link", "flowchart LR\nA:::c-->B", edges=[("A", "B")])
    parses("nodes named after keywords", "flowchart LR\nstyle --> click\nclass --o B",
           edges=[("style", "click"), ("class", "B")])
    checked[0] += 1
    heads = [d for _, _, _, d in parse_mermaid("flowchart LR\nA --o B\nC --x D\nE o--o F")["edges"]]
    if heads != [True, True, True]:
        failures.append(f"circle and cross heads lost their direction: {heads}")
    checked[0] += 1
    glued = parse_mermaid("flowchart LR\nA --text--> B")["edges"]
    if glued != [("A", "B", "text", True)]:
        failures.append(f"glued text is not the edge label: {glued}")
    parses("accessibility", "flowchart LR\naccTitle: Shop\naccDescr {\n  long words\n}\nA-->B",
           edges=[("A", "B")])
    checked[0] += 1
    if label_of('flowchart LR\nA["#quot;quoted#quot; &amp; #35;1"]', "A") != "quoted & #1":
        failures.append("entities: #quot; and #35; not decoded")
    checked[0] += 1
    if label_of('flowchart LR\nA["`**Bold** and\n_wrapped_`"]', "A") != "bold and wrapped":
        failures.append("markdown string: markers or newline not normalised")
    checked[0] += 1
    if label_of("flowchart LR\nA[one<br/>two]", "A") != "one two":
        failures.append("<br/> not normalised")

    refuses("sequence diagram", "sequenceDiagram\nA->>B: hi")
    refuses("state diagram whose body reads as a flowchart", "stateDiagram-v2\nA --> B")
    refuses("empty", "\n\n")
    refuses("garbage line", "flowchart LR\nA --> B\nthis is ??? not mermaid")
    refuses("unclosed shape", "flowchart LR\nA[open --> B")
    refuses("unclosed subgraph", "flowchart LR\nsubgraph S\nA-->B")

    def shape(sid, text):
        return [{"id": sid, "type": "rectangle"},
                {"id": sid + "t", "type": "text", "text": text, "containerId": sid}]

    def arrow(aid, a, b, text=None):
        out = [{"id": aid, "type": "arrow", "endArrowhead": "arrow",
                "startBinding": {"elementId": a}, "endBinding": {"elementId": b}}]
        if text:
            out.append({"id": aid + "t", "type": "text", "text": text, "containerId": aid})
        return out

    src = "flowchart LR\nA[Web shop] -->|Submits orders| B[Orders API]\nB --> C[(Orders db)]"
    # Wrapped onto two lines and carrying a C4 type line, as exdraw draws them.
    good = {"elements": shape("a", "Web shop") + shape("b", "Orders API\n[Container: Python]")
            + shape("c", "Orders\ndb") + arrow("x", "a", "b", "Submits\norders")
            + arrow("y", "b", "c")}

    def verdict(name: str, scene: dict, want: int, text: str = src) -> None:
        checked[0] += 1
        code, report = run(text, scene)
        if code != want:
            failures.append(f"{name}: exit {code}, want {want}: {json.dumps(report)[:200]}")

    verdict("all kept, wrapped and typed labels", good, 0)
    lost_label = json.loads(json.dumps(good))
    lost_label["elements"][7]["text"] = "Submits"
    verdict("edge label lost", lost_label, 1)
    lost_edge = json.loads(json.dumps(good))
    lost_edge["elements"] = [e for e in lost_edge["elements"] if e["id"] != "y"]
    verdict("edge lost", lost_edge, 1)
    reversed_edge = json.loads(json.dumps(good))
    reversed_edge["elements"][-1]["startBinding"], reversed_edge["elements"][-1]["endBinding"] = (
        {"elementId": "c"}, {"elementId": "b"})
    verdict("edge drawn the wrong way", reversed_edge, 1)
    extra = json.loads(json.dumps(good))
    extra["elements"] += arrow("z", "c", "a")
    verdict("arrow with no source edge", extra, 1)
    verdict("unsupported source", good, 2, "stateDiagram-v2\n[*] --> A")
    verdict("unparsed line", good, 2, src + "\nA --> ")
    verdict("header only, nothing to check", good, 2, "flowchart LR")
    verdict("elements that are not objects", {"elements": ["x", 1]}, 2)
    verdict("scene that is a list", [], 2)
    verdict("node lost, a longer label kept",
            {"elements": shape("b", "Orders API") + shape("c", "DB") + arrow("x", "b", "c")
             + arrow("y", "b", "c")}, 1, "flowchart LR\nA[API] --> C[DB]\nB[Orders API] --> C")
    verdict("bare id never matches free text",
            {"elements": shape("b", "Write a log") + shape("z", "Q") + arrow("x", "z", "b")
             + [{"id": "n", "type": "text", "text": "A"}]}, 1,
            "flowchart LR\nA --> B[Write a log]")
    # Nothing is lost here; the only fault is that the node label maps to two shapes.
    verdict("two shapes share a node label",
            {"elements": shape("a", "Worker") + shape("b", "Worker")}, 1,
            "flowchart LR\nA[Worker]")
    verdict("subgraph title in two texts, neither exact",
            {"elements": shape("a", "Orders API") + shape("b", "Orders DB")}, 1,
            "flowchart LR\nsubgraph Orders\nA[Orders API]\nB[Orders DB]\nend")
    verdict("edge labels swapped",
            {"elements": shape("a", "x") + shape("b", "y") + shape("c", "z")
             + arrow("p", "a", "b", "write") + arrow("q", "b", "c", "read")}, 1,
            "flowchart LR\nA[x] -->|read| B[y]\nB -->|write| C[z]")
    verdict("circle head drawn reversed",
            {"elements": shape("a", "p") + shape("b", "q") + arrow("r", "b", "a")}, 1,
            "flowchart LR\nA[p] --o B[q]")
    verdict("only empty labels", good, 2, 'flowchart LR\nA[""]')

    for failure in failures:
        print(f"FAIL {failure}")
    total = checked[0]
    verdict_word = "FAIL" if failures else "PASS"
    print(f"{verdict_word}: exfidelity self-test, {total} cases, {len(failures)} failure(s)")
    return 1 if failures else 0


def main() -> int:
    """Exit 1 means a verdict, so nothing unexpected may reach it: any crash is exit 2."""
    try:
        return checked_main()
    except Exception as exc:  # noqa: BLE001 - the exit code contract, see the docstring
        kind = type(exc).__name__
        print(f"internal error: {kind}: {exc}", file=sys.stderr)
        return 2


def checked_main() -> int:
    ap = argparse.ArgumentParser(description="Check a scene kept every label and edge of its "
                                             "Mermaid flowchart source.")
    ap.add_argument("source", nargs="?", type=Path, help="Mermaid flowchart (.mmd)")
    ap.add_argument("scene", nargs="?", type=Path, help=".excalidraw file")
    ap.add_argument("--json", action="store_true", help="print the full report as JSON")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not args.source or not args.scene:
        ap.error("SOURCE and SCENE are required")
    try:
        source_text = args.source.read_text(encoding="utf-8")
        scene = json.loads(args.scene.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        print(f"cannot read input: {exc}", file=sys.stderr)
        return 2
    code, report = run(source_text, scene)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return code
    # Values hoisted out of the f-strings, as in the self-test.
    if code == 2:
        error = report["error"]
        print(f"unreadable: {error}")
        return code
    for item in report["missing"]["labels"]:
        kind, ref, label = item["kind"], item["ref"], item["label"]
        print(f"missing label  {kind:<8} {ref}: {label}")
    for item in report["missing"]["edges"]:
        a, b = item["from"], item["to"]
        print(f"missing edge   {a} -> {b}")
    for item in report["ambiguous"]:
        kind, ref, label = item["kind"], item["ref"], item["label"]
        print(f"ambiguous      {kind:<8} {ref}: {label} matches more than one element")
    for aid in report["arrows_without_source"]:
        print(f"extra arrow    {aid} has no source edge")
    c = report["counts"]
    kept_l, all_l, kept_e, all_e = c["labels_kept"], c["labels"], c["edges_kept"], c["edges"]
    verdict, arrows = report["verdict"], c["arrows"]
    print(f"{verdict}: {kept_l}/{all_l} labels, {kept_e}/{all_e} edges, {arrows} arrows")
    return code


if __name__ == "__main__":
    sys.exit(main())
