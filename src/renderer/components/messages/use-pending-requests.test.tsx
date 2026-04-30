// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReactElement } from 'react'
import { usePendingRequests } from './use-pending-requests'
import { createAssistantMessage, createUserMessage, createToolCall } from '@renderer/test/factories'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'

// Mock useMessages
const mockMessagesData: { data: ApiMessageOrBoundary[] | undefined; isLoading: boolean } = {
  data: undefined,
  isLoading: false,
}

vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => mockMessagesData,
}))

// Mock useMessageStream
const mockStreamState = {
  isActive: false,
  pendingSecretRequests: [] as Array<{ toolUseId: string; secretName: string; reason?: string }>,
  pendingConnectedAccountRequests: [] as Array<{ toolUseId: string; toolkit: string; reason?: string }>,
  pendingRemoteMcpRequests: [] as Array<{ toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' }>,
  pendingQuestionRequests: [] as Array<{ toolUseId: string; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }> }>,
  pendingFileRequests: [] as Array<{ toolUseId: string; description: string; fileTypes?: string }>,
  pendingBrowserInputRequests: [] as Array<{ toolUseId: string; message: string; requirements: string[] }>,
  pendingScriptRunRequests: [] as Array<{ toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell' }>,
  pendingComputerUseRequests: [] as Array<{ toolUseId: string; method: string; params: Record<string, unknown>; permissionLevel: string; appName?: string }>,
  autoApprovedScriptRunIds: new Set<string>(),
}

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => mockStreamState,
  removeSecretRequest: vi.fn(),
  removeConnectedAccountRequest: vi.fn(),
  removeRemoteMcpRequest: vi.fn(),
  removeQuestionRequest: vi.fn(),
  removeFileRequest: vi.fn(),
  removeBrowserInputRequest: vi.fn(),
  removeScriptRunRequest: vi.fn(),
  removeComputerUseRequest: vi.fn(),
}))

// Mock proxy reviews — default to none
vi.mock('@renderer/hooks/use-proxy-reviews', () => ({
  usePendingProxyReviews: () => ({ data: { reviews: [] }, refetch: vi.fn() }),
}))

const defaultArgs = {
  sessionId: 's-1',
  agentSlug: 'agent-1',
  isViewOnly: false,
}

function findByDisplayName(items: ReactElement[], displayName: string) {
  return items.filter((el) => {
    const t = el.type as { displayName?: string; name?: string } | string
    if (typeof t === 'string') return false
    return (t.displayName ?? t.name) === displayName
  })
}

