/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはテストの一時ディレクトリ配下のみ */
// スキル本文から写して打つ bash ブロックを取り出し、一時ディレクトリで実際に流して結果を確かめる。
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { makeTemporaryDirectory, writeTree } from '../../src/tests/_helpers/temporary.js'
import { readPluginFile } from './_helpers/documents.js'

// 見出しの行の後ろ、次の見出しまでにある最初の bash ブロックを返す。
function extractBash(relative: string, heading: string): string {
  const lines = readPluginFile(relative).split('\n')
  const start = lines.indexOf(heading)
  if (start === -1) throw new Error(`見出しがありません: ${relative} ${heading}`)
  const rest = lines.slice(start + 1)
  const body: string[] = []
  let isInBlock = false
  for (const line of rest) {
    if (!isInBlock && line.startsWith('#')) break
    if (!isInBlock && line === '```bash') isInBlock = true
    else if (isInBlock && line === '```') return `${body.join('\n')}\n`
    else if (isInBlock) body.push(line)
  }
  throw new Error(`bash ブロックがありません: ${relative} ${heading}`)
}

function writeScript(directory: string, name: string, script: string): string {
  const file = path.join(directory, name)
  writeFileSync(file, script)
  return file
}

function runBash(script: string, cwd: string) {
  const scriptFile = writeScript(makeTemporaryDirectory(), 'step.sh', script)
  const result = spawnSync('bash', [scriptFile], { cwd, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function repositoryWith(files: Readonly<Record<string, string>>): string {
  const directory = makeTemporaryDirectory()
  writeTree(directory, files)
  return directory
}

describe('w-onboarding Step 4 のボード URL の取得', () => {
  const script = extractBash('skills/w-onboarding/SKILL.md', '### Step 4: 動作確認')
  const url = 'https://github.com/orgs/pecotcraft/projects/1'

  it('相対パスの .active から、ボード URL を 1 行で出す', () => {
    const directory = repositoryWith({
      '.pecot/config/projects/.active': 'p.json\n',
      '.pecot/config/projects/p.json': JSON.stringify({ project: { board_url: url } }),
    })
    expect(runBash(script, directory)).toMatchObject({ status: 0, stdout: `${url}\n` })
  })

  it('絶対パスの .active でも、ボード URL を 1 行で出す', () => {
    const directory = repositoryWith({ '.pecot/config/projects/p.json': JSON.stringify({ project: { board_url: url } }) })
    writeTree(directory, { '.pecot/config/projects/.active': `${path.join(directory, '.pecot/config/projects/p.json')}\n` })
    expect(runBash(script, directory)).toMatchObject({ status: 0, stdout: `${url}\n` })
  })

  it('board_url が無いと、終了コード 1 で止まる', () => {
    const directory = repositoryWith({
      '.pecot/config/projects/.active': 'p.json\n',
      '.pecot/config/projects/p.json': JSON.stringify({ project: {} }),
    })
    const result = runBash(script, directory)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })

  it('.active が無いと、終了コード 1 で止まる', () => {
    const result = runBash(script, repositoryWith({}))
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })
})

function git(cwd: string, ...arguments_: readonly string[]): void {
  const result = spawnSync('git', arguments_, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

// 親ディレクトリの下に、origin を持つ cur と、設定を持つ兄弟を置く。
function layout(origin: string, siblings: Readonly<Record<string, string>>): { parent: string, current: string } {
  const parent = makeTemporaryDirectory()
  const current = path.join(parent, 'cur')
  mkdirSync(current)
  git(current, 'init', '-q')
  git(current, 'remote', 'add', 'origin', origin)
  for (const [name, content] of Object.entries(siblings)) {
    writeTree(parent, { [`${name}/.pecot/config/projects/p.json`]: content })
  }
  return { parent, current }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => {
        resolve(port)
      })
    })
  })
}

