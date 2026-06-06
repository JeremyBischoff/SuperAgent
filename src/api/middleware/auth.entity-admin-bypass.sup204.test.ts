import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// SUP-204 — EntityAgentRole admin ACL-bypass repro.
//
// In AUTH_MODE the generic EntityAgentRole() middleware (scheduled-task,
// webhook-trigger, chat-integration routes) checked the caller's per-agent ACL
// role but never short-circuited for app admins, unlike AgentRead/AgentUser/
// AgentAdmin. An app admin (role==='admin') with no explicit agentAcl row got a
// 403 on those entity routes.
//
// This suite mirrors the EntityAgentRole() block in auth.test.ts but exercises
// the admin path. The mock preamble must be set up before importing the module
// under test (vi.mock is hoisted).
// ---------------------------------------------------------------------------

const mockIsAuthMode = vi.fn<() => boolean>()
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

const mockGetSession = vi.fn()
vi.mock('@shared/lib/auth/index', () => ({
  getAuth: () => ({ api: { getSession: mockGetSession } }),
}))

// Drizzle select chain: db.select().from().where().limit() -> mockLimit.
// mockSelect is the spy we assert was NOT called when an admin bypasses ACL.
const mockLimit = vi.fn()
const mockWhere = vi.fn(() => ({ limit: mockLimit }))
const mockFrom = vi.fn(() => ({ where: mockWhere }))
const mockSelect = vi.fn((..._args: unknown[]) => ({ from: mockFrom }))

vi.mock('@shared/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: { userId: 'user_id', agentSlug: 'agent_slug', role: 'role' },
  connectedAccounts: { id: 'id', userId: 'user_id' },
  remoteMcpServers: { id: 'id', userId: 'user_id' },
  notifications: { id: 'id', userId: 'user_id', agentSlug: 'agent_slug' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  and: (...args: unknown[]) => args,
}))

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: vi.fn(),
}))

// Import after mocks
import { EntityAgentRole } from './auth'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestEntity = { agentSlug: string; name: string }
const mockLookup = vi.fn<(id: string) => Promise<TestEntity | null>>()

const TestEntityRole = EntityAgentRole({
  paramName: 'entityId',
  lookupFn: mockLookup,
  contextKey: 'testEntity',
  entityName: 'Test entity',
})

/** Build a Hono app whose pre-middleware stamps the given user on context. */
function buildEntityApp(minRole: 'viewer' | 'user' | 'owner', user: { id: string; role?: string }) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('user' as never, user as never)
    return next()
  })
  app.get('/:entityId', TestEntityRole(minRole), (c) => {
    const entity = c.get('testEntity' as never)
    return c.json({ ok: true, entity })
  })
  return app
}

function mockAclQuery(role: string | null) {
  mockLimit.mockResolvedValue(role ? [{ role }] : [])
}

async function request(app: Hono, path = '/entity-1') {
  return app.request(`http://localhost${path}`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EntityAgentRole() — app-admin ACL bypass (SUP-204)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAuthMode.mockReturnValue(true)
    mockLookup.mockReset()
  })

  it('allows admins without requiring an explicit ACL row (even for the strictest role) and never consults the ACL', async () => {
    const entity: TestEntity = { agentSlug: 'my-agent', name: 'X' }
    mockLookup.mockResolvedValue(entity)
    // No ACL row for this admin on this agent.
    mockAclQuery(null)

    // 'owner' is the strictest role — the toughest case for the bypass.
    const app = buildEntityApp('owner', { id: 'admin-1', role: 'admin' })
    const res = await request(app)

    expect(res.status).toBe(200)
    const body = await res.json()
    // Entity is still stashed on context for the handler.
    expect(body.entity).toEqual(entity)
    // The admin bypass must occur BEFORE any ACL lookup.
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('still 404s for admins when the entity is missing (not-found precedes the bypass)', async () => {
    mockLookup.mockResolvedValue(null)

    const app = buildEntityApp('owner', { id: 'admin-1', role: 'admin' })
    const res = await request(app, '/missing-id')

    expect(res.status).toBe(404)
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('regression: a non-admin user with no ACL row still gets 403', async () => {
    const entity: TestEntity = { agentSlug: 'my-agent', name: 'X' }
    mockLookup.mockResolvedValue(entity)
    mockAclQuery(null)

    const app = buildEntityApp('owner', { id: 'user-1', role: 'user' })
    const res = await request(app)

    expect(res.status).toBe(403)
    // Non-admins are gated by the ACL lookup.
    expect(mockSelect).toHaveBeenCalled()
  })
})
