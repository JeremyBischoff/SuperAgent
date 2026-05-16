import { Button } from '@renderer/components/ui/button'
import { useSelection } from '@renderer/context/selection-context'
import { getApiBaseUrl } from '@renderer/lib/env'
import { SquareMousePointer, ArrowUpRight } from 'lucide-react'
import type { ApiAgentDashboard } from '@shared/lib/types/api'

export function DashboardCard({
  dashboard,
  agentSlug,
}: {
  dashboard: ApiAgentDashboard
  agentSlug: string
}) {
  const { setAgent } = useSelection()

  const handleClick = () => {
    setAgent(agentSlug, { kind: 'dashboard', slug: dashboard.slug })
  }

  // Prefix with getApiBaseUrl() so the <img> resolves to the dynamic Electron
  // API port (and to same-origin in web mode). Bare `/api/...` would resolve
  // against the renderer's origin and 404.
  const screenshotUrl = dashboard.hasScreenshot
    ? `${getApiBaseUrl()}/api/agents/${encodeURIComponent(agentSlug)}/artifacts/${encodeURIComponent(dashboard.slug)}/screenshot.png`
    : null

  return (
    // Card sits in normal flow at 96px tall and grows to 160px on hover, so
    // the height transition pushes the rows below it down rather than
    // overlaying them.
    <div className="group">
      <div
        className="relative h-24 group-hover:h-40 group-hover:shadow-lg rounded-lg border bg-card hover:border-accent-foreground/20 overflow-hidden [transition:height_300ms_cubic-bezier(0.2,0.8,0.2,1),box-shadow_250ms_ease-out,border-color_200ms_ease-out]"
      >
        {screenshotUrl ? (
          <img
            src={screenshotUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top"
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/40">
            <SquareMousePointer className="h-8 w-8 text-muted-foreground/50" />
          </div>
        )}
        <div className="relative z-10 flex h-full flex-col items-end justify-end p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <Button type="button" size="sm" variant="outline" onClick={handleClick}>
            Open app
            <ArrowUpRight />
          </Button>
        </div>
      </div>
    </div>
  )
}
