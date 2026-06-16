# Stale-session prompt — design

**Date:** 2026-06-15
**Branch:** `feat/stale-session-prompt`
**Status:** design approved, pending implementation plan
**Mockup:** `~/.gstack/projects/JeremyBischoff-SuperAgent/designs/stale-session-prompt-20260615/stale-session-prompt-mockups.html` (Variant A approved)

## Problem

Users don't understand sessions or when to start a new one, so they keep messaging the same conversation forever. Long conversations get slower and more expensive (every message re-reads the whole context), and the right moment to branch is never surfaced.

## Goals (roughly equal weight; teaching + cost lead slightly)

1. **Teach the session model** — make the new-topic vs continue-efficiently distinction legible at the moment it matters.
2. **Cut cost/latency** — branching away from a bloated context lowers the per-message cost.
3. **Frictionless continuation** — carrying context into a fresh session must be effortless.

A single prompt, fired at send-time into a stale session, that justifies itself with the real numbers and offers the cheaper paths.

## Behavioral model (inspired by Claude Code's resume prompt)

Claude Code shows a prompt when resuming an old/large session ("This session is 3d 3h old and 448.8k tokens… We recommend resuming from a summary"). We borrow the **behavior**, not the terminal UI:

- Lead with the **real numbers** (tokens + rough dollar cost), so the prompt teaches and justifies itself honestly.
- "Resume from summary" in Claude Code literally runs `/compact`; it never summarizes a full oversized transcript. It keeps live context window-bounded **incrementally** (auto-compact + microcompact) and reconstructs from `compact_boundary` markers, then summarizes a window-sized chunk. Its injected summary ends with "read the full transcript at: \<path\>".
- We diverge in two deliberate ways: (a) we **branch to a new session** instead of compacting in place (the ticket's intent, and the teaching goal); (b) we show **current-context cost** (forward, next-message) instead of cumulative (Claude Code's resume-reconstruction framing).

## Trigger

Fires when a user sends a message into an **existing** session (not the new-session composer) and **all** of:

