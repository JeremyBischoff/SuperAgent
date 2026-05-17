/**
 * Dev-only visual gallery for tool-call cards and the sub-agent block.
 *
 * Not wired into the app. Open at http://localhost:<port>/gallery.html while
 * `npm run dev` is running to iterate on tool-call card styling against a full
 * matrix of renderers and states without needing a live session.
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SelectionProvider } from '@renderer/context/selection-context'
import { ToolCallItem, StreamingToolCallItem } from '../tool-call-item'
import { SubAgentBlock } from '../subagent-block'
import { getRegisteredRendererNames } from '../tool-renderers'
import type { ApiToolCall } from '@shared/lib/types/api'

const GALLERY_SESSION_ID = 'gallery-session'
const GALLERY_AGENT_SLUG = 'gallery-agent'

type MockSpec = { input: Record<string, unknown>; result?: unknown }

// Realistic inputs/results per registered renderer. Anything not listed falls
// back to a generic JSON shape so every renderer still appears in the gallery.
const MOCKS: Record<string, MockSpec> = {
  Task: {
    input: {
      subagent_type: 'Explore',
      description: 'Find auth middleware',
      prompt: 'Locate the auth middleware and summarize how sessions are validated.',
    },
    result: 'Auth middleware lives in src/main/auth/. Sessions are validated via a signed cookie checked in `requireSession()`.',
  },
  Bash: {
    input: { command: 'npm run typecheck && npm run lint', description: 'Typecheck and lint' },
    result: '> superagent@0.3.26 typecheck\n> tsc --noEmit\n\n✓ no errors',
  },
  Read: {
    input: { file_path: '/Users/dev/superagent/src/renderer/App.tsx', limit: 50 },
    result: '1\timport { useState } from "react"\n2\timport { QueryProvider } from "./providers/query-provider"\n3\t...',
  },
  Write: {
    input: {
      file_path: '/Users/dev/superagent/src/renderer/components/foo.tsx',
      content: 'export function Foo() {\n  return <div>foo</div>\n}\n',
    },
    result: 'File written successfully.',
  },
  Glob: {
    input: { pattern: 'src/renderer/components/**/*.tsx' },
    result: 'src/renderer/components/messages/tool-call-item.tsx\nsrc/renderer/components/messages/subagent-block.tsx\n(42 matches)',
  },
  Grep: {
    input: { pattern: 'getToolRenderer', path: 'src', output_mode: 'files_with_matches' },
    result: 'src/renderer/components/messages/tool-call-item.tsx\nsrc/renderer/components/messages/tool-renderers/index.ts',
  },
  WebSearch: {
    input: { query: 'react query seed cache without fetch' },
    result: 'Top results:\n1. TanStack Query — setQueryData\n2. Seeding the cache (docs)',
  },
  WebFetch: {
    input: { url: 'https://tanstack.com/query/latest', prompt: 'How do I seed the cache?' },
    result: 'Use queryClient.setQueryData(key, data) to prime the cache before render.',
  },
  TodoWrite: {
    input: {
      todos: [
        { content: 'Merge main into branch', status: 'completed', activeForm: 'Merging main' },
        { content: 'Build tool-call gallery', status: 'in_progress', activeForm: 'Building gallery' },
        { content: 'Visual refinement pass', status: 'pending', activeForm: 'Refining visuals' },
      ],
    },
    result: 'Todos updated.',
  },
  AskUserQuestion: {
    input: {
      questions: [
        {
          question: 'Which approach for the gallery route?',
          header: 'Route',
          multiSelect: false,
          options: [
            { label: 'Separate HTML entry', description: 'Standalone /gallery.html, no auth gate' },
            { label: 'In-app dev panel', description: 'Hidden behind a keyboard shortcut' },
          ],
        },
      ],
    },
    result: 'Selected: Separate HTML entry',
  },
  'mcp__user-input__request_secret': {
    input: { key: 'OPENAI_API_KEY', description: 'API key used for the summarization step' },
  },
  'mcp__user-input__request_connected_account': {
    input: { provider: 'github', description: 'Needed to open pull requests on your behalf' },
  },
  'mcp__user-input__schedule_task': {
    input: { cron: '0 9 * * 1', prompt: 'Summarize last week\'s open PRs and post to Slack', timezone: 'America/New_York' },
    result: 'Task scheduled.',
  },
  'mcp__user-input__deliver_file': {
    input: { filePath: '/Users/dev/superagent/out/report.pdf', description: 'Weekly status report' },
    result: 'File delivered.',
  },
  'mcp__user-input__deliver_session': {
    input: { session_id: 'sess_abc123', agent_slug: 'researcher', description: 'Research transcript for review' },
  },
  'mcp__user-input__request_file': {
    input: { description: 'Upload the CSV export of last month\'s metrics', fileTypes: ['.csv'] },
  },
  'mcp__user-input__request_remote_mcp': {
    input: { name: 'Linear', url: 'https://mcp.linear.app/sse', description: 'Read and update issues' },
  },
  'mcp__user-input__request_script_run': {
    input: { script: 'pnpm db:migrate', description: 'Apply the pending DB migration', cwd: '/Users/dev/superagent' },
  },
  'mcp__agents__invoke_agent': {
    input: { slug: 'researcher', prompt: 'Investigate the latency regression in the ingest pipeline.', sync: true },
    result: 'Found the regression: a missing index on events.created_at added in #142.',
  },
  'mcp__agents__create_agent': {
    input: {
      name: 'Release Notes Bot',
      description: 'Drafts release notes from merged PRs',
      instructions: 'Every Friday, summarize merged PRs into user-facing release notes.',
    },
    result: 'Agent created: release-notes-bot',
  },
  'mcp__agents__list_agents': {
    input: {},
    result: 'researcher, release-notes-bot, gallery-agent',
  },
  'mcp__agents__get_agent_sessions': {
    input: { slug: 'researcher' },
    result: '3 sessions (2 completed, 1 running)',
  },
  'mcp__agents__get_agent_session_transcript': {
    input: { slug: 'researcher', session_id: 'sess_abc123', sync: true },
    result: 'Transcript: 14 messages, 6 tool calls.',
  },
  'mcp__dashboards__create_dashboard': {
    input: { slug: 'ingest-latency', name: 'Ingest Latency', description: 'p50/p95 ingest timings', framework: 'next' },
    result: 'Dashboard scaffolded at dashboards/ingest-latency.',
  },
  'mcp__dashboards__start_dashboard': {
    input: { slug: 'ingest-latency' },
    result: 'Dashboard running on http://localhost:3210',
  },
  'mcp__dashboards__list_dashboards': {
    input: {},
    result: 'ingest-latency (running), revenue (stopped)',
  },
  'mcp__dashboards__get_dashboard_logs': {
    input: { slug: 'ingest-latency', clear: false },
    result: '[12:01:03] ready in 412ms\n[12:01:09] GET / 200',
  },
}

