import { useCallback } from 'react'
import { toast } from 'sonner'
import { useCreateAgent } from '@renderer/hooks/use-agents'
import { useSelection } from '@renderer/context/selection-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'

export const UNTITLED_AGENT_NAME = 'Untitled'

// "Initializing" hold (~1s) + the staggered slide-in runtime, after which
// the just-created flag is cleared so revisiting the agent doesn't replay
// the animation.
const INTRO_ANIMATION_MS = 2200

/**
 * Immediately creates an Untitled agent and selects it. Replaces the old
 * "open the create-agent modal" flow — the user lands on the agent's home
 * page where the composer + creation aids handle the rest.
 *
 * Sets `justCreatedSlug` so AgentHome plays its staggered slide-in intro on
 * arrival (CSS disables it under prefers-reduced-motion).
 */
export function useCreateUntitledAgent() {
  const createAgent = useCreateAgent()
  const { setAgent, setJustCreatedSlug } = useSelection()
  const { track } = useAnalyticsTracking()

  const createUntitledAgent = useCallback(async () => {
    try {
      const agent = await createAgent.mutateAsync({ name: UNTITLED_AGENT_NAME })
      track('agent_created', { source: 'new', num_skills_added_at_creation: 0 })

      setJustCreatedSlug(agent.slug)
      setAgent(agent.slug)
      setTimeout(() => setJustCreatedSlug(null), INTRO_ANIMATION_MS)

      return agent
    } catch (error) {
      console.error('Failed to create untitled agent:', error)
      toast.error('Failed to create agent', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
      return null
    }
  }, [createAgent, setAgent, setJustCreatedSlug, track])

  return {
    createUntitledAgent,
    isPending: createAgent.isPending,
  }
}
