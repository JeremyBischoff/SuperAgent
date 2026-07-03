// The reference snapshot (design §7): the harness's own same-moment capture of each URL - a raw
// HTTP GET, a Playwright (chromium) rendered DOM with innerText, and a readability main-content
// extraction. Its role is SOURCE material for the judge, not a competing candidate: vendors are
// judged on extraction quality against what the page actually contained. Where the reference itself
// fails (bot wall, empty render), the record says so and judging falls back to cross-candidate
// comparison. Snapshots land in gitignored raw/<runId>/reference/; only the small index record is
// committed. Real mode only - mock mode uses mock.ts's mockReference.

import fs from 'fs'
import path from 'path'
import type { Browser } from '@playwright/test'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import { estimateTokens } from '../lib/format'
import { writeText } from '../lib/io'
import { referenceDir } from './paths'
import type { ReferenceRecord, UrlItem } from './types'

const REFERENCE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const RAW_GET_TIMEOUT_MS = 30_000
const RENDER_TIMEOUT_MS = 30_000
const RENDER_SETTLE_MS = 3_000 // give SPAs a beat to hydrate after domcontentloaded
// Below this much rendered innerText an HTML reference cannot anchor judging (canvas apps, walls).
const MIN_HTML_TEXT_CHARS = 200
const BLOCK_MARKERS = ['just a moment', 'cf-chl', 'captcha', 'access denied', 'are you a robot', 'enable javascript and cookies']
const BLOCK_STATUS = new Set([401, 403, 429, 451])

/** Readability main-content extraction; null when no article-like content is found. Pure. */
export function extractReadability(html: string, url: string): { title: string | null; text: string } | null {
  const dom = new JSDOM(html, { url })
  const article = new Readability(dom.window.document).parse()
  if (!article || !article.textContent || article.textContent.trim().length === 0) return null
  return { title: article.title ?? null, text: article.textContent.trim() }
}

export interface ReferenceQualityInput {
  fetchFailed: boolean
  renderFailed: boolean
  httpStatus?: number
  kind: 'html' | 'pdf'
  innerTextChars: number
  readabilityChars: number
  renderedHtml: string
}

/** Classify a capture (design §7): blocked (bot wall) | failed (transport/empty render) | ok.
 *  PDFs classify ok on a successful GET - they simply carry no readability text (kind is the caveat;
 *  hasUsableReference gates the judge and efficiency paths). Pure. */
export function classifyReferenceQuality(input: ReferenceQualityInput): ReferenceRecord['quality'] {
  if (input.httpStatus !== undefined && BLOCK_STATUS.has(input.httpStatus)) return 'blocked'
  const htmlLower = input.renderedHtml.slice(0, 20_000).toLowerCase()
  if (BLOCK_MARKERS.some((m) => htmlLower.includes(m))) return 'blocked'
  if (input.kind === 'pdf') return input.fetchFailed ? 'failed' : 'ok'
  if (input.fetchFailed && input.renderFailed) return 'failed'
  if (input.innerTextChars < MIN_HTML_TEXT_CHARS) return 'failed'
  return 'ok'
}

/** Can this reference anchor judging and the efficiency denominator? (Gate 1 assumption: PDFs and
 *  blocked/failed references route to the cross-candidate fallback and are excluded from efficiency.) */
export function hasUsableReference(record: ReferenceRecord): boolean {
  return record.quality === 'ok' && record.kind === 'html' && record.readabilityChars > 0
}

/** Capture the same-moment reference for one URL (real mode). Never throws: every failure mode is
 *  folded into the record's quality/notes so one bad page cannot abort a paid run. */
export async function captureReference(
  runId: string,
  urlItem: UrlItem,
  browser: Browser,
): Promise<{ record: ReferenceRecord; readabilityText: string }> {
  const dir = referenceDir(runId)
  fs.mkdirSync(dir, { recursive: true })
  const capturedAt = new Date().toISOString()
  const notes: string[] = []

  // 1. Raw GET (what the server sends without JS).
  let httpStatus: number | undefined
  let rawGetText = ''
  let fetchFailed = false
  let kind: 'html' | 'pdf' = urlItem.category === 'pdf' ? 'pdf' : 'html'
  try {
    const resp = await fetch(urlItem.url, {
      headers: { 'user-agent': REFERENCE_UA, accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(RAW_GET_TIMEOUT_MS),
    })
    httpStatus = resp.status
    const contentType = resp.headers.get('content-type') ?? ''
    if (contentType.includes('application/pdf')) kind = 'pdf'
    const buf = Buffer.from(await resp.arrayBuffer())
    if (kind === 'pdf') {
      fs.writeFileSync(path.join(dir, `${urlItem.id}.pdf`), buf)
      rawGetText = '' // binary; readability has no denominator for PDFs (excluded from efficiency)
      notes.push(`pdf bytes: ${buf.byteLength}`)
    } else {
      rawGetText = buf.toString('utf-8')
      writeText(path.join(dir, `${urlItem.id}.raw.html`), rawGetText)
    }
  } catch (err) {
    fetchFailed = true
    notes.push(`raw GET failed: ${err instanceof Error ? err.message : err}`)
  }

  // 2. Playwright rendered DOM + innerText (skipped for PDFs - chromium would just download them).
  let renderedHtml = ''
  let innerText = ''
  let renderFailed = false
  if (kind === 'html') {
    let page = null
    try {
      page = await browser.newPage({ userAgent: REFERENCE_UA })
      await page.goto(urlItem.url, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS })
      await page.waitForTimeout(RENDER_SETTLE_MS)
      renderedHtml = await page.content()
      innerText = await page.evaluate(() => document.body?.innerText ?? '')
      writeText(path.join(dir, `${urlItem.id}.rendered.html`), renderedHtml)
      writeText(path.join(dir, `${urlItem.id}.innertext.txt`), innerText)
    } catch (err) {
      renderFailed = true
      notes.push(`render failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      await page?.close().catch(() => {})
    }
  }

  // 3. Readability main text over the rendered DOM (falls back to the raw GET when render failed).
  let readabilityText = ''
  if (kind === 'html') {
    const source = renderedHtml || rawGetText
    if (source) {
      try {
        const extracted = extractReadability(source, urlItem.url)
        if (extracted) {
          readabilityText = extracted.text
          writeText(path.join(dir, `${urlItem.id}.readability.txt`), readabilityText)
        } else {
          notes.push('readability found no article content')
        }
      } catch (err) {
        notes.push(`readability failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  const record: ReferenceRecord = {
    runId,
    urlId: urlItem.id,
    capturedAt,
    quality: classifyReferenceQuality({
      fetchFailed,
      renderFailed,
      httpStatus,
      kind,
      innerTextChars: innerText.length,
      readabilityChars: readabilityText.length,
      renderedHtml,
    }),
    kind,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    rawGetChars: rawGetText.length,
    renderedChars: renderedHtml.length,
    innerTextChars: innerText.length,
    readabilityChars: readabilityText.length,
    readabilityTokens: estimateTokens(readabilityText),
    notes,
  }
  return { record, readabilityText }
}
