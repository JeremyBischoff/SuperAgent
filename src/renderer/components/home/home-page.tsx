
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { WidgetBoard, WidgetSizePopover, type GridRect, type WidgetItem, type WidgetSizeKey } from './widget-grid'
import { useAgents, useStartAgent, useStopAgent } from '@renderer/hooks/use-agents'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useMarkSessionNotificationsRead } from '@renderer/hooks/use-notifications'
import { applyAgentOrder } from '@renderer/lib/agent-ordering'
import { useSessions } from '@renderer/hooks/use-sessions'
import { useSelection } from '@renderer/context/selection-context'
import { Halftone } from '@renderer/components/agents/halftone'
import { UptimeBars, type UptimeRun, type UptimeRunStatus } from '@renderer/components/agents/uptime-bars'
import { WebhookHealthBars, type WebhookHealth } from '@renderer/components/agents/webhook-health-bars'
import { getAgentActivityStatus } from '@shared/lib/types/agent-activity-status'
import { WorkingDots, AwaitingDot, UnreadDot } from '@renderer/components/agents/status-indicators'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { useCreateUntitledAgent } from '@renderer/hooks/use-create-untitled-agent'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Button } from '@renderer/components/ui/button'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { DashboardCard } from './dashboard-card'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { Plus, Bot, Loader2, Search, Power, Square, Check, ArrowRight } from 'lucide-react'
import { useSearch } from '@renderer/context/search-context'
import { cn } from '@shared/lib/utils/cn'
import type { ApiAgent } from '@shared/lib/types/api'
import { formatDistanceToNow } from 'date-fns'
import { useRenderTracker } from '@renderer/lib/perf'

