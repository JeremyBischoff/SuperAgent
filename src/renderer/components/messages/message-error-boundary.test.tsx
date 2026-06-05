// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const captureRendererException = vi.fn()
vi.mock('@renderer/lib/error-reporting', () => ({
  captureRendererException: (...args: unknown[]) => captureRendererException(...args),
}))

import { MessageErrorBoundary } from './message-error-boundary'
import { MessageItem } from './message-item'
import type { ApiMessage } from '@shared/lib/types/api'

function Boom(): never {
  throw new Error('kaboom while rendering')
}

describe('MessageErrorBoundary', () => {
  beforeEach(() => {
    captureRendererException.mockClear()
  })

  it('renders children when they do not throw', () => {
    render(
      <MessageErrorBoundary kind="message" raw={{ id: 'm1' }}>
        <div>healthy child</div>
      </MessageErrorBoundary>
    )
    expect(screen.getByText('healthy child')).toBeInTheDocument()
    expect(screen.queryByTestId('message-error-boundary')).not.toBeInTheDocument()
  })

  it('shows an error box (not a crash) when a child throws', () => {
    // Suppress React's expected error log for the thrown render.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <MessageErrorBoundary kind="tool call" raw={{ id: 't1' }}>
        <Boom />
      </MessageErrorBoundary>
    )
    expect(screen.getByTestId('message-error-boundary')).toBeInTheDocument()
    expect(screen.getByText('Failed to display this tool call')).toBeInTheDocument()
    spy.mockRestore()
  })

  it('reports the error to Sentry with kind + item id', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <MessageErrorBoundary kind="tool call" raw={{ id: 't1' }} itemId="t1">
        <Boom />
      </MessageErrorBoundary>
    )
    expect(captureRendererException).toHaveBeenCalledTimes(1)
    const [error, context] = captureRendererException.mock.calls[0] as [Error, { tags: Record<string, string>; extra: Record<string, unknown> }]
    expect(error).toBeInstanceOf(Error)
    expect(context.tags).toMatchObject({ feature: 'message-render', item_kind: 'tool call' })
    expect(context.extra).toMatchObject({ itemId: 't1' })
    spy.mockRestore()
  })

  it('reveals the raw payload behind a "View raw" toggle', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <MessageErrorBoundary kind="message" raw={{ id: 'm1', secret: 'raw-payload-marker' }}>
        <Boom />
      </MessageErrorBoundary>
    )
    // Raw hidden by default
    expect(screen.queryByText(/raw-payload-marker/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('View raw'))
    expect(screen.getByText(/raw-payload-marker/)).toBeInTheDocument()
    // Toggle back
    fireEvent.click(screen.getByText('Hide raw'))
    expect(screen.queryByText(/raw-payload-marker/)).not.toBeInTheDocument()
    spy.mockRestore()
  })

  // End-to-end: a real MessageItem containing a tool call that crashes the
  // renderer (AskUserQuestion with a stringified `questions` arg — the exact bug
  // this branch does NOT fix) must degrade to the inline error box, not take the
  // thread down. The healthy text in the same message still renders.
  it('contains a crashing tool call inside a real MessageItem', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const message = {
      id: 'assistant-1',
      type: 'assistant',
      content: { text: 'Here is my question:' },
      toolCalls: [
        {
          id: 'toolu_bad',
          name: 'AskUserQuestion',
          input: { questions: '[{"question":"Pick one","options":[{"label":"A"}]}]' },
        },
      ],
      createdAt: new Date(),
    } as unknown as ApiMessage

    render(<MessageItem message={message} sessionId="s1" agentSlug="agent" isSessionActive={false} />)

    expect(screen.getByText('Failed to display this tool call')).toBeInTheDocument()
    expect(screen.getByText('Here is my question:')).toBeInTheDocument()
    expect(captureRendererException).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
