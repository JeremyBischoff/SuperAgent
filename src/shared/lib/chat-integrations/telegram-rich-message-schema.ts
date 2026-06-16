/**
 * Zod schema for Telegram Bot API 10.1 InputRichMessage — the typed contract for
 * a rich-message payload, where exactly one of `html` | `markdown` is present.
 * The converter builds this shape directly; the schema is the source of truth for
 * the `InputRichMessage` type and is exercised by the converter tests.
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
