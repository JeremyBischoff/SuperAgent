# Telegram Rich Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Telegram connector to render the agent's markdown using Telegram Bot API 10.1 Rich Messages, with animated live streaming in DMs, falling back to the legacy HTML path for safety.

**Architecture:** Pass the agent's GFM markdown straight to Telegram via `InputRichMessage.markdown` (Telegram parses it server-side — no client-side block assembly). All outbound bodies go rich; `markdownToTelegramHtml` is retained as a global-flag rollback target and an automatic error-retry fallback. Streaming is chat-type-aware: private chats (positive `chat_id`) use the animated `sendRichMessageDraft` path with a `<tg-thinking>` "Thinking…" animation and a final `sendRichMessage` commit; groups/channels use `editMessageText` + `rich_message`. The three existing connector hooks (`showTypingIndicator`, `sendStreamingUpdate`, `finalizeStreamingMessage`) carry all the new behavior — the chat-integration-manager is untouched.

**Tech Stack:** TypeScript, grammY (Telegram Bot framework), Zod (boundary validation), Vitest (unit tests). All work in `src/shared/lib/chat-integrations/`.

**Source spec:** `docs/superpowers/specs/2026-06-15-telegram-rich-messages-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Modify | Bump `grammy ^1.42.0` → `^1.44.0` |
| `src/shared/lib/chat-integrations/telegram-rich-message.ts` | Create | Pure converter: `markdownToRichMessage`, `splitForRichLimits`, `THINKING_RICH_MESSAGE`, the `RICH_MAX_LENGTH` constant |
| `src/shared/lib/chat-integrations/telegram-rich-message-schema.ts` | Create | Zod schema for `InputRichMessage`, validated at the send boundary |
| `src/shared/lib/chat-integrations/telegram-rich-message.test.ts` | Create | Converter + split + schema tests, golden-corpus test |
| `src/shared/lib/chat-integrations/config-schema.ts` | Modify | Add `richMessages`, `draftStreaming`, `skipEntityDetection` flags to `telegramConfigSchema` |
| `src/shared/lib/chat-integrations/telegram-connector.ts` | Modify | Config flags; `sendRichOrHtml`/`editRichOrHtml` fallback helpers; rich `sendMessage`, `sendUserRequestCard`, streaming (group edit + DM draft), `showTypingIndicator` thinking animation |
| `src/shared/lib/chat-integrations/finalize-streaming.test.ts` | Modify | Cover rich finalize, DM draft path, group edit path, error-retry |

**Verified grammY surface (from `@grammyjs/types@3.28.0`, bundled by grammy 1.44):** calls are made through `bot.api.raw.*` with exact arg objects:
- `bot.api.raw.sendRichMessage({ chat_id, rich_message, reply_markup?, reply_parameters? })` → returns `Message`
- `bot.api.raw.sendRichMessageDraft({ chat_id, draft_id, rich_message })` → returns `true` (private chats only; `draft_id` non-zero; same id animates)
- `bot.api.raw.editMessageText({ chat_id, message_id, rich_message })` → returns `Message | true`
- `InputRichMessage = { html?: string; markdown?: string; is_rtl?: boolean; skip_entity_detection?: boolean }` (exactly one of html|markdown)
- `<tg-thinking>` is a draft-only "Thinking…" placeholder block (carries no content).

---

## Task 1: Bump grammy + pin rich method signatures

**Files:**
- Modify: `package.json` (the `grammy` dependency line)

- [ ] **Step 1: Bump the dependency**

In `package.json`, change the `grammy` line under `dependencies`:
```json
"grammy": "^1.44.0",
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: lockfile updates to `grammy 1.44.0` and `@grammyjs/types 3.28.0` (transitive).

- [ ] **Step 3: Verify the rich methods exist on the raw API and pin their signatures**

Run:
```bash
node -e "const t=require('@grammyjs/types'); console.log('types loaded')" 2>/dev/null; \
grep -RnE 'sendRichMessage\b|sendRichMessageDraft|InputRichMessage' node_modules/@grammyjs/types/*.d.ts | head
```
Expected: matches for `sendRichMessage`, `sendRichMessageDraft`, and the `InputRichMessage` interface with fields `html`, `markdown`, `is_rtl`, `skip_entity_detection`. Confirm `editMessageText`'s args include an optional `rich_message`.

If any signature differs from the "Verified grammY surface" block above, update that block and the call sites in later tasks to match before proceeding.

- [ ] **Step 4: Typecheck baseline**

Run: `npm run typecheck`
Expected: PASS (no code changed yet besides the dep).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: bump grammy to ^1.44.0 for Bot API 10.1 rich messages"
```

---

## Task 2: Zod schema for InputRichMessage

**Files:**
- Create: `src/shared/lib/chat-integrations/telegram-rich-message-schema.ts`
- Test: `src/shared/lib/chat-integrations/telegram-rich-message.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/shared/lib/chat-integrations/telegram-rich-message.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { inputRichMessageSchema } from './telegram-rich-message-schema'

