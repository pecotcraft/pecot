#!/usr/bin/env node
/**
 * テーマの cx assertion（`check-cx.mjs --measure`）の出力 2 本を比べ、spec 別の cx 比較表を出す。
 * 依存更新で主要 sp の文字幅（`a:ext cx`）が縮んでいないかを見るための起点。
 *
 *   node plugins/pecot-visual/scripts/pptx-compare/compare-cx-measure.mjs \
 *
 *     <before-measure.txt> <after-measure.txt> [--config <config.yml>] [--out <path>]
 *
 * オプション:
 *   --config <path> `config.yml` の `min_cx_emu` と余裕（%）の列を加える。
 *   --out <path>    Markdown をファイルへ書く（既定は stdout）。どの判定でも先に書き出す。
 *   `--config=path` / `--out=path` の `=` 形式も受け付ける。
 *
 * measure 出力の取り方: before / after の各 checkout で、テーマのリポジトリの cx assertion を `--measure` 付きで実行する。
 * その標準出力を保存する。
 * 標準出力は `.pecot/work/<Issue 番号>/before/cx-measure.txt` のようなファイルへ保存する。
 *
 * 前提は cli/dist と、テーマのリポジトリで作る slidev build 成果物（`dist/`）。
 * 所要は 6 スライドの Phase 1 変換で 6 秒前後。
 *
 * measure 行は 2 形状ある。
 * カンマ split ではなく、アンカー付き正規表現 1 本で parse する。
 * `algn` / `anchor` / `wrap` は、値自体がカンマを含み得るためだ。
 *
 * 通常形は、`measure '<id>': ` の後に、次の 6 項目をカンマ区切りで並べた行。
 * `matched=N` / `min cx=V` / `suggested min_cx_emu=W` / `algn=A` / `anchor=B` / `wrap=C`。
 *
 * ヒット 0 の形は、`measure '<id>': matched 0` の行。
 *
 * ヒット 0 の spec は cx 欠測として表に出し、差の計算対象にしない。
 *
 * exit code:
 *   0: 全 spec で cx が同値または増加。
 *   1: cx が減少した spec がある。
 *   2: 実行エラー。引数不正・ファイル読み取り失敗・measure 行 0 件・config の parse 不整合を含む。
 *      `--out` の書き込み失敗を含む想定外の例外も同じ。
 *
 * 片側にだけある spec は差を計算できない。
 * そのため別節に出し、exit code には載せない（要判断）。
 * Markdown を先に書き出し、その後で exit code を決める。判定結果は問わない。
 * `--out` 未指定時は、stdout へ書いた後、`process.exitCode` を設定して自然終了する。
 * 書き込み直後に `process.exit` を呼ぶと、パイプ使用時の出力が途中で切れ得るためだ。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { parseOptions } from './lib/args.mjs'
import { formatDelta } from './lib/format.mjs'

const USAGE = 'usage: node compare-cx-measure.mjs <before-measure.txt> <after-measure.txt>'
  + ' [--config <config.yml>] [--out <path>]'

/** `check-cx.mjs --measure` の 1 行。`[INFO]` 前置と行頭空白を許容する。 */
const MEASURE_PATTERN
  = /^\s*(?:\[[A-Z]+\]\s*)?measure '(.*)': (?:matched 0|matched=(\d+), min cx=(\d+), suggested min_cx_emu=(\d+), algn=(.*), anchor=(.*), wrap=(.*))$/

/** `--opt value` と `--opt=value` の両方を受け付ける引数解析。 */
function parseArgs(argv) {
  const { positional, values } = parseOptions(argv, { valued: ['--config', '--out'] })
  const options = { config: values['--config'], out: values['--out'] }
  if (positional.length !== 2) {
    throw new Error(`位置引数は before / after の 2 つ: ${positional.length} 個を受け取った`)
  }
  return { beforePath: positional[0], afterPath: positional[1], options }
}

/** measure 出力から spec id → 測定値の Map を作る。同じ id が複数あれば後勝ち。 */
export function parseMeasure(text) {
  const specs = new Map()
  for (const line of text.split('\n')) {
    const matched = MEASURE_PATTERN.exec(line)
    if (matched === null) continue
    const [, id, count, cx, suggested, algn, anchor, wrap] = matched
    specs.set(id, count === undefined
      ? { id, matched: 0, cx: undefined, suggested: undefined, algn: undefined, anchor: undefined, wrap: undefined }
      : {
          id,
          matched: Number(count),
          cx: Number(cx),
          suggested: Number(suggested),
          algn,
          anchor,
          wrap,
        })
  }
  return specs
}

/**
 * `config.yml` から spec id → `min_cx_emu` を行 parse で取り出す。
 * `- id:` と `min_cx_emu:` の 2 キーだけを見て `#` 以降を落とす。
 * 出現順で対応付けるため、両キーの件数が一致しない場合は例外にする。
 */
