// @xmldom/xmldom + xpath を XmlEngine ポートに適合させるアダプタ。
// Python 版 (lxml) との出力差異を最小化するため、
// シリアライズ時に必ず xml-decl + standalone="yes" を出力する。

// xmldom の Element / Document は内部状態を持つ mutable オブジェクトであり
// readonly 化できない。`prefer-readonly-parameter-types` を本ファイル全体で無効化する。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */

import { DOMParser, MIME_TYPE, onErrorStopParsing, XMLSerializer } from '@xmldom/xmldom'
import type {
  Document as XmldomDocument,
  Element as XmldomElement,
  Node as XmldomNode,
} from '@xmldom/xmldom'
import { select, useNamespaces } from 'xpath'

import type {
  XmlDocument,
  XmlEngine,
  XmlNode,
} from '../../domain/_shared/ports.js'

const XML_DECL_STANDALONE_YES
  = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

// 不正 XML は libxml2 と同じく例外にする（既定の xmldom は warning / error を握り潰して
// 部分的な木を返すため、明示的に停止させる）。
const parser = new DOMParser({ onError: onErrorStopParsing })
const serializer = new XMLSerializer()

function parseDocument(xml: string): XmldomDocument {
  return parser.parseFromString(xml, MIME_TYPE.XML_APPLICATION)
}

// libxmljs2 は入力先頭の U+FEFF（BOM）を受理して読み飛ばしていた。
// 一方 xmldom + onErrorStopParsing は、BOM を root 要素外のコンテンツとして throw する。
// そのためパース前に除去し、BOM 付き PPTX（他アプリ出力に多い）を同じく受理できるようにする。
function stripBom(text: string): string {
  return text.startsWith('\u{FEFF}') ? text.slice(1) : text
}

function isElement(node: XmldomNode): node is XmldomElement {
  return node.nodeType === node.ELEMENT_NODE
}

// XPath の評価結果から要素ノードだけを wrap して返す。属性ノード・テキストノード・
// スカラ値（string / number / boolean）は捨てる。
function selectElements(
  xpath: string,
  context: XmldomNode,
  nsMap?: Readonly<Record<string, string>>,
): readonly XmlNode[] {
  const selected = nsMap === undefined
    ? select(xpath, context)
    : useNamespaces({ ...nsMap })(xpath, context)
  const result: XmlNode[] = []
  if (Array.isArray(selected)) {
    for (const node of selected) {
      if (isElement(node)) {
        result.push(new XmldomXmlNode(node))
      }
    }
  }
  return result
}

function parseFragmentRoot(xml: string): XmldomElement {
  const fragmentDocument = parseDocument(xml)
  const root = fragmentDocument.documentElement
  /* c8 ignore next 3 -- onErrorStopParsing は root を持たない入力で throw するため到達不能 */
  if (root === null) {
    throw new Error('XML fragment has no root element')
  }
  return root
}

class XmldomXmlNode implements XmlNode {
  private readonly element: XmldomElement

  constructor(element: XmldomElement) {
    this.element = element
  }

  private importFragment(xml: string): XmldomNode {
    return this.ownerDocument().importNode(parseFragmentRoot(xml), true)
  }

  private ownerDocument(): XmldomDocument {
    const { ownerDocument } = this.element
    /* c8 ignore next 3 -- parse 済み Document 配下の要素は常に ownerDocument を持つため到達不能 */
    if (ownerDocument === null) {
      throw new Error('XmlNode: element has no owner document')
    }
    return ownerDocument
  }

  private parentNode(): XmldomNode {
    const { parentNode } = this.element
    /* c8 ignore next 3 -- selectNodes が返す要素は常に親ノードを持つため到達不能 */
    if (parentNode === null) {
      throw new Error('XmlNode: element has no parent node')
    }
    return parentNode
  }

  selectNodes(
    xpath: string,
    nsMap?: Readonly<Record<string, string>>,
  ): readonly XmlNode[] {
    return selectElements(xpath, this.element, nsMap)
  }

  localName(): string {
    // xmldom の localName は DOM 仕様どおり null を取り得る型だが、XML パースで得た
    // Element では常に文字列。tagName の prefix 除去を fallback に置く。
    /* c8 ignore next -- 右辺は XML パース由来の Element では到達不能 */
    return this.element.localName ?? this.element.tagName.replace(/^[^:]*:/, '')
  }

  getAttr(name: string): string | undefined {
    // prefix 無しの名前は名前空間なし属性にだけ一致する（`getAttribute('id')` は
    // `r:id` に一致しない）。'prefix:localName' 形式は attributes を走査して
    // (prefix, localName) で比較する。
    const colonIndex = name.indexOf(':')
    if (colonIndex === -1) {
      return this.element.getAttribute(name) ?? undefined
    }
    const prefix = name.slice(0, colonIndex)
    const localName = name.slice(colonIndex + 1)
    const { attributes } = this.element
    for (let index = 0; index < attributes.length; index += 1) {
      const attribute = attributes.item(index)
      if (attribute !== null && attribute.prefix === prefix && attribute.localName === localName) {
        return attribute.value
      }
    }
    return undefined
  }

