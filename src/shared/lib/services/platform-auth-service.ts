import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose'

import { getSettings, updateSettings, type PlatformAuthSettings } from '@shared/lib/config/settings'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { PlatformAuthSettingsSchema } from '@shared/lib/types/skillset-schema'
import { captureException } from '@shared/lib/error-reporting'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getAuthProviderIssuer } from '@shared/lib/auth/provider-config'

export type PlatformAuthRecord = PlatformAuthSettings

export type PlatformAuthSource = 'settings' | 'env' | null


const ORG_ACCESS_TOKEN_AUDIENCE = 'platform-org-runtime'
const ORG_ACCESS_TOKEN_ALG = 'RS256'
const ORG_ACCESS_TOKEN_TYP = 'JWT'
const PLATFORM_AUTH_PROVIDER_ID = 'platform'

export interface VerifiedOrgAccessToken {
  orgId: string
  iss: string
  aud: string
  iat: number
  exp: number
  kid: string | null
}

export interface PlatformAuthStatus {
  connected: boolean
  tokenPreview: string | null
  email: string | null
  label: string | null
  orgId: string | null
  orgName: string | null
  role: string | null
  createdAt: string | null
  updatedAt: string | null
  source: PlatformAuthSource
}

interface SavePlatformAuthInput {
  token: string
  email?: string | null
  label?: string | null
  orgId?: string | null
  orgName?: string | null
  role?: string | null
}

function buildTokenPreview(token: string): string {
  if (token.length <= 12) {
    return token
  }
  return `${token.slice(0, 6)}...${token.slice(-4)}`
}

// JWKS resolver cache keyed by issuer URL. `createRemoteJWKSet` already
// memoizes JWK fetches and rotates on cooldown, so we only build one resolver
// per issuer for the process lifetime.
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

// Test hook: tests may swap in a `createLocalJWKSet` resolver to avoid
// needing a real /jwks endpoint.
type RemoteJwksResolver = ReturnType<typeof createRemoteJWKSet>
let injectedJwksResolver: RemoteJwksResolver | null = null

export function _setOrgJwksResolverForTest(resolver: RemoteJwksResolver | null): void {
  injectedJwksResolver = resolver
  jwksByIssuer.clear()
  cachedEnvManagedStatus = undefined
}

function getJwksResolverForIssuer(issuer: string): RemoteJwksResolver {
  if (injectedJwksResolver) return injectedJwksResolver
  let resolver = jwksByIssuer.get(issuer)
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL('/jwks', issuer))
    jwksByIssuer.set(issuer, resolver)
  }
  return resolver
}

export async function verifyOrgAccessTokenSigned(
  token: string,
  options: { issuer: string; audience?: string },
): Promise<VerifiedOrgAccessToken> {
  const { payload, protectedHeader } = await jwtVerify(
    token,
    getJwksResolverForIssuer(options.issuer),
    {
      issuer: options.issuer,
      audience: options.audience ?? ORG_ACCESS_TOKEN_AUDIENCE,
      algorithms: [ORG_ACCESS_TOKEN_ALG],
      typ: ORG_ACCESS_TOKEN_TYP,
    },
  )
  const orgIdValue = payload['orgId']
  if (typeof orgIdValue !== 'string' || orgIdValue.length === 0) {
    throw new joseErrors.JWTClaimValidationFailed(
      'orgId claim is required',
      payload,
      'orgId',
      'missing',
    )
  }
  return {
    orgId: orgIdValue,
    iss: typeof payload.iss === 'string' ? payload.iss : options.issuer,
    aud: Array.isArray(payload.aud)
      ? String(payload.aud[0] ?? '')
      : typeof payload.aud === 'string'
        ? payload.aud
        : '',
    iat: typeof payload.iat === 'number' ? payload.iat : 0,
    exp: typeof payload.exp === 'number' ? payload.exp : 0,
    kid: typeof protectedHeader.kid === 'string' ? protectedHeader.kid : null,
  }
}

