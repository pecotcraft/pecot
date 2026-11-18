import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..')
// テーマの右の欄が出る幅（xl）より広い 2 つと、スマートフォンの幅。
const WIDE = [1440, 1920] as const
const NARROW = 390
// テーマのテンプレートが出すページで、:notoc: を付けられない。
const NO_NOTOC = new Set(['search.html'])
const TOOL_LIST = 'reference/tools/pecot-workflow.html'
const TOOL_PAGE = '_generated/pecot-workflow/board-add.html'
const SKIPPED_DIRECTORIES = new Set(['_static', '_sources', '.doctrees'])

interface Site {
  readonly directory: string
  readonly pages: readonly string[]
  readonly browser: Browser
}

const state: { site?: Site } = {}

function site(): Site {
  if (state.site === undefined) throw new Error('サイトをビルドしていない')
  return state.site
}

function htmlPages(directory: string, prefix: string): string[] {
  const pages: string[] = []
  const entries = readdirSync(directory, { withFileTypes: true })
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
      pages.push(...htmlPages(path.join(directory, entry.name), relative))
    }
    else if (entry.isFile() && entry.name.endsWith('.html')) {
      pages.push(relative)
    }
  }
  return pages
}

beforeAll(async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'interface-spec-site-'))
  // 版の帯の PECOT_SITE_* は、手元の既定の値で作る。
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PECOT_SITE_')))
  execFileSync('uv', ['run', '--locked', '--project', 'docs', 'sphinx-build', '-W', '-q', '-b', 'html', 'docs', directory], {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  // permalink.html は sphinx-needs の転送のページで、テーマの形を持たない。
  const pages = htmlPages(directory, '').filter(page => page !== 'permalink.html').toSorted((a, b) => a.localeCompare(b))
  state.site = { directory, pages, browser: await chromium.launch() }
})

afterAll(async () => {
  if (state.site === undefined) return
  await state.site.browser.close()
  rmSync(state.site.directory, { recursive: true, force: true })
})

async function open(width: number, page: string): Promise<Page> {
  const tab = await site().browser.newPage({ viewport: { width, height: 900 } })
  const file = path.join(site().directory, page)
  await tab.goto(pathToFileURL(file).href)
  return tab
}

// 目次の無いページは、本文の右端からヘッダーの内側の右端までの空き（px）。目次のあるページは、欄の幅を負の値で返す。
async function rightGap(width: number, page: string): Promise<number> {
  const tab = await open(width, page)
  const gap = await tab.evaluate(() => {
    const sidebar = document.querySelector('#right-sidebar')
    if (sidebar !== null) return -sidebar.getBoundingClientRect().width
    const content = document.querySelector('#content')
    const header = document.querySelector('header .container:not(.pecot-site-row)')
    if (content === null || header === null) return Infinity
    const inner = header.getBoundingClientRect().right - Number(getComputedStyle(header).paddingRight.replace('px', ''))
    return Math.round(inner - content.getBoundingClientRect().right)
  })
  await tab.close()
  return gap
}

describe('公開サイトの見た目', () => {
  it.for(WIDE)('幅 %s px で、目次の無いページは本文がヘッダーの右端まで広がり、空欄を残さない', async (width) => {
    const gaps: Record<string, number> = {}
    const pages = site().pages.filter(page => !NO_NOTOC.has(page))
    for (const page of pages) {
      const gap = await rightGap(width, page)
      if (gap > 2) gaps[page] = gap
    }
    expect(gaps).toEqual({})
  })

  it.for(WIDE)('幅 %s px で、見出しが 2 段以上あるページは右に目次を出す', async (width) => {
    const gaps: Record<string, number> = {}
    for (const page of [TOOL_PAGE, 'genindex.html']) gaps[page] = await rightGap(width, page)
    expect(Object.values(gaps).every(gap => gap < 0)).toBe(true)
  })

  it('見出しのリンクはテーマのアイコンで、文字の ¶ を出さない', async () => {
    const broken: Record<string, number> = {}
    for (const page of site().pages) {
      const tab = await open(WIDE[0], page)
      const count = await tab.evaluate(() => [...document.querySelectorAll('a.headerlink')]
        .filter(link => link.querySelector('svg') === null || link.textContent.includes('¶')).length)
      await tab.close()
      if (count > 0) broken[page] = count
    }
    expect(broken).toEqual({})
  })

  it.for([TOOL_LIST, TOOL_PAGE])('%s の題のリンクは、カーソルを当てる前は見えず、当てると見える', async (page) => {
    const tab = await open(WIDE[0], page)
    const visibility = async (): Promise<string> => tab.evaluate(() => {
      const icon = document.querySelector('h1 a.headerlink > svg')
      return icon === null ? 'missing' : getComputedStyle(icon).visibility
    })
    const before = await visibility()
    await tab.hover('h1')
    const after = await visibility()
    await tab.close()
    expect([before, after]).toEqual(['hidden', 'visible'])
  })

  it('幅 390 px で、どのページも横にはみ出さない', async () => {
    const overflows: Record<string, number> = {}
    for (const page of site().pages) {
      const tab = await open(NARROW, page)
      const scrollWidth = await tab.evaluate(() => document.documentElement.scrollWidth)
      await tab.close()
      if (scrollWidth > NARROW) overflows[page] = scrollWidth
    }
    expect(overflows).toEqual({})
  })
})
