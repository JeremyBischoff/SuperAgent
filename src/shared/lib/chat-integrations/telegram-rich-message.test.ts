import { describe, it, expect } from 'vitest'
import { inputRichMessageSchema } from './telegram-rich-message-schema'

describe('inputRichMessageSchema', () => {
  it('accepts a markdown-only message', () => {
    const r = inputRichMessageSchema.parse({ markdown: '# Hi' })
    expect(r.markdown).toBe('# Hi')
  })

  it('accepts an html-only message', () => {
    expect(() => inputRichMessageSchema.parse({ html: '<b>x</b>' })).not.toThrow()
  })

  it('rejects when both html and markdown are present', () => {
    expect(() => inputRichMessageSchema.parse({ html: '<b>x</b>', markdown: 'x' })).toThrow()
  })

  it('rejects when neither html nor markdown is present', () => {
    expect(() => inputRichMessageSchema.parse({ is_rtl: true })).toThrow()
  })

  it('carries optional flags', () => {
    const r = inputRichMessageSchema.parse({ markdown: 'x', skip_entity_detection: true })
    expect(r.skip_entity_detection).toBe(true)
  })
})
