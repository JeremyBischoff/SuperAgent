import { shell } from 'electron'
import { z } from 'zod'

// Schemes safe to hand to the OS shell from UNTRUSTED contexts — popups opened by
// web / dashboard / agent-rendered content via setWindowOpenHandler. Only normal
// web links + mailto. Everything outside this set (file:, javascript:, data:,
// vbscript:, ftp:, and arbitrary custom app protocols like myapp://) is dropped:
// shell.openExternal asks the OS to launch a registered handler, which can start
// local apps or privileged flows entirely outside the browser sandbox.
const WEB_PROTOCOLS = ['https:', 'http:', 'mailto:'] as const

// Additional well-defined, user-facing OS handlers that the APP'S OWN UI may open
// via the `open-external` IPC: Messages (sms:/tel:) and macOS System Settings
// panes (x-apple.systempreferences:). Unlike file:/javascript:/data:/custom app
// protocols, these hand a *structured* request to a fixed OS handler — they can't
// launch an arbitrary local app with arbitrary arguments, and the user still
// confirms any resulting action (sending a text, changing a setting). They are
// deliberately NOT allowed from the popup handler, so agent-rendered web content
// cannot trigger them — only first-party app UI (the computer-use permission
// helper and the iMessage setup link) reaches them.
const APP_DEEP_LINK_PROTOCOLS = ['sms:', 'tel:', 'x-apple.systempreferences:'] as const

// Validate at the boundary (CLAUDE.md): the input must be a non-empty string that
// parses into a URL whose protocol is on the allowlist. `new URL()` throws on
// malformed input, which the refine catches and turns into a parse failure.
function makeAllowlistSchema(protocols: readonly string[]) {
  const allowed = new Set<string>(protocols)
  return z
    .string()
    .min(1)
    .refine((value) => {
      try {
        return allowed.has(new URL(value).protocol)
      } catch {
        return false
      }
    }, 'URL scheme is not on the safe-open allowlist')
}

const WebUrlSchema = makeAllowlistSchema(WEB_PROTOCOLS)
const AppUrlSchema = makeAllowlistSchema([...WEB_PROTOCOLS, ...APP_DEEP_LINK_PROTOCOLS])

async function forward(
  schema: ReturnType<typeof makeAllowlistSchema>,
  url: unknown,
  context: string,
): Promise<boolean> {
  const result = schema.safeParse(url)
  if (!result.success) {
    const printable = typeof url === 'string' ? url : `<${typeof url}>`
    console.warn(`safe-open-external (${context}): refusing to open disallowed URL: ${printable}`)
    return false
  }
  await shell.openExternal(result.data)
  return true
}

/**
 * Type guard: true only when `url` is a string with an allowlisted web scheme
 * (http/https/mailto). Mirrors the strict popup allowlist. Never throws.
 */
export function isSafeExternalUrl(url: unknown): url is string {
  return WebUrlSchema.safeParse(url).success
}

/**
 * Strict scheme-checked wrapper for UNTRUSTED callers (the popup
 * setWindowOpenHandler, which fires for web / dashboard / agent content).
 * Forwards only web schemes (http/https/mailto); logs and drops everything else
 * (including non-string / malformed input) without throwing.
 *
 * @returns true if the URL was forwarded to the shell, false if it was dropped.
 */
export async function safeOpenExternal(url: unknown): Promise<boolean> {
  return forward(WebUrlSchema, url, 'popup')
}

/**
 * Scheme-checked wrapper for FIRST-PARTY app UI (the `open-external` IPC handler).
 * Allows web schemes plus the well-defined OS user-action deep-links
 * (sms:/tel:/x-apple.systempreferences:) that legitimate app flows use — the
 * computer-use permission helper and the iMessage setup link. Still drops
 * file:/javascript:/data:/custom protocols. Never throws.
 *
 * @returns true if the URL was forwarded to the shell, false if it was dropped.
 */
export async function safeOpenExternalFromApp(url: unknown): Promise<boolean> {
  return forward(AppUrlSchema, url, 'app')
}
