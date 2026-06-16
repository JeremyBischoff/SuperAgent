# Telegram Rich Messages — Design Spec

- Date: 2026-06-15
- Branch: `feat/telegram-rich-messages`
- Status: Design approved, pending plan
- Linear: adopt Telegram Bot API 10.1 Rich Messages in the Telegram connector

## 1. Motivation

Telegram Bot API 10.1 (2026-06-11) shipped a **Rich Messages** system. Upstream
`grammY` support has landed: `grammy 1.44.0` / `@grammyjs/types 3.28.0`
(PRs `grammyjs/types#81` and `grammyjs/grammY#911`, both merged 2026-06-14). The
ticket's "blocked on upstream" status is **stale**.

Today the connector renders the agent's markdown into a limited Telegram HTML
subset via `markdownToTelegramHtml` (`src/shared/lib/chat-integrations/telegram-connector.ts:44-100`)
and sends with `{ parse_mode: 'HTML' }`. It carries a **monospace `<pre>` ASCII
table hack** (lines 61-82) because the legacy HTML path has no table support.

Goal: upgrade outbound rendering to Rich Messages, **uniformly across every
outbound surface**, and delete the table hack. The Telegram connector's job is
delivering polished **end briefs / summaries** to a user (final output), not
exposing agent process — so this is a rendering upgrade, not a feature expansion.

## 2. Authoritative facts (primary sources)

Verified against the live spec (`core.telegram.org/bots/api`,
`#rich-message-formatting-options`) and the published `@grammyjs/types@3.28.0`
type definitions.

### Input shape
`InputRichMessage` (the `rich_message` argument) has exactly four fields:
```ts
interface InputRichMessage {
  html?: string;              // exactly one of html | markdown
  markdown?: string;
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
}
```
You pass a **markdown (or HTML) string**; Telegram parses it server-side into
`RichBlock*` blocks. There is **no client-side block assembly** to write. The
~40 `RichBlock*` / `RichText*` classes are the *read* model (received messages),
not the send model.

### Rich Markdown
- **"Compatible with GitHub Flavored Markdown where possible and can contain
  arbitrary HTML."** Our agents already emit GFM.
- Supported in scope: pipe tables (with `|:--|--:|` alignment), `#`..`######`
  headings, `-`/`*`/`+` and `1.` and `- [ ]` lists, fenced code, `>` blockquotes,
  `**bold**` `*italic*` `~~strike~~` `` `code` `` `[x](url)`, `==marked==`
  (highlight), `||spoiler||`. Out of scope but available: footnotes, `$math$`,
  `<details>`, media, collages.
- Inline HTML is accepted inside markdown — an extensibility escape valve for any
  construct GFM lacks.

### Limits (per rich message)
- 32768 UTF-8 chars (vs the legacy 4096 plain limit)
- 500 blocks (incl. nested, list items, table rows)
- 16 nesting levels
- 50 media attachments
- **20 columns per table**
- Table cells: inline formatting only

### Methods
- `sendRichMessage` — any bot, **any chat type**, **not** business-gated
  (`business_connection_id` optional), **accepts `reply_markup`** (inline
  keyboards compose). Returns the sent `Message`.
- `sendRichMessageDraft` — **private chats only**, ephemeral **~30s preview**,
  whole-snapshot (re-send full message each tick under a `draft_id`; same id is
  animated), **does not persist** (must finalize with `sendRichMessage`). Returns
  `true`. **Deferred** (see §6).
- `editMessageText` — gained `rich_message?` (mutually exclusive with `text`);
  edits an already-persisted rich message in place. This is our progressive-update
  mechanism.

### Undocumented (do not assume)
- **Old-client degradation**: what a pre-10.1 client renders is undocumented, and
  there is **no fallback / plain-text field** on `InputRichMessage`. Whole-spec
  term counts: `fallback`=0, `outdated`=0, "update your app"=0, `degrade`=0.
- How an incomplete block renders mid-stream (only "animated" is documented).
- Caveat: API is days old; behavior may be clarified in later revisions.

## 3. Scope

### In scope (v1)
- Render the agent's final markdown as Rich Messages on **every outbound body**:
  agent replies/briefs, request-card text, `tool_status`.
- Native rendering of tables, headings, lists, blockquotes, code, inline styles,
  highlight, spoiler — by passing GFM markdown to `rich_message.markdown`.
- Delete the `<pre>` table hack.
- Retain `markdownToTelegramHtml` as a switchable legacy fallback.

