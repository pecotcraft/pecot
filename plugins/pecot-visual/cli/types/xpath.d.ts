// xpath の型を @xmldom/xmldom の Node 型で再宣言する。
// 本家 xpath.d.ts は `/// <reference lib="dom" />` の Node を前提にする。
// xmldom 0.9 の独自 Document / Element 型を渡すと、TS2739 / TS2345 になる。
// そのため使用する API だけを宣言し、実装側でキャストを持たない。
declare module 'xpath' {
  import type { Node as XmldomNode } from '@xmldom/xmldom'

  export type SelectedValue = XmldomNode | string | number | boolean | null
  export type SelectReturnType = XmldomNode[] | SelectedValue

  export type XPathSelect = (expression: string, node: XmldomNode) => SelectReturnType

  export function select(expression: string, node: XmldomNode): SelectReturnType
  export function useNamespaces(namespaceMap: Record<string, string>): XPathSelect
}
