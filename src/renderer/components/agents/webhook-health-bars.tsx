import { useId } from 'react'

/**
 * Webhook health indicator.
 *
 * Unlike the cron UptimeBars (discrete pass/fail per scheduled run), a webhook
 * has no "expected" event — its baseline is its own recent history. So this is
 * an anomaly view of *received-event volume*, not a status view.
 *
 * A gradient sparkline of daily received-event counts carries the whole signal:
 * the line is colored per-point by how far that day strays from the typical
 * rate — green inside the normal range, ramping through yellow to red as volume
 * drops or spikes. Direction isn't valence: both a collapse and a burst warm
 * toward red, because both mean "not behaving like it usually does."
 */

export interface WebhookHealth {
  /** Daily received-event counts, oldest → newest (e.g. last 14 days). */
  counts: number[]
  /** Display name for the hook (e.g. "GitHub push"). */
  label: string
}

// Column widths shared with the cron UptimeBars so the `·` + label line up
// across rows in the agent cards. Keep these in sync (68px graphic / w-10 metric).
const SPARK_W = 68 // px
const SPARK_H = 12 // px — match the cron pill height (UptimeBars uses h-3 = 12px)
const STROKE = 1.5 // px
const PAD = STROKE / 2 // inset by half the stroke so peak→trough == SPARK_H exactly

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function formatRate(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

/**
 * Health color for a single day's count: green inside the normal band, ramping
 * through yellow to red as it strays. Symmetric — a drop and a spike of equal
 * relative size get the same warmth.
 */
function healthColor(count: number, baseline: number): string {
  const rel = baseline > 0 ? Math.abs(count - baseline) / baseline : 0
  // Green core until ~20% off; fully red by ~100% off.
  const severity = Math.min(1, Math.max(0, (rel - 0.2) / 0.8))
  const hue = 140 - severity * 140 // 140 green → ~70 yellow → 0 red
  return `hsl(${Math.round(hue)} 72% 50%)`
}

interface WebhookHealthBarsProps {
  health: WebhookHealth
}

export function WebhookHealthBars({ health }: WebhookHealthBarsProps) {
  const { counts, label } = health
  const gradientId = useId()

  const baseline = median(counts)
  const n = counts.length

  // Normalize to the window's own min/max so the line uses the full height.
  const maxV = Math.max(...counts, 1)
  const minV = Math.min(...counts, 0)
  const span = maxV - minV || 1
  const y = (c: number) => PAD + (1 - (c - minV) / span) * (SPARK_H - 2 * PAD)
  const xAt = (i: number) => (n > 1 ? (i / (n - 1)) * SPARK_W : 0)

  const points = counts.map((c, i) => `${xAt(i).toFixed(1)},${y(c).toFixed(1)}`).join(' ')

  const current = counts[n - 1] ?? 0
  const rel = baseline > 0 ? (current - baseline) / baseline : 0
  const state = Math.abs(rel) <= 0.2 ? 'normal' : rel > 0 ? `${Math.round(rel * 100)}% above typical` : `${Math.round(-rel * 100)}% below typical`
  const ariaLabel = `${label}: ${formatRate(baseline)}/day, ${state}`

  return (
    <div className="flex items-center gap-2 text-xs" role="img" aria-label={ariaLabel}>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground">{label}</span> <span className="text-muted-foreground">Webhook</span>
      </span>
      <svg
        width={SPARK_W}
        height={SPARK_H}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        className="shrink-0 overflow-visible"
        aria-hidden
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            {counts.map((c, i) => (
              <stop key={i} offset={`${n > 1 ? (i / (n - 1)) * 100 : 0}%`} stopColor={healthColor(c, baseline)} />
            ))}
          </linearGradient>
        </defs>
        <polyline
          points={points}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={STROKE}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>

      <span className="w-10 tabular-nums text-muted-foreground shrink-0">{formatRate(baseline)}/d</span>
    </div>
  )
}
