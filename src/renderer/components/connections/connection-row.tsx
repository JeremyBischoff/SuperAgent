import type { ReactNode } from 'react'
import { IntegrationRow } from './integration-row'
import { McpStatusPill } from './mcp-status-pill'
import { formatCompactDistance, safeDate } from './utils'
import type { UnifiedRow } from './unified-rows'

interface ConnectionRowProps {
  row: UnifiedRow
  /** Right-side slot — pills, actions, switch, etc. */
  right: ReactNode
  /** Optional trailing item appended after the timestamp (e.g. trigger count). */
  subtitleExtra?: ReactNode
  /**
   * Optional content right-justified at the end of the subtitle row (no `·`
   * separator). Used for inline metadata like "N agents connected".
   */
  subtitleTrailing?: ReactNode
  /** When set, animates row position via the View Transitions API. */
  viewTransitionName?: string
  /** When provided, the row becomes clickable (and Enter/Space-activatable). */
  onActivate?: () => void
  /** Accessible label for the row when interactive. */
  ariaLabel?: string
}

export function ConnectionRow({
  row,
  right,
  subtitleExtra,
  subtitleTrailing,
  viewTransitionName,
  onActivate,
  ariaLabel,
}: ConnectionRowProps) {
  return (
    <IntegrationRow
      viewTransitionName={viewTransitionName}
      iconSlug={row.iconSlug}
      iconFallback={row.iconFallback}
      name={row.name}
      onActivate={onActivate}
      ariaLabel={ariaLabel}
      nameBadge={<McpStatusPill status={row.mcpStatus} errorMessage={row.mcpErrorMessage} />}
      subtitle={
        <>
          <span className="shrink-0">{row.type === 'oauth' ? 'API' : 'MCP'}</span>
          {row.subtitle && (
            <>
              <span className="shrink-0">·</span>
              <span className="truncate">{row.subtitle}</span>
            </>
          )}
          <span className="shrink-0">·</span>
          <span className="whitespace-nowrap shrink-0 tabular-nums">
            {formatCompactDistance(safeDate(row.date))}
          </span>
          {subtitleExtra && (
            <>
              <span className="shrink-0">·</span>
              {subtitleExtra}
            </>
          )}
          {subtitleTrailing && (
            <span className="ml-auto shrink-0 pl-2">{subtitleTrailing}</span>
          )}
        </>
      }
      right={right}
    />
  )
}