export function formatRelativeTime(date: Date | string | null | undefined): string | null {
  if (!date) return null
  const now = Date.now()
  const then = new Date(date).getTime()
  const diffMs = now - then
  const absDiff = Math.abs(diffMs)
  const isFuture = diffMs < 0

  if (absDiff < 60_000) return 'just now'
  const mins = Math.floor(absDiff / 60_000)
  if (mins < 60) return isFuture ? `in ${mins}m` : `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return isFuture ? `in ${hours}h` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return isFuture ? `in ${days}d` : `${days}d ago`
  const months = Math.floor(days / 30)
  return isFuture ? `in ${months}mo` : `${months}mo ago`
}

// Per-status ink color for the card's halftone banner. Motion/form (the motif)
// distinguishes agents; color just reflects activity state.
const HALFTONE_INK: Record<ReturnType<typeof getAgentActivityStatus>, string> = {
  sleeping: 'text-muted-foreground/50',
  idle: 'text-muted-foreground',
  working: 'text-foreground',
  awaiting_input: 'text-orange-500',
}

function hashSlug(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h
}

// ---- MOCK: per-trigger uptime bars ---------------------------------------
// Pure visual placeholder while we figure out the real trigger/runs wiring.
// Each agent gets 1–3 fake triggers, deterministic from its slug.
const MOCK_LABELS = ['Daily digest', 'Inbox sweep', 'Refresh metrics', 'Weekly review', 'Backup sync', 'Pulse check']
const UPTIME_BAR_COUNT = 14

function mockUptimeRows(slug: string): { id: string; label: string; runs: UptimeRun[] }[] {
  const h = hashSlug(slug)
  const rowCount = 1 + (h % 3) // 1..3 triggers per agent
  const rows: { id: string; label: string; runs: UptimeRun[] }[] = []
  const now = Date.now()
  for (let r = 0; r < rowCount; r++) {
    const rowSeed = (h ^ ((r + 1) * 2654435761)) >>> 0
    const label = MOCK_LABELS[(rowSeed >>> 8) % MOCK_LABELS.length]
    const runs: UptimeRun[] = []
    for (let i = 0; i < UPTIME_BAR_COUNT; i++) {
      const bit = (rowSeed >>> i) & 0x1f
      let status: UptimeRunStatus
      if (bit < 22) status = 'success'
      else if (bit < 26) status = 'awaiting'
      else if (bit < 28) status = 'failed'
      else status = 'empty'
      // Bars read left→right oldest→newest; rightmost is most recent.
      const ageDays = UPTIME_BAR_COUNT - 1 - i
      runs.push({
        status,
        sessionId: status === 'empty' ? undefined : `mock-${slug}-${r}-${i}`,
        startedAt: status === 'empty' ? undefined : new Date(now - ageDays * 24 * 60 * 60 * 1000),
      })
    }
    rows.push({ id: `${slug}-mock-${r}`, label, runs })
  }
  return rows
}

// MOCK: fake webhook-event volume so each card shows a different health state
// (normal / drop / spike / silent), deterministic from the agent slug.
const MOCK_WEBHOOK_LABELS = ['GitHub push', 'Stripe events', 'Gmail inbox', 'Calendar updates', 'Linear webhooks', 'Slack mentions']
const WEBHOOK_DAYS = 14

function mockWebhookHealth(slug: string): WebhookHealth {
  const h = hashSlug(slug)
  let seed = (h ^ 0x9e3779b9) >>> 0
  const rand = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0xffffffff
  }
  const label = MOCK_WEBHOOK_LABELS[(h >>> 5) % MOCK_WEBHOOK_LABELS.length]
  const baseline = 20 + Math.floor(rand() * 180) // ~20–200 events/day
  const counts: number[] = []
  for (let i = 0; i < WEBHOOK_DAYS; i++) {
    const noise = 1 + (rand() - 0.5) * 0.4 // ±20% daily jitter
    counts.push(Math.max(0, Math.round(baseline * noise)))
  }
  // Bend the most recent day(s) per scenario so the gradient varies card-to-card.
  const scenario = h % 4
  if (scenario === 1) {
    counts[WEBHOOK_DAYS - 1] = Math.round(baseline * 0.4) // a drop
    counts[WEBHOOK_DAYS - 2] = Math.round(baseline * 0.55)
  } else if (scenario === 2) {
    counts[WEBHOOK_DAYS - 1] = Math.round(baseline * (2 + rand())) // a spike
  } else if (scenario === 3) {
    counts[WEBHOOK_DAYS - 1] = 0 // crash to zero
    counts[WEBHOOK_DAYS - 2] = Math.round(baseline * 0.3)
  }
  return { counts, label }
}

// MOCK: pretend some agents (1 in 3, by slug hash) have no triggers/webhooks
// configured, so their cards render no health carousel at all.
function mockHasHealth(slug: string): boolean {
  return hashSlug(slug) % 3 !== 0
}
// --------------------------------------------------------------------------

// State label for the top-right status/control chip.
const AGENT_STATE_TAG: Record<'sleeping' | 'idle' | 'working' | 'awaiting', string> = {
  sleeping: 'Sleeping',
  idle: 'Idle',
  working: 'Working…',
  awaiting: 'Needs input',
}

function AgentCardPowerButton({ agent }: { agent: ApiAgent }) {
  const startAgent = useStartAgent()
  const stopAgent = useStopAgent()
  const isRunning = agent.status === 'running'
  const isPending = isRunning ? stopAgent.isPending : startAgent.isPending
  const tagState: 'sleeping' | 'idle' | 'working' | 'awaiting' = !isRunning
    ? 'sleeping'
    : agent.hasSessionsAwaitingInput
      ? 'awaiting'
      : agent.hasActiveSessions
        ? 'working'
        : 'idle'
  const label = AGENT_STATE_TAG[tagState]

  const activate = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    if (isPending) return
    if (isRunning) {
      stopAgent.mutate(agent.slug)
    } else {
      startAgent.mutate(agent.slug)
    }
  }

  return (
    // Frosted status chip with a white-bordered stop/power button inside. It's a
    // flex item in the card's control row (see AgentCard), so the kebab aligns
    // with it natively.
    <div className="flex items-center gap-1.5 rounded-md border border-border/50 bg-white/10 py-0.5 pl-1.5 pr-1 text-xs backdrop-blur-sm">
      <span className="leading-none text-muted-foreground">{label}</span>
      <span
        role="button"
        tabIndex={0}
        aria-label={isRunning ? 'Stop agent' : 'Wake up agent'}
        title={isRunning ? 'Stop agent' : 'Wake up agent'}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            activate(e)
          }
        }}
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded border bg-background text-foreground shadow-sm',
          'cursor-pointer transition-colors hover:bg-muted',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          isPending && 'pointer-events-none opacity-60'
        )}
      >
        {isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : isRunning ? (
          <Square className="h-2.5 w-2.5 fill-current" />
        ) : (
          <Power className="h-2.5 w-2.5" />
        )}
      </span>
    </div>
  )
}

// Baked halftone render settings + per-state motion (chosen during exploration;
// the dev tweak panel that produced them lives on the animation-experiments-draft
// branch). flow_3d is the working/idle/sleeping identity; pulse (in orange ink,
// via HALFTONE_INK) is the needs-input state.
const HALFTONE_STATE: Record<'sleeping' | 'idle' | 'working', { speed: number; dim: number; contrast: number }> = {
  // Clear separation: sleeping/idle are slow + faint + soft; working is notably
  // faster, fuller, and higher-contrast (bolder, denser dots).
  sleeping: { speed: 0.25, dim: 0.4, contrast: 1.35 },
  idle: { speed: 0.4, dim: 0.5, contrast: 1.4 },
  working: { speed: 0.9, dim: 1, contrast: 1.95 },
}

function AgentCardMatrix({
  slug,
  status,
  hasActiveSessions,
  hasSessionsAwaitingInput,
  className,
}: {
  slug: string
  status: 'running' | 'stopped'
  hasActiveSessions: boolean
  hasSessionsAwaitingInput: boolean
  /** Banner geometry (aspect ratio or fixed height); defaults to the wide strip. */
  className?: string
}) {
  const activityStatus = getAgentActivityStatus(status, hasActiveSessions, hasSessionsAwaitingInput)
  const stateTweak = activityStatus === 'awaiting_input' ? undefined : HALFTONE_STATE[activityStatus]
  return (
    <div
      role="img"
      aria-label={activityStatus}
      className={cn('w-full overflow-hidden', className ?? 'aspect-[32/9]', HALFTONE_INK[activityStatus])}
    >
      <Halftone
        motif={activityStatus === 'awaiting_input' ? 'pulse' : 'flow_3d'}
        state={activityStatus === 'working' ? 'working' : activityStatus === 'awaiting_input' ? 'alert' : 'idle'}
        speed={stateTweak?.speed}
        dim={stateTweak?.dim}
        spacing={5}
        maxRadius={1.3}
        vignette={0.4}
        contrast={stateTweak?.contrast ?? 1.6}
        speedScale={1}
        seed={hashSlug(slug)}
      />
    </div>
  )
}

interface NotableSession {
  id: string
  name: string
  isActive?: boolean
  isAwaitingInput?: boolean
  hasUnreadNotifications?: boolean
  lastActivityAt?: Date | string
}

/**
 * Strip a leading agent-name prefix from a session name — inside the agent's
 * own card it's redundant ("Test Agent One Story Session" → "Story Session").
 * Matches the longest run of the agent's leading words (so partial prefixes
 * like "Test Agent Linear…" under "Test Agent One" still strip), but requires
 * at least two words (or the full single-word name) to avoid false positives.
 */
function stripAgentPrefix(sessionName: string, agentName: string): string {
  const sessionWords = sessionName.trim().split(/\s+/)
  const agentWords = agentName.trim().split(/\s+/).filter(Boolean)
  if (agentWords.length === 0) return sessionName
  let matched = 0
  while (
    matched < agentWords.length &&
    matched < sessionWords.length &&
    sessionWords[matched].toLowerCase() === agentWords[matched].toLowerCase()
  ) {
    matched++
  }
  if (matched < Math.min(2, agentWords.length)) return sessionName
  const rest = sessionWords.slice(matched).join(' ').replace(/^[\s:–—\-·]+/, '')
  return rest.length >= 3 ? rest : sessionName
}

/** Compact relative age: 4m, 1h, 2d. */
function compactAgo(date: Date | string | undefined): string | null {
  if (!date) return null
  const mins = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60_000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

type SessionState = 'awaiting' | 'working' | 'unread'

// Notification-row prefix describing what happened in the session.
const SESSION_STATE_PREFIX: Record<SessionState, string> = {
  awaiting: 'Input needed',
  working: 'Working',
  unread: 'New message',
}

function sessionState(s: NotableSession): SessionState {
  if (s.isAwaitingInput) return 'awaiting'
  if (s.isActive) return 'working'
  return 'unread'
}

function SessionStateDot({ state }: { state: SessionState }) {
  // The three dots have different intrinsic footprints (awaiting reserves 12px
  // for its ping halo, unread is a bare 6px). Center each in one fixed 12px box
  // so the dot centers — and the text start — align across rows.
  const dot =
    state === 'awaiting' ? <AwaitingDot /> : state === 'working' ? <WorkingDots dotClassName="bg-foreground" /> : <UnreadDot />
  return <span className="flex h-3 w-3 shrink-0 items-center justify-center">{dot}</span>
}

/** Keyboard-activatable span — cards are <button>s, so inner controls can't be native buttons. */
function rowButtonProps(onActivate: (e: React.SyntheticEvent) => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      onActivate(e)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        onActivate(e)
      }
    },
  }
}

/**
 * Notifications section: a frosted panel (matching the title pill / health
 * chips) of hairline-divided rows — state dot, name, and a right-aligned
 * compact timestamp. Sizes to its content and scrolls when the list outgrows
 * the space available in the card.
 */
function AgentCardSessions({
  agentSlug,
  agentName,
  sessions,
}: {
  agentSlug: string
  agentName: string
  sessions: NotableSession[] | undefined
}) {
  const { setAgent } = useSelection()
  const markRead = useMarkSessionNotificationsRead()
  const notable = useMemo(
    () => (sessions ?? []).filter((s) => s.isActive || s.isAwaitingInput || s.hasUnreadNotifications),
    [sessions]
  )
  if (notable.length === 0) return null
  const open = (id: string) => setAgent(agentSlug, { kind: 'session', id })
  // Show up to three rows as-is; with four or more, show two and collapse the
  // rest into a trailing "{X} more →" row.
  const visible = notable.length > 3 ? notable.slice(0, 2) : notable
  const moreCount = notable.length - visible.length

  return (
    <div className="flex max-h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/50 bg-white/10 backdrop-blur-sm">
      <div className="min-h-0 overflow-y-auto px-2 py-1">
        {visible.map((s) => {
          const st = sessionState(s)
          const right = compactAgo(s.lastActivityAt) ?? ''
          return (
            <div
              key={s.id}
              className="group/row flex h-6 w-full items-center gap-2.5 text-xs"
            >
              <span {...rowButtonProps(() => open(s.id))} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left">
                <SessionStateDot state={st} />
                <span className="truncate text-foreground">
                  <span className="text-muted-foreground">{SESSION_STATE_PREFIX[st]}: </span>
                  {stripAgentPrefix(s.name, agentName)}
                </span>
              </span>
              {st === 'unread' || st === 'awaiting' ? (
                <>
                  {/* The timestamp swaps for actions on hover: unread gets
                      clear + open; needs-input has nothing to clear, just open. */}
                  <span className="shrink-0 text-muted-foreground tabular-nums group-hover/row:hidden">{right}</span>
                  <span className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
                    {st === 'unread' && (
                      <span
                        {...rowButtonProps(() => markRead.mutate(s.id))}
                        aria-label="Mark as read"
                        title="Mark as read"
                        className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </span>
                    )}
                    <span
                      {...rowButtonProps(() => open(s.id))}
                      aria-label="Open session"
                      title="Open session"
                      className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  </span>
                </>
              ) : (
                <span className="shrink-0 text-muted-foreground tabular-nums">{right}</span>
              )}
            </div>
          )
        })}
        {moreCount > 0 && (
          <span
            {...rowButtonProps(() => setAgent(agentSlug))}
            className="group/row flex h-6 w-full cursor-pointer items-center justify-end gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>{moreCount} more</span>
            <span className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground group-hover/row:inline-flex">
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * MOCK: rotating health carousel for the card's bottom row. One full-width
 * slide at a time — each cron trigger's uptime row, then the webhook health
 * row — so labels get the whole row instead of clipping. Auto-advances every
 * few seconds, pauses on hover; the dots jump straight to a slide.
 */
function AgentHealthCarousel({ agent }: { agent: ApiAgent }) {
  const { setAgent } = useSelection()
  const slides = useMemo(
    () => [
      ...mockUptimeRows(agent.slug).map((row) => ({ kind: 'cron' as const, id: row.id, row })),
      { kind: 'webhook' as const, id: `${agent.slug}-webhook`, health: mockWebhookHealth(agent.slug) },
    ],
    [agent.slug]
  )
  const count = slides.length
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused || count < 2) return
    const t = setInterval(() => setIndex((i) => (i + 1) % count), 4000)
    return () => clearInterval(t)
  }, [paused, count])

  const active = slides[index % count]

  const renderSlide = (s: (typeof slides)[number]) =>
    s.kind === 'cron' ? (
      <UptimeBars
        runs={s.row.runs}
        label={s.row.label}
        onRunClick={(run) => {
          if (run.sessionId) {
            setAgent(agent.slug, { kind: 'session', id: run.sessionId })
          }
        }}
      />
    ) : (
      <WebhookHealthBars health={s.health} />
    )

  return (
    <div
      className="mt-auto flex shrink-0 items-center gap-1.5"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* The frosted panel (title's bg-white/10 + backdrop-blur) lives on the
          container so the halftone reads softly through it and never flashes.
          A single content layer slides up inside it on each change — nothing
          underneath to bleed through. */}
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-md border border-border/50 bg-white/10 backdrop-blur-sm">
        <div
          key={active.id}
          className="px-2 py-1.5 animate-in slide-in-from-bottom-full duration-300"
        >
          {renderSlide(active)}
        </div>
      </div>
      {/* Vertical position dots, outside the chip to the right */}
      {count > 1 && (
        <span className="flex shrink-0 flex-col items-center gap-1">
          {slides.map((s, i) => (
            <span
              key={s.id}
              {...rowButtonProps(() => setIndex(i))}
              aria-label={`Show health row ${i + 1} of ${count}`}
              className={cn(
                'h-[3px] w-[3px] cursor-pointer rounded-full transition-colors',
                i === index % count ? 'bg-foreground/70' : 'bg-muted-foreground/30 hover:bg-muted-foreground/60'
              )}
            />
          ))}
        </span>
      )}
    </div>
  )
}

/**
 * Small-card title meta as a ticker: a single line that continuously scrolls
 * "Last run X · {N} new notifications" (orange needs-input dot wins over blue
 * unread), looping seamlessly via a duplicated run.
 */
function TickerTitleMeta({
  lastWorked,
  notifCount,
  notifState,
}: {
  lastWorked: string | null
  notifCount: number
  notifState: SessionState
}) {
  const run = (
    <span className="flex items-center gap-1.5 pr-8 text-muted-foreground">
      <span>Last run {lastWorked ?? 'never'}</span>
      <SessionStateDot state={notifState} />
      <span>
        {notifCount} new notification{notifCount !== 1 ? 's' : ''}
      </span>
    </span>
  )
  return (
    <div className="relative h-4 overflow-hidden text-xs">
      <style>{'@keyframes title-ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}'}</style>
      <div
        className="flex w-max items-center whitespace-nowrap"
        style={{ animation: 'title-ticker 14s linear infinite' }}
      >
        {run}
        {run}
      </div>
    </div>
  )
}

/**
 * Agent card, size-aware for the widget grid:
 *   S (1×1) — full-bleed halftone glance tile: title + last run + state pill.
 *   W (2×1) — banner strip, notifications in the middle, cron + webhook charts
 *             sharing one row pinned to the bottom.
 */
function AgentCard({ agent, size = 'W', sizeControl }: { agent: ApiAgent; size?: WidgetSizeKey; sizeControl?: ReactNode }) {
  useRenderTracker('AgentCard')
  const { setAgent } = useSelection()
  const lastWorked = agent.lastActivityAt ? formatDistanceToNow(new Date(agent.lastActivityAt), { addSuffix: true }) : null

  const isSmall = size === 'S'

  // Fetch sessions whenever there are notable ones — the Wide card lists them,
  // the Small card rotates a count into the title.
  const hasNotable = agent.hasActiveSessions || agent.hasSessionsAwaitingInput || agent.hasUnreadNotifications
  const { data: sessions } = useSessions(hasNotable ? agent.slug : null, { staleTime: 30_000 })

  // Notification summary for the Small card's rotating title meta. Orange
  // (needs input) always wins over blue (unread).
  const notifSessions = useMemo(
    () => (sessions ?? []).filter((s) => s.isAwaitingInput || s.hasUnreadNotifications),
    [sessions]
  )
  const notifState: SessionState | null = notifSessions.some((s) => s.isAwaitingInput)
    ? 'awaiting'
    : notifSessions.length > 0
      ? 'unread'
      : null

  const titleOverlay = (
    <div className="absolute bottom-2 left-4 max-w-[calc(100%-2rem)] rounded-md bg-white/10 px-2.5 py-1 backdrop-blur-sm">
      <div className="truncate text-sm font-normal text-foreground">{agent.name}</div>
      {isSmall && notifState ? (
        <TickerTitleMeta lastWorked={lastWorked} notifCount={notifSessions.length} notifState={notifState} />
      ) : (
        <div className="truncate text-xs text-muted-foreground">Last run {lastWorked ?? 'never'}</div>
      )}
    </div>
  )

  return (
    <AgentContextMenu agent={agent}>
      <button
        onClick={() => setAgent(agent.slug)}
        className="relative flex h-full w-full flex-col gap-3 overflow-hidden rounded-lg border bg-card p-4 text-left shadow-sm transition-[box-shadow,transform,border-color] duration-150 hover:border-accent-foreground/20 group-hover/widget:-translate-y-0.5 group-hover/widget:shadow-md"
      >
        {/* Control row: status chip + size kebab share one flex row, so
            items-center vertically centers the kebab against the chip, and the
            kebab simply appears to its right on hover (right-anchored row). */}
        <div className="absolute top-2 right-4 z-30 flex items-center gap-1.5">
          <AgentCardPowerButton agent={agent} />
          {sizeControl}
        </div>

        {isSmall ? (
          /* Glance tile: the halftone fills the card, content overlays it. */
          <>
            <div className="absolute inset-0">
              <AgentCardMatrix
                slug={agent.slug}
                status={agent.status}
                hasActiveSessions={agent.hasActiveSessions ?? false}
                hasSessionsAwaitingInput={agent.hasSessionsAwaitingInput ?? false}
                className="h-full"
              />
            </div>
            {titleOverlay}
          </>
        ) : (
          /* Wide: same glance-tile footing as Small — halftone fills the card,
             title in the bottom-left corner — with the notifications + health
             carousel overlaid on top. The content reserves bottom space (pb-11)
             so it clears the title pill. */
          <>
            <div className="absolute inset-0">
              <AgentCardMatrix
                slug={agent.slug}
                status={agent.status}
                hasActiveSessions={agent.hasActiveSessions ?? false}
                hasSessionsAwaitingInput={agent.hasSessionsAwaitingInput ?? false}
                className="h-full"
              />
            </div>
            <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-1.5 pb-11">
              {/* Notifications sit directly above the cron/webhook carousel
                  (bottom-aligned); any slack opens up above them. Scrolls when
                  the list overflows. */}
              <div className="flex min-h-0 flex-1 flex-col justify-end">
                <AgentCardSessions agentSlug={agent.slug} agentName={agent.name} sessions={sessions} />
              </div>
              {/* MOCK: rotating cron/webhook health carousel (not wired yet);
                  some mock agents have none. */}
              {mockHasHealth(agent.slug) && <AgentHealthCarousel agent={agent} />}
            </div>
            {titleOverlay}
          </>
        )}
      </button>
    </AgentContextMenu>
  )
}

/** Widget-grid key for a dashboard tile. Agents use their bare slug. */
const dashKey = (agentSlug: string, dashSlug: string) => `dash::${agentSlug}::${dashSlug}`

export function HomePage() {
  useRenderTracker('HomePage')
  const { data: agents, isLoading: agentsLoading } = useAgents()
  const { data: userSettings } = useUserSettings()
  const updateSettings = useUpdateUserSettings()

  // agentOrder (sidebar drag order) drives the initial flow-pack order of
  // uncustomized boards; once the user drags/resizes here, homeGridLayout wins.
  const orderedAgents = useMemo(
    () => applyAgentOrder(agents ?? [], userSettings?.agentOrder),
    [agents, userSettings?.agentOrder]
  )

  // Optimistic local layout while the homeGridLayout mutation is in flight.
  const [localLayout, setLocalLayout] = useState<Record<string, GridRect> | null>(null)
  const savedLayout = localLayout ?? userSettings?.homeGridLayout

  // Agents whose associated app/dashboard card is toggled off. localHidden is a
  // session override that wins over the server value, so the toggle takes effect
  // immediately and isn't clobbered by the post-save refetch.
  const [localHidden, setLocalHidden] = useState<Set<string> | null>(null)
  const hiddenApps = useMemo(
    () => localHidden ?? new Set(userSettings?.hiddenAppCards ?? []),
    [localHidden, userSettings?.hiddenAppCards]
  )

  const { widgetItems, dashboardsById, agentsWithApp } = useMemo(() => {
    const items: WidgetItem[] = []
    const dashes = new Map<string, { agentSlug: string; dashboard: { slug: string; name: string } }>()
    const withApp = new Set<string>()
    for (const agent of orderedAgents) {
      items.push({ id: agent.slug, rect: savedLayout?.[agent.slug], defaultSize: 'W' })
      const dashboards = Array.isArray(agent.dashboards) ? agent.dashboards : []
      if (dashboards.length > 0) withApp.add(agent.slug)
      if (hiddenApps.has(agent.slug)) continue // app card toggled off — skip its dashboard tiles
      for (const d of dashboards) {
        const id = dashKey(agent.slug, d.slug)
        items.push({ id, rect: savedLayout?.[id], defaultSize: 'S' })
        dashes.set(id, { agentSlug: agent.slug, dashboard: d })
      }
    }
    return { widgetItems: items, dashboardsById: dashes, agentsWithApp: withApp }
  }, [orderedAgents, savedLayout, hiddenApps])

  const agentBySlug = useMemo(() => new Map(orderedAgents.map((a) => [a.slug, a])), [orderedAgents])

  const commitLayout = (layout: Record<string, GridRect>) => {
    setLocalLayout(layout)
    updateSettings.mutate({ homeGridLayout: layout }, { onSettled: () => setLocalLayout(null) })
  }

  const toggleAppCard = (agentSlug: string) => {
    const next = new Set(hiddenApps)
    if (next.has(agentSlug)) next.delete(agentSlug)
    else next.add(agentSlug)
    setLocalHidden(next)
    updateSettings.mutate({ hiddenAppCards: [...next] })
  }

  const { createUntitledAgent, isPending: isCreatingAgent } = useCreateUntitledAgent()
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  const hasAgents = orderedAgents.length > 0
  const { openSearch } = useSearch()
  const isMac = getPlatform() === 'darwin'

  return (
    <div className="h-full flex flex-col">
      <header
        className={`shrink-0 flex h-12 items-center gap-2 border-b bg-background px-4 ${isElectron() ? 'app-drag-region' : ''}`}
      >
        <SidebarTrigger
          className={`app-no-drag ${needsTrafficLightPadding ? 'ml-16' : '-ml-1'}`}
        />
        <div className="flex-1 flex justify-center">
          <button
            type="button"
            onClick={openSearch}
            className="flex items-center gap-2 w-full max-w-md h-7 rounded-md border bg-muted/30 hover:bg-muted/60 transition-colors px-3 text-xs text-muted-foreground app-no-drag"
            data-testid="header-search-trigger"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 text-left truncate">Search agents and sessions...</span>
            <kbd className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
              {isMac ? '⌘K' : 'Ctrl+K'}
            </kbd>
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-7xl mx-auto space-y-8">
          {/* Agents Section */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Your Agents</h2>
              <Button
                size="sm"
                onClick={() => { void createUntitledAgent() }}
                className="app-no-drag"
                disabled={isCreatingAgent}
              >
                <Plus className="h-4 w-4 mr-1" />
                New Agent
              </Button>
            </div>

            {agentsLoading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : hasAgents ? (
              <WidgetBoard
                items={widgetItems}
                onCommit={commitLayout}
                renderItem={(id, size, onResize) => {
                  const dash = dashboardsById.get(id)
                  if (dash) {
                    return (
                      <div className="relative h-full transition-transform duration-150 group-hover/widget:-translate-y-0.5">
                        <DashboardCard dashboard={dash.dashboard} agentSlug={dash.agentSlug} variant="fill" align={size === 'S' ? 'top-left' : 'top'} />
                        <div className="absolute right-4 top-2 z-30 flex h-[26px] items-center">
                          <WidgetSizePopover size={size} onPick={onResize} />
                        </div>
                      </div>
                    )
                  }
                  const agent = agentBySlug.get(id)
                  if (!agent) return null
                  const sizeControl = (
                    <WidgetSizePopover
                      size={size}
                      onPick={onResize}
                      extra={
                        agentsWithApp.has(agent.slug) ? (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={!hiddenApps.has(agent.slug)}
                            aria-label="Show app card"
                            onClick={() => toggleAppCard(agent.slug)}
                            className="flex w-full items-center justify-between gap-3 px-1 py-0.5 text-xs"
                          >
                            <span>Show app</span>
                            <span
                              className={cn(
                                'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
                                !hiddenApps.has(agent.slug) ? 'bg-primary' : 'bg-input'
                              )}
                            >
                              <span
                                className={cn(
                                  'block h-3 w-3 rounded-full bg-background shadow transition-transform',
                                  !hiddenApps.has(agent.slug) ? 'translate-x-3.5' : 'translate-x-0.5'
                                )}
                              />
                            </span>
                          </button>
                        ) : null
                      }
                    />
                  )
                  return <AgentCard agent={agent} size={size} sizeControl={sizeControl} />
                }}
              />
            ) : (
              <div className="text-center py-12 border rounded-lg bg-muted/30">
                <Bot className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground mb-4">No agents yet</p>
                <Button onClick={() => { void createUntitledAgent() }} disabled={isCreatingAgent}>
                  <Plus className="h-4 w-4 mr-1" />
                  Create your first agent
                </Button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
