// カレントリポの origin と同じ host・owner を持つ設定ファイルを、兄弟リポの .pecot/config/projects/ から探す。
// 出力の行と対処は、w-onboarding の SKILL.md の Step 1 にある
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// 既定の sort と同じ UTF-16 の符号単位の順
const byCodeUnit = (a, b) => (a < b ? -1 : Number(a > b))

// git remote origin URL から host と owner を抽出
let origin
try {
  origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}
catch {
  console.log('ERROR: origin URL を取得できませんでした')
  process.exit(1)
}
// git-clone の GIT URLS の 2 形式（スキーム付き・scp 形式）。host は userinfo とポートの外に取る
// eslint-disable-next-line security/detect-unsafe-regex -- 1 行の origin に当てる。各群は区切りの記号を含まず、再試行は長さに比例して増えない
const m = origin.match(/^(?:https?|ssh|git|ftps?):\/\/(?:[^/@]+@)?([^/:@]+)(?::\d+)?\/([^/~][^/]*)\/([^/]+?)(?:\.git)?\/?$/)
  // eslint-disable-next-line security/detect-unsafe-regex -- 同上
  || origin.match(/^(?![A-Za-z]:)(?:[^@/:]+@)?([^/:@]+):\/?([^/~][^/]*)\/([^/]+?)(?:\.git)?\/?$/)
if (!m) {
  console.log('ERROR: origin URL を解析できませんでした:', origin)
  process.exit(1)
}
const host = m[1]
const owner = m[2]

// 兄弟リポの設定ファイルを走査して host/owner が一致するものを列挙
const matches = []
let siblings
try {
  siblings = fs.readdirSync('..').toSorted(byCodeUnit)
}
catch {
  console.log('ERROR: 親ディレクトリを読めませんでした')
  process.exit(1)
}
for (const sibling of siblings) {
  const directory = path.join('..', sibling, '.pecot', 'config', 'projects')
  let names
  try {
    names = fs.readdirSync(directory).filter(n => n.endsWith('.json')).toSorted(byCodeUnit)
  }
  catch {
    continue
  }
  for (const name of names) {
    const file = path.join(directory, name)
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (config.host === host && config.owner === owner) matches.push(file)
    }
    catch {
      // 解析できない JSON は読み飛ばす
    }
  }
}

if (matches.length === 0) {
  console.log('兄弟リポに一致する設定ファイルが見つかりませんでした')
}
else if (matches.length === 1) {
  console.log(`MATCH: ${matches[0]}`)
}
else {
  console.log('複数見つかりました（AskUserQuestion で選択）:')
  for (const p of matches) console.log(`  ${p}`)
}
