/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- AST ノードは readonly にできない */
// GraphQL の query 文字列から、要求の識別子を作る。
// gql は operationName を送らず、名前を持つ operation は CreateLinkedBranch だけなので、構造から作る。
// 識別子の作り方は次のとおり。inline fragment と fragment の参照（...Name）は展開する。
//   1. 根から子が 1 つの間に降りたフィールド名の道筋を '.' でつなぐ。
//   2. 子が分かれた最初の選択集合のフィールド名を '{}' で囲んで続ける。
//   3. 宣言した変数名を昇順に並べ、'|' の後ろにつける。
// 道筋を含めるのは、user と organization のように、同じ形で根だけが違う query を見分けるため。
import type { FieldNode, FragmentDefinitionNode, SelectionNode, SelectionSetNode } from 'graphql'
import { Kind, parse } from 'graphql'

import { compareStrings } from '../parity/baseline.js'

export interface ParsedOperation {
  /**
  query に書かれた operation 名。無名なら undefined
  */
  readonly name: string | undefined
  /**
  構造から作った識別子
  */
  readonly id: string
}

type Fragments = ReadonlyMap<string, FragmentDefinitionNode>

function fieldsOf(selections: readonly SelectionNode[], fragments: Fragments, expanding: ReadonlySet<string> = new Set()): FieldNode[] {
  return selections.flatMap((selection) => {
    if (selection.kind === Kind.FIELD) return [selection]
    if (selection.kind === Kind.INLINE_FRAGMENT) return fieldsOf(selection.selectionSet.selections, fragments, expanding)
    const name = selection.name.value
    const definition = fragments.get(name)
    if (definition === undefined) throw new TypeError(`GraphQL の fragment ${name} の定義が見つかりません`)
    // 輪になる参照は GraphQL が禁じる。無限に降りないよう、展開中の名前を持つ
    return expanding.has(name) ? [] : fieldsOf(definition.selectionSet.selections, fragments, new Set([...expanding, name]))
  })
}

function firstBranch(root: SelectionSetNode, fragments: Fragments): Readonly<{ path: readonly string[], fields: readonly FieldNode[] }> {
  const path: string[] = []
  let fields = fieldsOf(root.selections, fragments)
  for (;;) {
    const [only] = fields
    if (fields.length !== 1 || only?.selectionSet === undefined) return { path, fields }
    path.push(only.name.value)
    fields = fieldsOf(only.selectionSet.selections, fragments)
  }
}

export function parseOperation(query: string): ParsedOperation {
  const { definitions } = parse(query)
  const operation = definitions.find(definition => definition.kind === Kind.OPERATION_DEFINITION)
  if (operation === undefined) throw new TypeError('GraphQL の operation が見つかりません')
  const fragments = new Map(definitions.filter(definition => definition.kind === Kind.FRAGMENT_DEFINITION).map(definition => [definition.name.value, definition]))
  const branch = firstBranch(operation.selectionSet, fragments)
  const fields = branch.fields.map(field => field.name.value)
  const variables = (operation.variableDefinitions ?? []).map(definition => definition.variable.name.value).toSorted(compareStrings)
  return { name: operation.name?.value, id: `${branch.path.join('.')}{${fields.join(',')}}|${variables.join(',')}` }
}
