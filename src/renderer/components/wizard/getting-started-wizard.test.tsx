// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  useUserSettings: vi.fn(),
  useUpdateUserSettings: vi.fn(),
  useUpdateSettings: vi.fn(),
  usePlatformAuthStatus: vi.fn(),
}))

vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => mocks.useUserSettings(),
  useUpdateUserSettings: () => mocks.useUpdateUserSettings(),
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useUpdateSettings: () => mocks.useUpdateSettings(),
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => mocks.usePlatformAuthStatus(),
}))

vi.mock('@renderer/lib/env', () => ({
  isElectron: () => false,
  getPlatform: () => 'darwin',
}))

vi.mock('./welcome-step', () => ({
  WelcomeStep: () => <div data-testid="welcome-step">Welcome</div>,
}))

vi.mock('./configure-llm-step', () => ({
  ConfigureLLMStep: () => <div data-testid="llm-step">LLM</div>,
}))

vi.mock('./browser-setup-step', () => ({
  BrowserSetupStep: () => <div data-testid="browser-step">Browser</div>,
}))

vi.mock('./composio-step', () => ({
  ComposioStep: () => <div data-testid="composio-step">Composio</div>,
}))

vi.mock('./docker-setup-step', () => ({
  DockerSetupStep: () => <div data-testid="runtime-step">Runtime</div>,
}))

vi.mock('./privacy-step', () => ({
  PrivacyStep: () => <div data-testid="privacy-step">Privacy</div>,
}))

vi.mock('./create-agent-step', () => ({
  CreateAgentStep: () => <div data-testid="agent-step">Agent</div>,
}))

vi.mock('./ribbon-wave', () => ({
  RibbonWave: () => <div data-testid="ribbon-wave" />,
}))

import { GettingStartedWizard } from './getting-started-wizard'

beforeEach(() => {
  mocks.useUserSettings.mockReturnValue({
    data: {
      setupCompleted: false,
      onboardingProgress: null,
    },
  })
  mocks.useUpdateUserSettings.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  })
  mocks.useUpdateSettings.mockReturnValue({
    mutateAsync: vi.fn(),
  })
  mocks.usePlatformAuthStatus.mockReturnValue({
    data: { connected: false },
    isLoading: false,
  })
})

describe('GettingStartedWizard', () => {
  it('starts on the platform path when platform auth is already connected', () => {
    mocks.usePlatformAuthStatus.mockReturnValue({
      data: { connected: true },
      isLoading: false,
    })

    render(<GettingStartedWizard onClose={vi.fn()} />)

    expect(screen.queryByTestId('welcome-step')).not.toBeInTheDocument()
    expect(screen.getByTestId('browser-step')).toBeInTheDocument()
  })

  it('does not flash the welcome step while checking platform auth', () => {
    mocks.usePlatformAuthStatus.mockReturnValue({
      data: undefined,
      isLoading: true,
    })

    render(<GettingStartedWizard onClose={vi.fn()} />)

    expect(screen.queryByTestId('welcome-step')).not.toBeInTheDocument()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })
})
