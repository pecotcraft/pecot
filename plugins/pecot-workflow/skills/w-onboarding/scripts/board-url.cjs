// アクティブなプロジェクトの設定から、ボードの URL を 1 行で出す。
// 読めないときは、理由を stderr に出して終了コード 1 で止まる
const fs = require('node:fs')
const path = require('node:path')

const fail = (message) => {
  console.error(message)
  process.exit(1)
}
const active = path.resolve('.pecot/config/projects/.active')
let target
try {
  target = path.resolve(path.dirname(active), fs.readFileSync(active, 'utf8').trim())
}
catch {
  fail('アクティブなプロジェクトの指定を読めません: ' + active)
}
let url
try {
  url = (JSON.parse(fs.readFileSync(target, 'utf8')).project || {}).board_url
}
catch {
  fail('プロジェクト設定を読めません（ファイルが無い、または JSON として読めません）: ' + target)
}
if (typeof url !== 'string' || url === '') fail('project.board_url がありません: ' + target)
console.log(url)
