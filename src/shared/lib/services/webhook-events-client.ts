/**
 * Webhook Events Client
 *
 * Calls the platform proxy's webhook event endpoints for
 * polling pending events and acknowledging consumed events.
 */

import { decodeOrgIdFromToken } from '@shared/lib/platform-attribution'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'

// ============================================================================
// Types
// ============================================================================

export interface WebhookEvent {
  id: string
  composio_trigger_id: string
  trigger_type: string
  payload: unknown
  created_at: string
}

export interface RealtimeConfig {
  url: string
  apikey: string
  jwt: string
  channel: string
}

export interface PollResult {
  events: WebhookEvent[]
  realtime: RealtimeConfig | null
}

// ============================================================================
// API Calls
// ============================================================================

// Org-scoped JWTs encode the acting platform member as `<token>::<memberId>`
// (the proxy splits on `::` before JWT verification). Single-user opaque
// access keys ignore the suffix and act as the owner directly.
function buildBearer(memberId: string): string {
  const token = getPlatformAccessToken()
  if (!token) {
    throw new Error('Platform access token not available')
  }
  return decodeOrgIdFromToken(token) ? `${token}::${memberId}` : token
}

async function webhookEventsFetch<T>(
  endpoint: string,
  memberId: string,
  options: RequestInit = {},
): Promise<T> {
  const baseUrl = getPlatformProxyBaseUrl()
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${buildBearer(memberId)}`)

  const response = await fetch(`${baseUrl}/v1/webhook-events${endpoint}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Webhook events API error ${response.status}: ${text}`)
  }

  return response.json()
}

/**
 * Poll for pending webhook events and get Realtime connection credentials.
 * Events are atomically claimed (status: pending → claimed) on the server side.
 *
 * @param memberId Platform `subscribed_member.id` (`sub_...`) whose events to claim;
 * must match `webhook_events.member_id` rows Composio delivers for this user.
 */
export async function pollAndClaimEvents(memberId: string): Promise<PollResult> {
  return webhookEventsFetch<PollResult>('/poll', memberId, { method: 'POST' })
}

/**
 * Acknowledge events as consumed so they are not returned in the next poll.
 * Uses the same member context as the poll that claimed them.
 */
export async function acknowledgeEvents(
  eventIds: string[],
  memberId: string,
): Promise<void> {
  if (eventIds.length === 0) return
  await webhookEventsFetch('/ack', memberId, {
    method: 'POST',
    body: JSON.stringify({ event_ids: eventIds }),
  })
}
