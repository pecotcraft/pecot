// pecot-visual のリリースとみなす nx release group の名前を、1 行 1 件で stdout に出す (#1297)。
//
// 対象は、pecot-visual 自身の group と、pecot-visual が依存する project の group。
// text-rules の group は updateDependents: always を持つ。
// そのため、text-rules だけの version plan でも、nx は依存元の pecot-visual を上げる。
// plan に pecot-visual: が無いことだけを根拠にすると、pecot-visual のリリースなのに監査を飛ばす。
// その結果、@pecot/visual-mcp が配布されない。
//
// 依存する project は、手で列挙しない。
// plugins/pecot-visual/package.json の dependencies と devDependencies のうち、`workspace:` で参照するものから求める。
//   1. 依存の名前から、repo root の pnpm-workspace.yaml のメンバーで package.json の name が一致する dir を探す。
//   2. その dir の project.json の name を読む。
//   3. nx.json の release.groups で、その project を含む group を探す。
// 求められないときは exit 1 で止める。監査が静かに抜ける状態を避けるため。
//
// 読むのは plugins/pecot-visual/package.json の直下だけで、cli や assets などのメンバーの workspace: 依存は拾わない。
// nx の依存グラフも直下の package.json だけを読むので、updateDependents の対象とは一致している。
// そのため、pecot-visual の workspace のライブラリは、メンバーではなく直下の package.json に書く。
//
//   node release-groups.mjs <repo root>

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isSelfExecuted } from './self-exec.mjs'

const OWN_GROUP = 'pecot-visual'

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

// pnpm-workspace.yaml の packages ブロックのメンバーを相対パスで返す。
// 同じ解析を、シェル側の list_workspace_members (scripts/ci/pm-guard-lib.sh) も別実装で持つ。
// 解析の規則を変えるときは、両方をそろえる。
function workspaceMembers(file) {
  const members = []
  let inPackages = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^[^\s#]/.test(line)) {
      inPackages = line.startsWith('packages:')
      continue
    }
    const matched = inPackages ? /^\s*-\s*["']?([^"'\s#]+)["']?/.exec(line) : null
    if (matched?.[1] !== undefined) members.push(matched[1])
  }
  return members
}

export function releaseGroups(repoRoot) {
  const pluginRoot = path.join(repoRoot, 'plugins', 'pecot-visual')
  const manifest = readJson(path.join(pluginRoot, 'package.json'))
  const nxConfig = readJson(path.join(repoRoot, 'nx.json'))
  const groups = nxConfig?.release?.groups ?? {}

  const workspaceDependencies = []
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (String(range).startsWith('workspace:')) workspaceDependencies.push(name)
    }
  }

  const memberByName = new Map()
  for (const member of workspaceMembers(path.join(repoRoot, 'pnpm-workspace.yaml'))) {
    const memberManifest = path.join(repoRoot, member, 'package.json')
    if (existsSync(memberManifest)) memberByName.set(readJson(memberManifest).name, member)
  }

  const result = new Set([OWN_GROUP])
  for (const name of workspaceDependencies) {
    const member = memberByName.get(name)
    if (member === undefined) throw new Error(`workspace 依存 ${name} に対応するメンバーが pnpm-workspace.yaml に無い`)
    const projectFile = path.join(repoRoot, member, 'project.json')
    if (!existsSync(projectFile)) throw new Error(`workspace 依存 ${name} の project.json が無い: ${projectFile}`)
    const projectName = readJson(projectFile).name
    const owners = Object.entries(groups)
      .filter(([, group]) => (group.projects ?? []).includes(projectName))
      .map(([groupName]) => groupName)
    if (owners.length === 0) throw new Error(`project ${projectName} を含む release group が nx.json に無い`)
    for (const owner of owners) result.add(owner)
  }
  return [...result]
}

if (isSelfExecuted(import.meta.url)) {
  const repoRoot = process.argv[2]
  if (repoRoot === undefined) {
    console.error('usage: node release-groups.mjs <repo root>')
    process.exit(2)
  }
  try {
    process.stdout.write(releaseGroups(repoRoot).map((group) => `${group}\n`).join(''))
  } catch (error) {
    console.error(`ERROR: release group を解決できない: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