describe('inputRichMessageSchema', () => {
  it('accepts a markdown-only message', () => {
    const r = inputRichMessageSchema.parse({ markdown: '# Hi' })
    expect(r.markdown).toBe('# Hi')
  })

  it('accepts an html-only message', () => {
    expect(() => inputRichMessageSchema.parse({ html: '<b>x</b>' })).not.toThrow()
  })

  it('rejects when both html and markdown are present', () => {
    expect(() => inputRichMessageSchema.parse({ html: '<b>x</b>', markdown: 'x' })).toThrow()
  })

  it('rejects when neither html nor markdown is present', () => {
    expect(() => inputRichMessageSchema.parse({ is_rtl: true })).toThrow()
  })

  it('carries optional flags', () => {
    const r = inputRichMessageSchema.parse({ markdown: 'x', skip_entity_detection: true })
    expect(r.skip_entity_detection).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- telegram-rich-message`
Expected: FAIL with "Cannot find module './telegram-rich-message-schema'".

- [ ] **Step 3: Write the schema**

Create `src/shared/lib/chat-integrations/telegram-rich-message-schema.ts`:
```typescript
/**
 * Zod schema for Telegram Bot API 10.1 InputRichMessage.
 * Validated at the send boundary before calling the rich API.
 * Exactly one of `html` | `markdown` must be present.
 */
import { z } from 'zod'

export const inputRichMessageSchema = z
  .object({
    html: z.string().optional(),
    markdown: z.string().optional(),
    is_rtl: z.boolean().optional(),
    skip_entity_detection: z.boolean().optional(),
  })
  .refine(
    (v) => (v.html === undefined) !== (v.markdown === undefined),
    { message: 'InputRichMessage requires exactly one of html | markdown' },
  )

export type InputRichMessage = z.infer<typeof inputRichMessageSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- telegram-rich-message`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/lib/chat-integrations/telegram-rich-message-schema.ts src/shared/lib/chat-integrations/telegram-rich-message.test.ts
git commit -m "feat(telegram): add InputRichMessage Zod schema"
```

---

## Task 3: Converter module (markdownToRichMessage, splitForRichLimits, thinking block)

**Files:**
- Create: `src/shared/lib/chat-integrations/telegram-rich-message.ts`
- Test: `src/shared/lib/chat-integrations/telegram-rich-message.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append to the existing test file)

```typescript
import {
  markdownToRichMessage,
  splitForRichLimits,
  THINKING_RICH_MESSAGE,
  RICH_MAX_LENGTH,
} from './telegram-rich-message'

describe('markdownToRichMessage', () => {
  it('passes GFM markdown through untouched in the markdown field', () => {
    const md = '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |'
    expect(markdownToRichMessage(md)).toEqual({ markdown: md })
  })

  it('omits skip_entity_detection by default (auto-detection ON)', () => {
    expect(markdownToRichMessage('hi').skip_entity_detection).toBeUndefined()
  })

  it('sets skip_entity_detection when requested', () => {
    expect(markdownToRichMessage('hi', { skipEntityDetection: true }).skip_entity_detection).toBe(true)
  })
})

describe('splitForRichLimits', () => {
  it('returns a single chunk when under the limit', () => {
    expect(splitForRichLimits('short')).toEqual(['short'])
  })

  it('splits a body over the 32768 ceiling', () => {
    const big = 'para\n\n'.repeat(7000) // > 32768 chars
    const chunks = splitForRichLimits(big)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= RICH_MAX_LENGTH)).toBe(true)
  })
})

describe('THINKING_RICH_MESSAGE', () => {
  it('is a draft-only tg-thinking placeholder with no reasoning content', () => {
    expect(THINKING_RICH_MESSAGE.html).toContain('<tg-thinking')
    expect(THINKING_RICH_MESSAGE.markdown).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- telegram-rich-message`
Expected: FAIL with "Cannot find module './telegram-rich-message'".

- [ ] **Step 3: Write the converter**

Create `src/shared/lib/chat-integrations/telegram-rich-message.ts`:
```typescript
/**
 * Telegram Bot API 10.1 Rich Messages — markdown passthrough converter.
 *
 * Rich Markdown is "compatible with GitHub Flavored Markdown where possible",
 * so we hand the agent's markdown straight to Telegram. Telegram parses it into
 * rich blocks server-side; we do NOT build RichBlock objects.
 */
import { splitChatMessage } from './utils'
import type { InputRichMessage } from './telegram-rich-message-schema'

/** Max UTF-8 chars in a rich message (Bot API 10.1). */
export const RICH_MAX_LENGTH = 32768

export interface RichMessageOptions {
  skipEntityDetection?: boolean
}

/** Wrap agent markdown as an InputRichMessage. Near-identity passthrough. */
export function markdownToRichMessage(md: string, opts: RichMessageOptions = {}): InputRichMessage {
  return {
    markdown: md,
    ...(opts.skipEntityDetection ? { skip_entity_detection: true } : {}),
  }
}

/** Split an over-long body on block/paragraph boundaries under the rich ceiling. */
export function splitForRichLimits(md: string): string[] {
  return splitChatMessage(md, RICH_MAX_LENGTH)
}

/**
 * Draft-only "Thinking…" animation. The <tg-thinking> placeholder may only be
 * used in sendRichMessageDraft and carries no content (no agent reasoning shown).
 */
export const THINKING_RICH_MESSAGE: InputRichMessage = { html: '<tg-thinking></tg-thinking>' }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- telegram-rich-message`
Expected: PASS (all converter + schema tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/lib/chat-integrations/telegram-rich-message.ts src/shared/lib/chat-integrations/telegram-rich-message.test.ts
git commit -m "feat(telegram): add rich-message converter and split helper"
```

---

## Task 4: Config flags (rich on/off, draft streaming, entity detection)

**Files:**
- Modify: `src/shared/lib/chat-integrations/config-schema.ts:9-12`
- Modify: `src/shared/lib/chat-integrations/telegram-connector.ts:18-21` (the local `TelegramConfig` interface)
- Test: a schema test (append to `telegram-rich-message.test.ts` or a small new block)

- [ ] **Step 1: Write the failing test** (append to `telegram-rich-message.test.ts`)

```typescript
import { telegramConfigSchema } from './config-schema'

describe('telegramConfigSchema rich flags', () => {
  it('accepts the rich flags', () => {
    const r = telegramConfigSchema.parse({
      botToken: 't',
      richMessages: false,
      draftStreaming: false,
      skipEntityDetection: true,
    })
    expect(r.richMessages).toBe(false)
    expect(r.draftStreaming).toBe(false)
    expect(r.skipEntityDetection).toBe(true)
  })

  it('leaves the flags undefined when omitted (defaults applied in connector)', () => {
    const r = telegramConfigSchema.parse({ botToken: 't' })
    expect(r.richMessages).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- telegram-rich-message`
Expected: FAIL — `richMessages` not on the parsed type / stripped.

- [ ] **Step 3: Add the flags to the schema**

In `src/shared/lib/chat-integrations/config-schema.ts`, replace the `telegramConfigSchema` (lines 9-12):
```typescript
export const telegramConfigSchema = z.object({
  botToken: z.string().min(1, 'Bot token is required'),
  chatId: z.string().optional(),
  // Rich Messages (Bot API 10.1). Defaults are applied in the connector.
  richMessages: z.boolean().optional(),        // global rollback switch (default: rich)
  draftStreaming: z.boolean().optional(),       // animated DM streaming (default: on)
  skipEntityDetection: z.boolean().optional(),  // default: false (auto-detection ON)
})
```

- [ ] **Step 4: Mirror the flags on the connector's local interface**

In `src/shared/lib/chat-integrations/telegram-connector.ts`, replace the `TelegramConfig` interface (lines 18-21):
```typescript
export interface TelegramConfig {
  botToken: string
  chatId?: string
  richMessages?: boolean
  draftStreaming?: boolean
  skipEntityDetection?: boolean
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `npm run test:run -- telegram-rich-message && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/lib/chat-integrations/config-schema.ts src/shared/lib/chat-integrations/telegram-connector.ts src/shared/lib/chat-integrations/telegram-rich-message.test.ts
git commit -m "feat(telegram): add rich-message config flags"
```

---

## Task 5: Send helpers with automatic legacy fallback

Adds two private connector methods that send rich and, on throw, log + resend via the legacy HTML path. These are the single boundary for the rich grammY calls + error-retry.

**Files:**
- Modify: `src/shared/lib/chat-integrations/telegram-connector.ts` (imports + new private helpers + chat-type helper)
- Test: `src/shared/lib/chat-integrations/finalize-streaming.test.ts` (append a `describe` block)

- [ ] **Step 1: Write the failing test** (append to `finalize-streaming.test.ts`)

```typescript
describe('TelegramConnector.sendRichOrHtml', () => {
  let connector: TelegramConnector
  let mockSendRich: ReturnType<typeof vi.fn>
  let mockSendMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    connector = new TelegramConnector({ botToken: 'fake:token' })
    mockSendRich = vi.fn().mockResolvedValue({ message_id: 11 })
    mockSendMessage = vi.fn().mockResolvedValue({ message_id: 22 })
    ;(connector as any).bot = {
      api: { raw: { sendRichMessage: mockSendRich }, sendMessage: mockSendMessage },
    }
  })

  it('sends rich and returns its message id', async () => {
    const id = await (connector as any).sendRichOrHtml('123', 'hello')
    expect(mockSendRich).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 123,
      rich_message: { markdown: 'hello' },
    }))
    expect(id).toBe('11')
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('falls back to legacy HTML when the rich send throws', async () => {
    mockSendRich.mockRejectedValueOnce(new Error('rich rejected'))
    const id = await (connector as any).sendRichOrHtml('123', '**hi**')
    expect(mockSendMessage).toHaveBeenCalledWith('123', expect.stringContaining('<strong>hi</strong>'), expect.objectContaining({ parse_mode: 'HTML' }))
    expect(id).toBe('22')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- finalize-streaming`
Expected: FAIL — `sendRichOrHtml` is not a function.

- [ ] **Step 3: Add imports + helpers**

In `telegram-connector.ts`, add to the imports near the top:
```typescript
import { markdownToRichMessage, splitForRichLimits, THINKING_RICH_MESSAGE } from './telegram-rich-message'
import type { InputRichMessage } from './telegram-rich-message-schema'
```

Add these private methods inside the `TelegramConnector` class (next to the other helpers near the bottom, before the final `}`):
```typescript
  // ── Rich send helpers ───────────────────────────────────────────────

  /** Telegram private-chat ids are positive; groups/channels are negative. */
  private isPrivateChat(chatId: string): boolean {
    return Number(chatId) > 0
  }

  private get useRich(): boolean {
    return this.config.richMessages !== false
  }

  private richMessage(md: string): InputRichMessage {
    return markdownToRichMessage(md, { skipEntityDetection: this.config.skipEntityDetection === true })
  }

  /** Send a new rich message; on any rich-send failure, resend via legacy HTML. */
  private async sendRichOrHtml(
    chatId: string,
    md: string,
    other?: { reply_markup?: unknown; reply_parameters?: { message_id: number } },
  ): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected')
    if (this.useRich) {
      try {
        const sent = await this.bot.api.raw.sendRichMessage({
          chat_id: Number(chatId),
          rich_message: this.richMessage(md),
          ...(other as object),
        } as never)
        return String((sent as { message_id: number }).message_id)
      } catch (err) {
        console.error('[TelegramConnector] rich send failed, falling back to HTML:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'rich-send-fallback' }, extra: { provider: 'telegram', chatId } })
      }
    }
    const sent = await this.bot.api.sendMessage(chatId, this.markdownToHtml(md), {
      parse_mode: 'HTML',
      ...(other as object),
    } as never)
    return String(sent.message_id)
  }

  /** Edit a message to rich; on any rich-edit failure, edit via legacy HTML. */
  private async editRichOrHtml(chatId: string, messageId: string, md: string): Promise<void> {
    if (!this.bot) return
    if (this.useRich) {
      try {
        await this.bot.api.raw.editMessageText({
          chat_id: Number(chatId),
          message_id: Number(messageId),
          rich_message: this.richMessage(md),
        } as never)
        return
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (errMsg.includes('message is not modified')) return
        console.error('[TelegramConnector] rich edit failed, falling back to HTML:', err)
      }
    }
    try {
      await this.bot.api.editMessageText(chatId, Number(messageId), this.markdownToHtml(md), { parse_mode: 'HTML' })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (!errMsg.includes('message is not modified')) throw err
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- finalize-streaming`
Expected: PASS (the new `sendRichOrHtml` block; existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/shared/lib/chat-integrations/telegram-connector.ts src/shared/lib/chat-integrations/finalize-streaming.test.ts
git commit -m "feat(telegram): add rich send/edit helpers with HTML fallback"
```

---

## Task 6: Route sendMessage through the rich path

**Files:**
- Modify: `src/shared/lib/chat-integrations/telegram-connector.ts:311-326` (`sendMessage`)
- Test: `finalize-streaming.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `finalize-streaming.test.ts`)

```typescript
describe('TelegramConnector.sendMessage (rich)', () => {
  it('sends the body as a rich message split at the 32768 ceiling', async () => {
    const connector = new TelegramConnector({ botToken: 'fake:token' })
    const mockSendRich = vi.fn().mockResolvedValue({ message_id: 7 })
    ;(connector as any).bot = { api: { raw: { sendRichMessage: mockSendRich }, sendMessage: vi.fn() } }

    const id = await connector.sendMessage('500', { text: '# Brief\n\n| a | b |\n|---|---|\n| 1 | 2 |' })

    expect(mockSendRich).toHaveBeenCalledTimes(1)
    expect(mockSendRich).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 500,
      rich_message: expect.objectContaining({ markdown: expect.stringContaining('| a | b |') }),
    }))
    expect(id).toBe('7')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- finalize-streaming`
Expected: FAIL — current `sendMessage` calls `bot.api.sendMessage` (HTML), not `raw.sendRichMessage`.

- [ ] **Step 3: Rewrite `sendMessage`**

Replace `sendMessage` (lines 311-326):
```typescript
  async sendMessage(chatId: string, message: OutgoingMessage): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected')

    const chunks = splitForRichLimits(message.text || '(empty message)')
    const replyParams = message.replyToExternalId
      ? { reply_parameters: { message_id: Number(message.replyToExternalId) } }
      : undefined

    let lastMessageId = ''
    for (let i = 0; i < chunks.length; i++) {
      // Only the first chunk carries the reply-to.
      lastMessageId = await this.sendRichOrHtml(chatId, chunks[i], i === 0 ? replyParams : undefined)
    }
    return lastMessageId
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- finalize-streaming`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/lib/chat-integrations/telegram-connector.ts src/shared/lib/chat-integrations/finalize-streaming.test.ts
git commit -m "feat(telegram): send messages as rich with HTML fallback"
```

---

## Task 7: Route user request cards through the rich path (keep keyboards)

Card bodies move from hand-built HTML strings to markdown, sent via `sendRichOrHtml`, with the inline keyboard passed through unchanged in `reply_markup`. The callback-confirmation edit (line 150) stays HTML — it is a trivial one-line acknowledgement, not a brief, and is deliberately unchanged.

**Files:**
- Modify: `src/shared/lib/chat-integrations/telegram-connector.ts:402-480` (`sendUserRequestCard`)
- Test: `finalize-streaming.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append)

```typescript
describe('TelegramConnector.sendUserRequestCard (rich)', () => {
  let connector: TelegramConnector
  let mockSendRich: ReturnType<typeof vi.fn>
  beforeEach(() => {
    connector = new TelegramConnector({ botToken: 'fake:token' })
    mockSendRich = vi.fn().mockResolvedValue({ message_id: 5 })
    ;(connector as any).bot = { api: { raw: { sendRichMessage: mockSendRich }, sendMessage: vi.fn() } }
  })

  it('sends a single question as rich with an inline keyboard', async () => {
    await connector.sendUserRequestCard('123', {
      type: 'user_question_request',
      toolUseId: 't1',
      questions: [{ question: 'Pick one', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }] }],
    } as any)
    const call = mockSendRich.mock.calls[0][0]
    expect(call.rich_message.markdown).toContain('Pick one')
    expect(call.reply_markup.inline_keyboard.length).toBe(2)
  })

  it('sends tool_status as rich', async () => {
    await connector.sendUserRequestCard('123', {
      type: 'tool_status', toolUseId: 't2', toolName: 'Bash', summary: 'ran ls', status: 'success',
    } as any)
    expect(mockSendRich.mock.calls[0][0].rich_message.markdown).toContain('Bash')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- finalize-streaming`
Expected: FAIL — current card code calls `bot.api.sendMessage` with HTML.

- [ ] **Step 3: Rewrite `sendUserRequestCard`**

Replace `sendUserRequestCard` (lines 402-480). Note: bodies are now **markdown** (`**bold**`, `` `code` ``) and no longer need `escapeHtml`; the unsupported-in-chat path and keyboard wiring are preserved:
```typescript
  async sendUserRequestCard(chatId: string, event: UserRequestEvent): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected')

    if (isUnsupportedInChat(event)) {
      return this.sendRichOrHtml(chatId, `_${describeUnsupportedRequest(event)}_`)
    }

    switch (event.type) {
      case 'user_question_request': {
        let lastMessageId = ''

        if (event.questions.length > 1) {
          this.pendingQuestions.set(event.toolUseId, {
            totalQuestions: event.questions.length,
            answers: {},
          })
        }

        for (const q of event.questions) {
          const header = q.header ? `**${q.header}**\n` : ''
          const text = `${header}${q.question}`

          const keyboard: Array<Array<{ text: string; callback_data: string }>> = []
          if (q.options && q.options.length > 0) {
            for (const opt of q.options) {
              const cbId = this.registerCallback(event.toolUseId, { question: q.question, answer: opt.label })
              keyboard.push([{ text: opt.label, callback_data: cbId }])
            }
          }

          lastMessageId = await this.sendRichOrHtml(
            chatId,
            text,
            keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : undefined,
          )
        }
        return lastMessageId
      }

      case 'secret_request': {
        const text = `**Secret requested:** \`${event.secretName}\`\n${event.reason ? `\nReason: ${event.reason}` : ''}\n\nPlease reply with the secret value.`
        return this.sendRichOrHtml(chatId, text)
      }

      case 'file_request': {
        const text = `**File requested:**\n${event.description}${event.fileTypes ? `\n\nAccepted types: ${event.fileTypes}` : ''}\n\nPlease upload the file.`
        return this.sendRichOrHtml(chatId, text)
      }

      case 'file_delivery': {
        const text = `**File delivered:** \`${event.filePath}\`${event.description ? `\n${event.description}` : ''}\n\n_File download not yet supported — view in the app._`
        return this.sendRichOrHtml(chatId, text)
      }

      case 'tool_status': {
        const emoji = event.status === 'success' ? '✅' : event.status === 'error' ? '❌' : event.status === 'cancelled' ? '⛔' : '⏳'
        return this.sendRichOrHtml(chatId, `🔧 **${event.toolName}** — ${event.summary} ${emoji}`)
      }

      default:
        return this.sendRichOrHtml(chatId, `_${describeUnsupportedRequest(event)}_`)
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- finalize-streaming`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/lib/chat-integrations/telegram-connector.ts src/shared/lib/chat-integrations/finalize-streaming.test.ts
git commit -m "feat(telegram): render user request cards as rich, keep keyboards"
```

---

## Task 8: Group/channel streaming (rich edit path)

The non-private path. `sendStreamingUpdate` creates the message with `sendRichMessage` then edits with `editRichOrHtml`; `finalizeStreamingMessage` edits the persisted message rich and sends any overflow chunks. A module-level `STREAM_RICH_INTERMEDIATES` constant is the one-line Q4 A/B switch (default `true` = stream rich; set `false` to stream legacy HTML and only finalize rich).

**Files:**
- Modify: `src/shared/lib/chat-integrations/telegram-connector.ts` (add the const near other constants; rewrite `sendStreamingUpdate` 339-366 and `finalizeStreamingMessage` 368-389)
- Test: `finalize-streaming.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```typescript
describe('TelegramConnector streaming (group, rich)', () => {
  let connector: TelegramConnector
  let raw: { sendRichMessage: ReturnType<typeof vi.fn>; editMessageText: ReturnType<typeof vi.fn>; sendRichMessageDraft: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    connector = new TelegramConnector({ botToken: 'fake:token' })
    raw = {
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      sendRichMessageDraft: vi.fn().mockResolvedValue(true),
    }
    ;(connector as any).bot = { api: { raw, sendMessage: vi.fn(), editMessageText: vi.fn() } }
  })

  it('creates the message with sendRichMessage on first update (negative chat id)', async () => {
    const id = await connector.sendStreamingUpdate('-1001', 'partial')
    expect(raw.sendRichMessage).toHaveBeenCalledWith(expect.objectContaining({ chat_id: -1001 }))
    expect(raw.sendRichMessageDraft).not.toHaveBeenCalled()
    expect(id).toBe('100')
  })

  it('edits rich on subsequent updates', async () => {
    await connector.sendStreamingUpdate('-1001', 'more', '100')
    expect(raw.editMessageText).toHaveBeenCalledWith(expect.objectContaining({ chat_id: -1001, message_id: 100 }))
  })

  it('finalizes by editing the persisted message rich', async () => {
    await connector.finalizeStreamingMessage('-1001', '100', 'final brief')
    expect(raw.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
      message_id: 100,
      rich_message: expect.objectContaining({ markdown: 'final brief' }),
    }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- finalize-streaming`
Expected: FAIL — current streaming uses `bot.api.sendMessage`/`editMessageText` with HTML.

- [ ] **Step 3: Add the constant and the draft sentinel near the top constants (after line 26)**

```typescript
const RICH_DRAFT_SENTINEL_PREFIX = 'draft:'
// Q4 A/B switch: true = stream rich intermediates (group path); false = stream legacy HTML, finalize rich.
const STREAM_RICH_INTERMEDIATES = true
```

- [ ] **Step 4: Rewrite `sendStreamingUpdate` (lines 339-366)**

```typescript
  async sendStreamingUpdate(chatId: string, text: string, existingMessageId?: string): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected')
    const body = text || 'Thinking...'

    // DM animated draft path (Task 9 fills in driveDraftStream).
    if (this.useRich && this.config.draftStreaming !== false && this.isPrivateChat(chatId)) {
      return this.driveDraftStream(chatId, body)
    }

    // Group/channel edit path.
    if (!existingMessageId) {
      if (this.useRich && STREAM_RICH_INTERMEDIATES) {
        const sent = await this.bot.api.raw.sendRichMessage({ chat_id: Number(chatId), rich_message: this.richMessage(body) } as never)
        return String((sent as { message_id: number }).message_id)
      }
      const sent = await this.bot.api.sendMessage(chatId, this.markdownToHtml(body), { parse_mode: 'HTML' })
      return String(sent.message_id)
    }

    if (this.useRich && STREAM_RICH_INTERMEDIATES) {
      await this.editRichOrHtml(chatId, existingMessageId, body)
    } else {
      try {
        await this.bot.api.editMessageText(chatId, Number(existingMessageId), this.markdownToHtml(body), { parse_mode: 'HTML' })
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (!errMsg.includes('message is not modified')) throw err
      }
    }
    return existingMessageId
  }
```

- [ ] **Step 5: Rewrite `finalizeStreamingMessage` (lines 368-389)**

```typescript
  async finalizeStreamingMessage(chatId: string, messageId: string, finalText: string): Promise<void> {
    if (!this.bot) return
    const text = finalText || '(empty response)'

    // DM draft path: commit the ephemeral draft as a real persisted message.
    if (messageId.startsWith(RICH_DRAFT_SENTINEL_PREFIX)) {
      await this.commitDraft(chatId, text)
      return
    }

    const chunks = splitForRichLimits(text)
    try {
      await this.editRichOrHtml(chatId, messageId, chunks[0])
      for (let i = 1; i < chunks.length; i++) {
        await this.sendRichOrHtml(chatId, chunks[i])
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (!errMsg.includes('message is not modified')) {
        console.error('[TelegramConnector] Failed to finalize message:', err)
        captureException(err, { tags: { component: 'chat-integration', operation: 'finalize-message' }, extra: { provider: 'telegram', chatId, messageId } })
      }
    }
  }
```

Note: `driveDraftStream` and `commitDraft` are added in Task 9. To keep this task green in isolation, add temporary stubs now and replace them in Task 9:
```typescript
  private async driveDraftStream(chatId: string, body: string): Promise<string> {
    // Replaced in Task 9. Temporary: behave like a group create so Task 8 tests pass for non-DM only.
    const sent = await this.bot!.api.raw.sendRichMessage({ chat_id: Number(chatId), rich_message: this.richMessage(body) } as never)
    return String((sent as { message_id: number }).message_id)
  }
  private async commitDraft(chatId: string, text: string): Promise<void> {
    await this.sendRichOrHtml(chatId, text)
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:run -- finalize-streaming`
Expected: PASS (group streaming block green; earlier blocks still green).

- [ ] **Step 7: Commit**

```bash
git add src/shared/lib/chat-integrations/telegram-connector.ts src/shared/lib/chat-integrations/finalize-streaming.test.ts
git commit -m "feat(telegram): rich streaming for groups via editMessageText"
```

---

## Task 9: DM animated draft streaming

Replaces the Task 8 stubs with the real draft state machine: per-chat non-zero `draft_id`, `sendRichMessageDraft` on each update, a `draft:<chatId>` sentinel returned to the manager, and a final `sendRichMessage` commit that clears state.

**Files:**
- Modify: `src/shared/lib/chat-integrations/telegram-connector.ts` (add draft state fields; replace the Task 8 stubs)
- Test: `finalize-streaming.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```typescript
describe('TelegramConnector streaming (DM, draft)', () => {
  let connector: TelegramConnector
  let raw: { sendRichMessageDraft: ReturnType<typeof vi.fn>; sendRichMessage: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    connector = new TelegramConnector({ botToken: 'fake:token' })
    raw = {
      sendRichMessageDraft: vi.fn().mockResolvedValue(true),
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 200 }),
    }
    ;(connector as any).bot = { api: { raw, sendMessage: vi.fn() } }
  })

  it('streams via sendRichMessageDraft and returns a draft sentinel (positive chat id)', async () => {
    const id = await connector.sendStreamingUpdate('999', 'partial brief')
    expect(raw.sendRichMessageDraft).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 999,
      rich_message: { markdown: 'partial brief' },
    }))
    expect(raw.sendRichMessageDraft.mock.calls[0][0].draft_id).toBeGreaterThan(0)
    expect(id).toBe('draft:999')
  })

  it('reuses the same draft_id across updates for the same chat', async () => {
    await connector.sendStreamingUpdate('999', 'a')
    await connector.sendStreamingUpdate('999', 'a b', 'draft:999')
    const first = raw.sendRichMessageDraft.mock.calls[0][0].draft_id
    const second = raw.sendRichMessageDraft.mock.calls[1][0].draft_id
    expect(second).toBe(first)
  })

  it('commits the draft with sendRichMessage on finalize and clears state', async () => {
    await connector.sendStreamingUpdate('999', 'partial')
    await connector.finalizeStreamingMessage('999', 'draft:999', 'final brief')
    expect(raw.sendRichMessage).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 999, rich_message: expect.objectContaining({ markdown: 'final brief' }),
    }))
    expect((connector as any).activeDrafts.has('999')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- finalize-streaming`
Expected: FAIL — the stub `driveDraftStream` returns a numeric id, not the `draft:999` sentinel, and reuses no draft_id.

- [ ] **Step 3: Add draft state fields** (next to the other private fields, after line 116)

```typescript
  // Animated DM draft streaming: per-chat non-zero draft id.
  private nextDraftId = 1
  private activeDrafts: Map<string, number> = new Map()
```

- [ ] **Step 4: Replace the Task 8 stubs with the real implementation**

```typescript
  private draftIdFor(chatId: string): number {
    let id = this.activeDrafts.get(chatId)
    if (id === undefined) {
      id = this.nextDraftId++
      this.activeDrafts.set(chatId, id)
    }
    return id
  }

  private async driveDraftStream(chatId: string, body: string): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected')
    await this.bot.api.raw.sendRichMessageDraft({
      chat_id: Number(chatId),
      draft_id: this.draftIdFor(chatId),
      rich_message: this.richMessage(body),
    } as never)
    return `${RICH_DRAFT_SENTINEL_PREFIX}${chatId}`
  }

  private async commitDraft(chatId: string, text: string): Promise<void> {
    this.activeDrafts.delete(chatId)
    const chunks = splitForRichLimits(text)
    for (const chunk of chunks) {
      await this.sendRichOrHtml(chatId, chunk)
    }
  }
```

- [ ] **Step 5: Clear draft state on disconnect**

In `disconnect()` (near line 295, alongside `this.callbackDataMap.clear()`), add:
```typescript
    this.activeDrafts.clear()
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:run -- finalize-streaming`
Expected: PASS (DM draft block + all prior blocks).

- [ ] **Step 7: Commit**

```bash
git add src/shared/lib/chat-integrations/telegram-connector.ts src/shared/lib/chat-integrations/finalize-streaming.test.ts
git commit -m "feat(telegram): animated DM streaming via sendRichMessageDraft"
```

---

## Task 10: "Thinking…" animation in showTypingIndicator

In private chats with draft streaming on, the thinking phase shows the `<tg-thinking>` animation (driven by the manager's existing `showTypingIndicator` call on `stream_start`). Groups keep `sendChatAction('typing')`.

**Files:**
- Modify: `src/shared/lib/chat-integrations/telegram-connector.ts:391-398` (`showTypingIndicator`)
- Test: `finalize-streaming.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```typescript
describe('TelegramConnector.showTypingIndicator', () => {
  it('shows a tg-thinking draft in a DM with draft streaming on', async () => {
    const connector = new TelegramConnector({ botToken: 'fake:token' })
    const sendRichMessageDraft = vi.fn().mockResolvedValue(true)
    const sendChatAction = vi.fn().mockResolvedValue(true)
    ;(connector as any).bot = { api: { raw: { sendRichMessageDraft }, sendChatAction } }

    await connector.showTypingIndicator('999')
    expect(sendRichMessageDraft).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 999,
      rich_message: { html: '<tg-thinking></tg-thinking>' },
    }))
    expect(sendChatAction).not.toHaveBeenCalled()
  })

  it('uses the typing action in a group', async () => {
    const connector = new TelegramConnector({ botToken: 'fake:token' })
    const sendChatAction = vi.fn().mockResolvedValue(true)
    ;(connector as any).bot = { api: { raw: { sendRichMessageDraft: vi.fn() }, sendChatAction } }

    await connector.showTypingIndicator('-1001')
    expect(sendChatAction).toHaveBeenCalledWith('-1001', 'typing')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- finalize-streaming`
Expected: FAIL — current `showTypingIndicator` always calls `sendChatAction`.

- [ ] **Step 3: Rewrite `showTypingIndicator` (lines 391-398)**

```typescript
  async showTypingIndicator(chatId: string): Promise<void> {
    if (!this.bot) return
    try {
      if (this.useRich && this.config.draftStreaming !== false && this.isPrivateChat(chatId)) {
        await this.bot.api.raw.sendRichMessageDraft({
          chat_id: Number(chatId),
          draft_id: this.draftIdFor(chatId),
          rich_message: THINKING_RICH_MESSAGE,
        } as never)
        return
      }
      await this.bot.api.sendChatAction(chatId, 'typing')
    } catch {
      // Non-critical
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:run -- finalize-streaming`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/lib/chat-integrations/telegram-connector.ts src/shared/lib/chat-integrations/finalize-streaming.test.ts
git commit -m "feat(telegram): tg-thinking animation for DM thinking phase"
```

---

## Task 11: Golden-corpus test from representative agent briefs

Confidence check that real-shaped agent output passes through without throwing and stays within limits.

**Files:**
- Test: `src/shared/lib/chat-integrations/telegram-rich-message.test.ts` (append)

- [ ] **Step 1: Write the test**

```typescript
// Representative real agent briefs. Add more from actual sessions over time.
const GOLDEN_BRIEFS = [
  '# Benchmark results\n\nI benchmarked the eviction policies. **LRU wins** on hit-rate.\n\n| Policy | Hit rate | p99 |\n|--------|----------|-----|\n| LRU | 94% | 12ms |\n| FIFO | 88% | 9ms |\n\nMemory overhead is ~O(n).\n\n```python\ncache = LRUCache(maxsize=1000)\n```',
  '## Next steps\n\n- Add metrics\n- Benchmark under load\n- [ ] Open PR\n- [x] Write tests\n\n> Note: clock skew ruled out TTL eviction.',
  'Mixed: `inline code`, **bold _nested italic_ bold**, ~~strike~~, a [link](https://example.com), and ==highlight==.',
]

describe('golden corpus: real agent briefs', () => {
  it('converts every brief without throwing', () => {
    for (const md of GOLDEN_BRIEFS) {
      expect(() => markdownToRichMessage(md)).not.toThrow()
      expect(markdownToRichMessage(md).markdown).toBe(md)
    }
  })

  it('keeps each chunk within the rich ceiling', () => {
    for (const md of GOLDEN_BRIEFS) {
      for (const chunk of splitForRichLimits(md)) {
        expect(chunk.length).toBeLessThanOrEqual(RICH_MAX_LENGTH)
      }
    }
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm run test:run -- telegram-rich-message`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/shared/lib/chat-integrations/telegram-rich-message.test.ts
git commit -m "test(telegram): golden-corpus rich-message conversion test"
```

---

## Task 12: Full verification + cleanup

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm run test:run -- chat-integrations`
Expected: PASS — including the retained `telegram-markdown.test.ts` (the legacy fallback path is unchanged).

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS. (Do NOT run `npm run build` — it disrupts the dev server.)

- [ ] **Step 3: Confirm the `<pre>` table hack is gone from live paths**

Run: `rg -n 'render as aligned monospace|<pre>' src/shared/lib/chat-integrations/telegram-connector.ts`
Expected: matches only inside `markdownToTelegramHtml` (the retained legacy fallback), not in any rich send path.

- [ ] **Step 4: Commit any lint fixups**

```bash
git add -A src/shared/lib/chat-integrations/
git commit -m "chore(telegram): lint + verification pass for rich messages" || echo "nothing to commit"
```

---

## Pre-ship checks (manual, against a real bot — see spec §6)

These are empirical and cannot be unit-tested. Do them before enabling for users:

1. **Stray brackets:** send a brief containing `if a < b && c > d` (outside code) — confirm it renders, not mangled. If broken, add minimal escaping of stray `<`/`>`/`&` outside code spans in `markdownToRichMessage`.
2. **Partial-rich streaming (groups):** stream a brief containing a table into a group; watch the mid-stream render. If it flickers/looks broken, flip `STREAM_RICH_INTERMEDIATES` to `false`.
3. **Structural limit:** send a >20-column table; confirm Telegram returns a 400 (so the error-retry fires) rather than silently truncating.
4. **Draft 30s ephemerality:** in a DM, confirm the "Thinking…" animation + 1/sec drafts keep the preview alive across a long tool-call gap.
5. **Old-client:** best-effort — if a pre-10.1 client is reachable, observe what it renders. Otherwise rely on the `richMessages: false` global rollback flag.
```
