import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider, type ModelOption, type ModelPurpose } from './base-llm-provider'
import { attribution } from '@shared/lib/platform-attribution'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import type { ApiKeyStatus } from '../config/settings'

export class PlatformLlmProvider extends BaseLlmProvider {
  readonly id = 'platform' as const
  readonly name = 'Platform'
  // Not used — getApiKeyStatus/getEffectiveApiKey are both overridden to
  // read the platform token instead of a settings-stored API key.
  protected readonly settingsKeyField = 'anthropicApiKey' as const
  protected readonly envVarName = 'PLATFORM_TOKEN'

  override getApiKeyStatus(): ApiKeyStatus {
    const token = getPlatformAccessToken()
    if (token) {
      return { isConfigured: true, source: 'settings' }
    }
    if (process.env[this.envVarName]) {
      return { isConfigured: true, source: 'env' }
    }
    return { isConfigured: false, source: 'none' }
  }

  override getEffectiveApiKey(): string | undefined {
    return getPlatformAccessToken() ?? process.env[this.envVarName] ?? undefined
  }

  createClient(): Anthropic {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Platform token not configured. Please log in to the platform.')
    return new Anthropic({
      apiKey: '',
      baseURL: getPlatformProxyBaseUrl(),
      authToken: apiKey,
    })
  }

  getAvailableModels(): ModelOption[] {
    return [
      { value: 'claude-haiku-4-5', label: 'Claude 4.5 Haiku' },
      { value: 'claude-sonnet-4-6', label: 'Claude 4.6 Sonnet' },
      { value: 'claude-opus-4-6', label: 'Claude 4.6 Opus' },
      { value: 'claude-opus-4-7', label: 'Claude 4.7 Opus' },
    ]
  }

  getDefaultModel(purpose: ModelPurpose): string {
    switch (purpose) {
      case 'summarizer': return 'claude-haiku-4-5'
      case 'agent': return 'claude-opus-4-7'
      case 'browser': return 'claude-sonnet-4-6'
    }
  }

  getContainerEnvVars(): Record<string, string | undefined> {
    const proxyUrl = getPlatformProxyBaseUrl()
    const containerUrl = proxyUrl.replace('://localhost', '://host.docker.internal')

    const baseToken = this.getEffectiveApiKey()
    const auth = attribution.current()
    const customHeaderEntries = auth?.toExtraHeaderEntries() ?? []
    const customHeaders =
      customHeaderEntries.length > 0
        ? customHeaderEntries.map(([name, value]) => `${name}: ${value}`).join('\n')
        : undefined

    // The container's `@anthropic-ai/claude-agent-sdk` chain doesn't honor
    // `ANTHROPIC_CUSTOM_HEADERS` for SDK-driven outbound requests, so the
    // X-Platform-Member-Id header alone won't reach the platform proxy.
    // Embed the member id into the bearer token with `::` as a separator;
    // the proxy splits on it before JWT verification. The custom header is
    // still set as belt-and-suspenders for any code path that does honor it.
    const memberHeaderEntry = customHeaderEntries.find(
      ([name]) => name.toLowerCase() === 'x-platform-member-id'
    )
    const memberId = memberHeaderEntry?.[1]
    const authToken = baseToken && memberId ? `${baseToken}::${memberId}` : baseToken

    return {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: containerUrl,
      ANTHROPIC_AUTH_TOKEN: authToken,
      ANTHROPIC_CUSTOM_HEADERS: customHeaders,
    }
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const client = new Anthropic({
        apiKey: '',
        baseURL: getPlatformProxyBaseUrl(),
        authToken: apiKey,
      })
      await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      })
      return { valid: true }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Platform token validation failed' }
    }
  }
}