export function parseConfig(text) {
  const stripComment = (value) => value.replace(/#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
  const ids = [...text.matchAll(/^\s*- id:\s*(.+)$/gm)].map((m) => stripComment(m[1]))
  const mins = [...text.matchAll(/^\s*min_cx_emu:\s*(\d+)/gm)].map((m) => Number(m[1]))
  if (ids.length !== mins.length) {
    throw new Error(`config の \`- id:\` ${ids.length} 件と \`min_cx_emu:\` ${mins.length} 件が一致しない`)
  }
  return new Map(ids.map((id, index) => [id, mins[index]]))
}

/** min_cx_emu に対する余裕を `+247174 (5.26%)` 形式にする。min が 0 は比率が無意味なため欠測扱い。 */
function formatMargin(cx, min) {
  if (cx === undefined || min === undefined || min === 0) return '-'
  const margin = cx - min
  const ratio = (margin / min) * 100
  return `${margin >= 0 ? '+' : ''}${margin} (${ratio.toFixed(2)}%)`
}

function formatShape(spec) {
  if (spec === undefined || spec.algn === undefined) return '-'
  return `${spec.algn}/${spec.anchor}/${spec.wrap}`
}

async function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n${USAGE}\n`)
    process.exitCode = 2
    return
  }
  const { beforePath, afterPath, options } = parsed

  let beforeSpecs
  let afterSpecs
  let config
  try {
    beforeSpecs = parseMeasure(await readFile(beforePath, 'utf8'))
    afterSpecs = parseMeasure(await readFile(afterPath, 'utf8'))
    if (beforeSpecs.size === 0 || afterSpecs.size === 0) {
      throw new Error(`measure 行が見つかりません (before ${beforeSpecs.size} 件 / after ${afterSpecs.size} 件)`)
    }
    config = options.config === undefined
      ? undefined
      : parseConfig(await readFile(options.config, 'utf8'))
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`)
    process.exitCode = 2
    return
  }

  const commonIds = [...beforeSpecs.keys()].filter((id) => afterSpecs.has(id))
  const onlyBefore = [...beforeSpecs.keys()].filter((id) => !afterSpecs.has(id))
  const onlyAfter = [...afterSpecs.keys()].filter((id) => !beforeSpecs.has(id))

  let decreased = 0
  let missing = 0
  const rows = []
  for (const id of commonIds) {
    const before = beforeSpecs.get(id)
    const after = afterSpecs.get(id)
    const comparable = before.cx !== undefined && after.cx !== undefined
    if (!comparable) missing += 1
    if (comparable && after.cx < before.cx) decreased += 1
    rows.push({ id, before, after, comparable })
  }

  const lines = []
  const write = (line = '') => lines.push(line)
  write(`# cx 計測比較: ${basename(beforePath)} → ${basename(afterPath)}`)
  write()
  write(`- before: \`${beforePath}\``)
  write(`- after: \`${afterPath}\``)
  if (options.config !== undefined) write(`- config: \`${options.config}\``)
  write()
  write('## 判定')
  write()
  write(decreased === 0 ? '結果: PASS（cx が減少した spec なし）' : `結果: FAIL（${decreased} spec で cx が減少）`)
  write()
  write(`- spec 数: before ${beforeSpecs.size} / after ${afterSpecs.size}`
    + `（両側 ${commonIds.length} / before 固有 ${onlyBefore.length} / after 固有 ${onlyAfter.length}）`)
  write(`- cx 減少: ${decreased} 件`)
  write(`- cx 欠測（matched 0）: ${missing} 件`)
  if (config !== undefined) write(`- config の spec 数: ${config.size}`)
  write()
  write('## spec 別')
  write()
  const header = config === undefined
    ? '| spec | before cx | after cx | 差 | matched b/a | algn/anchor/wrap |'
    : '| spec | before cx | after cx | 差 | min_cx_emu | 余裕 | matched b/a | algn/anchor/wrap |'
  const separator = config === undefined
    ? '|---|---:|---:|---:|---|---|'
    : '|---|---:|---:|---:|---:|---|---|---|'
  write(header)
  write(separator)
  for (const row of rows) {
    const beforeCx = row.before.cx === undefined ? '(matched 0)' : String(row.before.cx)
    const afterCx = row.after.cx === undefined ? '(matched 0)' : String(row.after.cx)
    const delta = row.comparable ? formatDelta(row.before.cx, row.after.cx) : '-'
    const shape = formatShape(row.before) === formatShape(row.after)
      ? `同一 (${formatShape(row.after)})`
      : `${formatShape(row.before)} → ${formatShape(row.after)}`
    const cells = [row.id, beforeCx, afterCx, delta]
    if (config !== undefined) {
      const min = config.get(row.id)
      cells.push(min === undefined ? '-' : String(min))
      cells.push(formatMargin(row.after.cx ?? row.before.cx, min))
    }
    cells.push(`${row.before.matched}/${row.after.matched}`, shape)
    write(`| ${cells.join(' | ')} |`)
  }
  write()
  write('## 片側にだけある spec')
  write()
  if (onlyBefore.length === 0 && onlyAfter.length === 0) {
    write('なし。')
  } else {
    write('差を計算できないため exit code には載せない（要判断）。')
    write()
    for (const id of onlyBefore) write(`- before 固有: \`${id}\``)
    for (const id of onlyAfter) write(`- after 固有: \`${id}\``)
  }
  write()

  const markdown = `${lines.join('\n')}\n`
  if (options.out === undefined) {
    process.stdout.write(markdown)
  } else {
    await writeFile(options.out, markdown, 'utf8')
    process.stderr.write(`written: ${options.out}\n`)
  }
  process.exitCode = decreased === 0 ? 0 : 1
}

try {
  await main()
} catch (error) {
  process.stderr.write(`ERROR: 想定外のエラー: ${error.message}\n`)
  process.exitCode = 2
}
