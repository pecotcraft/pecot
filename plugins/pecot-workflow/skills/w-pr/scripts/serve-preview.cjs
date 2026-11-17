// PR のスクリーンショット用に、起点のディレクトリを http で静的に配信する。
// 引数は起点と port。立つと `Serving http://127.0.0.1:<port>/` を出す
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const fail = (message) => {
  console.error(`配信を立てられません: ${message}`)
  process.exit(1)
}
const root = path.resolve(process.argv[2])
const port = Number(process.argv[3])
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) fail(`port が 0〜65535 の整数ではありません（${process.argv[3]}）`)
if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) fail(`起点がディレクトリではありません（${root}）`)
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' }
http.createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    if (pathname.includes('\0')) return response.writeHead(400).end()
    const file = path.resolve(root, '.' + pathname)
    if (file !== root && !file.startsWith(root + path.sep)) return response.writeHead(403).end()
    fs.readFile(file, (error, body) => {
      if (error) return response.writeHead(404).end()
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }).end(body)
    })
  }
  catch {
    response.writeHead(400).end()
  }
}).on('error', error => fail(error.message))
  .listen(port, '127.0.0.1', () => console.log(`Serving http://127.0.0.1:${port}/`))
