import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attachContent } from '../../src/vitest/attach.js'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..')
// テーマの右の欄が出る幅（xl）より広い 2 つと、スマートフォンの幅。
const WIDE = [1440, 1920] as const
const NARROW = 390
// テーマのテンプレートが出すページで、:notoc: を付けられない。
const NO_NOTOC = new Set(['search.html'])
const TOOL_LIST = 'reference/tools/pecot-workflow-tools.html'
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
  // 開発版で作り、版の知らせとテストレポートへのリンクが入ったページを測る。
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PECOT_SITE_'))),
    PECOT_SITE_SIDE: 'dev',
  }
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

function shotName(width: number, page: string): string {
  return `幅 ${String(width)} px の ${page}`
}

async function screenshot(tab: Page): Promise<Buffer> {
  return tab.screenshot({ fullPage: true, animations: 'disabled' })
}

// shot を渡すと、閉じる前に測った画面を撮って、その名前で添付する。
async function closeTab(tab: Page, shot?: string): Promise<void> {
  if (shot !== undefined) await attachContent(shot, await screenshot(tab), '.png')
  await tab.close()
}

interface Shot {
  readonly page: string
  readonly png: Buffer
  readonly isViolated: boolean
}

// 全ページを回すケースの 1 枚。違反した最初のページを、無ければ index.html を、測った tab から撮る。
async function keepShot(shot: Shot | undefined, tab: Page, page: string, isViolated: boolean): Promise<Shot | undefined> {
  const isKept = shot?.isViolated === true || (!isViolated && page !== 'index.html')
  return isKept ? shot : { page, png: await screenshot(tab), isViolated }
}

async function attachShot(width: number, shot: Shot | undefined): Promise<void> {
  if (shot !== undefined) await attachContent(shotName(width, shot.page), shot.png, '.png')
}

// 目次の無いページは、本文の右端から本文の外枠の内側の右端までの空き（px）。目次のあるページは、欄の幅を負の値で返す。
async function gapOf(tab: Page): Promise<number> {
  return tab.evaluate(() => {
    const sidebar = document.querySelector('#right-sidebar')
    if (sidebar !== null) return -sidebar.getBoundingClientRect().width
    const content = document.querySelector('#content')
    const frame = document.querySelector('main')?.parentElement
    if (content === null || frame === undefined || frame === null) return Infinity
    const inner = frame.getBoundingClientRect().right - Number(getComputedStyle(frame).paddingRight.replace('px', ''))
    return Math.round(inner - content.getBoundingClientRect().right)
  })
}

async function rightGap(width: number, page: string, shot?: string): Promise<number> {
  const tab = await open(width, page)
  const gap = await gapOf(tab)
  await closeTab(tab, shot)
  return gap
}

describe('公開サイトの見た目', () => {
  it('開発版で作ったサイトは、フッターと機能要件の表にテストレポートへのリンクを持つ', async () => {
    const tab = await open(WIDE[0], TOOL_PAGE)
    const hrefs = await tab.evaluate(() => [...document.querySelectorAll('footer a, table.iface-behaviors a')]
      .map(link => link.getAttribute('href') ?? ''))
    await closeTab(tab)
    expect(hrefs).toContain('../../test-report/index.html')
    expect(hrefs.filter(href => href.startsWith('../../test-report/index.html?tags=PW-'))).not.toEqual([])
  })

  it.for(WIDE)('幅 %s px で、目次の無いページは本文が外枠の右端まで広がり、空欄を残さない', async (width) => {
    const gaps: Record<string, number> = {}
    let shot: Shot | undefined
    const pages = site().pages.filter(page => !NO_NOTOC.has(page))
    for (const page of pages) {
      const tab = await open(width, page)
      const gap = await gapOf(tab)
      shot = await keepShot(shot, tab, page, gap > 2)
      await closeTab(tab)
      if (gap > 2) gaps[page] = gap
    }
    await attachShot(width, shot)
    expect(gaps).toEqual({})
  })

  it.for(WIDE)('幅 %s px で、見出しが 2 段以上あるページは右に目次を出す', async (width) => {
    const gaps: Record<string, number> = {}
    for (const page of [TOOL_PAGE, 'genindex.html']) {
      gaps[page] = await rightGap(width, page, page === TOOL_PAGE ? shotName(width, page) : undefined)
    }
    expect(Object.values(gaps).every(gap => gap < 0)).toBe(true)
  })

  it.for(WIDE)('幅 %s px で、段落と箇条書きの 1 行は 50rem を超えない', async (width) => {
    const widths: Record<string, number> = {}
    let shot: Shot | undefined
    for (const page of site().pages) {
      const tab = await open(width, page)
      const widest = await tab.evaluate(() => Math.max(0, ...[...document.querySelectorAll('#content p, #content li')]
        .filter(element => element.closest('table') === null)
        .map(element => element.getBoundingClientRect().width)))
      shot = await keepShot(shot, tab, page, widest > 800 + 1)
      await closeTab(tab)
      if (widest > 800 + 1) widths[page] = Math.round(widest)
    }
    await attachShot(width, shot)
    expect(widths).toEqual({})
  })

  it.for(WIDE)('幅 %s px で、ヘッダーは画面の幅いっぱいに広がり、フッターの中身は真ん中に寄る', async (width) => {
    const tab = await open(width, 'index.html')
    const header = 'header .container:not(.pecot-site-row) a, header .container:not(.pecot-site-row) button'
    const [headerEdges, footerEdges] = await tab.evaluate(selectors => selectors.map((selector): [number, number] => {
      const boxes = [...document.querySelectorAll(selector)].map(element => element.getBoundingClientRect()).filter(box => box.width > 0)
      return [Math.min(...boxes.map(box => box.left)), innerWidth - Math.max(...boxes.map(box => box.right))]
    }), [header, 'footer a, footer span'] as const)
    await closeTab(tab, shotName(width, 'index.html'))
    expect(Math.max(...headerEdges ?? [Infinity])).toBeLessThanOrEqual(32)
    const [left, right] = footerEdges ?? [0, Infinity]
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2)
  })

  it('見出しのリンクはテーマのアイコンで、文字の ¶ を出さない', async () => {
    const broken: Record<string, number> = {}
    let shot: Shot | undefined
    for (const page of site().pages) {
      const tab = await open(WIDE[0], page)
      const count = await tab.evaluate(() => [...document.querySelectorAll('a.headerlink')]
        .filter(link => link.querySelector('svg') === null || link.textContent.includes('¶')).length)
      shot = await keepShot(shot, tab, page, count > 0)
      await closeTab(tab)
      if (count > 0) broken[page] = count
    }
    await attachShot(WIDE[0], shot)
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
    await closeTab(tab, shotName(WIDE[0], page))
    expect([before, after]).toEqual(['hidden', 'visible'])
  })

  it('幅 390 px で、どのページも横にはみ出さない', async () => {
    const overflows: Record<string, number> = {}
    let shot: Shot | undefined
    for (const page of site().pages) {
      const tab = await open(NARROW, page)
      const scrollWidth = await tab.evaluate(() => document.documentElement.scrollWidth)
      shot = await keepShot(shot, tab, page, scrollWidth > NARROW)
      await closeTab(tab)
      if (scrollWidth > NARROW) overflows[page] = scrollWidth
    }
    await attachShot(NARROW, shot)
    expect(overflows).toEqual({})
  })
})
