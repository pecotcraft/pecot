// PR に載せる画像だけを持つ、親の無い commit を作り、origin の pecot-attach/<ID> へ送る。
// 引数は画像のパス。一時の index で組むので、作業ツリー・index・HEAD は変えない。送った ID とブランチ名を出す
const { execFileSync } = require('node:child_process')
const { randomInt } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const fail = (message) => {
  console.error(`画像を送れません: ${message}`)
  process.exit(1)
}
const files = process.argv.slice(2)
if (files.length === 0) fail('画像のパスがありません')
const names = new Map()
for (const file of files) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) fail(`ファイルではありません（${file}）`)
  const name = path.basename(file)
  if (names.has(name)) fail(`同じ名前の画像が 2 つあります（${names.get(name)}・${file}）`)
  names.set(name, file)
}

const git = (arguments_, environment = process.env) => {
  try {
    return execFileSync('git', arguments_, { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }
  catch (error) {
    throw new Error(`git ${arguments_[0]} が失敗しました: ${(error.stderr || error.message).trim()}`, { cause: error })
  }
}

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
const id = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('')
const branch = `pecot-attach/${id}`

// 一時の index を finally で消すため、この中では process.exit で止めない
const build = () => {
  const index = path.join(git(['rev-parse', '--absolute-git-dir']), `pecot-attach-${id}.index`)
  const environment = { ...process.env, GIT_INDEX_FILE: index }
  try {
    for (const [name, file] of names) {
      const sha = git(['hash-object', '-w', '--no-filters', '--', file])
      git(['update-index', '--add', '--cacheinfo', `100644,${sha},${name}`], environment)
    }
    return git(['commit-tree', git(['write-tree'], environment), '-m', `pecot-attach ${id} [skip ci]`])
  }
  finally {
    fs.rmSync(index, { force: true })
    fs.rmSync(`${index}.lock`, { force: true })
  }
}

try {
  git(['push', 'origin', `${build()}:refs/heads/${branch}`])
}
catch (error) {
  fail(error.message)
}
console.log(`id=${id}`)
console.log(`branch=${branch}`)
