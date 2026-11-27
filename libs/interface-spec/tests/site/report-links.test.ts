import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LinkType, Stage, Status } from 'allure-js-commons'
import type { TestResult } from 'allure-js-commons'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attachContent } from '../../src/vitest/attach.js'
import { featureStory } from '../../src/vitest/report-labels.js'
import { step, stepSync } from '../../src/vitest/step.js'
import { explains } from '../../src/vitest/explains.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const GENERATE = path.join(REPO_ROOT, '.githooks/scripts/test_report/generate.py')
// generate.py の main() を、一時ディレクトリの root と report-lanes.json で呼ぶ。そろいの判定から allure generate まで、公開と同じ道で作る。
const GENERATE_LOCAL = [
  'import runpy, sys',
  'from pathlib import Path',
  'script, root, lanes, output = sys.argv[1:]',
  'main = runpy.run_path(script)["main"]',
  'sys.exit(main(["generate.py", "--local", "--output", output], root=Path(root), lanes_path=Path(lanes)))',
].join('\n')
const RESULTS = 'sample/test-results/test-unit/allure-results'
// 片方の頭がもう片方と同じ 2 つの ID。research R6 が URL の query を退けた前方の一致を、URL の tags が持たないことを見る。
const TAGGED = [
  { id: 'SM-ONE-02', name: 'SM-ONE-02 を確かめるテスト' },
  { id: 'SM-ONE-021', name: 'SM-ONE-021 を確かめるテスト' },
] as const
const UNTAGGED = 'tag を持たないテスト'
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

interface Report {
  readonly directory: string
  readonly server: Server
  readonly origin: string
  readonly browser: Browser
}

const state: { report?: Report } = {}

function report(): Report {
  if (state.report === undefined) throw new Error('レポートを作っていない')
  return state.report
}

// verifies が残すのと同じ tms のリンクと tag のラベルと、reporter が足す epic・feature・story を持つ結果。
function result(index: number, name: string, id: string | undefined): TestResult {
  const hierarchy = featureStory(id === undefined ? [] : [id], 'sample/tests/sample.test.ts', undefined)
  const start = 1_700_000_000_000 + index * 1000
  return {
    uuid: `00000000-0000-4000-8000-00000000000${String(index)}`,
    historyId: `sample-history-${String(index)}`,
    testCaseId: `sample-case-${String(index)}`,
    name,
    fullName: `tests/sample.test.ts#${name}`,
    status: Status.PASSED,
    statusDetails: {},
    stage: Stage.FINISHED,
    steps: [],
    attachments: [],
    parameters: [],
    start,
    stop: start + 10,
    labels: [
      { name: 'project', value: 'sample' },
      { name: 'lane', value: 'test-unit' },
      { name: 'epic', value: 'sample' },
      { name: 'feature', value: hierarchy.feature },
      { name: 'story', value: hierarchy.story },
      { name: 'suite', value: 'sample.test.ts' },
      ...(id === undefined ? [] : [{ name: 'tag', value: id }]),
    ],
    links: id === undefined ? [] : [{ type: LinkType.TMS, name: id, url: `http://localhost:8000/permalink.html?id=${id}` }],
  }
}

async function respond(directory: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
  const file = path.join(directory, pathname)
  if (!file.startsWith(`${directory}${path.sep}`)) {
    response.writeHead(404).end()
    return
  }
  try {
    const body = await readFile(file)
    response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body)
  }
  catch {
    response.writeHead(404).end()
  }
}

// awesome はデータを fetch で読むので、file:// でなく HTTP で配る。
async function serve(directory: string): Promise<{ server: Server, origin: string }> {
  const server = createServer((request, response) => {
    void respond(directory, request, response)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('サーバのポートを読めない')
  return { server, origin: `http://127.0.0.1:${String(address.port)}` }
}

beforeAll(async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'interface-spec-report-'))
  const results = path.join(directory, RESULTS)
  mkdirSync(results, { recursive: true })
  const tests = [...TAGGED.map(({ id, name }) => ({ id, name })), { id: undefined, name: UNTAGGED }]
  for (const [index, { id, name }] of tests.entries()) {
    const content = result(index, name, id)
    writeFileSync(path.join(results, `${content.uuid}-result.json`), JSON.stringify(content))
  }
  const lanes = path.join(directory, 'report-lanes.json')
  writeFileSync(lanes, JSON.stringify([{ project: 'sample', target: 'test-unit', results: RESULTS }]))
  const output = path.join(directory, 'report')
  execFileSync('python3', ['-c', GENERATE_LOCAL, GENERATE, directory, lanes, output], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const { server, origin } = await serve(output)
  state.report = { directory, server, origin, browser: await chromium.launch() }
})

afterAll(async () => {
  if (state.report === undefined) return
  const { browser, server, directory } = state.report
  await browser.close()
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
  rmSync(directory, { recursive: true, force: true })
})

describe('テストレポートの tag の絞り込み', () => {
  it.for(TAGGED)('URL の tags に $id を渡して開くと、一覧に $id の tag を持つテストだけを表示する', async ({ id, name }) => {
    await explains(`テストレポートの tag による絞り込みのテストです。URL の \`tags\` に \`${id}\` を指定して開いた場合に、一覧に \`${id}\` の tag を持つテストだけが表示され、頭が同じ別の ID のテストは含まれないことを確認します。`)
    const tab = await step('タブを開く', () => report().browser.newPage({ viewport: { width: 1280, height: 720 } }))
    await step('レポートを開く', async () => {
      await tab.goto(`${report().origin}/index.html?tags=${encodeURIComponent(id)}`)
    })
    await step('一覧の表示を待つ', async () => {
      await tab.getByTestId('tree-section').first().waitFor()
    })
    await step('全体を折りたたむ', async () => {
      // 木は 1 段目だけを開いて出る。すべて開いてから、葉のテストの名前を読む。
      await tab.getByTestId('collapse-all-button').click()
    })
    await step('テストの題の表示を待つ', async () => {
      await tab.getByTestId('tree-leaf-title').first().waitFor()
    })
    const titles = await step('題を集める', () => tab.getByTestId('tree-leaf-title').allTextContents())
    await step('画面を添付する', async () => {
      await attachContent(`tags=${id} の一覧`, await tab.screenshot({ fullPage: true, animations: 'disabled' }), '.png')
    })
    await step('タブを閉じる', async () => {
      await tab.close()
    })
    stepSync('題を比べる', () => {
      expect(titles).toEqual([name])
    })
  })
})
