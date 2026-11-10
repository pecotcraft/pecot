/* eslint-disable unicorn/name-replacements
   -- 対象 API (readSlidesTitle) と 'distDir' 命名は infra 側で確定。
   sanitizeFilename / title 解析の純粋関数検証は domain/slidev-to-pptx/tests/slides-title.test.ts に移設済 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { readSlidesTitle } from '../dom-converter.js'

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
    const distDir = await writeSlidesMd('---\ntitle: Hello World\n---\n\n# Hi')
    expect(await readSlidesTitle(distDir, logger)).toBe('Hello World')
  })

  it('quoted title はクォートを取り除く', async () => {
    const distDir = await writeSlidesMd('---\ntitle: \'Quoted Title\'\n---\n')
    expect(await readSlidesTitle(distDir, logger)).toBe('Quoted Title')
  })

  it('frontmatter が無ければ null を返す', async () => {
    const distDir = await writeSlidesMd('# No frontmatter\n')
    expect(await readSlidesTitle(distDir, logger)).toBeNull()
  })

  it('frontmatter に title が無ければ null を返す', async () => {
    const distDir = await writeSlidesMd('---\ntheme: default\n---\n# Hi')
    expect(await readSlidesTitle(distDir, logger)).toBeNull()
  })

  it('slides.md が存在しなければ logger.warn してから null を返す', async () => {
    const missingDist = path.join(workDir, 'no-such-dir', 'dist')
    const warn = vi.fn()
    const warnLogger = { ...logger, warn }
    const result = await readSlidesTitle(missingDist, warnLogger)
    expect(result).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
  })
})
/* eslint-enable unicorn/name-replacements */
