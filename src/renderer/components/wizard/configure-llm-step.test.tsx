// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  useSettings: vi.fn(),
  useUpdateSettings: vi.fn(),
  usePlatformAuthStatus: vi.fn(),
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => mocks.useSettings(),
  useUpdateSettings: () => mocks.useUpdateSettings(),
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => mocks.usePlatformAuthStatus(),
}))

vi.mock('@renderer/components/settings/provider-api-key-input', () => ({
  ProviderApiKeyInput: () => <div data-testid="provider-api-key-input" />,
}))

vi.mock('@renderer/components/settings/bedrock-credentials-input', () => ({
  BedrockCredentialsInput: () => <div data-testid="bedrock-credentials-input" />,
}))

import { ConfigureLLMStep } from './configure-llm-step'

beforeEach(() => {
  mocks.useUpdateSettings.mockReturnValue({ mutate: vi.fn() })
  mocks.useSettings.mockReturnValue({
    data: {
      llmProvider: 'anthropic',
      apiKeyStatus: {
        anthropic: { isConfigured: false },
      },
    },
  })
  mocks.usePlatformAuthStatus.mockReturnValue({
    data: { connected: false },
  })
})

describe('ConfigureLLMStep', () => {
  it('lets a connected platform provider satisfy the LLM setup step', async () => {
    const onCanProceedChange = vi.fn()
    mocks.useSettings.mockReturnValue({
      data: {
        llmProvider: 'platform',
        apiKeyStatus: {
          anthropic: { isConfigured: false },
        },
      },
    })
    mocks.usePlatformAuthStatus.mockReturnValue({
      data: { connected: true },
    })

    render(<ConfigureLLMStep onCanProceedChange={onCanProceedChange} />)

    expect(screen.getByText('Platform')).toBeInTheDocument()
    expect(screen.getByText(/platform-managed credentials/i)).toBeInTheDocument()
    await waitFor(() => expect(onCanProceedChange).toHaveBeenCalledWith(true))
  })

  it('does not show platform as a manual setup option when disconnected', () => {
    render(<ConfigureLLMStep onCanProceedChange={vi.fn()} />)

    expect(screen.queryByText('Platform')).not.toBeInTheDocument()
  })
})
