#!/usr/bin/env node
/**
 * 2 つのディレクトリにあるページ画像（PNG）を、画素で比べる。
 *
 *   node plugins/pecot-visual/scripts/page-compare/compare-pages.mjs <before-dir> <after-dir> [--out <path>]
 *
 * 両ディレクトリの `<N>.png`（N は整数）を、ファイル名で対応付ける。
 * 片側にしか無いページ、寸法の違うページ、画素の違うページは、別々に列挙する。
 * 許容差は 0。alpha は比べる対象にしない。
 *
 * オプション:
 *   --out <path>   Markdown をファイルへ書く（既定は stdout）。どの判定でも先に書き出す。
 *   `--out=path` の `=` 形式も受け付ける。
 *
 * # 比較の流れ
 *
 * 1. 各ページで、まずファイルの sha256 を比べる。一致したページは decode しない。
 * 2. 不一致のページだけ decode する。chunk の付加情報だけが違う PNG は、ここで画素一致になる。
 * 3. 寸法が違えば寸法違い。同寸なら画素を比べ、差分画素の件数・最初の座標・外接矩形を出す。
 *
 * # exit code
 *
 *   0: 全ページ一致。
 *   1: 差がある。画素差・寸法違い・片側欠けのどれでも 1 になる。
 *   2: 実行エラー。引数不正・ディレクトリ不在・読めない PNG を含む。
 *      対応外の PNG（16 bit・palette・grayscale・インターレース）も 2 になる。
 *
 * Markdown を先に書き出し、その後で exit code を決める。判定結果は問わない。
 * stdout へ書くときは、`process.exitCode` を設定して自然終了する。
 * 書き込み直後に `process.exit` を呼ぶと、パイプ使用時の出力が途中で切れ得るためだ。
 *
 * # non-goal
 *
 * - 依存の追加。Node 組み込みだけを使い、pngjs や pixelmatch は使わない。
 * - 許容差つきの比較と、差分画像の出力。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseOptions } from './lib/args.mjs'
import { comparePixels, sha256Of } from './lib/diff.mjs'
import { decodePng, PngError } from './lib/png.mjs'
import { buildReport } from './lib/report.mjs'
import { isSelfExecuted } from './lib/self-exec.mjs'

const USAGE = 'usage: node compare-pages.mjs <before-dir> <after-dir> [--out <path>]'

/** ディレクトリの `<N>.png` を { ページ番号 → ファイル名 } の Map にする。 */
async function listPages(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    throw new Error(`ディレクトリを読めません: ${dir}（${error.code ?? error.message}）`)
  }
  const pages = new Map()
  for (const name of names) {
    const match = /^(\d+)\.png$/.exec(name)
    if (match !== null) pages.set(Number(match[1]), name)
  }
  return pages
}

async function decodeFile(path) {
  const buffer = await readFile(path)
  try {
    return decodePng(buffer)
  } catch (error) {
    if (error instanceof PngError) throw new Error(`${path}: ${error.message}`)
    throw error
  }
}

async function main() {
  let parsed
  try {
    const { positional, values } = parseOptions(process.argv.slice(2), { valued: ['--out'] })
    if (positional.length !== 2) {
      throw new Error(`位置引数は before / after の 2 つ: ${positional.length} 個を受け取った`)
    }
    parsed = { beforeDir: positional[0], afterDir: positional[1], out: values['--out'] }
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n${USAGE}\n`)
    process.exitCode = 2
    return
  }
  const { beforeDir, afterDir, out } = parsed

  let report
  try {
    const before = await listPages(beforeDir)
    const after = await listPages(afterDir)
    const common = [...before.keys()].filter((n) => after.has(n)).sort((a, b) => a - b)
    const onlyBefore = [...before.keys()].filter((n) => !after.has(n)).sort((a, b) => a - b)
    const onlyAfter = [...after.keys()].filter((n) => !before.has(n)).sort((a, b) => a - b)

    const diffs = []
    for (const page of common) {
      const beforePath = join(beforeDir, before.get(page))
      const afterPath = join(afterDir, after.get(page))
      const [beforeBytes, afterBytes] = await Promise.all([readFile(beforePath), readFile(afterPath)])
      if (sha256Of(beforeBytes) === sha256Of(afterBytes)) continue
      const [a, b] = await Promise.all([decodeFile(beforePath), decodeFile(afterPath)])
      if (a.width !== b.width || a.height !== b.height) {
        diffs.push({
          page,
          dimension: {
            before: { width: a.width, height: a.height },
            after: { width: b.width, height: b.height },
          },
        })
        continue
      }
      const pixels = comparePixels(a, b)
      if (pixels !== null) diffs.push({ page, pixels })
    }
    report = buildReport({
      beforeDir, afterDir, matched: common.length, onlyBefore, onlyAfter, diffs,
    })
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`)
    process.exitCode = 2
    return
  }

  if (out === undefined) {
    process.stdout.write(report.markdown)
  } else {
    await writeFile(out, report.markdown, 'utf8')
    process.stderr.write(`written: ${out}\n`)
  }
  process.exitCode = report.exitCode
}

if (isSelfExecuted(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`ERROR: 想定外のエラー: ${error.message}\n`)
    process.exitCode = 2
  }
}
