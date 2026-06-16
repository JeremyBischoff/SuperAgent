import { z } from 'zod'

/** Body for POST /api/agents/:id/sessions/branch */
export const branchSessionRequestSchema = z.object({
  fromSessionId: z.string().min(1),
  message: z.string().min(1),         // the user's original typed message
  model: z.string().optional(),       // inherited from source session if omitted
  effort: z.string().optional(),
})
export type BranchSessionRequest = z.infer<typeof branchSessionRequestSchema>

/** Structured output we require from the summarizer model. */
export const summaryPayloadSchema = z.object({
  summary: z.string().min(1),
})
export type SummaryPayload = z.infer<typeof summaryPayloadSchema>