function genericMock(name: string): MockSpec {
  return {
    input: { note: `Generic mock input for ${name}`, value: 42 },
    result: `Generic result output for ${name}.`,
  }
}

function makeToolCall(
  name: string,
  state: 'success' | 'error' | 'running' | 'cancelled',
  idSuffix: string,
): ApiToolCall {
  const spec = MOCKS[name] ?? genericMock(name)
  const base: ApiToolCall = {
    id: `tc-${name}-${idSuffix}`,
    name,
    input: spec.input,
  }
  if (state === 'running' || state === 'cancelled') {
    // result left undefined → running (if active) / cancelled (if not)
    return base
  }
  return {
    ...base,
    result: state === 'error' ? 'Error: command exited with code 1\nsegmentation fault' : (spec.result ?? 'OK'),
    isError: state === 'error',
  }
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <div className="mb-3 border-b border-border pb-1">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

const MOCK_SUBAGENT_TOOL: ApiToolCall = {
  id: 'subagent-tool-done',
  name: 'Task',
  input: { subagent_type: 'Explore', description: 'Audit tool renderers' },
  result: 'Audited 45 renderers. All render without crashing; 3 use legacy bg-red-50 panels.',
  subagent: {
    agentId: 'gallery-subagent-1',
    status: 'completed',
    totalDurationMs: 184000,
    totalTokens: 48200,
    totalToolUseCount: 12,
  },
}

const MOCK_SUBAGENT_RUNNING_TOOL: ApiToolCall = {
  id: 'subagent-tool-running',
  name: 'Task',
  input: { subagent_type: 'general-purpose', description: 'Refactor status indicator' },
  subagent: { agentId: 'gallery-subagent-2', status: 'async_launched' },
}

export function ToolCallGallery() {
  const [dark, setDark] = useState(false)
  const [width, setWidth] = useState<'chat' | 'wide'>('chat')
  const queryClient = useQueryClient()

  // Prime the sub-agent transcript so SubAgentBlock renders without a live API.
  useState(() => {
    queryClient.setQueryData(GALLERY_SUBAGENT_CACHE.key, GALLERY_SUBAGENT_CACHE.data)
    return null
  })

  const toggleDark = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
  }

  const rendererNames = getRegisteredRendererNames()

  return (
    <SelectionProvider>
    <div className="min-h-screen bg-background text-foreground">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/95 px-6 py-3 backdrop-blur">
        <h1 className="text-sm font-semibold">Tool Call Gallery</h1>
        <span className="text-xs text-muted-foreground">{rendererNames.length} renderers</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setWidth(width === 'chat' ? 'wide' : 'chat')}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            {width === 'chat' ? 'Chat width' : 'Wide'}
          </button>
          <button
            onClick={toggleDark}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            {dark ? 'Dark' : 'Light'}
          </button>
        </div>
      </div>

      <div className={width === 'chat' ? 'mx-auto max-w-2xl px-6 py-8' : 'mx-auto max-w-5xl px-6 py-8'}>
        <Section title="Status states" subtitle="Same tool (Bash) across every status, collapsed">
          <ToolCallItem toolCall={makeToolCall('Bash', 'running', 'st')} isSessionActive messageCreatedAt={new Date(Date.now() - 4200)} />
          <ToolCallItem toolCall={makeToolCall('Bash', 'success', 'st')} />
          <ToolCallItem toolCall={makeToolCall('Bash', 'error', 'st')} />
          <ToolCallItem toolCall={makeToolCall('Bash', 'cancelled', 'st')} />
        </Section>

        <Section title="Pending user input" subtitle="running + user-input tools render the 'Waiting for input' state">
          <ToolCallItem toolCall={makeToolCall('AskUserQuestion', 'running', 'pi')} isSessionActive />
          <ToolCallItem toolCall={makeToolCall('mcp__user-input__request_secret', 'running', 'pi')} isSessionActive />
          <ToolCallItem toolCall={makeToolCall('mcp__user-input__request_connected_account', 'running', 'pi')} isSessionActive />
        </Section>

        <Section title="All renderers — collapsed" subtitle="Success state, collapsed row">
          {rendererNames.map((name) => (
            <ToolCallItem key={name} toolCall={makeToolCall(name, 'success', 'col')} agentSlug={GALLERY_AGENT_SLUG} />
          ))}
        </Section>

        <Section title="All renderers — expanded" subtitle="Success state, default-expanded body">
          {rendererNames.map((name) => (
            <ToolCallItem
              key={name}
              toolCall={makeToolCall(name, 'success', 'exp')}
              agentSlug={GALLERY_AGENT_SLUG}
              defaultExpanded
            />
          ))}
        </Section>

        <Section title="All renderers — error (expanded)" subtitle="Error state to check red text + result panes">
          {rendererNames.map((name) => (
            <ToolCallItem
              key={name}
              toolCall={makeToolCall(name, 'error', 'err')}
              agentSlug={GALLERY_AGENT_SLUG}
              defaultExpanded
            />
          ))}
        </Section>

        <Section title="Streaming" subtitle="Input still streaming in">
          <StreamingToolCallItem name="Bash" partialInput={'{"command":"npm run bui'} />
          <StreamingToolCallItem name="Write" partialInput={'{"file_path":"/tmp/a.ts","content":"export const a ='} />
          <StreamingToolCallItem name="UnknownTool" partialInput={'{"foo":'} />
        </Section>

        <Section title="Sub-agent block" subtitle="Completed (seeded transcript + stats) and running">
          <SubAgentBlock
            toolCall={MOCK_SUBAGENT_TOOL}
            sessionId={GALLERY_SESSION_ID}
            agentSlug={GALLERY_AGENT_SLUG}
            isCompleted
          />
          <SubAgentBlock
            toolCall={MOCK_SUBAGENT_RUNNING_TOOL}
            sessionId={GALLERY_SESSION_ID}
            agentSlug={GALLERY_AGENT_SLUG}
            isSessionActive
            activeSubagent={{
              parentToolId: MOCK_SUBAGENT_RUNNING_TOOL.id,
              agentId: 'gallery-subagent-2',
              streamingMessage: 'Looking at the StatusIndicator component to plan the refactor…',
              streamingToolUse: null,
              progressSummary: null,
            }}
          />
        </Section>
      </div>
    </div>
    </SelectionProvider>
  )
}

