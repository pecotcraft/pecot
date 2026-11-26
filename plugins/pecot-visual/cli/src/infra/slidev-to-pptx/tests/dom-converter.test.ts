/* eslint-disable unicorn/name-replacements
   -- 対象 API (readSlidesTitle) と 'distDir' 命名は infra 側で確定。
   sanitizeFilename / title 解析の純粋関数検証は domain/slidev-to-pptx/tests/slides-title.test.ts に移設済 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { readSlidesTitle } from '../dom-converter.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('readSlidesTitle', () => {
  const logger = { info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let workDir: string

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pecotv-readSlidesTitle-'))
  })

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  async function writeSlidesMd(content: string): Promise<string> {
    const presDir = path.join(workDir, `pres-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`)
    const distDir = path.join(presDir, 'dist')
    await mkdir(distDir, { recursive: true })
    await writeFile(path.join(presDir, 'slides.md'), content, 'utf8')
    return distDir
  }

  it('frontmatter の title を取得する', async () => {
    await explains('スライドのタイトルを読み取る `readSlidesTitle` のテストです。`slides.md` の frontmatter に `title` がある場合に、その値を返すことを確認します。')
    const distDir = await writeSlidesMd('---\ntitle: Hello World\n---\n\n# Hi')
    expect(await readSlidesTitle(distDir, logger)).toBe('Hello World')
  })

  it('title が引用符で囲まれている場合は、引用符を取り除いて返す', async () => {
    await explains('`slides.md` の frontmatter の `title` が引用符で囲まれている場合のテストです。引用符を取り除いた値（`Quoted Title`）を返すことを確認します。')
    const distDir = await writeSlidesMd('---\ntitle: \'Quoted Title\'\n---\n')
    expect(await readSlidesTitle(distDir, logger)).toBe('Quoted Title')
  })

  it('frontmatter が存在しない場合は、null を返す', async () => {
    await explains('`slides.md` に frontmatter が存在しない場合の、`readSlidesTitle` のテストです。`null` を返すことを確認します。')
    const distDir = await writeSlidesMd('# No frontmatter\n')
    expect(await readSlidesTitle(distDir, logger)).toBeNull()
  })

  it('frontmatter に title が存在しない場合は、null を返す', async () => {
    await explains('`slides.md` の frontmatter に `title` が存在しない場合の、`readSlidesTitle` のテストです。`null` を返すことを確認します。')
    const distDir = await writeSlidesMd('---\ntheme: default\n---\n# Hi')
    expect(await readSlidesTitle(distDir, logger)).toBeNull()
  })

  it('slides.md が存在しない場合は、警告をログに記録して null を返す', async () => {
    await explains('`slides.md` が存在しないディレクトリを渡した場合のテストです。警告を 1 回だけログに記録し、`null` を返すことを確認します。')
    const missingDist = path.join(workDir, 'no-such-dir', 'dist')
    const warn = vi.fn()
    const warnLogger = { ...logger, warn }
    const result = await readSlidesTitle(missingDist, warnLogger)
    expect(result).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
  })
})
/* eslint-enable unicorn/name-replacements */
