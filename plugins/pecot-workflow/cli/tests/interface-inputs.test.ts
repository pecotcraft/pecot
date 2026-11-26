// 定義書の入力名の決まり。書き込む項目は CLI だけの入力に dry_run を持ち、MCP の入力には持たない。1 つの対象を指す入力名は 1 つだけにする
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { authoredFileSchema } from '../../../../libs/interface-spec/src/domain/schema.js'
import { explains } from './_helpers/explains.js'

const propertySchema = z.object({ description: z.string().optional() })
const inputSchema = z.object({ properties: z.record(z.string(), propertySchema) })
const cliSchema = z.object({ only: z.record(z.string(), z.unknown()).optional() })
const entrySchema = z.object({ id: z.string(), input: inputSchema, cli: cliSchema.optional() })
const generatedSchema = z.object({ entries: z.array(entrySchema) })

const directory = path.resolve(import.meta.dirname, '../../interface')
const authoredText = readFileSync(path.join(directory, 'authored.yaml'), 'utf8')
const authored = authoredFileSchema.parse(parseYaml(authoredText))
const generatedText = readFileSync(path.join(directory, 'generated.json'), 'utf8')
const generated = generatedSchema.parse(JSON.parse(generatedText))

const WRITING_KINDS: ReadonlySet<string> = new Set(['write', 'destructive'])
// 予行を別の check のコマンドが担う項目と、その check の項目
const CHECKED_ELSEWHERE: ReadonlyMap<string, string> = new Map([['PW-ISSUE-CREATE', 'PW-ISSUE-CHECK']])
const OLD_NAMES: readonly string[] = ['issue', 'repo_ref', 'owner_repo', 'branch_name', 'plan']

type Target = 'issue' | 'pr' | 'repo' | 'branch'
interface TargetMatcher { readonly target: Target, readonly allowed: string, readonly byName: RegExp, readonly byDescription: RegExp }
interface Entry { readonly id: string, readonly input: { readonly properties: Readonly<Record<string, { readonly description?: string | undefined }>> } }