### Out of scope / deferred
- `RichBlockThinking` / `RichBlockDetails` / math blocks — wrong tool for
  briefs/summaries; would need agent→connector plumbing we deliberately avoid.
- `sendRichMessageDraft` animated streaming — deferred fast-follow (private-only,
  ephemeral, polish; not the backbone).
- Changing the interactive **mechanics** (inline keyboards, callback routing,
  the 64-byte `callback_data` workaround) — those stay; only the message *body*
  rendering changes. The 64-byte cap is a real Telegram limit, unrelated to rich
  messages, and is **not** removed.

## 4. Design

### 4.1 Send path
- New messages: `bot.api.sendRichMessage(chatId, { markdown }, opts)` — grammY
  wraps the raw `{ chat_id, rich_message, ... }` args — replaces
  `sendMessage(chatId, html, { parse_mode: 'HTML' })`.
- Progressive/streamed updates: `editMessageText(..., { rich_message: { markdown } })`
  replaces the HTML edit, at the **same throttle cadence the caller already uses**
  (throttle lives upstream, unchanged).
- `reply_markup`, `reply_parameters`, `caption` opts carry over unchanged onto the
  rich sends.

### 4.2 Converter — a thin, near-identity boundary
New module `src/shared/lib/chat-integrations/telegram-rich-message.ts`:
- `markdownToRichMessage(md: string): InputRichMessage` — returns
  `{ markdown: md }` for a **single** message (passthrough; GFM is compatible).
  Also the one place for any GFM-vs-Rich-Markdown normalization that
  testing/grilling surfaces (none assumed up front — added here if found).
- `splitForRichLimits(md: string): string[]` — chunks a body that exceeds the
  **32768**-char ceiling into multiple messages on block/paragraph boundaries.
  The send orchestration calls this first, then `markdownToRichMessage` per chunk
  (mirrors today's 4096 split in `finalizeStreamingMessage`, just at the 8x ceiling
  so it almost never fires). Keeping split separate avoids conflating "render one
  message" with "how many messages."
- Intentionally small (≈tens of lines total). Do **not** build block-assembly.

### 4.3 Validation
New `src/shared/lib/chat-integrations/telegram-rich-message-schema.ts`: a Zod
schema for `InputRichMessage`, `.parse()`d at the send boundary before the API
call (per project convention: validate JSON at boundaries).

### 4.4 Uniform rendering
All outbound bodies route through `markdownToRichMessage` + rich send. Request
cards become **rich body + existing inline keyboard** (`reply_markup` composes).
`markdownToTelegramHtml` is no longer the primary renderer anywhere.

### 4.5 Old-client fallback
- `markdownToTelegramHtml` is retained, demoted to a **config-switchable legacy
  send path** (send via `parse_mode: 'HTML'`).
- Default: ship rich. The switch is the kill-switch if old-client rendering turns
  out broken.
- **Pre-ship gate**: empirically test what a pre-10.1 client displays (undocumented).

### 4.6 Dependency bump
- `package.json`: `grammy ^1.42.0` → `^1.44.0` (pulls `@grammyjs/types 3.28.0`
  transitively; `@grammyjs/types` is not a direct dep).
- `npm install` in the worktree (no `node_modules` present yet).

## 5. Testing
- `telegram-rich-message.test.ts`: markdown passthrough; GFM table preserved (no
  `<pre>`); 32768-char split on block boundaries; Zod schema accepts/rejects.
- Update `finalize-streaming.test.ts`: streaming + finalize emit `rich_message`,
  full content preserved across splits.
- Keep `telegram-markdown.test.ts` (now covering the legacy fallback path).
- Mock `bot.api.sendRichMessage` / `editMessageText` as the existing tests mock
  their predecessors.

## 6. Risks & pre-ship checks
1. **Old-client degradation** (undocumented) — empirical test on an old client;
   legacy fallback retained as mitigation.
2. **Edit-stream flicker** — confirm `editMessageText`+`rich_message` updates
   in place without visible re-render/flicker at our throttle cadence.
3. **GFM ↔ Rich-Markdown corner cases** — nested formatting, table edge cases;
   surface via tests + `/grill-me`.
4. **>20-column tables** — rare for briefs; decide degrade behavior (e.g. leave to
   API error vs pre-check) during planning.

## 7. Non-goals restated
No agent-process streaming, no thinking/details/math, no draft animation, no
change to button/callback mechanics. Same outbound surface, upgraded rendering,
hack deleted.
