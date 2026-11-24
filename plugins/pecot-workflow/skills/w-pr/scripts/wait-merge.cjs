// PR のマージ・クローズ・コンフリクト・queue からの外れを待ち、その語を 1 行出す。
// 引数は PR の URL と、任意の間隔・上限（秒）。queue の状態は gh pr view に無いので GraphQL で読む
const { execFile } = require('node:child_process')
const fail = (message) => {
  console.error(`待ち受けを続けられません: ${message}`)
  process.exit(1)
}
const [url = '', intervalArgument, limitArgument] = process.argv.slice(2)
const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/u.exec(url)
if (match === null) fail(`PR の URL ではありません（${url}）`)
const [, host, owner, repository, number] = match
const seconds = (value, fallback, name) => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${name}が正の数ではありません（${value}）`)
  return parsed
}
const interval = seconds(intervalArgument, 60, '間隔')
const limit = seconds(limitArgument, 1500, '上限')
const MAX_FAILURES = 3
const query = 'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { state mergeable isInMergeQueue } } }'

const read = () => new Promise((resolve, reject) => {
  const arguments_ = ['api', '--hostname', host, 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repo=${repository}`, '-F', `number=${number}`]
  execFile('gh', arguments_, { timeout: 60_000 }, (error, stdout, stderr) => {
    if (error) return reject(new Error((stderr || error.message).trim()))
    try {
      const pullRequest = JSON.parse(stdout).data?.repository?.pullRequest
      if (pullRequest === undefined || pullRequest === null) return reject(new Error(`PR を読めません（${url}）`))
      resolve(pullRequest)
    }
    catch {
      reject(new Error(`gh の出力を読めません: ${stdout.trim()}`))
    }
  })
})

const judge = (pullRequest, wasQueued) => {
  if (pullRequest.state === 'MERGED' || pullRequest.state === 'CLOSED') return pullRequest.state
  if (pullRequest.mergeable === 'CONFLICTING') return 'CONFLICTING'
  if (wasQueued && !pullRequest.isInMergeQueue) return 'DEQUEUED'
  return
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const main = async () => {
  const deadline = Date.now() + limit * 1000
  let failures = 0
  let wasQueued = false
  for (;;) {
    try {
      const pullRequest = await read()
      failures = 0
      const word = judge(pullRequest, wasQueued)
      if (word !== undefined) return console.log(word)
      wasQueued = pullRequest.isInMergeQueue === true
    }
    catch (error) {
      failures += 1
      if (failures >= MAX_FAILURES) fail(error.message)
    }
    const rest = deadline - Date.now()
    if (rest <= 0) return console.log('TIMEOUT')
    await sleep(Math.min(interval * 1000, rest))
  }
}

main()