// 名前か説明から、その入力が指す対象を求める。説明は書き出しの英語（`Issue reference (owner/repo/N)` など）
// allowed は、その対象を指す入力として使ってよい名前（対象ごとに 1 つ）
const TARGET_MATCHERS: readonly TargetMatcher[] = [
  { target: 'issue', allowed: 'issue_ref', byName: /(?:^|_)issue(?:_|$)/u, byDescription: /\bIssue (?:reference|ref)\b|\bIssue\b[^.]+\(`?owner\/repo\/(?:N|\d+)/u },
  { target: 'pr', allowed: 'pr_ref', byName: /(?:^|_)pr(?:_|$)/u, byDescription: /^PR reference/u },
  { target: 'repo', allowed: 'repo', byName: /(?:^|_)repo(?:_|$)/u, byDescription: /^Repository\b[^.]+owner\/repo|^Target repository\b/u },
  { target: 'branch', allowed: 'branch', byName: /(?:^|_)branch(?:_|$)/u, byDescription: /^Name of the branch\b/u },
]

// 役割が対象そのものではない入力。名前か説明が対象に似るが、別の役割を持つので、明示の例外にする
const ROLE_EXCEPTIONS: Readonly<Record<string, string>> = {
  by: '待たせる相手の Issue。操作の対象の issue_ref とは別の役割',
  parent_epic: '親の Epic。操作の対象の Issue ではない',
  no_issue_ref: '関連 Issue の自動設定を止める印で、Issue を指さない',
  allow_existing_branch: '既存のブランチの再利用を許す印で、ブランチを指さない',
  delete_branch: 'ブランチを消すかの印で、ブランチを指さない',
  keep_branch: 'ブランチを残すかの印で、ブランチを指さない',
  develop_branch: '設定値としての開発ブランチ名。操作するブランチではない',
  release_branch: '設定値としてのリリースブランチ名。操作するブランチではない',
  base: 'PR の base。操作するブランチ（branch）とは別の役割',
  head: 'PR の head。操作するブランチ（branch）とは別の役割',
}

function targetsOf(name: string, description: string): readonly TargetMatcher[] {
  return TARGET_MATCHERS.filter(matcher => matcher.byName.test(name) || matcher.byDescription.test(description))
}

/**
対象を指す入力のうち、許す名前でなく、例外の一覧にも無いものを `<項目>: <入力名> (<対象>)` で返す
*/
function aliasesIn(entries: readonly Entry[]): string[] {
  return entries.flatMap(entry => Object.entries(entry.input.properties).flatMap(([name, property]) =>
    targetsOf(name, property.description ?? '')
      .filter(matcher => name !== matcher.allowed && !Object.keys(ROLE_EXCEPTIONS).includes(name))
      .map(matcher => `${entry.id}: ${name} (${matcher.target})`)))
}

function entryOf(name: string, description: string): Entry {
  return { id: 'x', input: { properties: { [name]: { description } } } }
}

function hasInput(id: string, name: string): boolean {
  return Object.keys(generated.entries.find(entry => entry.id === id)?.input.properties ?? {}).includes(name)
}

function hasCliOnlyDryRun(id: string): boolean {
  return Object.keys(generated.entries.find(entry => entry.id === id)?.cli?.only ?? {}).includes('dry_run')
}

describe('定義書の入力名', () => {
  it('どの項目も、MCP の入力に dry_run を持たない', async () => {
    await explains('定義書の入力名の決まりのテストです。定義書のすべての項目を調べた場合に、MCP の入力に `dry_run` を持つ項目が 1 つも無いことを確認します。')
    expect(generated.entries.filter(entry => hasInput(entry.id, 'dry_run')).map(entry => entry.id)).toEqual([])
  })

  it('write か destructive の effects を持つ項目は、予行を check の項目が担うものを除き、CLI だけの入力に dry_run を持つ', async () => {
    await explains('定義書の入力名の決まりのテストです。`write` か `destructive` の効果を持つ項目を調べた場合に、予行を `check` の項目が担うものを除き、CLI だけの入力に `dry_run` を持つことを確認します。')
    const writing = Object.entries(authored.entries)
      .filter(([, entry]) => entry.effects.some(effect => WRITING_KINDS.has(effect.kind)))
      .map(([id]) => id)
    expect(writing.length).toBeGreaterThan(20)
    expect(writing.filter(id => !hasCliOnlyDryRun(id) && !CHECKED_ELSEWHERE.has(id))).toEqual([])
  })

  it('予行を check の項目が担う項目は、dry_run を持たず、その check の項目は書き込まない', async () => {
    await explains('定義書の入力名の決まりのテストです。予行を `check` の項目が担う項目を調べた場合に、`dry_run` を持たず、その `check` の項目が読むだけの効果であることを確認します。')
    for (const [id, check] of CHECKED_ELSEWHERE) {
      expect(hasInput(id, 'dry_run') || hasCliOnlyDryRun(id)).toBe(false)
      expect(Object.entries(authored.entries).find(([key]) => key === check)?.[1].effects.map(effect => effect.kind)).toEqual(['read', 'read'])
    }
  })

  it('Issue・PR・リポ・操作するブランチを指す入力の名前は、対象ごとに 1 つ（issue_ref・pr_ref・repo・branch）で、役割の名前は例外の一覧にある', async () => {
    await explains('定義書の入力名の決まりのテストです。Issue・PR・リポ・ブランチを指す入力を調べた場合に、対象ごとの名前（`issue_ref`・`pr_ref`・`repo`・`branch`）か、例外の一覧にある役割の名前だけであることを確認します。')
    expect(aliasesIn(generated.entries)).toEqual([])
  })

  it('対象を指す入力が、対象ごとに決めた名前で実在する', async () => {
    await explains('定義書の入力名の決まりのテストです。対象ごとに決めた名前を調べた場合に、どの名前も定義書の入力に実在することを確認します。')
    const used = new Set(generated.entries.flatMap(entry => Object.keys(entry.input.properties)))
    expect(TARGET_MATCHERS.map(matcher => matcher.allowed).filter(name => !used.has(name))).toEqual([])
  })

  it('例外の一覧の入力は、どれも定義書に実在する', async () => {
    await explains('定義書の入力名の決まりのテストです。例外の一覧の入力名を調べた場合に、どれも定義書に実在することを確認します。')
    const used = new Set(generated.entries.flatMap(entry => Object.keys(entry.input.properties)))
    expect(Object.keys(ROLE_EXCEPTIONS).filter(name => !used.has(name))).toEqual([])
  })

  it('新しい別名（issue_number・pull_request・repository・target_branch）を足した項目は、検出する', async () => {
    await explains('定義書の入力名の決まりのテストです。`issue_number` などの新しい別名を持つ項目を調べた場合に、別名として検出し、決めた名前の項目は検出しないことを確認します。')
    expect(aliasesIn([entryOf('issue_number', 'Issue reference (owner/repo/N)')])).toEqual(['x: issue_number (issue)'])
    expect(aliasesIn([entryOf('pull_request', 'PR reference (owner/repo/123)')])).toEqual(['x: pull_request (pr)'])
    expect(aliasesIn([entryOf('repository', 'Repository in owner/repo form')])).toEqual(['x: repository (repo)'])
    expect(aliasesIn([entryOf('target_branch', 'Target')])).toEqual(['x: target_branch (branch)'])
    expect(aliasesIn([entryOf('issue_ref', 'Issue reference (owner/repo/N)'), entryOf('repo', 'Repository in owner/repo form')])).toEqual([])
  })

  it('改名前の名前を入力に持つ項目が無い', async () => {
    await explains('定義書の入力名の決まりのテストです。改名前の名前を入力に持つ項目を調べた場合に、該当する項目が 1 つも無いことを確認します。')
    const found = generated.entries.flatMap(entry => OLD_NAMES.filter(name => hasInput(entry.id, name)).map(name => `${entry.id}: ${name}`))
    expect(found).toEqual([])
  })
})
