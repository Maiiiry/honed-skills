# Untrusted text into blocks

Text from another system (a ticket description, a CRM comment, a commit message) is typed by people
who never meant it for Slack. In `mrkdwn` it is code: `<!channel>` pings everyone, a bare `@here` can
become a mention, `<https://x|y>` renders a link labelled anything, `*` and `_` change the formatting.

## The recipe

1. **Decode first.** HTML entities and rich text from the source become plain characters.
2. **Cut on the raw text, then escape.** Escaping lengthens text (`&` becomes `&amp;`, five
   characters), so cutting afterwards can split an entity or overshoot the limit. Leave the growth as
   margin below a hard limit, or, if the limit is on the escaped length, cut by whole escaped
   characters: append each character's escape until the next one would cross the limit. When a
   converter (below) emits markup, cut each text run before it is wrapped, never inside a generated
   `<url|label>` or a `*...*` pair.
3. **Escape `&` first, then `<`, then `>`**, or the `&` of `&lt;` is escaped a second time and shows
   as `&amp;lt;`. Do it in every `mrkdwn` string: section text, fields, context, and the top-level
   `text`, which Slack also parses and uses for notifications. `scripts/blockkit.py` ships
   `escape_mrkdwn` and `cut_then_escape`, and its selftest checks both.
4. **Stop the automatic parsing.** Set `verbatim: true` on every `mrkdwn` text object that carries
   source text: the default `verbatim: false` turns some bare names and `@here` into mentions. Never
   send `link_names=1` or a `parse=full` with such text. Escaping alone does not cover this, and
   `verbatim: true` alone does not stop a literal `<!channel>`: you need both.
5. **Formatting characters have no escape.** mrkdwn offers none for `*`, `_`, `~` or the backtick. A
   string whose formatting must not change goes into a field that is never parsed: `plain_text`
   (headers, container titles, button labels) or a `rich_text` leaf `text` element. Use those for
   names, statuses and titles.
6. **URLs inside `<url|label>`**: escape the URL and encode `|` as `%7C`, or the label starts early.
   Allow only `http` and `https`.
7. **Bare URLs**: after escaping, turn each into `<url|host>` (or a fixed label such as "Slack
   message" for a permalink). A 150-character permalink otherwise wraps over four lines on a phone.

## HTML to mrkdwn

A source that stores rich text as HTML (a CRM's activity feed, many ticketing tools) needs a
converter, not a regex. With the standard library `html.parser`: block tags end a line at their END
only (`<p>a</p><p>b</p>` is two lines, not three), `<br>` breaks, `<b>` becomes `*`, `<i>` becomes
`_`, `<li>` becomes `•`, `<a href>` becomes `<url|text>` for http(s) only, `script` and `style` are
dropped, every text run is escaped, and invisible characters are removed: zero-width space, joiner
and non-joiner (U+200B to U+200D), word joiner (U+2060), the byte-order mark (U+FEFF) and the
bidirectional controls (U+202A to U+202E, U+2066 to U+2069).

## Tests worth writing

- `<!channel>`, a bare `@here` and `&` in a description render inert, in the blocks AND in `text`.
- A body made only of `&` stays under the limit after escaping.
- A blank or whitespace-only title falls back to a fixed one (a `header` needs 1 to 150 characters).
- A hostile `href` (`javascript:`, a `|`, a `>`) never becomes a link.
- Break the escape on purpose and watch a test fail.
