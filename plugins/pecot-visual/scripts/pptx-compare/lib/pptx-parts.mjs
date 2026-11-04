/**
 * pptx（zip）を part 名 → メタ情報の Map に読み出す。
 *
 * cli/dist の `YauzlYazlPptxArchive` を使い、`entries()` を逐次で読む。
 * 1 つの yauzl ZipFile に対する `openReadStream` の並列化は未検証のため、使わない。
 * xml / rels / svg だけ text を保持する。
 * それ以外は、size と sha256 だけ残して Buffer を捨てる。
 * 13 MB 級 deck 2 本で、常駐メモリが数十 MB 増えるのを避けるためだ。
 * 読了後に必ず `close()` する。
 */
import { createHash } from 'node:crypto'

/** text を保持する part の拡張子。 */
const TEXT_PART_PATTERN = /\.(?:xml|rels|svg)$/i

/** part 名が埋め込み書体の実体か。名前でなく sha256 で比較するため区別する。 */
export function isFontPart(name) {
  return name.startsWith('ppt/fonts/')
}

/** part 名がラスタ media（png / jpg 等の非 svg）か。 */
export function isRasterMediaPart(name) {
  return name.startsWith('ppt/media/') && !/\.svg$/i.test(name)
}

/**
 * pptx を読み出す。戻り値は part 名 → { name, size, sha256, text（任意） } の Map（名前昇順）。
 * 読み取りに失敗した場合は例外を投げる（呼び出し側の先頭の mjs が exit 2 に倒す）。
 */
export async function readParts(pptxPath, cli) {
  const archive = new cli.PptxArchive()
  const reader = await archive.read(pptxPath)
  const collected = []
  try {
    for await (const entry of reader.entries()) {
      const buffer = await entry.read()
      const isText = TEXT_PART_PATTERN.test(entry.part)
      collected.push({
        name: entry.part,
        size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        text: isText ? buffer.toString('utf8') : undefined,
      })
    }
  } finally {
    await reader.close()
  }
  collected.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return new Map(collected.map((part) => [part.name, part]))
}