  setAttr(name: string, value: string): void {
    this.element.setAttribute(name, value)
  }

  text(): string {
    return this.element.textContent ?? ''
  }

  setText(value: string): void {
    while (this.element.firstChild !== null) {
      this.element.removeChild(this.element.firstChild)
    }
    this.element.appendChild(this.ownerDocument().createTextNode(value))
  }

  remove(): void {
    this.parentNode().removeChild(this.element)
  }

  replaceWithXml(xml: string): void {
    // フラグメントを別 Document として parse し、importNode で自 Document に取り込んでから
    // 置換する（文字列のまま挿入するとテキストとしてエスケープされる）。
    const replacement = this.importFragment(xml)
    this.parentNode().replaceChild(replacement, this.element)
  }

  appendChildXml(xml: string): void {
    this.element.appendChild(this.importFragment(xml))
  }

  addNextSiblingXml(xml: string): void {
    // `appendChildXml` と対称、sibling 挿入 API。自ノードが最終子のときは
    // nextSibling が null になり、insertBefore(node, null) は末尾追加として振る舞う。
    const sibling = this.importFragment(xml)
    this.parentNode().insertBefore(sibling, this.element.nextSibling)
  }

  moveToEnd(): void {
    // DOM の appendChild は既存の子を渡すと移動として振る舞う（先に detach される）。
    this.parentNode().appendChild(this.element)
  }
}

class XmldomXmlDocument implements XmlDocument {
  private readonly document: XmldomDocument

  constructor(document: XmldomDocument) {
    this.document = document
  }

  selectNodes(
    xpath: string,
    nsMap?: Readonly<Record<string, string>>,
  ): readonly XmlNode[] {
    return selectElements(xpath, this.document, nsMap)
  }

  appendChildXml(xml: string): void {
    const root = this.document.documentElement
    /* c8 ignore next 3 -- onErrorStopParsing は root を持たない Document を返さないため到達不能 */
    if (root === null) {
      throw new Error('appendChildXml: document has no root element')
    }
    root.appendChild(this.document.importNode(parseFragmentRoot(xml), true))
  }

  internalDocument(): XmldomDocument {
    return this.document
  }
}

export class XmldomXmlEngine implements XmlEngine {
  parse(buffer: Readonly<Buffer>): XmlDocument {
    const source = stripBom(Buffer.from(buffer).toString('utf8'))
    return new XmldomXmlDocument(parseDocument(source))
  }

  serialize(document: XmlDocument): Buffer {
    if (!(document instanceof XmldomXmlDocument)) {
      throw new TypeError(
        'XmldomXmlEngine.serialize: document must come from this engine',
      )
    }
    const raw = serializer.serializeToString(document.internalDocument())
    // xmldom はテキストノード中の CR（`&#13;` 由来）を生の \r で書き出す。パーサは
    // 入力の改行を正規化するため生 \r は再パースで LF に化ける。libxml2 と同じく
    // 文字参照に戻して情報を保つ。
    // 属性値は xmldom が serialize 時点で既に `&#13;` を出力するため、この replaceAll は
    // 属性値には働かない（対象は生の \r のみ）。
    // comment / CDATA 中の生の \r も、理論上はこの replaceAll の対象になる。
    // ただしパーサが入力の生 \r を parse 時点で LF へ正規化するため、到達しない。
    // `&#13;` エンティティ自体は comment / CDATA 内でデコードされず、文字列のまま残る。
    // 本エンジンに comment / CDATA を書き込む API も無い。
    const normalized = ensureStandaloneYes(raw.replaceAll('\r', '&#13;'))
    return Buffer.from(normalized, 'utf8')
  }
}

function ensureStandaloneYes(xml: string): string {
  // xmldom は入力の xml-decl（と decl〜root 間の空白）をそのまま出力し、decl が無ければ
  // 出力しない。PowerPoint 互換のため、xml-decl 行を必ず standalone="yes" 版に揃え、
  // libxml2 と同じく root の後に改行を 1 つ置く。
  // 先読みで xml-decl の `<?xml` 直後を空白 or `?` に限定し、`<?xml-stylesheet ...?>` の
  // ような別 PI を xml-decl と誤認して吸収しないようにする。
  const declarationMatch = /^<\?xml(?=[\s?])[^?]*\?>\s*/.exec(xml)
  const rest = declarationMatch === null ? xml : xml.slice(declarationMatch[0].length)
  // xmldom の serializeToString は末尾に改行を付与しないため、true 分岐は事実上到達しない。
  // 将来の xmldom 版が末尾改行を出力するようになっても、改行が二重にならないための保険。
  const body = rest.endsWith('\n') ? rest : `${rest}\n`
  return `${XML_DECL_STANDALONE_YES}\n${body}`
}
