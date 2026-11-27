/* eslint-disable unicorn/name-replacements -- test fixture */
import { request, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { resolveBoundPort, startServer } from '../server.js'
import { explains } from '../../../../tests/_helpers/explains.js'

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

  it('ルート（/）にアクセスすると、index.html を text/html で返す', async () => {
    await explains('スライドの配信用サーバー `startServer` のテストです。ルート（`/`）へアクセスすると、`index.html` の内容を `text/html` で返すことを確認します。')
    port = 39_001
    server = await startServer(distDir, port, silentLogger)
    const r = await fetchText(port, '/')
    expect(r.status).toBe(200)
    expect(r.text).toContain('index')
    expect(r.contentType).toContain('text/html')
  })

  it('存在するファイルには、拡張子に応じた Content-Type を付けて返す', async () => {
    await explains('`.js` と `.css` のファイルを要求した場合のテストです。拡張子に応じた `Content-Type`（`javascript` と `css`）が付いて返ることを確認します。')
    port = 39_002
    server = await startServer(distDir, port, silentLogger)
    const js = await fetchText(port, '/main.js')
    expect(js.status).toBe(200)
    expect(js.contentType).toContain('javascript')
    const css = await fetchText(port, '/style.css')
    expect(css.contentType).toContain('css')
  })

  it('クエリ文字列が付いた URL でも、クエリを除いてファイルを返す', async () => {
    await explains('`/main.js?v=2` のようにクエリ文字列が付いた URL を要求した場合に、クエリを取り除いたファイルが返り、ステータスが 200 になることを確認します。')
    port = 39_003
    server = await startServer(distDir, port, silentLogger)
    const r = await fetchText(port, '/main.js?v=2')
    expect(r.status).toBe(200)
  })

  it('拡張子がなく存在しないパスには、index.html を返す', async () => {
    await explains('拡張子がなく、存在しないパス（`/5/3`）を要求した場合のテストです。SPA のルーティングのために、`index.html` が `text/html` で返ることを確認します。')
    port = 39_004
    server = await startServer(distDir, port, silentLogger)
    const r = await fetchText(port, '/5/3')
    expect(r.status).toBe(200)
    expect(r.text).toContain('index')
    expect(r.contentType).toContain('text/html')
  })

  it('拡張子があり存在しないパスには、404 を返す', async () => {
    await explains('拡張子があり、存在しないファイル（`/missing.png`）を要求した場合に、ステータス 404 と `Not found` を返すことを確認します。')
    port = 39_005
    server = await startServer(distDir, port, silentLogger)
    const r = await fetchText(port, '/missing.png')
    expect(r.status).toBe(404)
    expect(r.text).toBe('Not found')
  })

  it('index.html も存在しない場合は、404 を返す', async () => {
    await explains('配信するディレクトリに `index.html` が存在しない場合のテストです。拡張子のない存在しないパスを要求しても、ステータス 404 を返すことを確認します。')
    const emptyDir = path.join(workDir, 'empty-dist')
    await mkdir(emptyDir, { recursive: true })
    port = 39_006
    server = await startServer(emptyDir, port, silentLogger)
    const r = await fetchText(port, '/whatever')
    expect(r.status).toBe(404)
  })

  it('拡張子から種類を判定できないファイルには、application/octet-stream を付けて返す', async () => {
    await explains('未知の拡張子（`.zzz`）のファイルを要求した場合のテストです。ステータス 200 で、`Content-Type` が `application/octet-stream` になることを確認します。')
    const unknownExtPath = path.join(distDir, 'data.zzz')
    await writeFile(unknownExtPath, 'binary', 'utf8')
    port = 39_007
    server = await startServer(distDir, port, silentLogger)
    const r = await fetchText(port, '/data.zzz')
    expect(r.status).toBe(200)
    expect(r.contentType).toContain('application/octet-stream')
  })

  it('ルートを要求すると、ステータス 200 で応答する', async () => {
    await explains('ルート（`/`）を要求した場合のテストです。ステータス 200 で応答することを確認します。')
    port = 39_008
    server = await startServer(distDir, port, silentLogger)
    // raw socket request で、HTTP/1.0 の URL 無し相当を再現するのは難しい。
    // そのため、root request が動くことだけを確認する。
    // null 合体の既定値 '/' の分岐は、単体で coverage を達成する。
    const r = await fetchText(port, '/')
    expect(r.status).toBe(200)
  })

  it('ポートに 0 を指定した場合は、OS が割り当てた実際のポートで配信し、address() から取得できる', async () => {
    await explains('ポートに 0 を指定して起動した場合のテストです。OS が割り当てた実際のポートが `address()` から取得でき、そのポートでルートにアクセスできることを確認します。')
    server = await startServer(distDir, 0, silentLogger)
    const address = server.address()
    if (address === null || typeof address !== 'object') throw new Error('AddressInfo が取れません')
    expect(address.port).toBeGreaterThan(0)
    const r = await fetchText(address.port, '/')
    expect(r.status).toBe(200)
  })

  it('ポートがすでに使用されている場合は、EADDRINUSE で失敗する', async () => {
    await explains('同じポートで 2 つ目のサーバーを起動する場合のテストです。待ち続けずに、`EADDRINUSE` のエラーで失敗することを確認します。')
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
    await explains('親ディレクトリを指す `..` を含むパスを要求した場合のテストです。配信するディレクトリの外のファイルは返さず、ステータス 404 を返すことを確認します。')
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
    await explains('拡張子がなく `..` を含むパス（`/../../etc`）を要求した場合のテストです。`index.html` を返さず、ステータス 404 を返すことを確認します。')
    server = await startServer(distDir, 0, silentLogger)
    const address = server.address()
    if (address === null || typeof address !== 'object') throw new Error('AddressInfo が取れません')
    const r = await requestRawPath(address.port, '/../../etc')
    expect(r.status).toBe(404)
  })

  it('dist 自身に正規化される要求 (`/.`・`//`) は 404 を返す', async () => {
    await explains('配信するディレクトリ自身を指すパス（`/.`・`/./`・`//`）を要求した場合のテストです。ステータス 404 と `Not found` を返すことを確認します。')
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
    await explains('サーバーの待ち受けアドレスのテストです。ループバックアドレス（`127.0.0.1`）だけで待ち受けることを確認します。')
    server = await startServer(distDir, 0, silentLogger)
    const address = server.address()
    if (address === null || typeof address !== 'object') throw new Error('AddressInfo が取れません')
    expect(address.address).toBe('127.0.0.1')
  })

  it('起動時に console.log へ出力しない', async () => {
    await explains('サーバーを起動した場合のテストです。標準出力を汚さないように、`console.log` が呼ばれないことを確認します。')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ })
    try {
      server = await startServer(distDir, 0, silentLogger)
      expect(spy).not.toHaveBeenCalled()
    }
    finally {
      spy.mockRestore()
    }
  })

  it('サーバーの起動後にエラーが発生した場合は、握りつぶさずに logger.error へ出力する', async () => {
    await explains('起動後のサーバーでエラーが発生する場合のテストです。エラーのメッセージ（`socket boom`）を含む内容が `logger.error` に出力されることを確認します。')
    const logger = { error: vi.fn() }
    server = await startServer(distDir, 0, logger)
    server.emit('error', new Error('socket boom'))
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('socket boom'))
  })
})

describe('resolveBoundPort', () => {
  it('address() がポートを含む場合は、そのポートを返す', async () => {
    await explains('実際のポートを求める `resolveBoundPort` のテストです。`address()` がポート（45678）を含む場合に、要求したポートではなくそのポートを返すことを確認します。')
    const fake = { address: () => ({ port: 45_678, address: '127.0.0.1', family: 'IPv4' }) } as unknown as Server
    expect(resolveBoundPort(fake, 4001)).toBe(45_678)
  })

  it('address() がポートを含まない場合は、要求したポートを返す', async () => {
    await explains('`address()` が `null` を返す場合のテストです。要求したポート（4001）をそのまま返すことを確認します。')
    const fake = { address: () => null } as unknown as Server
    expect(resolveBoundPort(fake, 4001)).toBe(4001)
  })

  it('要求したポートが 0 で、実際のポートも取得できない場合は、例外が発生する', async () => {
    await explains('要求したポートが 0 で、`address()` も `null` を返す場合のテストです。`cannot resolve the bind port of the dist server` を含むメッセージの例外が発生することを確認します。')
    const fake = { address: () => null } as unknown as Server
    expect(() => resolveBoundPort(fake, 0)).toThrow('cannot resolve the bind port of the dist server')
  })
})
