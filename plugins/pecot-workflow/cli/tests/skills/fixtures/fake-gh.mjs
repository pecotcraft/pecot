// wait-pr.cjs のテストで gh の代わりに置く。responses.json の応答を呼ばれた順に返し、最後の応答は繰り返す
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const directory = import.meta.dirname
const responses = JSON.parse(readFileSync(path.join(directory, 'responses.json'), 'utf8'))
const counter = path.join(directory, 'count')
const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
writeFileSync(counter, String(count + 1))
appendFileSync(path.join(directory, 'calls.log'), `${JSON.stringify(process.argv.slice(2))}\n`)
const response = responses[Math.min(count, responses.length - 1)]
if (response === 'fail') {
  process.stderr.write('HTTP 502\n')
  process.exitCode = 1
}
else {
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: response } } }))
}
