import { describe, expect, it } from 'vitest'
import { classifyReferenceQuality, extractReadability, hasUsableReference } from './reference'

const ARTICLE_HTML = `<!DOCTYPE html><html><head><title>Test Article</title></head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<article><h1>The Real Headline For Readers</h1>
${'<p>This is the main article body text that readability should keep. It talks about one topic at length and carries the substance of the page.</p>'.repeat(8)}
</article>
<footer>Copyright 2026 - Privacy - Terms - Newsletter signup</footer>
</body></html>`

describe('extractReadability', () => {
  it('keeps the article body and drops nav/footer boilerplate', () => {
    const res = extractReadability(ARTICLE_HTML, 'https://example.com/a')
    expect(res).not.toBeNull()
    expect(res?.text).toContain('main article body text')
    expect(res?.text).not.toContain('Newsletter signup')
    expect(res?.title).toContain('Headline')
  })

  it('returns null when there is no article to find', () => {
    expect(extractReadability('<html><body></body></html>', 'https://example.com/x')).toBeNull()
  })
})

describe('classifyReferenceQuality', () => {
  const base = {
    fetchFailed: false,
    renderFailed: false,
    httpStatus: 200,
    kind: 'html' as const,
    innerTextChars: 5000,
    readabilityChars: 4000,
    renderedHtml: '<html><body>fine</body></html>',
  }

  it('is ok for a healthy capture and for a pdf (kind carries the caveat)', () => {
    expect(classifyReferenceQuality(base)).toBe('ok')
    expect(classifyReferenceQuality({ ...base, kind: 'pdf', innerTextChars: 0, readabilityChars: 0 })).toBe('ok')
  })

  it('is blocked on bot-wall status codes and challenge markers', () => {
    expect(classifyReferenceQuality({ ...base, httpStatus: 403 })).toBe('blocked')
    expect(classifyReferenceQuality({ ...base, httpStatus: 429 })).toBe('blocked')
    expect(
      classifyReferenceQuality({ ...base, renderedHtml: '<html><body>Just a moment... checking your browser</body></html>' }),
    ).toBe('blocked')
  })

  it('is failed on transport failure or an empty render', () => {
    expect(classifyReferenceQuality({ ...base, fetchFailed: true, renderFailed: true })).toBe('failed')
    expect(classifyReferenceQuality({ ...base, innerTextChars: 40 })).toBe('failed')
  })
})

describe('hasUsableReference', () => {
  const rec = {
    runId: 'r',
    urlId: 'u',
    capturedAt: 't',
    quality: 'ok' as const,
    kind: 'html' as const,
    rawGetChars: 1,
    renderedChars: 1,
    innerTextChars: 1,
    readabilityChars: 10,
    readabilityTokens: 3,
    notes: [],
  }

  it('requires ok quality, html kind, and readability text', () => {
    expect(hasUsableReference(rec)).toBe(true)
    expect(hasUsableReference({ ...rec, quality: 'blocked' })).toBe(false)
    expect(hasUsableReference({ ...rec, kind: 'pdf' })).toBe(false)
    expect(hasUsableReference({ ...rec, readabilityChars: 0 })).toBe(false)
  })
})
