// SPDX-License-Identifier: MIT
// Minimal XML parser for SVG (BURN-50). Node has no DOMParser, so the core reads
// SVG with this instead: elements, attributes, the predefined and numeric
// entities, CDATA, comments and processing instructions. A DOCTYPE is skipped,
// except that plain `<!ENTITY name "value">` declarations in its internal subset
// are honoured (old Illustrator files declare their namespaces that way). No
// external entities, no validation.

export interface XmlElement {
  type: 'element'
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
  /** 1-based source line of the start tag. */
  line: number
}

export interface XmlText {
  type: 'text'
  text: string
}

export type XmlNode = XmlElement | XmlText

export class XmlParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`XML line ${line}: ${message}`)
    this.name = 'XmlParseError'
  }
}

export interface XmlParseResult {
  root: XmlElement
  /** Entity names that were referenced but not defined; left in the text as written. */
  unknownEntities: string[]
}

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

const isNameStart = (c: string) => /[A-Za-z_:À-￿]/.test(c)
const isNameChar = (c: string) => /[A-Za-z0-9_:.\-·À-￿]/.test(c)
const isSpace = (c: string | undefined) => c === ' ' || c === '\n' || c === '\t' || c === '\r'

export function parseXml(source: string): XmlParseResult {
  const src = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  const entities: Record<string, string> = { ...PREDEFINED }
  const unknown = new Set<string>()
  let pos = 0
  let line = 1

  const advance = (to: number) => {
    for (let i = pos; i < to; i++) if (src.charCodeAt(i) === 10) line++
    pos = to
  }
  const fail = (message: string): never => {
    throw new XmlParseError(message, line)
  }
  const expectEnd = (marker: string, what: string) => {
    const end = src.indexOf(marker, pos)
    if (end < 0) fail(`unterminated ${what}`)
    return end
  }

  const decode = (text: string): string =>
    text.indexOf('&') < 0
      ? text
      : text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.\-]*);/g, (whole, ref: string) => {
          if (ref[0] === '#') {
            const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
            return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole
          }
          const value = entities[ref]
          if (value === undefined) {
            unknown.add(ref)
            return whole
          }
          return value
        })

  const readName = (): string => {
    const start = pos
    if (pos >= src.length || !isNameStart(src[pos]!)) fail('expected a name')
    while (pos < src.length && isNameChar(src[pos]!)) pos++
    return src.slice(start, pos)
  }
  const skipSpace = () => {
    let p = pos
    while (isSpace(src[p])) p++
    advance(p)
  }

  const skipDoctype = () => {
    // pos is at "<!DOCTYPE"
    advance(pos + 9)
    let depth = 0
    while (pos < src.length) {
      const c = src[pos]
      if (c === '[') {
        depth++
        advance(pos + 1)
      } else if (c === ']') {
        depth--
        advance(pos + 1)
      } else if (c === '>' && depth <= 0) {
        advance(pos + 1)
        return
      } else if (c === '"' || c === "'") {
        const end = src.indexOf(c, pos + 1)
        if (end < 0) fail('unterminated DOCTYPE literal')
        advance(end + 1)
      } else if (depth > 0 && src.startsWith('<!ENTITY', pos)) {
        const end = expectEnd('>', 'ENTITY declaration')
        const decl = src.slice(pos, end + 1)
        // Only general internal entities: <!ENTITY name "value"> (not % parameter or SYSTEM/PUBLIC).
        const m = /^<!ENTITY\s+([A-Za-z_][\w.\-]*)\s+(["'])([\s\S]*?)\2\s*>$/.exec(decl)
        if (m) entities[m[1]!] = decode(m[3]!)
        advance(end + 1)
      } else if (depth > 0 && src.startsWith('<!--', pos)) {
        advance(expectEnd('-->', 'comment') + 3)
      } else {
        advance(pos + 1)
      }
    }
    fail('unterminated DOCTYPE')
  }

  // Skips misc content outside the root (prolog, comments, PIs, whitespace).
  const skipMisc = (allowDoctype: boolean) => {
    for (;;) {
      skipSpace()
      if (src.startsWith('<?', pos)) advance(expectEnd('?>', 'processing instruction') + 2)
      else if (src.startsWith('<!--', pos)) advance(expectEnd('-->', 'comment') + 3)
      else if (allowDoctype && src.startsWith('<!DOCTYPE', pos)) skipDoctype()
      else return
    }
  }

  const parseElement = (): XmlElement => {
    const startLine = line
    advance(pos + 1) // <
    const name = readName()
    const attributes: Record<string, string> = {}
    for (;;) {
      skipSpace()
      const c = src[pos]
      if (c === undefined) fail(`unterminated start tag <${name}>`)
      if (c === '/' && src[pos + 1] === '>') {
        advance(pos + 2)
        return { type: 'element', name, attributes, children: [], line: startLine }
      }
      if (c === '>') {
        advance(pos + 1)
        break
      }
      const attr = readName()
      skipSpace()
      if (src[pos] !== '=') fail(`attribute ${attr} on <${name}> has no value`)
      advance(pos + 1)
      skipSpace()
      const q = src[pos]
      if (q !== '"' && q !== "'") fail(`attribute ${attr} on <${name}> is not quoted`)
      const end = src.indexOf(q!, pos + 1)
      if (end < 0) fail(`unterminated value for ${attr}`)
      attributes[attr] = decode(src.slice(pos + 1, end))
      advance(end + 1)
    }

    const children: XmlNode[] = []
    const pushText = (text: string) => {
      if (!text) return
      const last = children[children.length - 1]
      if (last?.type === 'text') last.text += text
      else children.push({ type: 'text', text })
    }
    for (;;) {
      const lt = src.indexOf('<', pos)
      if (lt < 0) fail(`<${name}> is never closed`)
      if (lt > pos) {
        pushText(decode(src.slice(pos, lt)))
        advance(lt)
      }
      if (src.startsWith('</', pos)) {
        advance(pos + 2)
        const close = readName()
        if (close !== name) fail(`</${close}> closes <${name}> (line ${startLine})`)
        skipSpace()
        if (src[pos] !== '>') fail(`malformed end tag </${close}>`)
        advance(pos + 1)
        return { type: 'element', name, attributes, children, line: startLine }
      }
      if (src.startsWith('<!--', pos)) advance(expectEnd('-->', 'comment') + 3)
      else if (src.startsWith('<![CDATA[', pos)) {
        const end = expectEnd(']]>', 'CDATA section')
        pushText(src.slice(pos + 9, end))
        advance(end + 3)
      } else if (src.startsWith('<?', pos)) advance(expectEnd('?>', 'processing instruction') + 2)
      else if (src.startsWith('<!', pos)) fail('unexpected markup declaration inside an element')
      else children.push(parseElement())
    }
  }

  skipMisc(true)
  if (src[pos] !== '<') fail('no root element')
  const root = parseElement()
  skipMisc(false)
  if (pos < src.length) fail('content after the root element')
  return { root, unknownEntities: [...unknown] }
}

/** Concatenated text content of an element and its descendants. */
export function textContent(node: XmlNode): string {
  if (node.type === 'text') return node.text
  return node.children.map(textContent).join('')
}
