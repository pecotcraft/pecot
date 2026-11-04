// CUJ: draw.io の embed が init を送った後に Node 側の handshake 設置が遅れても、SVG が書き出せる。
//
// 守る対象は src/infra/drawio/screenshot.ts の exportViaEmbed。embed.diagrams.net は init を再送しない。
// iframe の読み込みを始めてから message の listener を付けると、その間に届いた init を取りこぼす。
// すると export の応答が来ないまま 60 秒待って、時間切れになる。
// 実 embed では、init が setContent の約 3 秒後に届く（.pecot/work/1225/fix/race.mjs で計測）。
// listener を先に付けてから読み込みを始める形に直したことを、実 Chromium で固定する。
//
// embed は外部サービスなので使わない。
// embed.diagrams.net の URL を、playwright の route で、ローカルの HTML に差し替える。
// この HTML は、同じ protocol（init → load → export）を即座に返す。
// 差し替えにより init は iframe の読み込み直後に届く。
// そのため handshake の設置を 4 秒遅らせれば、旧実装では確実に取りこぼす。
// 外部ネットワークには出ない。

import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isChromiumCached } from '../_helpers/pecotv-e2e-run.js'

const EMBED_URL_PATTERN = 'https://embed.diagrams.net/**'
const HANDSHAKE_DELAY_MS = 4000
// 旧実装は取りこぼして 60 秒待つ。それより十分手前で失敗にする。
const TEST_TIMEOUT_MS = 30_000
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'

// init を即座に送り、load → export の action に応える最小の embed。
const FAKE_EMBED_HTML = `<!doctype html><html><body><script>
const send = (message) => parent.postMessage(JSON.stringify(message), '*')
addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.action === 'load') send({ event: 'load' })
  else if (message.action === 'export') {
    send({ event: 'export', data: 'data:image/svg+xml;base64,' + btoa(${JSON.stringify(SVG)}) })
  }
})
send({ event: 'init' })
</script></body></html>`

const launchedBrowsers: Browser[] = []

afterEach(async () => {
  vi.doUnmock('../../src/infra/playwright/launch.js')
  vi.resetModules()
  for (const browser of launchedBrowsers.splice(0)) await browser.close()
})

/**
実 Chromium を起動し、embed をローカルの偽物に差し替え、setContent の完了後に Node 側を止める。
*/
function mockLaunchWithSlowHandshake(): void {
  vi.doMock('../../src/infra/playwright/launch.js', () => ({
    launchChromium: async (): Promise<Browser> => {
      const browser = await chromium.launch({ headless: true })
      launchedBrowsers.push(browser)
      const newPage = browser.newPage.bind(browser)
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Playwright の型に従う
      browser.newPage = async (...arguments_: Parameters<Browser['newPage']>): Promise<Page> => {
        const page = await newPage(...arguments_)
        await page.route(EMBED_URL_PATTERN, async (route) => {
          await route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_EMBED_HTML })
        })
        const setContent = page.setContent.bind(page)
        // setContent が返ってから handshake を設置する page.evaluate に進むまでの間に、Node 側が止まった状況を作る。
        // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Playwright の型に従う
        page.setContent = async (...contentArguments: Parameters<Page['setContent']>): Promise<void> => {
          await setContent(...contentArguments)
          await new Promise((resolve) => {
            setTimeout(resolve, HANDSHAKE_DELAY_MS)
          })
        }
        return page
      }
      return browser
    },
  }))
}

describe.skipIf(!isChromiumCached())('exportViaEmbed の handshake', () => {
  it('handshake の設置が遅れても、先に届いた init を取りこぼさず SVG を返す', async () => {
    mockLaunchWithSlowHandshake()
    const { exportViaEmbed } = await import('../../src/infra/drawio/screenshot.js')

    const started = performance.now()
    const exported = await exportViaEmbed('<mxfile/>', { format: 'svg' })

    expect(exported.toString('utf8')).toBe(SVG)
    expect(performance.now() - started).toBeLessThan(TEST_TIMEOUT_MS)
  }, TEST_TIMEOUT_MS)
})
