import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// Mocks — before importing the module under test
// ============================================================================

const mockExecSync = vi.fn()
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}))

const mockCheckCommandAvailable = vi.fn()
const mockExecWithPath = vi.fn()
vi.mock('./base-container-client', () => ({
  BaseContainerClient: class {
    config: unknown
    constructor(config: unknown) {
      this.config = config
    }
  },
  checkCommandAvailable: (...args: unknown[]) => mockCheckCommandAvailable(...args),
  execWithPath: (...args: unknown[]) => mockExecWithPath(...args),
  CONTAINER_INTERNAL_PORT: 3000,
  shellEscape: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
}))

const mockRunWithAdminPrivileges = vi.fn()
const mockIsAdminPrivilegeCancelError = vi.fn((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('User canceled') || message.includes('-128')
})
vi.mock('@shared/lib/run-with-admin-privileges', () => ({
  runWithAdminPrivileges: (...args: unknown[]) => mockRunWithAdminPrivileges(...args),
  isAdminPrivilegeCancelError: (error: unknown) => mockIsAdminPrivilegeCancelError(error),
}))

import {
  AppleContainerClient,
  APPLE_CONTAINER_PKG_SHA256,
  appleContainerProvisionIO,
  ensureAppleContainerReady,
  resetAppleContainerClientForTests,
} from './apple-container-client'

describe('AppleContainerClient.isEligible', () => {
  const originalPlatform = process.platform
  const originalArch = process.arch

  beforeEach(() => {
    resetAppleContainerClientForTests()
    mockExecSync.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true, configurable: true })
    Object.defineProperty(process, 'arch', { value: originalArch, writable: true, configurable: true })
    resetAppleContainerClientForTests()
  })

  function setPlatformArch(platform: string, arch: string) {
    Object.defineProperty(process, 'platform', { value: platform, writable: true, configurable: true })
    Object.defineProperty(process, 'arch', { value: arch, writable: true, configurable: true })
  }

  it.each([
    { platform: 'darwin', arch: 'arm64', version: '26.0', expected: true, label: 'arm64 macOS 26+' },
    { platform: 'darwin', arch: 'x64', version: '26.0', expected: false, label: 'Intel' },
    { platform: 'darwin', arch: 'arm64', version: '15.4', expected: false, label: 'macOS < 26' },
    { platform: 'linux', arch: 'arm64', version: '26.0', expected: false, label: 'non-darwin' },
  ])('isEligible=$expected for $label', ({ platform, arch, version, expected }) => {
    setPlatformArch(platform, arch)
    mockExecSync.mockReturnValue(Buffer.from(`${version}\n`))
    expect(AppleContainerClient.isEligible()).toBe(expected)
    if (arch !== 'arm64' || platform !== 'darwin') {
      expect(mockExecSync).not.toHaveBeenCalled()
    }
  })
})

describe('ensureAppleContainerReady', () => {
  const originalPlatform = process.platform
  const originalArch = process.arch
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    resetAppleContainerClientForTests()
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true, configurable: true })
    Object.defineProperty(process, 'arch', { value: 'arm64', writable: true, configurable: true })
    mockExecSync.mockReturnValue(Buffer.from('26.0\n'))
    mockIsAdminPrivilegeCancelError.mockImplementation((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error ?? '')
      return message.includes('User canceled') || message.includes('-128')
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true, configurable: true })
    Object.defineProperty(process, 'arch', { value: originalArch, writable: true, configurable: true })
    globalThis.fetch = originalFetch
    resetAppleContainerClientForTests()
  })

  it('skips download when CLI is already installed', async () => {
    mockCheckCommandAvailable.mockResolvedValue(true)
    mockExecWithPath.mockResolvedValue({ stdout: '', stderr: '' })
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await ensureAppleContainerReady()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockRunWithAdminPrivileges).not.toHaveBeenCalled()
    expect(mockExecWithPath).toHaveBeenCalledWith('container system start --enable-kernel-install')
  })

  it('first-install: download, verify, elevate, start', async () => {
    mockCheckCommandAvailable.mockResolvedValue(false)
    appleContainerProvisionIO.downloadToFile = vi.fn().mockResolvedValue(undefined)
    appleContainerProvisionIO.hashFileSha256 = vi.fn().mockResolvedValue(APPLE_CONTAINER_PKG_SHA256)
    mockRunWithAdminPrivileges.mockResolvedValue(undefined)
    mockExecWithPath.mockResolvedValue({ stdout: '', stderr: '' })

    await ensureAppleContainerReady()

    expect(appleContainerProvisionIO.downloadToFile).toHaveBeenCalledOnce()
    expect(mockRunWithAdminPrivileges).toHaveBeenCalledOnce()
    expect(mockRunWithAdminPrivileges.mock.calls[0]?.[0]).toMatch(/^installer -pkg '.*' -target \/$/)
    expect(mockExecWithPath).toHaveBeenCalledWith('container system start --enable-kernel-install')
  })

  it('refuses to provision on ineligible machines', async () => {
    Object.defineProperty(process, 'arch', { value: 'x64', writable: true, configurable: true })
    resetAppleContainerClientForTests()

    await expect(ensureAppleContainerReady()).rejects.toThrow(/Apple silicon|macOS 26/i)
    expect(mockRunWithAdminPrivileges).not.toHaveBeenCalled()
  })

  it('never elevates when downloaded digest mismatches', async () => {
    mockCheckCommandAvailable.mockResolvedValue(false)
    const badBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('not-the-installer'))
        controller.close()
      },
    })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: badBody,
    }) as unknown as typeof fetch

    await expect(ensureAppleContainerReady()).rejects.toThrow(/integrity check/i)
    expect(mockRunWithAdminPrivileges).not.toHaveBeenCalled()
  })

  it('maps admin cancel to a recoverable error', async () => {
    mockCheckCommandAvailable.mockResolvedValue(false)
    appleContainerProvisionIO.downloadToFile = vi.fn().mockResolvedValue(undefined)
    appleContainerProvisionIO.hashFileSha256 = vi.fn().mockResolvedValue(APPLE_CONTAINER_PKG_SHA256)
    mockRunWithAdminPrivileges.mockRejectedValue(new Error('User canceled. (-128)'))

    await expect(ensureAppleContainerReady()).rejects.toThrow(/cancelled|canceled/i)
    expect(mockRunWithAdminPrivileges.mock.calls[0]?.[0]).not.toContain('http')
  })

  it('mutex serializes concurrent ensure calls', async () => {
    let resolveAvailable: ((v: boolean) => void) | undefined
    let availableCalls = 0
    mockCheckCommandAvailable.mockImplementation(() => {
      availableCalls++
      return new Promise<boolean>((resolve) => {
        resolveAvailable = resolve
      })
    })
    mockExecWithPath.mockResolvedValue({ stdout: '', stderr: '' })

    const p1 = ensureAppleContainerReady()
    const p2 = ensureAppleContainerReady()
    expect(availableCalls).toBe(1)

    resolveAvailable?.(true)
    await Promise.all([p1, p2])
    expect(availableCalls).toBe(1)
  })
})
