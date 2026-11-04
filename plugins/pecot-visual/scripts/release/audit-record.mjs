// pecotv のリリース監査記録の読み書き (#1059 / #1071)。
//
// 記録は audit-mcp-dist.sh が version 作成前に書き、publish-mcp-dist.sh が配布前に読む。
// 両者を別々の JSON 生成・解釈コードで結ぶと、フィールド名の文字列一致だけが契約になる。
// すると、片側を変更しても気づけず、ずれが生じる。
// 読み・書き・検証をこのモジュールに集約し、フィールド名は下の FIELD を唯一の定義にする。
//
// 監査するツリーは 2 つ。MCP 配布ツリーと、永続層 <置き場>/mcp-dist。
// 記録は、ツリーごとに 1 セクションを持つ。
// publish が比較するのは、配布ツリーの指紋だけ。
// 永続層の指紋は「何を監査したか」の証跡で、比較の判定には使わない。
// 永続層は利用者環境で --no-package-lock により毎回解決し直される。
// そのため、同じ解決結果になる保証が無い。
//
//   import: buildPassRecord / buildSkippedRecord / writeAuditRecord / readAuditRecord
//
//   直接起動:
//     node audit-record.mjs write <path> pass <head> <registry> \
//
//                                      <dist-summary.json> <runtime-summary.json>
//
//     node audit-record.mjs write <path> skipped <head>
//
//     node audit-record.mjs read <path>
//
//       -> status / fingerprint / head / blocking を 1 行 1 フィールドで stdout に出す。
//          fingerprint は配布ツリー、blocking は両ツリーの critical + high 合計。
//          空フィールドは空行。呼び出し側は mapfile -t で受ける。

import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isSelfExecuted } from './self-exec.mjs'

// 記録の JSON フィールド名の唯一の定義。書き手・読み手はここだけを参照する。
export const FIELD = {
  SKIPPED: 'skipped',
  HEAD: 'head',
  REGISTRY: 'registry',
  CREATED_AT: 'createdAt',
  DIST: 'dist',
  RUNTIME: 'runtime',
  FINGERPRINT: 'fingerprint',
  TOTAL: 'total',
  VULNERABILITIES: 'vulnerabilities',
  EXCEPTED: 'excepted'
}

// 監査したツリーのセクション名。表示名との対応は audit-mcp-dist.sh 側が持つ。
export const TREE = [FIELD.DIST, FIELD.RUNTIME]

// vulnerabilities 直下の severity 別件数。critical / high は publish の可否判定に使う。
export const SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MODERATE: 'moderate',
  LOW: 'low',
  INFO: 'info'
}

