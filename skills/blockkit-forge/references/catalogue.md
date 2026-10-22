# Catalogue: what exists, what is documented, what was measured

Read 2026-10-22: docs.slack.dev (every block, element and composition page, the 2025 to 2026
changelog) and the live schema through `blocks.validate`. Re-run `scripts/blockkit.py schema` before
relying on an enum: this list ages.

## Global limits (docs)

- 50 blocks per message, 100 per modal or Home tab. Keep top-level `text` under 4,000 characters.
- Desktop notifications read blocks first (changelog 2026-07-13). Mobile notifications and screen
  readers use `text` only, so always send it.
- `markdown` blocks share 12,000 characters per message.
- `blocks.validate` enforces none of these per-message totals: three `data_visualization` blocks in
  one message validated. Count them yourself.

## Blocks

| Block | Surfaces | Since | Key limits and notes |
| --- | --- | --- | --- |
| `section` | msg, modal, home | classic | `text` 1-3,000; `fields` up to 10 of 2,000, two columns; one `accessory`; `expand: true` forces full text (else "see more" may appear) |
| `header` | msg, modal, home | classic | `plain_text` up to 150; `level` 1-4 |
| `context` | msg, modal, home | classic | up to 10 images and text objects; renders small and grey |
| `divider`, `image`, `actions`, `input`, `video` | msg, modal, home | classic | `actions` up to 25 elements; `video` needs `links.embed:write` |
| `rich_text` | msg, modal, home | classic | sections, lists (`indent`), quotes, preformatted (`language`); leaf `text` is never parsed as mrkdwn |
| `markdown` | msg | 2025-02 | standard Markdown, all header levels render the same size |
| `table` | msg, home | 2025-08 | up to 100 rows of 20 cells, 10,000 characters |
| `context_actions` | msg | 2025-10 | `feedback_buttons`, `icon_button` |
| `task_card`, `plan` | msg | 2026-02 | built for streaming |
| `alert` | modal only | 2026-04 | `level` default, info, warning, error, success |
| `card` | msg, modal, home | 2026-04 | title, subtitle 150; body 200; up to 3 buttons; `slack_icon` (49 names) or image |
| `carousel` | msg, home | 2026-04 | 1-10 cards, sideways |
| `data_table` | msg, home | 2026-05 | 2-201 rows, sortable, paged |
| `data_visualization` | msg, home | 2026-06 | at most 2 per message; `line`, `bar`, `area` (series plus `axis_config`), `pie` (`segments`) |
| `container` | msg, home | 2026-06 | 1-10 `child_blocks`; `width` narrow, standard, wide, full; `is_collapsible`, `default_collapsed` |

## Live schema beyond the docs (blocks.validate, 2026-10-22)

All 34 block types the validator knew: actions, card, condition, context, context_actions, divider,
image, section, header, sticker, contact_card, share_shortcut, share_prompt, share_workflow, video,
channel_set, channel_section, table, loading, markdown, message_embed, plan, task_card, callout,
canvas_table, alert, carousel, data_table, container, layout, salesforce_record_card,
data_visualization, fallback_canary, page. (`rich_text`, `input` and `file` validate too: the list
comes from the first schema branch.)

Use these for exploration only. One bot message in one workspace accepted the three below, which
proves they parse, not that every client renders them or that they stay. A production bot keeps a
documented fallback.

Undocumented, but they validate and a bot message accepted them:

- `callout`: `background_color` indigo, blue, jade, pink, gray, purple, orange, brown, green;
  `child_blocks` divider, image, section, contact_card, header.
- `condition`: `cases[].conditions[]` of type `client` or `content_type`, `op` `=`, `!=`, `>`, `<`,
  plus a `default` branch. Block Kit Builder shows desktop, iOS and Android branches.
- `contact_card`: `contact_user_id`.

Enums the validator returns: `button.style` primary, danger. `text.type` plain_text, mrkdwn.
`context.elements[]` image, plain_text, mrkdwn. Rich-text leaf types include `tag` (a coloured pill:
gray, brown, purple, indigo, blue, green, yellow, orange, red per the docs; a wrong colour answers
`invalid_blocks` with no enum, so `schema` cannot probe it).

## People and notifications (docs, plus one measurement)

- `<@U...>` in an app's message notifies the user only if they are a channel member.
- `<!subteam^ID>` notifies every member. `verbatim: true` does not stop manual `<...>` syntax.
- `mrkdwn` text objects default to `verbatim: false`, which parses some bare names into mentions.
- No documented silent mention exists. A tag added by `chat.update` did not notify in one live test.
  Undocumented: test it on yourself once per workspace.
