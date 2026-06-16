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