// readAuditRecord が返す状態。
//   MISSING  記録が無い。
//   INVALID  読めない / スキーマを満たさない（止める）。
//   SKIPPED  pecot-visual 非対象のリリースとして監査をスキップした記録。
//   OK       比較に使える記録。
export const STATUS = {
  MISSING: 'MISSING',
  INVALID: 'INVALID',
  SKIPPED: 'SKIPPED',
  OK: 'OK'
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const num = (value) => Number(value)

// audit-summary.mjs が --out へ書いた要約から記録用のセクションを組む。
// blocking（脆弱なパッケージの一覧）は中止時にだけ使う実行時情報なので記録には載せない。
function treeSection(summary) {
  const vulnerabilities = isPlainObject(summary[FIELD.VULNERABILITIES]) ? summary[FIELD.VULNERABILITIES] : {}
  return {
    [FIELD.FINGERPRINT]: summary[FIELD.FINGERPRINT],
    [FIELD.TOTAL]: num(summary[FIELD.TOTAL]),
    [FIELD.VULNERABILITIES]: {
      [SEVERITY.CRITICAL]: num(vulnerabilities[SEVERITY.CRITICAL]),
      [SEVERITY.HIGH]: num(vulnerabilities[SEVERITY.HIGH]),
      [SEVERITY.MODERATE]: num(vulnerabilities[SEVERITY.MODERATE]),
      [SEVERITY.LOW]: num(vulnerabilities[SEVERITY.LOW]),
      [SEVERITY.INFO]: num(vulnerabilities[SEVERITY.INFO])
    },
    [FIELD.EXCEPTED]: Array.isArray(summary[FIELD.EXCEPTED]) ? summary[FIELD.EXCEPTED] : []
  }
}

export function buildPassRecord({ head, registry, dist, runtime }) {
  return {
    [FIELD.HEAD]: head,
    [FIELD.REGISTRY]: registry,
    [FIELD.CREATED_AT]: new Date().toISOString(),
    [FIELD.DIST]: treeSection(dist),
    [FIELD.RUNTIME]: treeSection(runtime)
  }
}

export function buildSkippedRecord(head) {
  return {
    [FIELD.SKIPPED]: true,
    [FIELD.HEAD]: head,
    [FIELD.CREATED_AT]: new Date().toISOString()
  }
}

// 記録の書き出し。同一ディレクトリの一時ファイルへ書いてから rename で置換する。
// writeFileSync は truncate してから書くため、中断すると途中までの JSON が残る。
// 次の読み手は「不正な記録」として止まる。配布は止まるが、原因が読み取りにくい。
export function writeAuditRecord(recordPath, record) {
  const dir = path.dirname(recordPath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = path.join(dir, `.${path.basename(recordPath)}.${process.pid}.tmp`)
  writeFileSync(tmpPath, JSON.stringify(record, null, 2) + '\n')
  renameSync(tmpPath, recordPath)
}

// セクションの素性のチェック。指紋の欠落と同じ厳しさで、severity 件数の型も見る。
// 数値でない・キーが無い・vulnerabilities が配列、のいずれかを通してしまうと、
// severity の判定が fail-open になる。その場合は、指紋の不一致で初めて止まる。
// 満たさない場合は null、満たす場合は { fingerprint, blocking }。
function readTreeSection(section) {
  if (!isPlainObject(section)) return null
  const fingerprint = section[FIELD.FINGERPRINT]
  const vulnerabilities = section[FIELD.VULNERABILITIES]
  if (typeof fingerprint !== 'string' || fingerprint === '') return null
  if (!isPlainObject(vulnerabilities)) return null
  const critical = vulnerabilities[SEVERITY.CRITICAL]
  const high = vulnerabilities[SEVERITY.HIGH]
  if (typeof critical !== 'number' || typeof high !== 'number') return null
  return { fingerprint, blocking: critical + high }
}

// 記録の読み取りと検証。返す形は { status, fingerprint, head, blocking }。
// fingerprint（配布ツリー）/ head / blocking（両ツリー合計）は status === OK のときだけ
// 意味を持つ。片方のツリーのセクションが欠けている記録は INVALID として止める。
export function readAuditRecord(recordPath) {
  const empty = { status: STATUS.INVALID, fingerprint: '', head: '', blocking: 0 }
  if (!existsSync(recordPath)) return { ...empty, status: STATUS.MISSING }

  let data = null
  try {
    data = JSON.parse(readFileSync(recordPath, 'utf8'))
  } catch {
    return empty
  }
  if (!isPlainObject(data)) return empty
  if (data[FIELD.SKIPPED] === true) return { ...empty, status: STATUS.SKIPPED }

  const head = data[FIELD.HEAD]
  if (typeof head !== 'string' || head === '') return empty

  const sections = TREE.map((tree) => readTreeSection(data[tree]))
  if (sections.some((section) => section === null)) return empty

  return {
    status: STATUS.OK,
    fingerprint: sections[0].fingerprint,
    head,
    blocking: sections.reduce((sum, section) => sum + section.blocking, 0)
  }
}

if (isSelfExecuted(import.meta.url)) {
  const [command, recordPath, ...rest] = process.argv.slice(2)
  const usage = () => {
    console.error('usage: audit-record.mjs write <path> pass <head> <registry> <dist-summary.json> <runtime-summary.json>')
    console.error('       audit-record.mjs write <path> skipped <head>')
    console.error('       audit-record.mjs read <path>')
    process.exit(1)
  }
  if (!command || !recordPath) usage()

  if (command === 'write') {
    const [kind, ...values] = rest
    if (kind === 'skipped') {
      const [head] = values
      if (!head) usage()
      writeAuditRecord(recordPath, buildSkippedRecord(head))
    } else if (kind === 'pass') {
      const [head, registry, distSummary, runtimeSummary] = values
      if (values.length !== 4) usage()
      const readSummary = (file) => JSON.parse(readFileSync(file, 'utf8'))
      writeAuditRecord(
        recordPath,
        buildPassRecord({
          head,
          registry,
          dist: readSummary(distSummary),
          runtime: readSummary(runtimeSummary)
        })
      )
    } else {
      usage()
    }
  } else if (command === 'read') {
    const { status, fingerprint, head, blocking } = readAuditRecord(recordPath)
    process.stdout.write([status, fingerprint, head, blocking].join('\n') + '\n')
  } else {
    usage()
  }
}
