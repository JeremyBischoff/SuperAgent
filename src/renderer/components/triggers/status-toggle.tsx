import { Pause } from 'lucide-react'
import { Switch } from '@renderer/components/ui/switch'

interface StatusToggleProps {
  status: string
  isActive: boolean
  isPaused: boolean
  disabled?: boolean
  canToggle: boolean
  onToggle: (next: boolean) => void
  activeLabel?: string
  pausedLabel?: string
  ariaLabelResume?: string
  ariaLabelPause?: string
}

export function StatusToggle({
  status,
  isActive,
  isPaused,
  disabled = false,
  canToggle,
  onToggle,
  activeLabel = 'Active',
  pausedLabel = 'Paused',
  ariaLabelResume = 'Resume',
  ariaLabelPause = 'Pause',
}: StatusToggleProps) {
  if (!isActive || !canToggle) {
    return <span className="text-xs text-muted-foreground capitalize">{status}</span>
  }

  return (
    <div className="flex items-center gap-2">
      <div
        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${
          isPaused
            ? 'bg-muted text-muted-foreground'
            : 'bg-green-500/10 text-green-700 dark:text-green-400'
        }`}
      >
        {isPaused ? (
          <Pause className="h-2.5 w-2.5 fill-current" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        )}
        {isPaused ? pausedLabel : activeLabel}
      </div>
      <Switch
        checked={!isPaused}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-label={isPaused ? ariaLabelResume : ariaLabelPause}
      />
    </div>
  )
}
