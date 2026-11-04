// 参照 yaml（レイアウトの宣言）の `examples` から、ページの雛形（フロントマター）を取り出す。
// `slide_page` が雛形を書き出すときと、`slide create` が初期ページを作るときに共用する。

/**
参照 yaml の examples ブロックの開始行。雛形の探索はここから後ろだけを見る。
*/
const EXAMPLES_REGEX = /^examples:[ \t]*$/m

/**
examples の 1 件目の `frontmatter: |` ブロックのマーカー行。

行頭アンカーは必須。アンカー無しだと media-right-code.yaml の
`codeSrc: /slides/code/sample-frontmatter.yaml` に誤マッチする。
*/
const FRONTMATTER_BLOCK_REGEX = /^([ \t]*)frontmatter:[ \t]*\|[ \t]*$/m

/**
雛形として成立するフロントマターの先頭・末尾。
*/
const FRONTMATTER_DELIMITER = '---'

/**
examples の 1 件目の `frontmatter: |` ブロックの中身を取り出す。

ブロックの先頭行・末尾行は既に `---` なので、呼び出し側で囲み直さない (囲むと
「空のフロントマター + Markdown 本文」になり、レイアウトが当たらないページを通知なしに作ってしまう)。
yaml パーサは使わない (parse → stringify を挟むとコメント・引用符・キー順が
書き換わり、参照 yaml が示した雛形と別物のページが出来る)。

抽出できないのは、examples を持たない参照 yaml だけ。
参照スキーマ (validate-references/lib/schema.json) が examples を minItems: 1 と定めているため、正規のテンプレートでは起こらない。
呼び出し側は失敗応答にする。

探索は `examples:` 以降に限る。手前のセクション (props の description 等) に
`frontmatter: |` と書かれた説明文があっても雛形として拾わないため。
*/
export function extractSkeleton(referenceText: string): string | undefined {
  const examples = EXAMPLES_REGEX.exec(referenceText)
  if (examples === null) return undefined
  const examplesText = referenceText.slice(examples.index)

  const marker = FRONTMATTER_BLOCK_REGEX.exec(examplesText)
  if (marker === null) return undefined
  /* c8 ignore next -- regex の group 1 は必ずキャプチャされるため、空文字への代替の右辺は到達不能 */
  const markerIndent = (marker[1] ?? '').length

  const body: string[] = []
  // ブロック内の空行は、後続に本文が続くと分かった時点でまとめて採る (末尾の空行は捨てる)。
  const pendingBlankLines: string[] = []
  for (const line of examplesText.slice(marker.index).split('\n').slice(1)) {
    if (line.trim() === '') {
      pendingBlankLines.push('')
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent <= markerIndent) break
    body.push(...pendingBlankLines.splice(0), line)
  }
  const first = body[0]
  if (first === undefined) return undefined

  // ブロックのインデント基準は 1 行目。深い行は相対インデントを保ったまま落とす。
  const blockIndent = first.length - first.trimStart().length
  return `${body.map(line => line.slice(blockIndent)).join('\n')}\n`
}

/**
取り出した雛形がフロントマターとして成立しているか。

参照 yaml の examples が `---` で囲まれていないと、そのまま書き出したページは
「フロントマター無しの Markdown 本文」になりレイアウトが当たらない。書き込む前に弾く。
*/
export function isFrontmatterBlock(skeleton: string): boolean {
  // 末尾の改行を落としてから両端を見る。`---` 1 本だけの雛形は startsWith 側で落ちる。
  const trimmed = skeleton.trimEnd()
  return trimmed.startsWith(`${FRONTMATTER_DELIMITER}\n`) && trimmed.endsWith(FRONTMATTER_DELIMITER)
}
