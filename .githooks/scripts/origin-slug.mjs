// git の origin の URL (argv[2]) から、GitHub の owner/name を求めて標準出力へ書く。
// 求められないときは何も書かずに終わる。形の確認は呼び出し側が行う。
//
// nx（extract-repo-slug.js）と同じく、URL は new URL() で解析する。
// scp 形式 (git@host:owner/name.git) だけは URL ではないので、別に扱う。
const raw = (process.argv[2] ?? '').trim()

const scp = raw.includes('://') ? null : /^(?:[^@/:]+@)?[^/:]+:(.+)$/.exec(raw)
let path = ''
if (scp) {
  path = scp[1]
} else {
  try {
    path = new URL(raw).pathname
  } catch {
    process.exit(0)
  }
}

const trimSlashes = (s) => s.replace(/^\/+|\/+$/g, '')
process.stdout.write(trimSlashes(trimSlashes(path).replace(/\.git$/, '')))
