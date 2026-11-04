// npm audit --json の出力を集計し、例外リストを適用した結果を要約する (#1050 / #1071)。
//
// 配布ツリーと永続層を同じ規則で集計するため、audit-mcp-dist.sh が 1 ツリーにつき 1 回起動する。
// シェルは JSON を解釈しない規約で、jq を前提にしない。
// そのため、判定に要る値は stdout へ 1 フィールド 1 行で返す。
// 記録へ載せる JSON と人が読む一覧は、ファイルへ書く。
//
//   node audit-summary.mjs --audit=<audit.json> --exceptions=<path|空> --label=<表示名>
//
//                          --fingerprint=<hex> --out=<summary.json>
//
//                          [--excepted-out=<txt>] [--blocking-out=<txt>]
//
//     stdout 10 行: status / message / total / critical / high / moderate / low / info /
//
//                   例外適用件数 / blocking 件数
//
//     status が OK 以外のとき、3 行目以降は空行（呼び出し側は監査未実施として中止する）。
//
//   node audit-summary.mjs --audit=<audit.json> --canary=<package>
//
//     stdout 2 行: status (FOUND|MISSING|UNAVAILABLE) / message
//
//     監査先が advisory を実装しているかの確認だけを行う（集計はしない）。
//
// 例外は advisory 単位で、判定を唯一通過させる仕組み。
// 読めない・形が違う例外リストは、「例外なし」に倒さず監査未実施として扱う（fail-closed）。

import { readFileSync, writeFileSync } from 'node:fs'
import { isSelfExecuted } from './self-exec.mjs'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// 低い順。実効 severity は「例外を除いた最大」で決める。
const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical']

const maxSeverity = (a, b) => {
  if (typeof b !== 'string' || !SEVERITY_ORDER.includes(b)) return a
  if (a === null) return b
  return SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a
}

const isBlocking = (severity) => severity === 'high' || severity === 'critical'

// npm の advisory オブジェクトは GHSA id を独立フィールドで持たず、url の末尾にだけ持つ。
// GHSA- 始まりでない末尾（別 advisory DB の id 等）は、比較用のキーにしない。
const advisoryId = (url) => {
  if (typeof url !== 'string') return ''
  const tail = url.split('/').pop() ?? ''
  return tail.startsWith('GHSA-') ? tail : ''
}

/**
 * npm audit --json の出力を読む。監査が成立していない出力（不達・認証失敗等）は
 * { ok: false, message } を返す。message は npm が JSON に書いた理由。
 */
export function parseAuditJson(auditPath) {
  let data = null
  try {
    data = JSON.parse(readFileSync(auditPath, 'utf8'))
  } catch {
    data = null
  }
  const counts = data?.metadata?.vulnerabilities
  if (!isPlainObject(counts) || typeof counts.high !== 'number' || typeof counts.critical !== 'number') {
    const raw = data?.message ?? data?.error?.summary ?? data?.error?.detail ?? ''
    const message =
      String(raw).replace(/\s+/g, ' ').trim() ||
      'npm audit が監査結果 (metadata.vulnerabilities) を返しませんでした'
    return { ok: false, message }
  }
  return {
    ok: true,
    message: '',
    total: data.metadata?.dependencies?.total ?? 0,
    vulnerabilities: isPlainObject(data.vulnerabilities) ? data.vulnerabilities : {}
  }
}

// 例外の比較用キー。同一 GHSA が複数パッケージへ跨るケースを表現する。
// そのため、キーは advisory 単独ではなく (advisory, package) の組にする (#1071 F-03)。
const exceptionKey = (advisory, pkg) => `${advisory} ${pkg}`

/**
 * 例外リストの読み込み。パスが空文字なら「例外なし」。
 * 形が少しでも違えば throw する（書き損じで判定が緩むのを防ぐ）。
 *
 * 返り値は 2 つの Map を持つ。
 *   byKey:      (advisory, package) の組 -> entry。実際の適用（素通し）に使う。
 *   byAdvisory: advisory -> 登録されている package の Set。id は一致するが登録
 *               package と違う advisory（上流の改名・登録し直しで陳腐化した記載）を
 *               検出するのに使う。
 */
