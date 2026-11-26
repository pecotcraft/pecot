/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはテストの一時ディレクトリ配下のみ */
// スキルの scripts/ にあるスクリプトを、一時ディレクトリで実際に動かして結果を確かめる。
// あわせて、スキルの本文がスクリプトを埋め込まず、在るファイルを指していることを確かめる。
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { makeTemporaryDirectory, writeTree } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { pluginRoot, readDocuments, readPluginFile } from './_helpers/documents.js'

function scriptPath(relative: string): string {
  return path.join(pluginRoot, relative)
}

function runScript(relative: string, cwd: string) {
  const result = spawnSync(process.execPath, [scriptPath(relative)], { cwd, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('スキルの本文とスクリプトのファイル', () => {
  it.for([
    { skill: 'skills/w-onboarding/SKILL.md', script: 'scripts/detect-sibling-config.cjs' },
    { skill: 'skills/w-onboarding/SKILL.md', script: 'scripts/board-url.cjs' },
    { skill: 'skills/w-pr/SKILL.md', script: 'scripts/serve-preview.cjs' },
    { skill: 'skills/w-pr/SKILL.md', script: 'scripts/wait-merge.cjs' },
  ])('$skill は、base directory の $script を node で動かすよう書き、そのファイルが在る', ({ skill, script }) => {
    expect(readPluginFile(skill)).toContain(`node <このスキルの base directory>/${script}`)
    const file = path.join(pluginRoot, path.dirname(skill), script)
    expect(existsSync(file)).toBe(true)
  })

  it('スキルとエージェントの本文に、node で動かすスクリプトを埋め込まない', () => {
    const embedded = readDocuments()
      .filter(({ text }) => /node (?:--input-type|--eval|-[ep] |- <<)/u.test(text))
      .map(({ file }) => file)
    expect(embedded).toStrictEqual([])
  })
})

function repositoryWith(files: Readonly<Record<string, string>>): string {
  const directory = makeTemporaryDirectory()
  writeTree(directory, files)
  return directory
}

describe('w-onboarding Step 4 のボード URL の取得', () => {
  const script = 'skills/w-onboarding/scripts/board-url.cjs'
  const url = 'https://github.com/orgs/pecotcraft/projects/1'

  it('相対パスの .active から、ボード URL を 1 行で出す', () => {
    const directory = repositoryWith({
      '.pecot/config/projects/.active': 'p.json\n',
      '.pecot/config/projects/p.json': JSON.stringify({ project: { board_url: url } }),
    })
    expect(runScript(script, directory)).toMatchObject({ status: 0, stdout: `${url}\n` })
  })

  it('絶対パスの .active でも、ボード URL を 1 行で出す', () => {
    const directory = repositoryWith({ '.pecot/config/projects/p.json': JSON.stringify({ project: { board_url: url } }) })
    writeTree(directory, { '.pecot/config/projects/.active': `${path.join(directory, '.pecot/config/projects/p.json')}\n` })
    expect(runScript(script, directory)).toMatchObject({ status: 0, stdout: `${url}\n` })
  })

  it('board_url が無いと、終了コード 1 で止まる', () => {
    const directory = repositoryWith({
      '.pecot/config/projects/.active': 'p.json\n',
      '.pecot/config/projects/p.json': JSON.stringify({ project: {} }),
    })
    const result = runScript(script, directory)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })

  it('.active が無いと、終了コード 1 で止まる', () => {
    const result = runScript(script, repositoryWith({}))
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
  const script = 'skills/w-onboarding/scripts/detect-sibling-config.cjs'

  const mine = JSON.stringify({ host: 'github.com', owner: 'pecotcraft' })
  const other = JSON.stringify({ host: 'github.com', owner: 'other' })
  const https = 'https://github.com/pecotcraft/cur.git'

  it('一致が 1 件だと、MATCH の行でそのパスを出す', () => {
    const { current } = layout(https, { a: mine, b: other })
    expect(runScript(script, current)).toMatchObject({
      status: 0,
      stdout: 'MATCH: ../a/.pecot/config/projects/p.json\n',
    })
  })

  it('一致が 2 件だと、複数見つかった旨と 2 行のパスを出す', () => {
    const { current } = layout(https, { a: mine, b: mine })
    expect(runScript(script, current).stdout).toBe(
      '複数見つかりました（AskUserQuestion で選択）:\n'
      + '  ../a/.pecot/config/projects/p.json\n'
      + '  ../b/.pecot/config/projects/p.json\n',
    )
  })

  it('一致が 0 件だと、見つからなかった旨を出す', () => {
    const { current } = layout(https, { b: other })
    expect(runScript(script, current)).toMatchObject({
      status: 0,
      stdout: '兄弟リポに一致する設定ファイルが見つかりませんでした\n',
    })
  })

  it('ssh の origin でも、一致が 1 件と数える', () => {
    const { current } = layout('git@github.com:pecotcraft/cur.git', { a: mine })
    expect(runScript(script, current).stdout).toBe('MATCH: ../a/.pecot/config/projects/p.json\n')
  })

  it.for([
    'user@github.com:pecotcraft/cur.git',
    'ssh://git@github.com/pecotcraft/cur.git',
    'https://user:tok@github.com:8443/pecotcraft/cur.git',
    'git://github.com/pecotcraft/cur.git',
    'https://github.com/pecotcraft/cur/',
  ])('origin が %s だと、一致が 1 件と数える', (origin) => {
    const { current } = layout(origin, { a: mine })
    expect(runScript(script, current).stdout).toBe('MATCH: ../a/.pecot/config/projects/p.json\n')
  })

  it('別名の origin だと、host が別名になり一致が 0 件になる', () => {
    const { current } = layout('gh-alias:pecotcraft/cur.git', { a: mine })
    expect(runScript(script, current).stdout).toBe('兄弟リポに一致する設定ファイルが見つかりませんでした\n')
  })

  it('シンボリックリンクの兄弟リポも、一致に数える', () => {
    const { parent, current } = layout(https, {})
    const outer = makeTemporaryDirectory()
    writeTree(outer, { '.pecot/config/projects/p.json': mine })
    symlinkSync(outer, path.join(parent, 'lnk'))
    expect(runScript(script, current).stdout).toBe('MATCH: ../lnk/.pecot/config/projects/p.json\n')
  })

  it('解析できない JSON は、一致の数に入れない', () => {
    const { current } = layout(https, { a: mine, broken: '{"host":' })
    expect(runScript(script, current).stdout).toBe('MATCH: ../a/.pecot/config/projects/p.json\n')
  })

  it.for(['foo', 'git@github.com:~pecotcraft/cur.git', 'C:/pecotcraft/cur.git'])('origin が %s だと、解析できない旨の ERROR の行を出して終了コード 1 で止まる', (origin) => {
    const { current } = layout(origin, { a: mine })
    expect(runScript(script, current)).toMatchObject({
      status: 1,
      stdout: `ERROR: origin URL を解析できませんでした: ${origin}\n`,
    })
  })

  it('origin が無いと、取得できない旨の ERROR の行を出して終了コード 1 で止まる', () => {
    const current = makeTemporaryDirectory()
    git(current, 'init', '-q')
    expect(runScript(script, current)).toMatchObject({
      status: 1,
      stdout: 'ERROR: origin URL を取得できませんでした\n',
    })
  })
})

describe('w-pr のプレビューの配信', () => {
  const script = scriptPath('skills/w-pr/scripts/serve-preview.cjs')
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
    server = spawn(process.execPath, [script, '.pecot/work/399', String(port)], { cwd: repository, detached: true, stdio: 'ignore' })
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

  it.for(['70000', '-1', 'abc'])('port が %s だと、立てられない旨を出して終了コード 1 で止まる', (port) => {
    const repository = makeTemporaryDirectory()
    writeTree(repository, { '.pecot/work/399/index.html': '<p>x</p>\n' })
    const result = spawnSync(process.execPath, [script, '.pecot/work/399', port], { cwd: repository, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toBe(`配信を立てられません: port が 0〜65535 の整数ではありません（${port}）\n`)
  })
})

function open(mergeable: string, isInMergeQueue = false) {
  return { state: 'OPEN', mergeable, isInMergeQueue }
}

function parseArguments(line: string): readonly string[] {
  const parsed: unknown = JSON.parse(line)
  return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
}

describe('w-pr のマージの待ち受け', () => {
  const script = scriptPath('skills/w-pr/scripts/wait-merge.cjs')
  const url = 'https://github.com/pecotcraft/pecot-sandbox/pull/12'
  const fakeGh = readFileSync(path.join(import.meta.dirname, 'fixtures/fake-gh.mjs'), 'utf8')

  function waitMerge(responses: readonly unknown[], arguments_: readonly string[] = [url, '0.05', '2']) {
    const bin = makeTemporaryDirectory()
    writeTree(bin, { 'gh': `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-gh.mjs" "$@"\n`, 'fake-gh.mjs': fakeGh, 'responses.json': JSON.stringify(responses) })
    chmodSync(path.join(bin, 'gh'), 0o755)
    const result = spawnSync(process.execPath, [script, ...arguments_], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}` },
    })
    const log = path.join(bin, 'calls.log')
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => parseArguments(line)) : []
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls }
  }

  it.for([
    { name: 'マージされた', responses: [{ state: 'MERGED', mergeable: 'UNKNOWN', isInMergeQueue: false }], word: 'MERGED' },
    { name: 'マージされずに閉じられた', responses: [{ state: 'CLOSED', mergeable: 'MERGEABLE', isInMergeQueue: false }], word: 'CLOSED' },
    { name: 'base とコンフリクトした', responses: [open('CONFLICTING')], word: 'CONFLICTING' },
    { name: 'merge queue から外れて開いたまま', responses: [open('MERGEABLE', true), open('MERGEABLE')], word: 'DEQUEUED' },
  ])('PR が $name なら、$word を 1 行出して終了コード 0 で終わる', ({ responses, word }) => {
    expect(waitMerge(responses)).toMatchObject({ status: 0, stdout: `${word}\n`, stderr: '' })
  })

  it('開いたままの間は待ち続け、マージされたら MERGED を出す', () => {
    const result = waitMerge([open('UNKNOWN'), open('MERGEABLE', true), { state: 'MERGED', mergeable: 'UNKNOWN', isInMergeQueue: false }])
    expect(result).toMatchObject({ status: 0, stdout: 'MERGED\n' })
    expect(result.calls).toHaveLength(3)
  })

  it('開いたまま上限が来ると、TIMEOUT を出して終了コード 0 で終わる', () => {
    const result = waitMerge([open('MERGEABLE')], [url, '0.05', '0.3'])
    expect(result).toMatchObject({ status: 0, stdout: 'TIMEOUT\n' })
    expect(result.calls.length).toBeGreaterThan(1)
  })

  it('PR の URL のホスト・owner・repo・番号で、GraphQL を読む', () => {
    const [call] = waitMerge([{ state: 'MERGED', mergeable: 'UNKNOWN', isInMergeQueue: false }]).calls
    expect(call?.slice(0, 4)).toStrictEqual(['api', '--hostname', 'github.com', 'graphql'])
    expect(call).toEqual(expect.arrayContaining(['owner=pecotcraft', 'repo=pecot-sandbox', 'number=12']))
    expect(call?.find(argument => argument.startsWith('query='))).toContain('isInMergeQueue')
  })

  it('gh が 1 回失敗しても、読み直して続ける', () => {
    expect(waitMerge(['fail', { state: 'MERGED', mergeable: 'UNKNOWN', isInMergeQueue: false }])).toMatchObject({ status: 0, stdout: 'MERGED\n' })
  })

  it('gh が 3 回続けて失敗すると、理由を stderr に出して終了コード 1 で止まる', () => {
    const result = waitMerge(['fail'])
    expect(result).toMatchObject({ status: 1, stdout: '', stderr: '待ち受けを続けられません: HTTP 502\n' })
    expect(result.calls).toHaveLength(3)
  })

  it.for([
    { name: '間隔が 0', arguments_: [url, '0'], message: '間隔が正の数ではありません（0）' },
    { name: '上限が数でない', arguments_: [url, '1', 'abc'], message: '上限が正の数ではありません（abc）' },
    { name: 'URL が PR を指さない', arguments_: ['https://github.com/pecotcraft/pecot-sandbox/issues/12'], message: 'PR の URL ではありません（https://github.com/pecotcraft/pecot-sandbox/issues/12）' },
  ])('$name だと、gh を呼ばずに終了コード 1 で止まる', ({ arguments_, message }) => {
    expect(waitMerge([open('MERGEABLE')], arguments_)).toMatchObject({ status: 1, stdout: '', stderr: `待ち受けを続けられません: ${message}\n`, calls: [] })
  })
})