// Mock subagent transcript used by SubAgentBlock via the seeded query cache.
export const GALLERY_SUBAGENT_CACHE: {
  key: [string, string, string, string]
  data: unknown
} = {
  key: ['subagent-messages', GALLERY_SESSION_ID, GALLERY_AGENT_SLUG, 'gallery-subagent-1'],
  data: [
    {
      id: 'sub-msg-1',
      type: 'assistant',
      content: { text: 'Starting the renderer audit. I will read the registry first.' },
      toolCalls: [
        {
          id: 'sub-tc-1',
          name: 'Read',
          input: { file_path: 'src/renderer/components/messages/tool-renderers/index.ts' },
          result: 'export const toolRenderers = { ... } (45 entries)',
        },
      ],
      createdAt: new Date().toISOString(),
    },
    {
      id: 'sub-msg-2',
      type: 'assistant',
      content: { text: 'Found 3 renderers still using `bg-red-50` panels: request-file, request-secret, deliver-file.' },
      toolCalls: [
        {
          id: 'sub-tc-2',
          name: 'Grep',
          input: { pattern: 'bg-red-50', path: 'src/renderer/components/messages/tool-renderers' },
          result: '3 files matched',
        },
      ],
      createdAt: new Date().toISOString(),
    },
  ],
}