export function loadExceptions(exceptionsPath) {
  const byKey = new Map()
  const byAdvisory = new Map()
  if (!exceptionsPath) return { byKey, byAdvisory }

  let data = null
  try {
    data = JSON.parse(readFileSync(exceptionsPath, 'utf8'))
  } catch (error) {
    throw new Error(`例外リストを読めません: ${exceptionsPath} (${error.message})`)
  }
  const entries = isPlainObject(data) ? data.exceptions : undefined
  if (!Array.isArray(entries)) {
    throw new Error(`例外リストの exceptions が配列ではありません: ${exceptionsPath}`)
  }

  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      throw new Error(`例外リストの要素がオブジェクトではありません: ${exceptionsPath}`)
    }
    for (const field of ['advisory', 'package', 'reason', 'added', 'reevaluate']) {
      if (typeof entry[field] !== 'string' || entry[field] === '') {
        throw new Error(`例外リストの ${field} が非空文字列ではありません: ${exceptionsPath}`)
      }
    }
    if (!entry.advisory.startsWith('GHSA-')) {
      throw new Error(`例外リストの advisory が GHSA- で始まりません: ${entry.advisory}`)
    }
    const key = exceptionKey(entry.advisory, entry.package)
    if (byKey.has(key)) {
      throw new Error(`例外リストに同じ advisory と package の組が 2 度あります: ${entry.advisory} ${entry.package}`)
    }
    byKey.set(key, entry)
    if (!byAdvisory.has(entry.advisory)) byAdvisory.set(entry.advisory, new Set())
    byAdvisory.get(entry.advisory).add(entry.package)
  }
  return { byKey, byAdvisory }
}

/**
 * 例外を適用した実効 severity の集計。
 *
 * npm の `vulnerabilities[name].via` は、2 種類の要素を持つ。
 * object 要素は advisory 本体、string 要素は「別パッケージ経由でこのパッケージも脆弱」を表す辺。
 * 例外で advisory が消えると、それを経由して脆弱とされていたパッケージも連鎖して消える必要がある。
 * そのため、object 要素の severity を葉として string 要素を再帰的に辿る。
 * 例外を除いた最大 severity を、実効値とする。
 * `effects`（逆向きの辺）は使わない。
 *
 * 例外リストに載っている advisory id が別パッケージのものとして現れた場合は、throw する。
 * これは例外の陳腐化にあたる。呼び出し側は監査未実施として中止する。
 *
 * 循環は訪問中集合で止める。
 * 後退辺（訪問中のノードへの参照）に当たった探索は、severity が確定値ではなくなる。
 * そのため、その探索に連なる結果は `done` へメモ化しない。
 * 対象は、後退辺を辿った側も、辿られた側も含む。
 * メモ化すると、`Object.keys` の列挙順によって、次の 2 つが入れ替わる。
 * 1 つは、先に訪問し終えてメモ化された側。もう 1 つは、後退辺として severity 無しに畳まれた側。
 * その結果、実効 severity と blocking 件数がキー順に依存してしまう（#1071 F-01）。
 */
export function summarizeVulnerabilities(vulnerabilities, exceptions) {
  const done = new Map()
  const visiting = new Set()
  const excepted = new Map()

  const walk = (name) => {
    const cached = done.get(name)
    if (cached !== undefined) return cached
    if (visiting.has(name)) return { severity: null, advisories: [], cyclic: true }
    const info = vulnerabilities[name]
    if (!isPlainObject(info)) return { severity: null, advisories: [], cyclic: false }

    visiting.add(name)
    let severity = null
    let cyclic = false
    const advisories = []
    for (const via of Array.isArray(info.via) ? info.via : []) {
      if (isPlainObject(via)) {
        const id = advisoryId(via.url)
        const entry = id === '' ? undefined : exceptions.byKey.get(exceptionKey(id, via.name))
        if (entry !== undefined) {
          const key = exceptionKey(id, via.name)
          excepted.set(key, {
            advisory: id,
            package: String(via.name),
            severity: typeof via.severity === 'string' ? via.severity : ''
          })
          continue
        }
        // id は一致するが対象パッケージが違う例外は、上流の改名・登録し直しで陳腐化した
        // 記載。通さず、監査未実施として扱う。
        const registeredPackages = id === '' ? undefined : exceptions.byAdvisory.get(id)
        if (registeredPackages !== undefined && !registeredPackages.has(via.name)) {
          throw new Error(`例外リストの ${id} は ${[...registeredPackages].join(', ')} に登録されていますが、監査結果では ${via.name} の advisory です（例外の陳腐化）`)
        }
        severity = maxSeverity(severity, via.severity)
        advisories.push({ title: via.title ?? '(title 不明)', url: via.url ?? '' })
      }
      else if (typeof via === 'string') {
        if (Object.prototype.hasOwnProperty.call(vulnerabilities, via)) {
          const sub = walk(via)
          severity = maxSeverity(severity, sub.severity)
          advisories.push(...sub.advisories)
          if (sub.cyclic) cyclic = true
        }
        else {
          // 参照先が報告に載っていない（npm がツリーに無い advisory を破棄した等）。
          // 判定を緩める方向に倒さず、npm が当該パッケージへ付けた severity を使う。
          // info.severity は、例外で消した advisory の寄与も含み得る。
          // そのため、例外を適用していても、ここで severity が復元され得る。
          // 理由を blocking の advisory 行として残す。
          // 例外が適用されていないように見える状況を、判別できるようにする (#1071 F-02 / F-12)。
          severity = maxSeverity(severity, info.severity)
          advisories.push({
            title: `npm 報告の severity。advisory の参照先 ${via} が報告に載っていない`,
            url: ''
          })
        }
      }
    }
    visiting.delete(name)

    const result = { severity, advisories, cyclic }
    if (!cyclic) done.set(name, result)
    return result
  }

  const counts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 }
  const blocking = []
  for (const name of Object.keys(vulnerabilities)) {
    const { severity, advisories } = walk(name)
    // 例外で advisory が全て消えたパッケージはどのバケットにも数えない。
    if (severity === null) continue
    counts[severity] += 1
    if (!isBlocking(severity)) continue
    const byUrl = new Map()
    for (const advisory of advisories) byUrl.set(`${advisory.url} ${advisory.title}`, advisory)
    blocking.push({ name, severity, advisories: [...byUrl.values()] })
  }

  blocking.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const exceptedList = [...excepted.values()].sort((a, b) =>
    a.advisory < b.advisory ? -1 : a.advisory > b.advisory ? 1 : 0
  )
  // 一度も一致しなかった例外（通知なしで残ると、陳腐化に気付けない）。
  // 判定には使わない。呼び出し側が要約出力の 1 行として残すためだけに返す (#1071 F-11)。
  const unapplied = [...exceptions.byKey.entries()]
    .filter(([key]) => !excepted.has(key))
    .map(([, entry]) => ({ advisory: entry.advisory, package: entry.package }))
    .sort((a, b) => (a.advisory < b.advisory ? -1 : a.advisory > b.advisory ? 1 : (a.package < b.package ? -1 : a.package > b.package ? 1 : 0)))
  return { counts, blocking, excepted: exceptedList, unapplied }
}