function warnInvalidEnvPlatformToken(reason: string, error?: unknown): void {
  console.warn(`[platform-auth] invalid PLATFORM_TOKEN: ${reason}`)
  captureException(error ?? new Error(`Invalid PLATFORM_TOKEN: ${reason}`), {
    tags: { area: 'platform-auth', op: 'verify-env-token' },
  })
}

// Cached env-managed status. `undefined` = init not yet run, `null` = not in
// auth-mode or no PLATFORM_TOKEN, otherwise = the verified status object.
// Async verification (`jwtVerify` against remote JWKS) cannot run inside the
// sync `getEnvManagedStatus()` call site, so we precompute it once at startup
// via `initEnvManagedPlatformStatus()` and read the cache on every status read.
let cachedEnvManagedStatus: PlatformAuthStatus | null | undefined = undefined

function buildEnvManagedStatus(envToken: string, orgId: string | null): PlatformAuthStatus {
  return {
    connected: true,
    tokenPreview: buildTokenPreview(envToken),
    email: null,
    label: 'Managed by organization',
    // `orgId` reflects a verified claim. Authoritative ownership / isolation
    // decisions still require the proxy's active-row check on org_access_key.
    orgId,
    orgName: null,
    role: null,
    createdAt: null,
    updatedAt: null,
    source: 'env',
  }
}

// Runs once at startup (from auth-mode startup-validation). Reads the env
// PLATFORM_TOKEN, derives the issuer from AUTH_PROVIDERS_JSON, runs a real
// `jwtVerify` against the issuer JWKS, and caches the verified status.
// Verification failure logs warn + Sentry and stores a status with
// `orgId: null` so downstream callers don't trust an unverifiable token.
export async function initEnvManagedPlatformStatus(): Promise<void> {
  if (!isAuthMode()) {
    cachedEnvManagedStatus = null
    return
  }
  const envToken = process.env.PLATFORM_TOKEN?.trim()
  if (!envToken) {
    cachedEnvManagedStatus = null
    return
  }
  const issuer = getAuthProviderIssuer(PLATFORM_AUTH_PROVIDER_ID)
  if (!issuer) {
    warnInvalidEnvPlatformToken('no issuer configured for org access token verification')
    cachedEnvManagedStatus = buildEnvManagedStatus(envToken, null)
    return
  }
  try {
    const verified = await verifyOrgAccessTokenSigned(envToken, { issuer })
    cachedEnvManagedStatus = buildEnvManagedStatus(envToken, verified.orgId)
  } catch (error) {
    const reason =
      error instanceof joseErrors.JWTExpired
        ? 'token expired'
        : error instanceof joseErrors.JWTClaimValidationFailed
          ? `claim validation failed: ${error.claim ?? 'unknown'}`
          : error instanceof joseErrors.JOSEError
            ? `signature verification failed: ${error.code}`
            : 'verification failed'
    warnInvalidEnvPlatformToken(reason, error)
    cachedEnvManagedStatus = buildEnvManagedStatus(envToken, null)
  }
}

// Test-only reset hook. Returns the cache to "uninitialized" so the next
// init call re-runs verification.
export function _resetEnvManagedPlatformStatusForTest(): void {
  cachedEnvManagedStatus = undefined
}

function readRecord(): PlatformAuthRecord | null {
  const raw = getSettings().platformAuth
  if (!raw) return null
  // Validate at the boundary; a corrupt settings.json shouldn't crash callers
  // mid-request, but we do want to see it in Sentry.
  const parsed = PlatformAuthSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    captureException(parsed.error, { tags: { area: 'platform-auth', op: 'read' } })
    return null
  }
  return parsed.data
}

function writeRecord(record: PlatformAuthRecord | null): void {
  const settings = getSettings()
  settings.platformAuth = record ?? undefined
  updateSettings(settings)
}

