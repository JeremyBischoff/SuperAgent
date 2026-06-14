/**
 * Browser scenario for E2E testing.
 *
 * Launches a real Chromium (from Playwright) in headless mode, connects via CDP,
 * starts screencast, and streams frames through a mock WS server that the
 * browser-stream-proxy connects to — exercising the full streaming pipeline.
 *
 * This file is only imported when E2E_MOCK=true && E2E_CHROMIUM_PATH is set.
 */

import { spawn, type ChildProcess } from 'child_process'
import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'
import net from 'net'
import type { MockScenario, MockContainerClient } from './mock-container-client'

interface BrowserState {
  httpServer: http.Server
  wss: WebSocketServer
  cdpWs: WebSocket | null
  chromeProcess: ChildProcess | null
  port: number
}

// Track active browser instances for cleanup
const activeBrowsers = new Map<string, BrowserState>()

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function waitForCDP(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch {
      // CDP not ready yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Chrome CDP not ready on port ${port} after ${timeoutMs}ms`)
}

export class BrowserScenario implements MockScenario {
  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    const url = userMessage.replace(/^browse\s+/i, '').trim() || 'https://example.com'

    // Emit message_start immediately so the session appears active
    client.emitStreamMessage(sessionId, {
      type: 'stream_event',
      content: { type: 'stream_event', event: { type: 'message_start' } },
    })

    this.launchBrowser(sessionId, client, url).catch((err) => {
      console.error('[BrowserScenario] Failed to launch browser:', err)
      client.emitStreamMessage(sessionId, {
        type: 'result',
        content: { type: 'result', subtype: 'error', error: String(err) },
      })
    })
  }

  private async launchBrowser(
    sessionId: string,
    client: MockContainerClient,
    url: string,
  ): Promise<void> {
    const chromiumPath = process.env.E2E_CHROMIUM_PATH
    if (!chromiumPath) {
      throw new Error('E2E_CHROMIUM_PATH not set — cannot launch browser for E2E test')
    }

    // 1. Find free ports for mock WS server and Chrome CDP
    const [mockPort, cdpPort] = await Promise.all([findFreePort(), findFreePort()])

    // 2. Start mock HTTP + WS server that the browser-stream-proxy will connect to
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/browser/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ active: true, sessionId }))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const wss = new WebSocketServer({ server: httpServer, path: '/browser/stream' })

    // Buffer the last frame so late-connecting WS clients (the browser-stream-proxy)
    // get an immediate frame even if the page is static and CDP stopped sending.
    let lastMetadataJson: string | null = null
    let lastFrameBuffer: Buffer | null = null
    const fallbackFrameBuffer = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQgJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
      'base64',
    )

    wss.on('connection', (ws) => {
      console.log('[BrowserScenario] WS client connected to mock stream')
      // Send the buffered frame immediately so the client doesn't wait
      if (lastMetadataJson && lastFrameBuffer) {
        ws.send(lastMetadataJson)
        ws.send(lastFrameBuffer)
      }
    })

    await new Promise<void>((resolve) => {
      httpServer.listen(mockPort, () => {
        console.log(`[BrowserScenario] Mock WS server on port ${mockPort}`)
        resolve()
      })
    })

    const state: BrowserState = {
      httpServer,
      wss,
      cdpWs: null,
      chromeProcess: null,
      port: mockPort,
    }
    activeBrowsers.set(sessionId, state)

    // 3. Launch Chromium in headless mode
    const chrome = spawn(
      chromiumPath,
      [
        `--remote-debugging-port=${cdpPort}`,
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--no-sandbox',
        `--user-data-dir=/tmp/e2e-browser-${Date.now()}`,
      ],
      { detached: false, stdio: 'pipe' },
    )

    state.chromeProcess = chrome
    chrome.on('exit', (code) => {
      console.log(`[BrowserScenario] Chrome exited with code ${code}`)
    })

    // 4. Wait for CDP endpoint to become available
    await waitForCDP(cdpPort)

    // 5. Get a PAGE-level CDP WebSocket URL.
    //    Page.startScreencast only works on page targets, not the browser target.
    //    /json returns the list of page targets; /json/version returns the browser target.
    const pagesRes = await fetch(`http://127.0.0.1:${cdpPort}/json`)
    const pages = (await pagesRes.json()) as Array<{ webSocketDebuggerUrl: string; type: string }>
    const pageTarget = pages.find((p) => p.type === 'page')
    if (!pageTarget) {
      throw new Error('No page target found in Chrome')
    }

    // 6. Connect to the page-level CDP target
    const cdpWs = new WebSocket(pageTarget.webSocketDebuggerUrl)
    state.cdpWs = cdpWs

    await new Promise<void>((resolve, reject) => {
      cdpWs.on('open', resolve)
      cdpWs.on('error', reject)
    })

    let publishedFrameCount = 0
    const publishFrame = (frameBuffer: Buffer, meta: { deviceWidth?: number; deviceHeight?: number } = {}) => {
      const metadataJson = JSON.stringify({
        type: 'metadata',
        deviceWidth: meta.deviceWidth || 1280,
        deviceHeight: meta.deviceHeight || 720,
      })

      // Buffer for late-connecting clients
      lastMetadataJson = metadataJson
      lastFrameBuffer = frameBuffer
      publishedFrameCount += 1
      if (publishedFrameCount === 1) {
        console.log(`[BrowserScenario] Published first browser frame (${frameBuffer.length} bytes)`)
      }

      wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(metadataJson)
          ws.send(frameBuffer)
        }
      })
    }

    let cmdId = 1
    const pendingCdpCommands = new Map<number, {
      method: string
      resolve: (result: unknown) => void
      reject: (error: Error) => void
    }>()

    const cdpRequest = <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      const id = cmdId++
      return new Promise((resolve, reject) => {
        pendingCdpCommands.set(id, {
          method,
          resolve: (result) => resolve(result as T),
          reject,
        })
        cdpWs.send(JSON.stringify({ id, method, params }))
      })
    }

    const cdpSend = (method: string, params?: Record<string, unknown>) => {
      void cdpRequest(method, params).catch((error) => {
        console.error(`[BrowserScenario] CDP ${method} failed:`, error)
      })
    }
    const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
      let timeout: ReturnType<typeof setTimeout> | null = null
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    }

    // 7. Forward screencast frames to connected WS clients (the browser-stream-proxy).
    // Register before Page.startScreencast so the first frame cannot arrive before
    // the ack handler exists; missing that ack stalls the stream.
    cdpWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (typeof msg.id === 'number') {
          const pending = pendingCdpCommands.get(msg.id)
          if (pending) {
            pendingCdpCommands.delete(msg.id)
            if (msg.error) {
              pending.reject(new Error(`${pending.method}: ${JSON.stringify(msg.error)}`))
            } else {
              pending.resolve(msg.result)
            }
          }
          return
        }

        if (msg.method === 'Page.screencastFrame') {
          const frameBuffer = Buffer.from(msg.params.data, 'base64')
          const meta = msg.params.metadata || {}
          publishFrame(frameBuffer, meta)

          // Ack the frame so CDP keeps sending
          cdpSend('Page.screencastFrameAck', {
            sessionId: msg.params.sessionId,
          })
        }
      } catch {
        // Ignore parse errors
      }
    })

    // 8. Enable page events and navigate
    await cdpRequest('Page.enable')
    await cdpRequest('Page.navigate', { url })

    // Wait a moment for navigation
    await new Promise((r) => setTimeout(r, 2000))

    // 9. Capture an initial real browser frame. Some headless environments do
    // not emit a Page.screencastFrame until later; buffering one screenshot keeps
    // late WebSocket clients from seeing a blank preview.
    try {
      const result = await withTimeout(
        cdpRequest<{ data?: string }>('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 50,
        }),
        2000,
        'initial browser screenshot',
      )
      if (result.data) {
        publishFrame(Buffer.from(result.data, 'base64'))
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`[BrowserScenario] Initial screenshot unavailable (${reason}); using fallback frame`)
      publishFrame(fallbackFrameBuffer, { deviceWidth: 1, deviceHeight: 1 })
    }

    // 10. Start screencast on the page target
    await cdpRequest('Page.startScreencast', {
      format: 'jpeg',
      quality: 50,
      maxWidth: 1280,
      maxHeight: 720,
    })

    // 11. Update container manager cached status to point to the mock WS server's port.
    //     browser-stream-proxy reads getCachedInfo() to know where to connect.
    //     Dynamic import to avoid circular dependency (mock-container-client ← client-factory ← container-manager).
    const { containerManager } = await import('./container-manager')
    const agentId = client.getAgentId()
    containerManager.updateCachedStatus(agentId, 'running', mockPort)

    // 12. Track active browser on the mock client (for /browser/status responses)
    client.setActiveBrowserSession(sessionId)

    // 13. Write user message to JSONL
    client.writeJsonlEntry(sessionId, {
      type: 'user',
      message: { content: `browse ${url}` },
      timestamp: new Date().toISOString(),
    })

    // 14. Emit browser_active via SSE so the frontend shows BrowserPreview
    client.emitStreamMessage(sessionId, {
      type: 'browser_active',
      content: { type: 'browser_active', active: true, sessionId },
    })

    console.log(`[BrowserScenario] Browser launched and streaming for ${url}`)
  }
}

/**
 * Clean up a specific browser scenario (kill Chrome, close WS server).
 */
export function cleanupBrowserSession(sessionId: string): void {
  const state = activeBrowsers.get(sessionId)
  if (!state) return

  console.log(`[BrowserScenario] Cleaning up session ${sessionId}`)
  activeBrowsers.delete(sessionId)

  try { state.cdpWs?.close() } catch { /* best-effort cleanup */ }
  try { state.chromeProcess?.kill() } catch { /* best-effort cleanup */ }
  try { state.wss.close() } catch { /* best-effort cleanup */ }
  try { state.httpServer.close() } catch { /* best-effort cleanup */ }
}

/**
 * Clean up ALL active browser scenarios.
 */
export function cleanupAllBrowserSessions(): void {
  for (const sessionId of activeBrowsers.keys()) {
    cleanupBrowserSession(sessionId)
  }
}

// Ensure cleanup on process exit
if (process.env.E2E_MOCK === 'true') {
  process.on('exit', cleanupAllBrowserSessions)
}
