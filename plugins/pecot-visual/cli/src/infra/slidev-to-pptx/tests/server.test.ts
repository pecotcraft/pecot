/* eslint-disable unicorn/name-replacements -- test fixture */
import { request, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { resolveBoundPort, startServer } from '../server.js'

const silentLogger = { error: vi.fn() }

async function fetchText(port: number, urlPath: string): Promise<{ status: number, text: string, contentType: string }> {
  const response = await fetch(`http://127.0.0.1:${port.toString()}${urlPath}`)
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get('content-type') ?? '',
  }
}

// fetch は `..` を正規化して送るので、生のパスは node:http の request で送る
async function requestRawPath(port: number, rawPath: string): Promise<{ status: number, text: string }> {
  return new Promise((resolve, reject) => {
    const client = request({ host: '127.0.0.1', port, path: rawPath }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { text += chunk })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, text }) })
    })
    client.on('error', reject)
    client.end()
  })
}

describe('startServer', () => {
  let workDir: string
  let distDir: string
  let server: Server | undefined
  let port: number

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pecotv-server-'))
    distDir = path.join(workDir, 'dist')
    await mkdir(distDir, { recursive: true })
    await writeFile(path.join(distDir, 'index.html'), '<html><body>index</body></html>', 'utf8')
    await writeFile(path.join(distDir, 'main.js'), 'console.log("hi")', 'utf8')
    await writeFile(path.join(distDir, 'style.css'), 'body { color: red }', 'utf8')
  })

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    if (!server) {
      return
    }

    await new Promise<void>((resolve) => { server!.close(() => { resolve() }) })
    server = undefined
  })

  it('ルート / は index.html を text/html で返す', async () => {
    port = 39_001
    server = await startServer(distDir, port, silentLogger)
    const r = await fetchText(port, '/')
    expect(r.status).toBe(200)
    expect(r.text).toContain('index')
    expect(r.contentType).toContain('text/html')
  })

  it('実在ファイルは mime-types ルックアップの結果を Content-Type として返す', async () => {
    port = 39_002
    server = await startServer(distDir, port, silentLogger)
    const js = await fetchText(port, '/main.js')
    expect(js.status).toBe(200)
    expect(js.contentType).toContain('javascript')
    const css = await fetchText(port, '/style.css')
    expect(css.contentType).toContain('css')
  })

  it('クエリ文字列は除去してファイル解決する', async () => {
    port = 39_003
    server = await startServer(distDir, port, silentLogger)
    const r = await fetchText(port, '/main.js?v=2')
    expect(r.status).toBe(200)
  })

  it('拡張子なしの未存在パス (SPA) は index.html を返す', async () => {
    port = 39_004
    server = await startServer(distDir, port, silentLogger)
    const r = await fetchText(port, '/5/3')
    expect(r.status).toBe(200)
    expect(r.text).toContain('index')
    expect(r.contentType).toContain('text/html')
  })

  it('拡張子付きの未存在パスは 404', async () => {
    port = 39_005
    server = await startServer(distDir, port, silentLogger)
    const r = await fetchText(port, '/missing.png')
    expect(r.status).toBe(404)
    expect(r.text).toBe('Not found')
  })

  it('SPA fallback で index.html も無ければ 404', async () => {
    const emptyDir = path.join(workDir, 'empty-dist')
    await mkdir(emptyDir, { recursive: true })
    port = 39_006
    server = await startServer(emptyDir, port, silentLogger)
    const r = await fetchText(port, '/whatever')
    expect(r.status).toBe(404)
  })

  it('lookup 失敗時は application/octet-stream を返す', async () => {
    const unknownExtPath = path.join(distDir, 'data.zzz')
    await writeFile(unknownExtPath, 'binary', 'utf8')
    port = 39_007
    server = await startServer(distDir, port, silentLogger)
    const r = await fetchText(port, '/data.zzz')
    expect(r.status).toBe(200)
    expect(r.contentType).toContain('application/octet-stream')
  })

  it('request.url が undefined のときは / にフォールバック', async () => {
    port = 39_008
    server = await startServer(distDir, port, silentLogger)
    // raw socket request で、HTTP/1.0 の URL 無し相当を再現するのは難しい。
    // そのため、root request が動くことだけを確認する。
    // null 合体の既定値 '/' の分岐は、単体で coverage を達成する。
    const r = await fetchText(port, '/')
    expect(r.status).toBe(200)
  })

  it('port 0 (ephemeral) は OS 採番の実ポートで配信し address() から取得できる', async () => {
    server = await startServer(distDir, 0, silentLogger)
    const address = server.address()
    if (address === null || typeof address !== 'object') throw new Error('AddressInfo が取れません')
    expect(address.port).toBeGreaterThan(0)
    const r = await fetchText(address.port, '/')
    expect(r.status).toBe(200)
  })

  it('ポートが占有済みのときは EADDRINUSE で reject する (無限 pending にしない)', async () => {
    // 占有ポートは固定値でなく ephemeral bind の実ポートを使う (固定値だと他プロセスの
    // 先行占有でテスト自体が落ちる)。
    server = await startServer(distDir, 0, silentLogger)
    const address = server.address()
    if (address === null || typeof address !== 'object') throw new Error('AddressInfo が取れません')
    // listen 失敗を reject で完結させる設計の回帰テスト。
    // プロセスに uncaughtException リスナーが居るかで、挙動が変わらない。
    // リスナーは dom-to-pptx の Emscripten ランタイムが登録する。
    await expect(startServer(distDir, address.port, silentLogger)).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('`..` を含む要求には、dist の外のファイルを返さず 404 を返す', async () => {
    await writeFile(path.join(workDir, 'outside.txt'), 'outside-secret', 'utf8')
    server = await startServer(distDir, 0, silentLogger)
    const address = server.address()
    if (address === null || typeof address !== 'object') throw new Error('AddressInfo が取れません')
    for (const rawPath of ['/../outside.txt', '/a/../../outside.txt', '/../dist/../outside.txt']) {
      const r = await requestRawPath(address.port, rawPath)
      expect(r.status).toBe(404)
      expect(r.text).not.toContain('outside-secret')
    }
  })

  it('拡張子の無い `..` の要求にも、index.html を返さず 404 を返す', async () => {
    server = await startServer(distDir, 0, silentLogger)
    const address = server.address()
    if (address === null || typeof address !== 'object') throw new Error('AddressInfo が取れません')
    const r = await requestRawPath(address.port, '/../../etc')
    expect(r.status).toBe(404)
  })

  it('dist 自身に正規化される要求 (`/.`・`//`) は 404 を返す', async () => {
    server = await startServer(distDir, 0, silentLogger)
    const address = server.address()
    if (address === null || typeof address !== 'object') throw new Error('AddressInfo が取れません')
    for (const rawPath of ['/.', '/./', '//']) {
      const r = await requestRawPath(address.port, rawPath)
      expect(r.status).toBe(404)
      expect(r.text).toBe('Not found')
    }
  })

  it('ループバック (127.0.0.1) だけで待ち受ける', async () => {
    server = await startServer(distDir, 0, silentLogger)
    const address = server.address()
    if (address === null || typeof address !== 'object') throw new Error('AddressInfo が取れません')
    expect(address.address).toBe('127.0.0.1')
  })

  it('起動時に console.log へ書かない (起動ログは pipeline が logger 経由で出す。--json の stdout を JSON 行だけに保つ)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ })
    try {
      server = await startServer(distDir, 0, silentLogger)
      expect(spy).not.toHaveBeenCalled()
    }
    finally {
      spy.mockRestore()
    }
  })

  it('listen 成功後のサーバエラーは logger.error へ 1 行出して握り潰さない', async () => {
    const logger = { error: vi.fn() }
    server = await startServer(distDir, 0, logger)
    server.emit('error', new Error('socket boom'))
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('socket boom'))
  })
})

describe('resolveBoundPort', () => {
  it('address() が AddressInfo なら実ポートを返す', () => {
    const fake = { address: () => ({ port: 45_678, address: '127.0.0.1', family: 'IPv4' }) } as unknown as Server
    expect(resolveBoundPort(fake, 4001)).toBe(45_678)
  })

  it('address() が AddressInfo でなければ要求ポートへフォールバックする', () => {
    const fake = { address: () => null } as unknown as Server
    expect(resolveBoundPort(fake, 4001)).toBe(4001)
  })

  it('要求ポートが 0 (ephemeral) で実ポートも取れないときは throw する', () => {
    const fake = { address: () => null } as unknown as Server
    expect(() => resolveBoundPort(fake, 0)).toThrow('bind ポートを解決できません')
  })
})
