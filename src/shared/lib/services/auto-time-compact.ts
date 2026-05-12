/**
 * Auto Time-Based Compact (V0, recency, no LLM).
 *
 * Appends `[compact_boundary, isCompactSummary user]` to the JSONL tail.
 * SDK resume reader (sdk.mjs, `hasPreservedSegment` branch) discards
 * everything before the boundary, so the next API request is built from
 * `[system, summary_as_user]` only.
 *
 * Summary content reconstructs the conversation as one string:
 *   - older turns: User/Assistant text only; tool I/O collapses to `[...]`
 *   - recent K turns: full text + `[tool_use:name] {input}` + `[tool_result] …`
 *   - per-tool-result content truncated at TOOL_RESULT_MAX_CHARS
 *
 * After the append we `interruptSession` to drop the SDK's in-memory chain
 * so the next user message restarts the Query and re-reads JSONL.
 */

import * as fs from 'fs'
import { randomUUID } from 'crypto'
import { APP_VERSION } from '@shared/lib/config/version'
import { containerManager } from '@shared/lib/container/container-manager'
import type {
  ContentBlock,
  JsonlEntry,
  JsonlMessageEntry,
  ToolResultBlock,
} from '@shared/lib/types/agent'
import {
  getSessionJsonlPath,
  readJsonlFile,
} from '@shared/lib/utils/file-storage'

const STRATEGY = 'time_recency'
const ENTRYPOINT_TAG = 'superagent-auto-time-compact'
const TOOL_RESULT_MAX_CHARS = 8_000
const TOOL_PLACEHOLDER = '[...]'
// Trigger gate: only burn a boundary when real activity has accumulated.
const MIN_NEW_USER_TEXT = 1
const MIN_NEW_TOOL_USES = 10

function isCompactBoundary(e: JsonlEntry | undefined): boolean {
  if (!e) return false
  const x = e as { type?: string; subtype?: string }
  return x.type === 'system' && x.subtype === 'compact_boundary'
}

function isHumanUserText(e: JsonlEntry | undefined): boolean {
  if (!e) return false
  const m = e as JsonlMessageEntry
  if (m.type !== 'user' || m.isCompactSummary) return false
  const c = m.message?.content
  if (typeof c === 'string') return true
  if (!Array.isArray(c)) return false
  return !c.some((b) => (b as { type?: string }).type === 'tool_result')
}

function getBlocks(e: JsonlMessageEntry): ContentBlock[] {
  const c = e.message?.content
  if (typeof c === 'string') return [{ type: 'text', text: c } as ContentBlock]
  return Array.isArray(c) ? (c as ContentBlock[]) : []
}

function joinTextBlocks(e: JsonlMessageEntry): string {
  const parts: string[] = []
  for (const b of getBlocks(e)) {
    const x = b as { type?: string; text?: string }
    if (x.type === 'text' && typeof x.text === 'string') parts.push(x.text)
  }
  return parts.join('\n').trim()
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    try { return JSON.stringify(content) } catch { return String(content) }
  }
  const parts: string[] = []
  for (const b of content) {
    const x = b as { type?: string; text?: string }
    if (x.type === 'text' && typeof x.text === 'string') parts.push(x.text)
    else if (x.type === 'image') parts.push('[image]')
    else {
      try { parts.push(JSON.stringify(b)) } catch { parts.push(String(b)) }
    }
  }
  return parts.join('\n')
}

function truncate(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : text.slice(0, limit) + `… [truncated ${text.length - limit} chars]`
}

function isSyntheticAssistant(m: JsonlMessageEntry): boolean {
  if (m.type !== 'assistant') return false
  const msg = m.message as { model?: string } | undefined
  return msg?.model === '<synthetic>'
}

/**
 * Build the transcript-style summary string.
 *
 * - All human user-text and assistant text is preserved verbatim.
 * - Tool I/O is sliced by recency: only the most recent `keepLastTools`
 *   tool_use calls (and their paired tool_result entries) are emitted in
 *   full. Older tool_use/tool_result blocks collapse into a single
 *   `[...]` placeholder per contiguous run.
 *
 * Walking the JSONL once linearly is enough — we just have to know up
 * front which tool_use IDs are "recent" so we can route their result
 * counterparts the same way.
 */