describe('usePendingRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMessagesData.data = undefined
    mockMessagesData.isLoading = false
    Object.assign(mockStreamState, {
      isActive: false,
      pendingSecretRequests: [],
      pendingConnectedAccountRequests: [],
      pendingRemoteMcpRequests: [],
      pendingQuestionRequests: [],
      pendingFileRequests: [],
      pendingBrowserInputRequests: [],
      pendingScriptRunRequests: [],
      pendingComputerUseRequests: [],
      autoApprovedScriptRunIds: new Set<string>(),
    })
  })

  it('returns SSE-based pending secret requests', () => {
    mockMessagesData.data = []
    mockStreamState.pendingSecretRequests = [
      { toolUseId: 'tu-1', secretName: 'API_KEY' },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = findByDisplayName(result.current.items, 'SecretRequestItem')
    expect(matches).toHaveLength(1)
    expect((matches[0].props as { secretName: string }).secretName).toBe('API_KEY')
  })

  it('returns SSE-based pending question requests', () => {
    mockMessagesData.data = []
    mockStreamState.pendingQuestionRequests = [
      {
        toolUseId: 'tu-q1',
        questions: [
          {
            question: 'Which DB?',
            header: 'DB',
            options: [{ label: 'PG', description: 'PostgreSQL' }],
            multiSelect: false,
          },
        ],
      },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = findByDisplayName(result.current.items, 'QuestionRequestItem')
    expect(matches).toHaveLength(1)
    expect((matches[0].props as { toolUseId: string }).toolUseId).toBe('tu-q1')
  })

  it('returns SSE-based pending file requests', () => {
    mockMessagesData.data = []
    mockStreamState.pendingFileRequests = [
      { toolUseId: 'tu-f1', description: 'Upload config file' },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = findByDisplayName(result.current.items, 'FileRequestItem')
    expect(matches).toHaveLength(1)
    expect((matches[0].props as { description: string }).description).toBe('Upload config file')
  })

  it('returns SSE-based pending connected account requests', () => {
    mockMessagesData.data = []
    mockStreamState.pendingConnectedAccountRequests = [
      { toolUseId: 'tu-ca-1', toolkit: 'slack', reason: 'Need access' },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = findByDisplayName(result.current.items, 'ConnectedAccountRequestItem')
    expect(matches).toHaveLength(1)
    expect((matches[0].props as { toolkit: string }).toolkit).toBe('slack')
  })

  it('returns SSE-based pending remote MCP requests', () => {
    mockMessagesData.data = []
    mockStreamState.pendingRemoteMcpRequests = [
      { toolUseId: 'tu-mcp-1', url: 'https://mcp.test.com', name: 'Test MCP' },
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(1)
    const matches = findByDisplayName(result.current.items, 'RemoteMcpRequestItem')
    expect(matches).toHaveLength(1)
    expect((matches[0].props as { url: string }).url).toBe('https://mcp.test.com')
  })

  it('derives pending secret request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-secret',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'DB_PASSWORD', reason: 'For database' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = findByDisplayName(result.current.items, 'SecretRequestItem')
    expect(matches).toHaveLength(1)
    expect((matches[0].props as { secretName: string }).secretName).toBe('DB_PASSWORD')
  })

  it('does not derive pending requests from history when session is idle', () => {
    mockStreamState.isActive = false
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-secret',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'DB_PASSWORD' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(0)
  })

  it('deduplicates SSE and message-based pending requests by toolUseId', () => {
    mockStreamState.isActive = true
    mockStreamState.pendingSecretRequests = [
      { toolUseId: 'tu-dup', secretName: 'API_KEY' },
    ]
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tu-dup',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'API_KEY' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = findByDisplayName(result.current.items, 'SecretRequestItem')
    expect(matches).toHaveLength(1)
  })

  it('derives connected_account pending request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-ca',
            name: 'mcp__user-input__request_connected_account',
            input: { toolkit: 'github', reason: 'Need access' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = findByDisplayName(result.current.items, 'ConnectedAccountRequestItem')
    expect(matches).toHaveLength(1)
    expect((matches[0].props as { toolkit: string }).toolkit).toBe('github')
  })

  it('derives question pending request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-q',
            name: 'AskUserQuestion',
            input: {
              questions: [
                { question: 'Which env?', header: 'Env', options: [{ label: 'Prod', description: 'Production' }], multiSelect: false },
              ],
            },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = findByDisplayName(result.current.items, 'QuestionRequestItem')
    expect(matches).toHaveLength(1)
  })

  it('derives file pending request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-file',
            name: 'mcp__user-input__request_file',
            input: { description: 'Upload config', fileTypes: '.json' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = findByDisplayName(result.current.items, 'FileRequestItem')
    expect(matches).toHaveLength(1)
    expect((matches[0].props as { description: string }).description).toBe('Upload config')
  })

  it('derives remote MCP pending request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-mcp',
            name: 'mcp__user-input__request_remote_mcp',
            input: { url: 'https://mcp.example.com', name: 'Example' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    const matches = findByDisplayName(result.current.items, 'RemoteMcpRequestItem')
    expect(matches).toHaveLength(1)
    expect((matches[0].props as { url: string }).url).toBe('https://mcp.example.com')
  })

  it('skips message-based requests when subsequent user message exists', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-secret',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'API_KEY' },
            result: undefined,
          }),
        ],
      }),
      createUserMessage({ content: { text: 'never mind' } }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(0)
  })

  it('skips message-based requests when tool call already has a result', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-done',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'DONE_KEY' },
            result: 'provided',
          }),
        ],
      }),
    ]

    const { result } = renderHook(() => usePendingRequests(defaultArgs))

    expect(result.current.count).toBe(0)
  })

  it('pendingUserMessage causes message-based extraction to skip (as if user moved on)', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-skipped',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'SKIP_KEY' },
            result: undefined,
          }),
        ],
      }),
    ]

    const { result } = renderHook(() =>
      usePendingRequests({
        ...defaultArgs,
        pendingUserMessage: { text: 'New input', sentAt: Date.now() },
      }),
    )

    expect(result.current.count).toBe(0)
  })
})
