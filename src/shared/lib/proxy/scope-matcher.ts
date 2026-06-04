import { SCOPE_MAPS, type ScopeMapEntry } from './scope-maps'
import { SCOPE_DESCRIPTIONS } from './scope-descriptions'

export interface ScopeMatchResult {
  matched: boolean
  scopes: string[]
  /**
   * Curated per-scope descriptions describing what each scope GRANTS.
   * Used in "Always allow <scope>" menu items and the settings dialog.
   */
  descriptions: Record<string, string>
  /**
   * Description of the matched API endpoint (what the current call DOES).
   * Used to render the prompt headline so the user sees the immediate action,
   * not a broader scope-level summary that may be alarming.
   */
  endpointDescription?: string
}

/**
 * Account- and risk-group-level scope sentinels that are legal API scope
 * policy keys for any toolkit:
 *  - '*'            account default (applies to every scope)
 *  - '*read'        all read-risk scopes for the toolkit
 *  - '*write'       all write-risk scopes
 *  - '*destructive' all destructive-risk scopes
 *
 * The in-session "Allow all <label>" action routes the risk-group sentinels
 * through the proxy-review /always endpoint, so they are expected input.
 */
export const API_SCOPE_SENTINELS = ['*', '*read', '*write', '*destructive'] as const

/**
 * Is `scope` a legal API scope policy key for `toolkit`?
 *
 * True for the shared sentinels (valid on any toolkit) or a scope the toolkit
 * actually declares in its scope map. Used to reject garbage or smuggled
 * scopes before they are persisted as a policy. An unknown toolkit has no
 * known scope set, so only sentinels are accepted for it.
 */
export function isValidApiScope(toolkit: string | undefined, scope: unknown): boolean {
  if (typeof scope !== 'string' || scope.length === 0) return false
  if ((API_SCOPE_SENTINELS as readonly string[]).includes(scope)) return true
  if (!toolkit) return false
  const provider = SCOPE_MAPS[toolkit]
  if (!provider) return false
  const all = Array.isArray(provider.allScopes)
    ? provider.allScopes
    : Object.values(provider.allScopes).flat()
  return all.includes(scope)
}

/**
 * Match a request against scope maps to determine which scopes apply.
 * Pure function — no DB or side effects.
 */
export function matchScopes(
  toolkit: string,
  method: string,
  targetPath: string
): ScopeMatchResult {
  const empty: ScopeMatchResult = { matched: false, scopes: [], descriptions: {}, endpointDescription: undefined }

  const provider = SCOPE_MAPS[toolkit]
  if (!provider) return empty

  // Normalize
  const normalizedMethod = method.toUpperCase()
  let normalizedPath = targetPath
  if (!normalizedPath || normalizedPath.trim() === '') return empty
  if (!normalizedPath.startsWith('/')) normalizedPath = '/' + normalizedPath

  // Filter by method. An entry with method "*" is method-agnostic and matches
  // any HTTP verb — used for RPC-style APIs (e.g. Slack) where the path alone
  // identifies the operation and the same scope applies whether the agent calls
  // it via GET or POST.
  const methodMatches = provider.scopeMap.filter(
    (entry) => entry.method === '*' || entry.method === normalizedMethod
  )

  // Glob-match each entry's pathPattern against the target path
  type ScoredMatch = { entry: ScopeMapEntry; wildcardCount: number }
  const matches: ScoredMatch[] = []

  for (const entry of methodMatches) {
    const wc = globMatch(entry.pathPattern, normalizedPath)
    if (wc !== null) {
      matches.push({ entry, wildcardCount: wc })
    }
  }

  if (matches.length === 0) return empty

  // Keep the most specific matches (fewest wildcards)
  const minWildcards = Math.min(...matches.map((m) => m.wildcardCount))
  const bestMatches = matches.filter((m) => m.wildcardCount === minWildcards)

  // Collect union of scopes and descriptions
  const scopeSet = new Set<string>()
  const descriptions: Record<string, string> = {}
  const providerScopeDescriptions = SCOPE_DESCRIPTIONS[toolkit] ?? {}

  for (const { entry } of bestMatches) {
    for (const scope of entry.sufficientScopes) {
      scopeSet.add(scope)
      if (scope in descriptions) continue
      // Prefer the curated per-scope description; fall back to the
      // matched endpoint description so we don't regress on scopes
      // that are not yet curated.
      const curated = providerScopeDescriptions[scope]
      if (curated) {
        descriptions[scope] = curated
      } else if (entry.description) {
        descriptions[scope] = entry.description
      }
    }
  }

  // The first matching endpoint's description summarizes the call itself.
  const endpointDescription = bestMatches.find((m) => m.entry.description)?.entry.description

  return {
    matched: true,
    scopes: Array.from(scopeSet),
    descriptions,
    endpointDescription,
  }
}

/**
 * Glob-match a path pattern against a target path.
 * Returns the number of wildcard segments used, or null if no match.
 *
 * Rules:
 *  - Split both by '/', compare segment-by-segment
 *  - '*' matches any single non-empty segment
 *  - Segments must match exactly otherwise
 */
function globMatch(pattern: string, path: string): number | null {
  // Normalize leading slashes
  const patternSegs = pattern.replace(/^\//, '').split('/')
  const pathSegs = path.replace(/^\//, '').split('/')

  if (patternSegs.length !== pathSegs.length) return null

  let wildcardCount = 0
  for (let i = 0; i < patternSegs.length; i++) {
    if (patternSegs[i] === '*') {
      if (!pathSegs[i]) return null // * must match non-empty
      wildcardCount++
    } else if (patternSegs[i] !== pathSegs[i]) {
      return null
    }
  }

  return wildcardCount
}
