import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ============================================================================
// Security repro guardrails for the agents router.
//
// These tests prove that the remote-MCP assignment routes verify the acting
// user owns the requested MCP IDs (SUP-199). Without the ownership check, a
// user with access to any agent could attach another user's remote MCP — and
// its stored bearer/OAuth credentials — to that agent.
//
// Harness: db.select() drains `selectQueue` in call order; db.insert().values()
// records into `insertValuesCalls`. Auth is mocked so AgentUser() passes and the
// acting user / auth-mode are controllable per test.
// ============================================================================

// --- Mutable harness state (referenced only by mock *implementations*, set in
// --- beforeEach / individual tests — never inside a vi.mock factory) ---------
let selectQueue: unknown[] = []
let insertValuesCalls: unknown[] = []

// Auth middleware — passthrough (caller already proved AgentUser access)
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentRead: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentUser: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

// Container manager (provide-remote-mcp grabs a client; ownership rejection
// returns before it is ever used)
const mockContainerFetch = vi.fn()
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getClient: () => ({
      fetch: (...args: unknown[]) => mockContainerFetch(...args),
      start: vi.fn(),
      stop: vi.fn(),
    }),
    ensureRunning: vi.fn(),
    getCachedInfo: () => ({ status: 'running', port: 8080 }),
  },
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    broadcastGlobal: vi.fn(),
    persistMessage: vi.fn(),
    markAllSessionsInactiveForAgent: vi.fn(),
  },
}))

// DB mock — select drains selectQueue; insert.values() records the rows.
const mockDbSelect = vi.fn()
const mockDbInsert = vi.fn()
vi.mock('@shared/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    delete: () => ({ where: () => Promise.resolve(undefined) }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  remoteMcpServers: { id: 'id', userId: 'user_id', name: 'name', url: 'url', status: 'status', toolsJson: 'tools_json' },
  agentRemoteMcps: { id: 'id', agentSlug: 'agent_slug', remoteMcpId: 'remote_mcp_id', createdAt: 'created_at' },
  connectedAccounts: {},
  agentConnectedAccounts: {},
  proxyAuditLog: {},
  mcpAuditLog: {},
  agentAcl: {},
  user: {},
  messageAuthor: {},
  apiScopePolicies: {},
  mcpToolPolicies: {},
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  and: (...args: unknown[]) => args,
  inArray: (col: string, vals: string[]) => ({ col, vals }),
  desc: (col: string) => ({ col }),
  count: () => 'count',
  like: (col: string, val: string) => ({ col, val }),
  or: (...args: unknown[]) => args,
}))

// Auth mode + current user — controllable per test
const mockIsAuthMode = vi.fn(() => true)
const mockGetCurrentUserId = vi.fn(() => 'user-b')
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => mockIsAuthMode() }))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => mockGetCurrentUserId() }))

// Remaining agents.ts dependencies (not exercised here, but needed to import it)
vi.mock('@shared/lib/services/agent-service', () => ({
  listAgentsWithStatus: vi.fn(), createAgent: vi.fn(), getAgentWithStatus: vi.fn(),
  getAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(),
  agentExists: vi.fn().mockResolvedValue(true),
}))
vi.mock('@shared/lib/services/session-service', () => ({
  listSessions: vi.fn(), updateSessionName: vi.fn(), registerSession: vi.fn(),
  getSessionMessagesWithCompact: vi.fn(), getSession: vi.fn(), getSessionMetadata: vi.fn(),
  updateSessionMetadata: vi.fn(), deleteSession: vi.fn(), removeMessage: vi.fn(), removeToolCall: vi.fn(),
}))
vi.mock('@shared/lib/services/secrets-service', () => ({
  listSecrets: vi.fn(), getSecret: vi.fn(), setSecret: vi.fn(), deleteSecret: vi.fn(),
  keyToEnvVar: vi.fn(), getSecretEnvVars: vi.fn(),
}))
vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  listScheduledTasks: vi.fn(), listPendingScheduledTasks: vi.fn(),
}))
vi.mock('@shared/lib/account-providers', () => ({ getProvider: vi.fn() }))
vi.mock('@shared/lib/services/skillset-service', () => ({
  getAgentSkillsWithStatus: vi.fn(), getDiscoverableSkills: vi.fn(), installSkillFromSkillset: vi.fn(),
  updateSkillFromSkillset: vi.fn(), createSkillPR: vi.fn(), getSkillPRInfo: vi.fn(),
  getSkillPublishInfo: vi.fn(), publishSkillToSkillset: vi.fn(), refreshAgentSkills: vi.fn(),
}))
vi.mock('@shared/lib/services/artifact-service', () => ({ listArtifactsFromFilesystem: vi.fn() }))
vi.mock('@shared/lib/proxy/host-url', () => ({
  getContainerHostUrl: () => 'localhost', getAppPort: () => 3000,
}))
vi.mock('@shared/lib/services/agent-template-service', () => ({
  exportAgentTemplate: vi.fn(), importAgentFromTemplate: vi.fn(), installAgentFromSkillset: vi.fn(),
  updateAgentFromSkillset: vi.fn(), getAgentTemplateStatus: vi.fn(), getDiscoverableAgents: vi.fn(),
  refreshSkillsetCaches: vi.fn(), getAgentPRInfo: vi.fn(), createAgentPR: vi.fn(),
  getAgentPublishInfo: vi.fn(), publishAgentToSkillset: vi.fn(), refreshAgentTemplates: vi.fn(),
  hasOnboardingSkill: vi.fn(),
}))
vi.mock('@shared/lib/utils/retry', () => ({ withRetry: vi.fn() }))
vi.mock('@shared/lib/utils/message-transform', () => ({ transformMessages: vi.fn() }))
vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveAnthropicApiKey: () => 'test-key', getEffectiveModels: () => ({}),
  getEffectiveAgentLimits: () => ({}), getCustomEnvVars: () => ({}), getSettings: () => ({ container: {} }),
}))
vi.mock('@shared/lib/proxy/token-store', () => ({ revokeProxyToken: vi.fn(), validateProxyToken: vi.fn() }))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@shared/lib/utils/file-storage', () => ({
  getSessionJsonlPath: vi.fn(), readFileOrNull: vi.fn(), getAgentSessionsDir: vi.fn(),
  readJsonlFile: vi.fn(), getAgentWorkspaceDir: vi.fn(), getTempUploadsDir: vi.fn(),
  ensureDirectory: vi.fn(), removeDirectory: vi.fn(),
}))