const readArgs = (argv) => {
  const args = {}
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/s.exec(arg)
    if (match === null) {
      console.error(`usage: audit-summary.mjs --audit=<audit.json> --exceptions=<path> --label=<name> --fingerprint=<hex> --out=<json> [--excepted-out=<txt>] [--blocking-out=<txt>]`)
      console.error(`       audit-summary.mjs --audit=<audit.json> --canary=<package>`)
      process.exit(1)
    }
    args[match[1]] = match[2]
  }
  return args
}

if (isSelfExecuted(import.meta.url)) {
  const args = readArgs(process.argv.slice(2))
  if (!args.audit) {
    console.error('usage: audit-summary.mjs --audit=<audit.json> ...')
    process.exit(1)
  }
  const audit = parseAuditJson(args.audit)

  if (args.canary !== undefined) {
    if (!audit.ok) {
      process.stdout.write(`UNAVAILABLE\n${audit.message}\n`)
    }
    else {
      const found = Object.prototype.hasOwnProperty.call(audit.vulnerabilities, args.canary)
      process.stdout.write(`${found ? 'FOUND' : 'MISSING'}\n\n`)
    }
  }
  else {
    if (!args.out || !args.label || !args.fingerprint) {
      console.error('usage: audit-summary.mjs --audit=<audit.json> --exceptions=<path> --label=<name> --fingerprint=<hex> --out=<json> [--excepted-out=<txt>] [--blocking-out=<txt>]')
      process.exit(1)
    }

    let exceptions = null
    let message = audit.ok ? '' : audit.message
    if (audit.ok) {
      try {
        exceptions = loadExceptions(args.exceptions ?? '')
      } catch (error) {
        message = error.message
      }
    }

    if (exceptions === null) {
      process.stdout.write(['UNAVAILABLE', message, '', '', '', '', '', '', '', ''].join('\n') + '\n')
    }
    else {
      // 例外の陳腐化はここで throw される。監査未実施として扱う。
      let summary = null
      try {
        summary = summarizeVulnerabilities(audit.vulnerabilities, exceptions)
      } catch (error) {
        process.stdout.write(['UNAVAILABLE', error.message, '', '', '', '', '', '', '', ''].join('\n') + '\n')
        process.exit(0)
      }
      const { counts, blocking, excepted, unapplied } = summary
      writeFileSync(
        args.out,
        JSON.stringify(
          {
            fingerprint: args.fingerprint,
            total: audit.total,
            vulnerabilities: counts,
            excepted,
            blocking
          },
          null,
          2
        ) + '\n'
      )
      if (args['excepted-out']) {
        writeFileSync(
          args['excepted-out'],
          excepted.map((e) => `${args.label}の例外適用: ${e.advisory} ${e.package} (${e.severity})\n`).join('') +
            unapplied.map((e) => `${args.label}の例外未適用: ${e.advisory} ${e.package}\n`).join('')
        )
      }
      if (args['blocking-out']) {
        writeFileSync(
          args['blocking-out'],
          blocking
            .map(
              (b) =>
                `  ${b.name} (${b.severity})\n` +
                b.advisories.map((a) => `    - ${a.title} ${a.url}\n`).join('')
            )
            .join('')
        )
      }
      process.stdout.write(
        [
          'OK',
          '',
          audit.total,
          counts.critical,
          counts.high,
          counts.moderate,
          counts.low,
          counts.info,
          excepted.length,
          blocking.length
        ].join('\n') + '\n'
      )
    }
  }
}
