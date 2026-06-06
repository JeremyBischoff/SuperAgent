import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// SUP-217 — Electron host-browser exposes Chrome DevTools Protocol on all
// interfaces.
//
// ChromeProvider.launch() spawns Chrome with `--remote-debugging-address=0.0.0.0`
// and, on Windows, runs the fallback forwarding proxy bound to `0.0.0.0`. CDP has
// no auth token, so anything reachable on the LAN can fully remote-control the
// dedicated Chrome profile. These tests pin the guardrail: CDP / the forwarding
// proxy must bind to loopback (or a specific host-internal bridge interface),
// never all interfaces.
//
// Against current `main` (which passes 0.0.0.0) both cases FAIL; after the fix
// they pass.
// ---------------------------------------------------------------------------

// Hoisted shared mock state — referenced by the vi.mock factories (which are
// hoisted above the imports) and by the tests.
const h = vi.hoisted(() => {
  const listenCalls: Array<{ port: unknown; host: unknown }> = []

  function makeServer() {
    const server: Record<string, unknown> = {
      listen: (port: unknown, host: unknown, cb?: unknown) => {
        listenCalls.push({ port, host })
        if (typeof cb === 'function') (cb as () => void)()
        return server
      },
      on: () => server,
      address: () => ({ port: 9999 }),
      close: (cb?: unknown) => {
        if (typeof cb === 'function') (cb as () => void)()
        return server
      },
    }
    return server
  }

  function makeChild(pid: number) {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    return {
      pid,
      killed: false,
      stderr: { on: () => {} },
      on(ev: string, cb: (...a: unknown[]) => void) {
        ;(handlers[ev] = handlers[ev] || []).push(cb)
        return this
      },
      kill() {
        this.killed = true
        return true
      },
    }
  }

  class Socket {
    private _h: Record<string, () => void> = {}
    setTimeout() {}
    on(ev: string, cb: () => void) {
      this._h[ev] = cb
      return this
    }
    connect() {
      // Report the port as open so waitForPort() resolves immediately.
      queueMicrotask(() => this._h.connect?.())
      return this
    }
    destroy() {}
  }

  const createServer = vi.fn((_listener?: unknown) => makeServer())
  const connect = vi.fn(() => ({ pipe: () => {}, on: () => {}, destroy: () => {} }))
  const netMock = { createServer, connect, Socket }

  const spawnMock = vi.fn((_cmd: string, _args: string[]) => makeChild(4321))
  const execSyncMock = vi.fn(() => 'default via 172.22.192.1 dev eth0')

  function reset() {
    listenCalls.length = 0
    spawnMock.mockClear().mockImplementation((_cmd: string, _args: string[]) => makeChild(4321))
    execSyncMock.mockClear().mockImplementation(() => 'default via 172.22.192.1 dev eth0')
    createServer.mockClear()
    connect.mockClear()
  }

  return { listenCalls, createServer, connect, netMock, spawnMock, execSyncMock, reset }
})

vi.mock('child_process', () => ({ spawn: h.spawnMock, execSync: h.execSyncMock }))

vi.mock('net', () => ({ default: h.netMock, ...h.netMock }))

vi.mock('fs', () => {
  const m = {
    existsSync: () => true,
    mkdirSync: () => undefined,
    rmSync: () => undefined,
    readFileSync: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    writeFileSync: () => undefined,
    statSync: () => ({ size: 0, mtimeMs: 0 }),
    accessSync: () => undefined,
    readdirSync: () => [],
    readlinkSync: () => '',
    constants: { X_OK: 1 },
  }
  return { default: m, ...m }
})

vi.mock('@shared/lib/config/data-dir', () => ({
  getDataDir: () => '/tmp/sa-sup217-data',
  getAgentDownloadsDir: () => '/tmp/sa-sup217-downloads',
}))

vi.mock('@shared/lib/browser/chrome-profile', () => ({
  listChromeProfiles: () => [],
  copyChromeProfileData: () => false,
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: () => {},
  addErrorBreadcrumb: () => {},
}))

// The fix imports the WSL2 distro-name constant to reuse the gateway-IP
// detection pattern. Stub it so the heavy container-client module isn't loaded.
vi.mock('@shared/lib/container/wsl2-container-client', () => ({
  WSL2_DISTRO_NAME: 'superagent',
}))

import { ChromeProvider } from './chrome-provider'

const originalPlatform = process.platform
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

/** Find the spawned Chrome arg list (the one carrying --remote-debugging-port). */
function getChromeArgs(): string[] | null {
  for (const call of h.spawnMock.mock.calls) {
    const argList = call[1]
    if (
      Array.isArray(argList) &&
      argList.some((a) => typeof a === 'string' && a.startsWith('--remote-debugging-port='))
    ) {
      return argList as string[]
    }
  }
  return null
}

describe('ChromeProvider CDP bind address (SUP-217)', () => {
  let provider: ChromeProvider

  beforeEach(() => {
    h.reset()
    provider = new ChromeProvider()
  })

  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it('linux: binds Chrome CDP to loopback, never 0.0.0.0', async () => {
    setPlatform('linux')

    await provider.launch('agent1')

    const args = getChromeArgs()
    expect(args, 'Chrome should have been spawned with debugging args').not.toBeNull()
    // The vulnerability: CDP advertised on every interface.
    expect(args).not.toContain('--remote-debugging-address=0.0.0.0')
    // The guardrail: loopback-only (proxy forwards to the container).
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
  })

  it('win32: forwarding proxy is never bound to 0.0.0.0', async () => {
    setPlatform('win32')

    await provider.launch('agent1')

    const hosts = h.listenCalls.map((c) => c.host)
    // The proxy must have actually been created and bound to something.
    expect(hosts.length).toBeGreaterThan(0)
    // The vulnerability: proxy listener on all interfaces.
    expect(hosts).not.toContain('0.0.0.0')

    // Chrome's own CDP arg must also be loopback, not all-interfaces.
    const args = getChromeArgs()
    expect(args).not.toBeNull()
    expect(args).not.toContain('--remote-debugging-address=0.0.0.0')
  })
})