// Import the agents router after all mocks are set up
import agents from './agents'

// --- Harness helpers ---------------------------------------------------------

// A thenable that ignores all query-builder chaining and resolves to the next
// queued select result (defaulting to [] when the queue is drained).
function makeSelectChain() {
  const result = selectQueue.length > 0 ? selectQueue.shift() : []
  const chain: Record<string, unknown> = {}
  for (const method of ['from', 'innerJoin', 'leftJoin', 'rightJoin', 'where', 'orderBy', 'limit', 'offset', 'groupBy', 'having']) {
    chain[method] = () => chain
  }
  chain.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result).then(onF, onR)
  chain.catch = (onR: (e: unknown) => unknown) => Promise.resolve(result).catch(onR)
  chain.finally = (onF: () => void) => Promise.resolve(result).finally(onF)
  return chain
}

// insert(table).values(rows) records rows and is awaitable both directly and
// via .onConflictDoNothing().
function makeInsertChain() {
  return {
    values: (rows: unknown) => {
      insertValuesCalls.push(rows)
      const settled = Promise.resolve(undefined)
      return {
        onConflictDoNothing: () => settled,
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => settled.then(onF, onR),
        catch: (onR: (e: unknown) => unknown) => settled.catch(onR),
        finally: (onF: () => void) => settled.finally(onF),
      }
    },
  }
}

function appWithAgents() {
  const app = new Hono()
  app.route('/api/agents', agents)
  return app
}

function expectClientError(status: number) {
  expect(status).toBeGreaterThanOrEqual(400)
  expect(status).toBeLessThan(500)
}

describe('security repro: remote MCP ownership (SUP-199)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectQueue = []
    insertValuesCalls = []
    mockIsAuthMode.mockReturnValue(true)
    mockGetCurrentUserId.mockReturnValue('user-b')
    mockDbSelect.mockImplementation(() => makeSelectChain())
    mockDbInsert.mockImplementation(() => makeInsertChain())
  })

  it('rejects attaching another user remote MCP id to an agent', async () => {
    selectQueue = [[]]

    const res = await appWithAgents().request('http://localhost/api/agents/attacker-agent/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpIds: ['victim-mcp-id'] }),
    })

    expectClientError(res.status)
    expect(insertValuesCalls).toEqual([])
  })

  it('rejects providing another user remote MCP id at runtime approval', async () => {
    selectQueue = [[]]

    const res = await appWithAgents().request('http://localhost/api/agents/attacker-agent/sessions/sess-1/provide-remote-mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId: 'tu-1', remoteMcpId: 'victim-mcp-id' }),
    })

    expectClientError(res.status)
    expect(insertValuesCalls).toEqual([])
    expect(mockContainerFetch).not.toHaveBeenCalled()
  })

  it('allows attaching a remote MCP the acting user owns', async () => {
    mockGetCurrentUserId.mockReturnValue('user-a')
    // 1) ownership lookup -> owned; 2) existing-mappings lookup -> none
    selectQueue = [[{ id: 'my-mcp-id' }], []]

    const res = await appWithAgents().request('http://localhost/api/agents/my-agent/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpIds: ['my-mcp-id'] }),
    })

    expect(res.status).toBe(200)
    expect(insertValuesCalls).toHaveLength(1)
    expect(insertValuesCalls[0]).toEqual([
      expect.objectContaining({ agentSlug: 'my-agent', remoteMcpId: 'my-mcp-id' }),
    ])
  })

  it('does not gate on ownership when auth mode is disabled', async () => {
    mockIsAuthMode.mockReturnValue(false)
    // 1) ownership lookup (no userId filter) -> exists; 2) existing-mappings -> none
    selectQueue = [[{ id: 'shared-mcp-id' }], []]

    const res = await appWithAgents().request('http://localhost/api/agents/my-agent/remote-mcps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpIds: ['shared-mcp-id'] }),
    })

    expect(res.status).toBe(200)
    expect(insertValuesCalls).toHaveLength(1)
  })
})
