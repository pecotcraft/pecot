#!/usr/bin/env node
/**
 * 依存更新の前後で pptx を比較する。
 * 非決定差を正規化したうえで、slide 別・deck 全体の指標表と機械判定を Markdown で出す。
 *
 *   node plugins/pecot-visual/scripts/pptx-compare/compare-pptx.mjs <before.pptx> <after.pptx> \
 *
 *     [--all] [--max-list <N>] [--out <path>]
 *
 * オプション:
 *   --all          差分の無い slide も表に載せる（既定は差分のある slide のみ）。
 *   --max-list <N> 列挙の表示上限（既定 40）。判定は常に全件で行い、表示だけを絞る。
 *   --out <path>   Markdown をファイルへ書く（既定は stdout）。どの判定でも先に書き出す。
 *   `--max-list=N` / `--out=path` の `=` 形式も受け付ける。
 *
 * # before の取り方
 *
 * 依存を更新する前の checkout で、対象の Slidev プロジェクトを変換して残す。
 * build は、次のコマンドを `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` を付けて実行する。
 *
 *   ( cd plugins/pecot-visual && pnpm --filter @pecot/pecotv-cli run build )
 *
 * 変換は、次のコマンドで行う。
 *
 *   node plugins/pecot-visual/cli/dist/cli.js slide convert <project-dir> \
 *
 *     --no-cache --out .pecot/work/<Issue 番号>/before/deck.pptx
 *
 * `--no-cache` を付けて、キャッシュを読まずに全 slide を変換する。
 * before / after で project-dir と他のオプションを揃える。
 * 揃えないと、バージョン差と設定差を区別できなくなる。
 *
 * # after の取り方
 *
 * 依存を更新した checkout で、同じ project-dir・同じオプションで変換する。
 * build には、before と同じく `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` を付ける。
 *
 *   ( cd plugins/pecot-visual && pnpm install --frozen-lockfile )
 *
 *   ( cd plugins/pecot-visual && pnpm --filter @pecot/pecotv-cli run build )
 *
 *   node plugins/pecot-visual/cli/dist/cli.js slide convert <project-dir> \
 *
 *     --no-cache --out .pecot/work/<Issue 番号>/after/deck.pptx
 *
 * 変換の所要は、51 slide の deck で 1 回あたり 47 秒前後（#1062 の測定値）。
 *
 * # 判定基準
 *
 * 「判定」節で PASS / FAIL を出すのは、機械判定できる次の 5 項目だけ。
 *
 *   1. before の `a:t` 文字列が after に全て残る（消失 0）。
 *   2. テキストが一致する sp の `xfrm` 差が 0。
 *   3. 対応する slide でテキストあり sp の件数が減らない。
 *   4. 対応する slide で `p:pic` の件数が減らない。
 *   5. before の埋め込み typeface が after に全て残る。
 *
 * slide の対応付けは、part 名の番号（`slide<N>.xml`）で行う。
 * 対応の付かない slide は、判定の対象外にする。
 * 次の項目は、判別力が無いか、可否を機械で決められない。
 * そのため「要判断」の事実として並べる（読者が判断する）。
 * slide 数の増減。`detectPreviewDivergence` の実数。ファイルサイズ比。追加された `a:t`。
 * `p:timing` / `a:highlight` の増加。ラスタ media の相違。after だけの typeface。
 * 埋め込み書体 part の増減。
 *
 * # exit code
 *
 *   0: 機械判定 5 項目が全て PASS。
 *   1: FAIL が 1 つ以上ある。
 *   2: 実行エラー。引数不正・cli/dist 不在・pptx 読み取り失敗・slide XML の parse 失敗を含む。
 *      `--out` の書き込み失敗を含む想定外の例外も同じ。
 *
 * Markdown を先に書き出し、その後で exit code を決める。判定結果は問わない。
 * `--out` 未指定時は、stdout へ書いた後、`process.exitCode` を設定して自然終了する。
 * 書き込み直後に `process.exit` を呼ぶと、パイプ使用時の出力が途中で切れ得るためだ。
 *
 * # cli/dist の解決順
 *
 * 1. 環境変数 `PECOTV_CLI_DIST`（dist ディレクトリの絶対パス）。
 * 2. 既定の `plugins/pecot-visual/cli/dist/`。
 *
 * 解決は `lib/cli-dist.mjs` の 1 か所に閉じている。相対の段数もそこだけが持つ。
 * 本番・テストとも、同じ 1 本の流れを通る。
 * dist が無い場合は、build 手順を stderr に出して exit 2。
 *
 * # non-goal
 *
 * - PowerPoint / LibreOffice でのレンダリング確認（見た目の検証は本スクリプトの対象外）。
 * - 依存の追加。cli/dist と node 組み込みだけを使う。
 *   jszip / fast-xml-parser / js-yaml と、TypeScript の型ストリップ import は使わない。
 *   型ストリップ import とは、`extract-sp.ts` の直接 import を指す。
 * - 既知非決定 media の除外リストを持つこと。ラスタ media の相違は事実として列挙する。
 */