- `!isAwaitingInput` — session is **not** parked on a permission/tool/secret/etc. decision. (Team's rule: a hanging permission needs full live context to resolve; never offer to branch it.)
- session is **not actively running** (agent mid-turn).
- **AND** one of (OR):
  - **idle gap:** `now − lastActivityAt > STALE_TIME_GAP_MS` (default **6h**)
  - **size:** current context > `STALE_CONTEXT_TOKENS` (default **~150k**, ≈75% of the 200k window — near the likely auto-compact point, so it fires in a narrow band before a compaction; confirm it trips in practice)

OR (not AND) because the two signals serve different goals: idle → "returning, maybe new topic" (teaching); size → "expensive right now" (cost). AND would miss the old-but-small case and the big-but-recent case.

**Why current context, not cumulative:** branching saves *future* per-message cost, which is driven by the current live context, not the sunk cumulative total. Auto-compact (on by default) keeps the live context bounded and oscillating under ~200k; the current value is also what the client already has (`lastUsage`), so the trigger needs no new plumbing.

**Signals (all already available):**
- `lastActivityAt` — precomputed per session (`parseSessionInfo`, `session-service.ts:179-222`); on `useSession` in `main-content.tsx`.
- current context **occupancy** — `lastUsage.inputTokens + cacheReadInputTokens + cacheCreationInputTokens` (last turn's input side ≈ what the next message re-reads). **NOTE:** `contextWindow` (the `?? 200_000` fallback at `use-message-stream.ts:726`) is the model's **max window**, not occupancy — use it only as the denominator for a "% full" framing, never as the size signal itself. Live via the `context_usage` SSE event; persisted as `lastUsage`; `contextUsage` in `main-content.tsx:98`. Confirm exact field semantics at implementation.
- `isAwaitingInput` — `messagePersister.isSessionAwaitingInput` (`message-persister.ts:323`), surfaced on the sessions list (`agents.ts:1261`); for the open session, derivable live from `useMessageStream` pending arrays.

**Thresholds live as named constants in code** (a dedicated `shared/` module), not user settings, not UI. They are current best guesses to be calibrated from real usage; promote to env-overridable (Claude Code uses `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`) only if ops demand appears.

## The prompt (Variant A)

An `AlertDialog` (reuse the `MountChoiceDialog` button-grid pattern, `mount-choice-dialog.tsx:20-69`) over the dimmed chat, in SuperAgent's existing monochrome dark theme.

**Header — concrete numbers, scenario-adaptive:**
- size trigger: "This chat is holding ~152k tokens in context. Your next message re-reads all of it — about $0.55, and that repeats on every message."
- idle trigger: "Last active 3 days ago. (~12k tokens, ~$0.04 to continue.) If this is a new topic, a fresh chat keeps \<Agent\> focused."
- Dollar figure assumes API billing; on a subscription it reads as "a chunk of your usage limits." The app knows the billing mode (`platform-tab.tsx` subscription vs `ANTHROPIC_API_KEY`).

**Three explicit options** (each states what happens to the just-typed message):
1. **Continue from a summary** *(recommended, visually defaulted)* — fresh, fast session carrying a short summary; "your current chat stays saved."
2. **Start a new topic with \<Agent\>** — clean slate, nothing carried over.
3. **Send here anyway** — keep full context in this conversation; **permanent per-session dismissal** ("we won't ask again in this one").

## Actions

- **Start a new topic** → existing create-session path with the user's message verbatim (`useCreateSession`, `use-sessions.ts:35-61` → `POST /api/agents/:id/sessions`). No summary, no jsonl reference. Navigate via `setView({kind:'session', id})`.
- **Continue from a summary** → new server endpoint (below). Generates/reuses a summary, composes the new session's `initialMessage`, creates the session, returns its id; client navigates in.
- **Send here anyway** → dismiss, send into the current session as originally intended (existing `useSendMessage`), and set the per-session dismissal flag. Message never lost.

## Summary mechanism

Generation happens **server-side** (needs the LLM client + jsonl read). One new endpoint, e.g. `POST /api/agents/:id/sessions/branch`.

**Budgeted-recency, single rule:** feed the summarizer the most recent messages up to a token budget = Haiku window (~200k) minus headroom for the instruction and output. A small session → the budget swallows it whole; a big one → the recent slice. No separate "is it oversized?" branch. When the budget forces a slice, **prepend any existing `compact_boundary` summary** already in the `.jsonl` (Claude Code's "last summary + recent verbatim" shape) so the older portion isn't lost.

- **Reuse before generate:** if the old `.jsonl` already holds a recent `compact_boundary` summary (auto-compact is on by default, so long sessions accumulate them), reuse it — zero LLM cost. Only generate fresh when none exists or it's stale.
- **Model:** the existing `summarizerModel` setting (default `claude-haiku-4-5`) via `getConfiguredLlmClient` (`llm-provider/helpers.ts:15-20`), following the `agent-template-service.ts` / `skillset-service.ts` pattern (`messages.create` + json_schema + `withRetry`). Haiku's lower fidelity is acceptable *because* the full transcript is reachable.
- **Injected `initialMessage` (Claude Code's proven shape):** `[continuation preamble + summary + "full transcript at: <in-container jsonl path>" + "continue directly, don't recap"] + [user's original typed message]`. The jsonl path is the **in-container** path (`.claude/projects/-workspace/{oldSessionId}.jsonl`), readable because all of an agent's sessions share one workspace. It is for **targeted** lookups, never a bulk re-read.
- **Injection point:** `CreateSessionRequest.initialMessage` (`agent-container/src/types.ts:55-70`; delivered at `session-manager.ts:147`).

## Rendering the carried-over context

Split what's **sent** from what's **shown**:
- **Sent to the model:** the full payload above.
- **Shown to the user:** a **collapsed "Continued from \<old session name\>" card** (reuse the existing `compact_boundary` visual treatment, `message-transform.ts`), summary on expand; the user's actual typed message renders normally below. Requires a small marker so the renderer distinguishes carried-context from the real message.

## Cost / token display

- Token count = **current context** (`lastUsage`), formatted with existing `formatTokens` (`subagent-block.tsx:29`).
- Cost = current context × rate from the existing `usage-service.ts` + `model-pricing.json` (rates broken out by input / output / cacheCreation / cacheRead, `usage-service.ts:72`). **Extract a shared `estimateMessageCost(tokens, model)` helper** (second consumer now).
- Idle session = cold cache → the first message pays the **cache-creation** rate on the whole context; that is the accurate "cost to come back" figure.
- Output excluded (unpredictable); input dominates for the sessions we prompt on. Always labeled "~".

## Failure + latency

- **During generation:** "Continue from a summary" enters a loading state **in the modal** ("Carrying over context…"); other options stay clickable. Reuse of an existing boundary is near-instant. Hard timeout (~10-15s).
- **On success:** create session, navigate in, context card populated.
- **On failure:** stay in the modal, honest inline error ("Couldn't summarize right now"), keep **Retry / Start a new topic / Send here anyway**. Never create a half-summarized session, never drop the message, never fall back to "let the agent read the whole transcript" (recreates the oversized-context problem).

## Persistence — per-session dismissal

Add `stalePromptDismissed?: boolean` to `SessionMetadata` (`agent.ts:78-108`, stored in `session-metadata.json`). Set via the existing session-update path (the one that already handles `starred`/rename — open to extension, no new endpoint). The trigger checks `!stalePromptDismissed`. Survives reloads/restarts.

## Architecture

- **Trigger detection: client-side** — the client already has every signal; gate in `MessageInput.onSubmit` (`message-input.tsx:64-92`) before `sendMessage.mutateAsync()`.
- **Branch-with-summary: one new server endpoint** — reads jsonl, summarizes, creates the session with the injected message.
- Trigger logic isolated in one pure helper (time + size + awaiting-input + dismissed → decision) so it's unit-testable and extractable if a second consumer (e.g. chat integrations) ever appears. Server preflight endpoint deferred (YAGNI; no second consumer yet).
- **Zod at the boundary** (project convention): schemas for the branch request, the summary payload, and the new `SessionMetadata` field, in a dedicated `*-schema.ts` beside the feature.

## Stated assumptions (carried in without separate grilling — flag during review if wrong)

- **Scope:** interactive UI sends only. Programmatic/invoked sessions (`x-agent`) bypass naturally since the gate lives in `MessageInput`.
- **Multi-user web:** dismissal is **per-session** (anyone's "send here anyway" silences it for that session). The new branched session is owned by the user who branched.
- **New session inherits** the old session's model + effort settings (continuity).
- **Old session is left untouched** (branch is non-destructive; it stays in the sidebar). No old→new cross-link in v1.
- **Brand-new sessions never prompt** (structural: the new-session composer is a different component).

## Key files / seams

| Concern | Location |
|---|---|
| Send (gate here) | `src/renderer/components/messages/message-input.tsx:64-92`; `use-messages.ts` |
| New session | `use-sessions.ts:35-61` → `POST /api/agents/:id/sessions` (`agents.ts:1273-1376`) → `session-manager.ts:90-160` |
| Navigation | `selection-context.tsx` (`setView`/`setAgent`); `main-content.tsx:189` |
| Session data | `useSession` (`main-content.tsx:68`); `SessionInfo`/`ApiSession` (`api.ts:85,95`) |
| Suppression | `isAwaitingInput` (`agents.ts:1261`, `message-persister.ts:323`); `useMessageStream` pending arrays |
| Size/cost | `lastUsage`/`context_usage` (`use-message-stream.ts:716-729`, `main-content.tsx:98`); `usage-service.ts` + `model-pricing.json`; `formatTokens` |
| Summary | `summarizerModel` (`config/settings.ts`); `getConfiguredLlmClient` (`llm-provider/helpers.ts:15-20`); `agent-template-service.ts` pattern |
| jsonl | `getSessionJsonlPath` (`file-storage.ts:431-441`); `readJsonlFile` (`session-service.ts`) |
| compact_boundary | `ApiCompactBoundary` (`api.ts:177-184`); `message-transform.ts`; `message-persister` `isCompactSummary` |
| Dialog | `alert-dialog.tsx`; `mount-choice-dialog.tsx:20-69` |
| Metadata | `SessionMetadata` (`agent.ts:78-108`); `registerSession` (`session-service.ts:103-116`) |

## Testing

- **Trigger helper (pure):** unit tests over (idle time, current tokens, isAwaitingInput, running, dismissed) → prompt/suppress decision, including each OR branch and every suppression case.
- **Summary service:** mock the LLM boundary; assert budgeted-recency slicing, compact_boundary reuse, payload composition, in-container jsonl path, and the failure path.
- **Cost helper:** unit test `estimateMessageCost` against `model-pricing.json`, incl. cache-creation-when-idle.
- **E2E:** stale session → prompt appears; awaiting-permission session → suppressed; each action lands in the right place; "send here anyway" → never prompts that session again. (Run mock-mode, tee'd: `E2E_MOCK=true npx playwright test 2>&1 | tee /tmp/e2e-results.txt`.)

## Open calibration items (post-ship, from real usage)

- `STALE_TIME_GAP_MS` (6h) — top candidate for tuning.
- `STALE_CONTEXT_TOKENS` (~150k) — sits near the auto-compact point; verify it actually fires, drop toward ~100-120k if it rarely trips.
- Summarizer budget headroom; whether Haiku fidelity is sufficient or worth the main model.