/**
 * Reconcile skillset configs + installed metadata after an auth change.
 *
 * Provider-polymorphic: each provider's `isConfigValid` / `isInstalledValid`
 * decides what belongs. Lives behind a dynamic import to break a module
 * cycle (skillset-reconcile → skillset-provider → platform-provider → here).
 */
async function reconcileAfterAuthChange(): Promise<void> {
  try {
    const mod = await import('./skillset-reconcile')
    mod.reconcileSkillsetConfigsForCurrentAuth()
    await mod.reconcileInstalledForCurrentAuth()
  } catch (error) {
    captureException(error, { tags: { area: 'platform-auth', op: 'reconcile' } })
  }
}

function getEnvManagedStatus(): PlatformAuthStatus | null {
  if (cachedEnvManagedStatus !== undefined) return cachedEnvManagedStatus
  // Fast-path defaults for callers that read status before init has run
  // (e.g., tests, or pre-startup diagnostics). Returns a conservative status
  // with `orgId: null` until `initEnvManagedPlatformStatus()` populates the
  // cache with a verified value.
  if (!isAuthMode()) return null
  const envToken = process.env.PLATFORM_TOKEN?.trim()
  if (!envToken) return null
  return buildEnvManagedStatus(envToken, null)
}

export function getPlatformAuthStatus(_userId?: string): PlatformAuthStatus {
  const envManaged = getEnvManagedStatus()
  if (envManaged) return envManaged

  const record = readRecord()
  if (record) {
    return {
      connected: true,
      tokenPreview: record.tokenPreview,
      email: record.email,
      label: record.label,
      orgId: record.orgId,
      orgName: record.orgName,
      role: record.role,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      source: 'settings',
    }
  }

  return {
    connected: false,
    tokenPreview: null,
    email: null,
    label: null,
    orgId: null,
    orgName: null,
    role: null,
    createdAt: null,
    updatedAt: null,
    source: null,
  }
}

export async function savePlatformAuth(_userId: string, input: SavePlatformAuthInput): Promise<PlatformAuthStatus> {
  const trimmedToken = input.token.trim()
  if (!trimmedToken) {
    throw new Error('Token is required')
  }

  const existing = readRecord()
  const newOrgId = input.orgId?.trim() || null
  const orgChanged = existing?.orgId !== newOrgId

  const now = new Date().toISOString()
  const record: PlatformAuthRecord = PlatformAuthSettingsSchema.parse({
    token: trimmedToken,
    tokenPreview: buildTokenPreview(trimmedToken),
    email: input.email?.trim() || null,
    label: input.label?.trim() || null,
    orgId: newOrgId,
    orgName: input.orgName?.trim() || null,
    role: input.role?.trim() || null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  writeRecord(record)

  if (orgChanged) {
    // Auth state changed — sweep stale configs + installed files for the
    // previous org. Runs *after* writing the new record so the polymorphic
    // reconcile sees the current auth.
    await reconcileAfterAuthChange()
  }

  return getPlatformAuthStatus()
}

export function getPlatformAccessToken(_userId?: string): string | null {
  const envToken = process.env.PLATFORM_TOKEN?.trim()
  if (isAuthMode() && envToken) return envToken
  return readRecord()?.token ?? null
}

async function clearPlatformAuth(): Promise<void> {
  writeRecord(null)
  await reconcileAfterAuthChange()
}

export async function revokePlatformTokenRemotely(): Promise<boolean> {
  const token = readRecord()?.token
  if (!token) return false

  const proxyBase = getPlatformProxyBaseUrl()
  if (!proxyBase) return false

  try {
    const res = await fetch(`${proxyBase}/v1/revoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    return res.ok
  } catch (error) {
    captureException(error, { tags: { area: 'platform-auth', op: 'revoke' } })
    return false
  }
}

export async function revokePlatformToken(options?: { clearLocal?: boolean }): Promise<boolean> {
  const success = await revokePlatformTokenRemotely()
  if (options?.clearLocal !== false) {
    await clearPlatformAuth()
  }
  return success
}