import { writeFile } from 'node:fs/promises'

import { loadCliDist } from './lib/cli-dist.mjs'
import { readParts } from './lib/pptx-parts.mjs'
import { buildFontContext, diffParts } from './lib/normalize.mjs'
import { collectMetrics } from './lib/metrics.mjs'
import { buildReport } from './lib/report.mjs'
import { parseOptions } from './lib/args.mjs'

const USAGE = 'usage: node compare-pptx.mjs <before.pptx> <after.pptx>'
  + ' [--all] [--max-list <N>] [--out <path>]'

/** `--opt value` と `--opt=value` の両方を受け付ける引数解析。 */
function parseArgs(argv) {
  const { positional, values, flags } = parseOptions(argv, {
    flags: ['--all'],
    valued: ['--max-list', '--out'],
  })
  const options = { all: flags.has('--all'), maxList: 40, out: values['--out'] }
  if (values['--max-list'] !== undefined) {
    const value = Number(values['--max-list'])
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`--max-list には 1 以上の整数を指定する: ${value}`)
    }
    options.maxList = value
  }
  if (positional.length !== 2) {
    throw new Error(`位置引数は before / after の 2 つ: ${positional.length} 個を受け取った`)
  }
  return { beforePath: positional[0], afterPath: positional[1], options }
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

  let cli
  try {
    cli = await loadCliDist()
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`)
    process.exitCode = 2
    return
  }

  let beforeParts
  let afterParts
  try {
    beforeParts = await readParts(beforePath, cli)
    afterParts = await readParts(afterPath, cli)
  } catch (error) {
    process.stderr.write(`ERROR: pptx の読み取りに失敗: ${error.message}\n`)
    process.exitCode = 2
    return
  }

  const beforeFonts = buildFontContext(beforeParts)
  const afterFonts = buildFontContext(afterParts)

  let before
  let after
  try {
    before = collectMetrics(beforePath, beforeParts, cli, beforeFonts)
    after = collectMetrics(afterPath, afterParts, cli, afterFonts)
  } catch (error) {
    process.stderr.write(`ERROR: 指標の抽出に失敗: ${error.message}\n`)
    process.exitCode = 2
    return
  }

  const partDiff = diffParts(beforeParts, afterParts, beforeFonts, afterFonts)
  const report = buildReport({
    beforePath,
    afterPath,
    before,
    after,
    partDiff,
    showAll: options.all,
    maxList: options.maxList,
  })

  if (options.out === undefined) {
    process.stdout.write(report.markdown)
  } else {
    await writeFile(options.out, report.markdown, 'utf8')
    process.stderr.write(`written: ${options.out}\n`)
  }
  process.exitCode = report.exitCode
}

try {
  await main()
} catch (error) {
  process.stderr.write(`ERROR: 想定外のエラー: ${error.message}\n`)
  process.exitCode = 2
}