function formatSummary(entries: JsonlEntry[], keepLastTools: number): string {
  const allToolUseIds: string[] = []
  for (const e of entries) {
    if (e.type !== 'assistant') continue
    const m = e as JsonlMessageEntry
    if (isSyntheticAssistant(m)) continue
    for (const b of getBlocks(m)) {
      const x = b as { type?: string; id?: string }
      if (x.type === 'tool_use' && x.id) allToolUseIds.push(x.id)
    }
  }
  const keptIds = new Set(
    allToolUseIds.slice(Math.max(0, allToolUseIds.length - keepLastTools))
  )

  const lines: string[] = [
    `[auto-time-compact] Conversation transcript. The most recent ${keepLastTools} tool call(s) are kept verbatim; older tool I/O is elided as "${TOOL_PLACEHOLDER}".`,
  ]
  let droppedPending = false
  const flushDropped = () => {
    if (droppedPending) { lines.push(TOOL_PLACEHOLDER); droppedPending = false }
  }

  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const m = entry as JsonlMessageEntry
    if (m.isCompactSummary) continue
    if (isSyntheticAssistant(m)) continue

    if (m.type === 'user') {
      const blocks = getBlocks(m)
      const isToolResultMsg = blocks.some(
        (b) => (b as { type?: string }).type === 'tool_result'
      )
      if (!isToolResultMsg) {
        const text = joinTextBlocks(m)
        if (text) {
          flushDropped()
          lines.push('')
          lines.push(`User: ${text}`)
        }
        continue
      }
      for (const b of blocks) {
        const x = b as ToolResultBlock & { type?: string; tool_use_id?: string }
        if (x.type !== 'tool_result') continue
        if (x.tool_use_id && keptIds.has(x.tool_use_id)) {
          flushDropped()
          const text = stringifyToolResult(x.content).trim()
          if (text) lines.push(`[tool_result] ${truncate(text, TOOL_RESULT_MAX_CHARS)}`)
        } else {
          droppedPending = true
        }
      }
    } else {
      for (const b of getBlocks(m)) {
        const x = b as {
          type?: string
          text?: string
          id?: string
          name?: string
          input?: unknown
        }
        if (x.type === 'text' && typeof x.text === 'string') {
          flushDropped()
          lines.push(`Assistant: ${x.text}`)
        } else if (x.type === 'tool_use') {
          if (x.id && keptIds.has(x.id)) {
            flushDropped()
            let input: string
            try { input = JSON.stringify(x.input ?? {}) } catch { input = '{}' }
            lines.push(`[tool_use: ${x.name ?? 'unknown'}] ${input}`)
          } else {
            droppedPending = true
          }
        }
      }
    }
  }
  flushDropped()
  return lines.join('\n')
}

function makeBoundary(sessionId: string, parentUuid: string | null) {
  return {
    parentUuid,
    logicalParentUuid: parentUuid,
    isSidechain: false,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted (auto, time-based)',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 0 },
    compact_metadata: { trigger: 'auto', pre_tokens: 0 },
    sessionContextMetadata: { strategy: STRATEGY },
    userType: 'external',
    entrypoint: ENTRYPOINT_TAG,
    cwd: '/workspace',
    sessionId,
    version: APP_VERSION,
    gitBranch: 'HEAD',
    slug: ENTRYPOINT_TAG,
  }
}

function makeSummaryEntry(sessionId: string, boundaryUuid: string, summary: string) {
  return {
    parentUuid: boundaryUuid,
    isSidechain: false,
    promptId: randomUUID(),
    type: 'user',
    message: { role: 'user', content: summary },
    uuid: randomUUID(),
    timestamp: new Date(Date.now() + 1).toISOString(),
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    userType: 'external',
    entrypoint: ENTRYPOINT_TAG,
    cwd: '/workspace',
    sessionId,
    version: APP_VERSION,
    gitBranch: 'HEAD',
    slug: ENTRYPOINT_TAG,
  }
}

function countFreshActivity(
  entries: JsonlEntry[],
  latestBoundaryTs: string | null
): { newUserText: number; newToolUses: number } {
  let newUserText = 0
  let newToolUses = 0
  for (const e of entries) {
    const ts = (e as { timestamp?: string }).timestamp
    if (latestBoundaryTs && (!ts || ts <= latestBoundaryTs)) continue
    if (isHumanUserText(e)) newUserText++
    if (e.type === 'assistant') {
      for (const b of getBlocks(e as JsonlMessageEntry)) {
        if ((b as { type?: string }).type === 'tool_use') newToolUses++
      }
    }
  }
  return { newUserText, newToolUses }
}

export async function advanceAutoTimeCompact(
  agentSlug: string,
  sessionId: string,
  keepLastTools: number
): Promise<boolean> {
  const tag = `[AutoTimeCompact] ${agentSlug}/${sessionId}`
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)

  const entries = await readJsonlFile<JsonlEntry>(jsonlPath)
  if (entries.length === 0) return false

  let latestBoundaryTs: string | null = null
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isCompactBoundary(entries[i])) {
      latestBoundaryTs = (entries[i] as { timestamp?: string }).timestamp ?? null
      break
    }
  }

  const { newUserText, newToolUses } = countFreshActivity(entries, latestBoundaryTs)
  if (newUserText < MIN_NEW_USER_TEXT) return false
  if (newToolUses <= MIN_NEW_TOOL_USES) return false

  const summary = formatSummary(entries, keepLastTools)

  const tailUuid = (entries[entries.length - 1] as { uuid?: string }).uuid
  if (!tailUuid) return false

  const boundary = makeBoundary(sessionId, tailUuid)
  const summaryEntry = makeSummaryEntry(sessionId, boundary.uuid, summary)
  await fs.promises.appendFile(
    jsonlPath,
    [JSON.stringify(boundary), JSON.stringify(summaryEntry)].map((l) => l + '\n').join(''),
    'utf-8'
  )

  try {
    await containerManager.getClient(agentSlug).interruptSession(sessionId)
  } catch (err) {
    console.warn(`${tag} interruptSession failed (non-fatal):`, err)
  }

  console.log(
    `${tag} compacted: entries=${entries.length} keepLastTools=${keepLastTools} ` +
      `newUserText=${newUserText} newToolUses=${newToolUses} summaryChars=${summary.length}`
  )
  return true
}
