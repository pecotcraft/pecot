import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attachContent } from '../../src/vitest/attach.js'
import { step, stepSync } from '../../src/vitest/step.js'
import { explains } from '../../src/vitest/explains.js'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..')
// テーマの右の欄が出る幅（xl）より広い 2 つと、スマートフォンの幅。
const WIDE = [1440, 1920] as const
const NARROW = 390
// テーマのテンプレートが出すページで、:notoc: を付けられない。
const NO_NOTOC = new Set(['search.html'])
const TOOL_LIST = 'reference/tools/pecot-workflow-tools.html'
const TOOL_PAGE = '_generated/pecot-workflow/board_add.html'
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
  it('開発版でビルドしたサイトは、フッターと機能要件の表に、テストレポートへのリンクを含む', async () => {
    await explains('開発版でビルドした公開サイトの表示のテストです。ツールのページを開いた場合に、フッターと機能要件の表に、テストレポートへのリンクと、項目の ID で絞り込むリンクが含まれることを確認します。')
    const tab = await step('ページを開く', () => open(WIDE[0], TOOL_PAGE))
    const hrefs = await step('リンクを集める', () => tab.evaluate(() => [...document.querySelectorAll('footer a, table.iface-behaviors a')]
      .map(link => link.getAttribute('href') ?? '')))
    await step('ページを閉じる', async () => {
      await closeTab(tab)
    })
    stepSync('リンクを比べる', () => {
      expect(hrefs).toContain('../../test-report/index.html')
      expect(hrefs.filter(href => href.startsWith('../../test-report/index.html?tags=PW-'))).not.toEqual([])
    })
  })

  it.for(WIDE)('幅 %s px で、目次がないページは、本文が外枠の右端まで広がり、空欄を残さない', async (width) => {
    await explains(`開発版でビルドした公開サイトの表示のテストです。幅 ${String(width)} px で全ページを開いた場合に、目次がないページの本文が外枠の右端まで広がり、右側に空欄が残らないことを確認します。`)
    const gaps: Record<string, number> = {}
    let shot: Shot | undefined
    const pages = site().pages.filter(page => !NO_NOTOC.has(page))
    await step('各ページの余白を測る', async () => {
      for (const page of pages) {
        const tab = await open(width, page)
        const gap = await gapOf(tab)
        shot = await keepShot(shot, tab, page, gap > 2)
        await closeTab(tab)
        if (gap > 2) gaps[page] = gap
      }
    })
    await step('スクリーンショットを添付する', async () => {
      await attachShot(width, shot)
    })
    stepSync('余白を比べる', () => {
      expect(gaps).toEqual({})
    })
  })

  it.for(WIDE)('幅 %s px で、見出しが 2 段以上あるページは、右に目次を表示する', async (width) => {
    await explains(`開発版でビルドした公開サイトの表示のテストです。幅 ${String(width)} px で、見出しが 2 段以上あるページを開いた場合に、右側に目次の欄が表示されることを確認します。`)
    const gaps: Record<string, number> = {}
    await step('各ページの右の余白を測る', async () => {
      for (const page of [TOOL_PAGE, 'genindex.html']) {
        gaps[page] = await rightGap(width, page, page === TOOL_PAGE ? shotName(width, page) : undefined)
      }
    })
    stepSync('目次の出方を比べる', () => {
      expect(Object.values(gaps).every(gap => gap < 0)).toBe(true)
    })
  })

  it.for(WIDE)('幅 %s px で、段落と箇条書きの 1 行は 50rem を超えない', async (width) => {
    await explains(`開発版でビルドした公開サイトの表示のテストです。幅 ${String(width)} px で全ページを開いた場合に、表の外にある段落と箇条書きの幅が、50rem（800 px）を超えないことを確認します。`)
    const widths: Record<string, number> = {}
    let shot: Shot | undefined
    await step('各ページの行幅を測る', async () => {
      for (const page of site().pages) {
        const tab = await open(width, page)
        const widest = await tab.evaluate(() => Math.max(0, ...[...document.querySelectorAll('#content p, #content li')]
          .filter(element => element.closest('table') === null)
          .map(element => element.getBoundingClientRect().width)))
        shot = await keepShot(shot, tab, page, widest > 800 + 1)
        await closeTab(tab)
        if (widest > 800 + 1) widths[page] = Math.round(widest)
      }
    })
    await step('スクリーンショットを添付する', async () => {
      await attachShot(width, shot)
    })
    stepSync('行幅を比べる', () => {
      expect(widths).toEqual({})
    })
  })

  it.for(WIDE)('幅 %s px で、ヘッダーは画面の幅いっぱいに広がり、フッターの中身は真ん中に寄る', async (width) => {
    await explains(`開発版でビルドした公開サイトの表示のテストです。幅 ${String(width)} px でトップページを開いた場合に、ヘッダーの内容が画面の左端から 32 px 以内まで広がり、フッターの内容が左右の余白の等しい真ん中に寄ることを確認します。`)
    const tab = await step('ページを開く', () => open(width, 'index.html'))
    const header = 'header .container:not(.pecot-site-row) a, header .container:not(.pecot-site-row) button'
    const [headerEdges, footerEdges] = await step('ヘッダーとフッターの端を測る', () => tab.evaluate(selectors => selectors.map((selector): [number, number] => {
      const boxes = [...document.querySelectorAll(selector)].map(element => element.getBoundingClientRect()).filter(box => box.width > 0)
      return [Math.min(...boxes.map(box => box.left)), innerWidth - Math.max(...boxes.map(box => box.right))]
    }), [header, 'footer a, footer span'] as const))
    await step('ページを閉じる', async () => {
      await closeTab(tab, shotName(width, 'index.html'))
    })
    stepSync('ヘッダーの幅を比べる', () => {
      expect(Math.max(...headerEdges ?? [Infinity])).toBeLessThanOrEqual(32)
    })
    const [left, right] = footerEdges ?? [0, Infinity]
    stepSync('フッターの寄りを比べる', () => {
      expect(Math.abs(left - right)).toBeLessThanOrEqual(2)
    })
  })

  it('見出しのリンクは、テーマのアイコンで表示し、文字の ¶ を表示しない', async () => {
    await explains('開発版でビルドした公開サイトの表示のテストです。全ページを開いた場合に、見出しのリンクがテーマの SVG アイコンで表示され、文字の `¶` を含まないことを確認します。')
    const broken: Record<string, number> = {}
    let shot: Shot | undefined
    await step('各ページのリンクを調べる', async () => {
      for (const page of site().pages) {
        const tab = await open(WIDE[0], page)
        const count = await tab.evaluate(() => [...document.querySelectorAll('a.headerlink')]
          .filter(link => link.querySelector('svg') === null || link.textContent.includes('¶')).length)
        shot = await keepShot(shot, tab, page, count > 0)
        await closeTab(tab)
        if (count > 0) broken[page] = count
      }
    })
    await step('スクリーンショットを添付する', async () => {
      await attachShot(WIDE[0], shot)
    })
    stepSync('切れたリンクを比べる', () => {
      expect(broken).toEqual({})
    })
  })

  it.for([TOOL_LIST, TOOL_PAGE])('%s の題のリンクは、カーソルを当てる前は非表示で、当てると表示される', async (page) => {
    await explains(`開発版でビルドした公開サイトの表示のテストです。\`${page}\` を開いた場合に、題のリンクのアイコンが、カーソルを当てる前は非表示で、題に当てると表示されることを確認します。`)
    const tab = await step('ページを開く', () => open(WIDE[0], page))
    const visibility = async (): Promise<string> => tab.evaluate(() => {
      const icon = document.querySelector('h1 a.headerlink > svg')
      return icon === null ? 'missing' : getComputedStyle(icon).visibility
    })
    const before = await step('カーソルを当てる前の可視を調べる', () => visibility())
    await step('カーソルを当てる', async () => {
      await tab.hover('h1')
    })
    const after = await step('当てた後の可視を調べる', () => visibility())
    await step('ページを閉じる', async () => {
      await closeTab(tab, shotName(WIDE[0], page))
    })
    stepSync('可視を比べる', () => {
      expect([before, after]).toEqual(['hidden', 'visible'])
    })
  })

  it('幅 390 px で、どのページも横にはみ出さない', async () => {
    await explains('開発版でビルドした公開サイトの表示のテストです。スマートフォンの幅（390 px）で全ページを開いた場合に、どのページも横にはみ出さない（横スクロールが発生しない）ことを確認します。')
    const overflows: Record<string, number> = {}
    let shot: Shot | undefined
    await step('各ページのはみ出しを測る', async () => {
      for (const page of site().pages) {
        const tab = await open(NARROW, page)
        const scrollWidth = await tab.evaluate(() => document.documentElement.scrollWidth)
        shot = await keepShot(shot, tab, page, scrollWidth > NARROW)
        await closeTab(tab)
        if (scrollWidth > NARROW) overflows[page] = scrollWidth
      }
    })
    await step('スクリーンショットを添付する', async () => {
      await attachShot(NARROW, shot)
    })
    stepSync('はみ出しを比べる', () => {
      expect(overflows).toEqual({})
    })
  })
})
