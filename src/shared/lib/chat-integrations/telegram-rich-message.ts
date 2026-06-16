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
 * Animated "Thinking…" indicator shown before the response streams, sent as a
 * sequence of draft frames under the streaming draft id. A Telegram rich-message
 * draft renders its *updates* (same draft_id → animated diff), not its first
 * static snapshot — so a single static draft shows a blank bubble. Cycling these
 * frames is what makes the indicator render; the first streamed token then
 * replaces the draft in place. (This is also why the empty <tg-thinking>
 * placeholder never appeared.)
 */
export const THINKING_FRAMES: InputRichMessage[] = [
  { markdown: '✨ Thinking' },
  { markdown: '✨ Thinking.' },
  { markdown: '✨ Thinking..' },
  { markdown: '✨ Thinking...' },
]
