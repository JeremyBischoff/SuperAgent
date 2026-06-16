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