async function waitUntilServing(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${String(port)}/`)
      return
    }
    catch {
      await sleep(100)
    }
  }
  throw new Error('配信が立ちませんでした')
}

describe('w-onboarding の兄弟リポの検出', () => {
  const script = extractBash('skills/w-onboarding/references/existing-config-detection.md', '## 2. 兄弟リポに同一プロジェクトの設定あり')

  const mine = JSON.stringify({ host: 'github.com', owner: 'pecotcraft' })
  const other = JSON.stringify({ host: 'github.com', owner: 'other' })
  const https = 'https://github.com/pecotcraft/cur.git'

  it('一致が 1 件だと、MATCH の行でそのパスを出す', () => {
    const { current } = layout(https, { a: mine, b: other })
    expect(runBash(script, current)).toMatchObject({
      status: 0,
      stdout: 'MATCH: ../a/.pecot/config/projects/p.json\n',
    })
  })

  it('一致が 2 件だと、複数見つかった旨と 2 行のパスを出す', () => {
    const { current } = layout(https, { a: mine, b: mine })
    expect(runBash(script, current).stdout).toBe(
      '複数見つかりました（AskUserQuestion で選択）:\n'
      + '  ../a/.pecot/config/projects/p.json\n'
      + '  ../b/.pecot/config/projects/p.json\n',
    )
  })

  it('一致が 0 件だと、見つからなかった旨を出す', () => {
    const { current } = layout(https, { b: other })
    expect(runBash(script, current)).toMatchObject({
      status: 0,
      stdout: '兄弟リポに一致する設定ファイルが見つかりませんでした\n',
    })
  })

  it('ssh の origin でも、一致が 1 件と数える', () => {
    const { current } = layout('git@github.com:pecotcraft/cur.git', { a: mine })
    expect(runBash(script, current).stdout).toBe('MATCH: ../a/.pecot/config/projects/p.json\n')
  })

  it('シンボリックリンクの兄弟リポも、一致に数える', () => {
    const { parent, current } = layout(https, {})
    const outer = makeTemporaryDirectory()
    writeTree(outer, { '.pecot/config/projects/p.json': mine })
    symlinkSync(outer, path.join(parent, 'lnk'))
    expect(runBash(script, current).stdout).toBe('MATCH: ../lnk/.pecot/config/projects/p.json\n')
  })

  it('解析できない JSON は、一致の数に入れない', () => {
    const { current } = layout(https, { a: mine, broken: '{"host":' })
    expect(runBash(script, current).stdout).toBe('MATCH: ../a/.pecot/config/projects/p.json\n')
  })

  it('origin を解析できないと、ERROR の行を出して終了コード 1 で止まる', () => {
    const { current } = layout('foo', { a: mine })
    expect(runBash(script, current)).toMatchObject({
      status: 1,
      stdout: 'ERROR: origin URL を解析できませんでした: foo\n',
    })
  })
})

describe('w-pr のプレビューの配信', () => {
  const script = extractBash('skills/w-pr/SKILL.md', '#### スクリーンショット')
  let server: ChildProcess | undefined

  afterEach(() => {
    if (server?.pid !== undefined) {
      try {
        process.kill(-server.pid)
      }
      catch {
        // すでに止まっている
      }
    }
    server = undefined
  })

  async function serve(): Promise<number> {
    const repository = makeTemporaryDirectory()
    writeTree(repository, { '.pecot/work/399/index.html': '<!doctype html><p>日本語</p>\n', 'secret.txt': 'x' })
    const port = await freePort()
    const filled = script.replaceAll('<Issue番号>', '399').split('<port>').join(String(port))
    const scriptFile = writeScript(makeTemporaryDirectory(), 'serve.sh', filled)
    server = spawn('bash', [scriptFile], { cwd: repository, detached: true, stdio: 'ignore' })
    await waitUntilServing(port)
    return port
  }

  it('.html を text/html で 200 を返す', async () => {
    const port = await serve()
    const response = await fetch(`http://127.0.0.1:${String(port)}/index.html`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('日本語')
  })

  it('..%2f で配信の起点の外を指すと、403 を返す', async () => {
    const port = await serve()
    const response = await fetch(`http://127.0.0.1:${String(port)}/..%2f..%2f..%2fsecret.txt`)
    expect(response.status).toBe(403)
  })

  it('無いパスには、404 を返す', async () => {
    const port = await serve()
    const response = await fetch(`http://127.0.0.1:${String(port)}/nope.html`)
    expect(response.status).toBe(404)
  })

  it('止めると、接続を受け付けなくなる', async () => {
    const port = await serve()
    if (server?.pid !== undefined) process.kill(-server.pid)
    await sleep(300)
    await expect(fetch(`http://127.0.0.1:${String(port)}/index.html`)).rejects.toThrow()
  })
})
