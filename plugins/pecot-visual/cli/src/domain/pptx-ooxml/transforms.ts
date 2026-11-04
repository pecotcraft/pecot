// XmlMutation: 単一の XmlNode に適用する宣言的な変換種別。
// commands 層が「適用された XmlMutation 一覧」を --report に書き出すためのデータ型を兼ねる。

import type { XmlNode } from '../_shared/ports.js'

export type XmlMutation
  = | { readonly kind: 'set-attr', readonly name: string, readonly value: string }
    | { readonly kind: 'set-text', readonly value: string }
    | { readonly kind: 'remove' }
    | { readonly kind: 'replace-with-xml', readonly xml: string }

export function applyMutation(node: XmlNode, mutation: XmlMutation): void {
  switch (mutation.kind) {
    case 'set-attr': {
      node.setAttr(mutation.name, mutation.value)
      return
    }
    case 'set-text': {
      node.setText(mutation.value)
      return
    }
    case 'remove': {
      node.remove()
      return
    }
    case 'replace-with-xml': {
      node.replaceWithXml(mutation.xml)
      return
    }
  }
}
