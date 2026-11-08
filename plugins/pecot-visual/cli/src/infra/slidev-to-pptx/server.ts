// 旧 lib 由来の dist HTTP server / SPA fallback の構造を踏襲する。
/* eslint-disable unicorn/name-replacements, unicorn/import-style, unicorn/no-negated-condition */
/* eslint-disable security/detect-non-literal-fs-filename */
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve as resolvePath, sep } from 'node:path'

import * as mimeTypes from 'mime-types'

const lookup = mimeTypes.lookup.bind(mimeTypes)

export const LOOPBACK_HOST = '127.0.0.1'

/**
dist 配信サーバが実際に bind したポートを解決する。
listen 後の `address()` が AddressInfo を返せば、その port を使う。
返さない場合 (address() が null / パイプ名を返す stub 等) は、要求ポートへフォールバックする。
要求ポートが 0 (ephemeral) のまま実ポートを取れないときは throw する。
`http://127.0.0.1:0` という到達不能な baseUrl を組ませないため。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Server は mutable 型
export function resolveBoundPort(server: Server, fallbackPort: number): number {
  const address = server.address()
  if (address !== null && typeof address === 'object') return address.port
  if (fallbackPort === 0) {
    throw new Error('dist 配信サーバの bind ポートを解決できません (address() が AddressInfo を返さず、要求ポートも 0 (ephemeral))')
  }
  return fallbackPort
}

/**
Slidev dist/ ディレクトリを配信する HTTP サーバーを起動する。
routerMode: history のデッキではスライド URL がパス (/2, /5/3 等) になる。
そのため拡張子を持たないパスは、index.html を返してクライアントサイドルータに委譲する。
routerMode: hash のデッキはスライド番号がフラグメントに載り、サーバーには常に / だけが要求される。
*/
export function startServer(distDir: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, res) => {
      void (async () => {
        const urlPath = (request.url ?? '/').split('?', 1)[0]
        const safePath = urlPath ?? '/'
        const root = resolvePath(distDir)
        const filePath = resolvePath(root, '.' + (safePath === '/' ? '/index.html' : safePath))
        // `..` を含む要求で dist の外を読ませない。dist 自身を指す要求 (`/.` など) も同じ判定で 404 にする
        if (!filePath.startsWith(root + sep)) {
          res.writeHead(404)
          res.end('Not found')
          return
        }

        try {
          const content = await readFile(filePath)
          const contentType = lookup(filePath) || 'application/octet-stream'
          res.writeHead(200, { 'Content-Type': contentType })
          res.end(content)
        }
        catch {
          if (!safePath.includes('.')) {
            try {
              const indexContent = await readFile(join(distDir, 'index.html'))
              res.writeHead(200, { 'Content-Type': 'text/html' })
              res.end(indexContent)
            }
            catch {
              res.writeHead(404)
              res.end('Not found')
            }
          }
          else {
            res.writeHead(404)
            res.end('Not found')
          }
        }
      })()
    })

    // listen 失敗 (EADDRINUSE 等) は reject で呼び出し元へ返す。
    // error ハンドラが無いと、プロセスに uncaughtException リスナーが居る環境では例外が吸われる。
    // リスナーは dom-to-pptx の Emscripten ランタイムが登録する。
    // すると Promise は永遠に pending のままになり、CLI が無限ハングする。
    server.once('error', reject)
    // ループバックだけで待ち受け、同じネットワークの他の端末から届かないようにする
    server.listen(port, LOOPBACK_HOST, () => {
      // listen 成功後は Promise が settled 済みで reject が無効になる。
      // そのため reject リスナーを外し、stderr 出力へ差し替える。
      // 以後のサーバエラー (配信中の socket error 等) は通知なしで捨てず、変換ログから観測できるようにする。
      server.removeListener('error', reject)
      server.on('error', (error: Readonly<Error>) => {
        console.error(`dist 配信サーバ error: ${error.message}`)
      })
      // 起動ログは呼び出し元 (pipeline.ts) が logger 経由で出す。ここで console.log すると
      // `slide convert --json` の stdout (JSON 行専用) に混在する。
      resolve(server)
    })
  })
}
/* eslint-enable unicorn/name-replacements, unicorn/import-style, unicorn/no-negated-condition */
/* eslint-enable security/detect-non-literal-fs-filename */
