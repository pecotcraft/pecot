// テストの結果の feature・story を、ファイルの場所と verifies の ID から決める（test-conventions.md の「機能の階層」）。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { LabelName, LinkType } from 'allure-js-commons'
import type { TestResult } from 'allure-js-commons'
import { getProjectRoot } from 'allure-js-commons/sdk/reporter'
import type { LifecycleListener } from 'allure-js-commons/sdk/reporter'

// 定義書の項目の ID から name を引く表。generated.json の prefix・plugin・entries から作る。
export interface ItemTable {
  readonly prefix: string
  readonly plugin: string
  readonly names: ReadonlyMap<string, string>
}

export interface FeatureStory {
  readonly feature: string
  readonly story: string
}

const ID_NUMBER = /-\d{2}$/u
const COMMON_ITEM = /^[^-]+-COMMON$/u

// 要件の ID から末尾の -NN を除いた、項目の ID。
export function itemId(id: string): string {
  return id.replace(ID_NUMBER, '')
}

function isCommon(id: string): boolean {
  return COMMON_ITEM.test(itemId(id))
}

// ids は verifies を呼んだ順。testFile はリポのルートからの POSIX のパス。table は定義書の無い project では undefined。
export function featureStory(ids: readonly string[], testFile: string, table: ItemTable | undefined): FeatureStory {
  const chosen = ids.find(id => !isCommon(id)) ?? ids[0]
  if (chosen === undefined) return { feature: path.posix.dirname(testFile), story: testFile }
  const item = itemId(chosen)
  if (table === undefined) return { feature: item, story: chosen }
  const feature = item === `${table.prefix}-COMMON` ? `${table.plugin} 共通` : (table.names.get(item) ?? item)
  return { feature, story: chosen }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEntry(value: unknown): value is { readonly id: string, readonly name: string } {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string'
}

// project の root の interface/generated.json から表を作る。ファイルが無ければ undefined。
export function loadItemTable(projectDirectory: string): ItemTable | undefined {
  const file = path.join(projectDirectory, 'interface', 'generated.json')
  if (!existsSync(file)) return undefined
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isRecord(data)) throw new Error(`${file} がオブジェクトでない`)
  const { prefix, plugin, entries } = data
  if (typeof prefix !== 'string' || typeof plugin !== 'string' || !Array.isArray(entries) || !entries.every(isEntry)) {
    throw new Error(`${file} に prefix・plugin・entries（id と name）が無い`)
  }
  return { prefix, plugin, names: new Map(entries.map(entry => [entry.id, entry.name])) }
}

// start から上へたどり、fileName を持つ最初のディレクトリを返す。
export function findUp(start: string, fileName: string): string | undefined {
  let directory = path.resolve(start)
  for (;;) {
    if (existsSync(path.join(directory, fileName))) return directory
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

interface Place {
  readonly root: string
  readonly project: string | undefined
}

// allure-vitest の reporter の listeners に渡す。feature・story の無い結果にだけ、書き出す直前に足す。
export function reportLabelsListener(load: (projectDirectory: string) => ItemTable | undefined = loadItemTable): LifecycleListener {
  const places = new Map<string, Place>()
  const tables = new Map<string, ItemTable | undefined>()
  const place = (directory: string): Place => {
    const known = places.get(directory)
    if (known !== undefined) return known
    // nx の外で動かしたときは、allure-vitest が parentSuite を作る基準を、ルートの代わりにする。
    const found = { root: findUp(directory, 'nx.json') ?? getProjectRoot(), project: findUp(directory, 'project.json') }
    places.set(directory, found)
    return found
  }
  const table = (project: string | undefined): ItemTable | undefined => {
    if (project === undefined) return undefined
    if (!tables.has(project)) tables.set(project, load(project))
    return tables.get(project)
  }
  return {
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 渡された結果を書き換える
    beforeTestResultWrite: (result: TestResult) => {
      if (result.labels.some(label => label.name === 'feature' || label.name === 'story')) return
      const suite = result.labels.find(label => label.name === 'parentSuite')?.value
      if (suite === undefined) return
      // allure-vitest は parentSuite を、getProjectRoot() からのテストのファイルのパスで作る。
      const file = path.resolve(getProjectRoot(), suite)
      const ids = result.links.filter(link => link.type === LinkType.TMS).map(link => link.name ?? link.url)
      const { root, project } = place(path.dirname(file))
      const testFile = path.relative(root, file).split(path.sep).join('/')
      const { feature, story } = featureStory(ids, testFile, ids.length === 0 ? undefined : table(project))
      result.labels.push({ name: LabelName.FEATURE, value: feature }, { name: LabelName.STORY, value: story })
    },
  }
}
