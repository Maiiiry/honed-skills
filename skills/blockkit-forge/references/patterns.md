# Patterns that held up in production

Each one was judged by a fresh reviewer from screenshots at desktop and phone width.

## The notification card (one per item, many per channel)

1. `header`: what it is and whose, `Account: Subject`. A blank subject falls back to a fixed title.
2. `context`: the record link, a region or team, the created date (month as a word, in italics).
3. `rich_text` with one `tag` element: the state as a coloured pill, alone on its line. Something
   beside it wraps mid-value on a phone.
4. `section` with an EVEN number of `fields` (2x2 or 2x3): an odd count leaves a hole in the grid.
5. The long text in a `container`: `is_collapsible`, `default_collapsed`, `width: full`, the first
   line as `subtitle`. Up to 10 `section` children of at most 2,900 characters each; past that, a link
   to the rest.
6. One `actions` button to the source record. Then a `divider`, so stacked cards do not run together.

A card that showed a 1,400-character excerpt was judged "one card fills the whole pane". With the
text folded, two cards fit a screen.

## People without a ping

Post with plain names, then `chat.update` the same message with `<@U...>` tags. A tag added by an edit
did not notify in one live test. That is undocumented, so verify it once per workspace by tagging
yourself before you build on it. Tag in the post itself only where the ping is the point, such as a
"cc" to a manager. Resolve a name only when exactly one active user carries it; a queue or a shared
name stays plain text.

## A card that stays current

Store the posted `ts`. When the source state changes, `chat.update` re-renders the card, and one
short note goes to its thread. Keep what the card shows, so an unchanged item costs no write.

## The thread as a timeline

One reply per event, oldest first: a status change (`` Status `New` → `In Process` ``), a comment
(the author, the time in italics, the body as a quote), a reply to a comment. Record each reply's
`ts` right after it posts, keyed by the source event id: that dedups, and it finds a mirrored message
when the source removes it. Check that each reply landed in the thread.

## Fallbacks and guards

- A card Slack refuses for its content retries as a fixed header plus the button, with no source text.
- Record a post as `pending` before it, and settle a `pending` one from `conversations.history` next run.
- Cap the number of new posts per run, so a broken filter cannot post hundreds of cards.
- A scheduled run with no stored state stops, because it would repost every item. Only a run started
  by hand may create the first state.
- Pace the writes: about one post per second per channel, and honour `Retry-After` on HTTP 429 and on
  `ok: false` with `ratelimited`. A tag added by an edit is a second write per card, so a backfill of
  sixty cards is a hundred and twenty calls before any thread note.

## Posting identity: a different name or picture

Slack offers three ways to change the name and picture a bot posts under. Pick by what the bot does
with its messages later.

| Route | Scope | What it changes | Cost |
| --- | --- | --- | --- |
| `username` plus `icon_url` or `icon_emoji` on `chat.postMessage` | `chat:write.customize` | that one message | the message is stored as a `bot_message` that no token owns |
| rename or re-icon the app in its settings | app admin | every post of that app, in every channel | one setting, global |
| a dedicated app (for example one per log channel) | a workspace admin's approval | everything that app posts | an approval request with a written justification |

**Measured (2026-10-14):** a message posted with a `username` override could not be deleted, not
even with the bot's own token (`cant_delete_message`). A workspace admin had to remove it. The same override also replaced the app's designed icon with the emoji.

**Inferred, not tested:** such a message most likely refuses `chat.update` as well, for the same
reason. Test it once (post with an override, then edit it) before building on it.

So the rule: a bot that edits its posts (live status, tags added by an edit, a re-render, a
fallback) or may need to delete one must post under its own identity. Give it a different name or
picture through a dedicated app, or through the app's own settings. Keep per-message overrides for
fire-and-forget posts only, and carry the identity in the message itself (a header, a context line)
when an app of its own is not worth the approval.

The approval request that worked named four things: the app id, the one channel it posts to, the
narrowest scopes that do the job (for a logger: `chat:write`, plus the history scope of its one
channel for read-back), and the app it replaces.
