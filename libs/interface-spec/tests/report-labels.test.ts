import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LabelName, LinkType, Severity, Stage, Status } from 'allure-js-commons'
import type { Label, Link, TestResult } from 'allure-js-commons'
import { getProjectRoot, stringifyEnvInfo } from 'allure-js-commons/sdk/reporter'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { osName } from '../src/vitest/allure-reporter.js'
import { attachJson, attachOutput } from '../src/vitest/attach.js'
import { featureStory, findUp, layerOf, loadItemTable, loadLayerTable, reportLabelsListener, severityOf } from '../src/vitest/report-labels.js'
import type { ItemTable, LayerRule } from '../src/vitest/report-labels.js'
import { stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const LIB_ROOT = path.resolve(import.meta.dirname, '..')
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'report-labels')
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
const FIXTURE_DIRECTORY = 'libs/interface-spec/tests/fixtures/report-labels'

const TABLE: ItemTable = {
  prefix: 'PT',
  plugin: 'pecot-tools',
  names: new Map([['PT-AWS-S3-LS', 'aws_s3_ls'], ['PT-AWS-STS-GET-CALLER-IDENTITY', 'aws_sts_get_caller_identity']]),
}
const FILE = 'plugins/pecot-tools/cli/tests/integration/tools-reject.test.ts'

// allure-vitest が書き出す直前の結果のうち、listener が読む欄だけを持つもの。
function testResult(parentSuite: string | undefined, ids: readonly string[], labels: readonly Label[] = []): TestResult {
  const links: Link[] = ids.map(id => ({ type: LinkType.TMS, name: id, url: `http://localhost:8000/permalink.html?id=${id}` }))
  return {
    uuid: 'uuid',
    name: 'name',
    fullName: 'fullName',
    historyId: 'historyId',
    status: Status.PASSED,
    statusDetails: {},
    stage: Stage.FINISHED,
    steps: [],
    attachments: [],
    parameters: [],
    labels: [...(parentSuite === undefined ? [] : [{ name: LabelName.PARENT_SUITE, value: parentSuite }]), ...labels],
    links,
  }
}

// allure-vitest と同じく、getProjectRoot() からのテストのファイルのパス。
const PARENT_SUITE = path.relative(getProjectRoot(), path.join(REPO_ROOT, FILE))

const HIERARCHY: ReadonlySet<string> = new Set(['epic', 'feature', 'story'])

function hierarchy(labels: readonly Label[]): Label[] {
  return labels.filter(label => HIERARCHY.has(label.name))
}

function severities(labels: readonly Label[]): string[] {
  return labels.filter(label => label.name === 'severity').map(label => label.value)
}

const LANE_LABELS: readonly Label[] = [{ name: 'project', value: 'pecot-tools' }, { name: 'lane', value: 'test-cli' }]

const labelSchema = z.object({ name: z.string(), value: z.string() })
const childResultSchema = z.object({
  name: z.string(),
  status: z.string(),
  labels: z.array(labelSchema),
})

function readChildResult(file: string): z.infer<typeof childResultSchema> {
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
  return childResultSchema.parse(data)
}

describe('featureStory', () => {
  it.for([
    { name: 'ID が無い', ids: [], file: FILE, expected: { feature: 'plugins/pecot-tools/cli/tests/integration', story: FILE } },
    { name: 'ルートの直下のファイルで ID が無い', ids: [], file: 'a.test.ts', expected: { feature: '.', story: 'a.test.ts' } },
    { name: '項目の ID が 1 つ', ids: ['PT-AWS-S3-LS-03'], file: FILE, expected: { feature: 'aws_s3_ls', story: 'PT-AWS-S3-LS-03' } },
    { name: 'COMMON の後に項目の ID', ids: ['PT-COMMON-14', 'PT-AWS-S3-LS-03'], file: FILE, expected: { feature: 'aws_s3_ls', story: 'PT-AWS-S3-LS-03' } },
    { name: '項目の ID が 2 つ', ids: ['PT-AWS-STS-GET-CALLER-IDENTITY-01', 'PT-AWS-S3-LS-03'], file: FILE, expected: { feature: 'aws_sts_get_caller_identity', story: 'PT-AWS-STS-GET-CALLER-IDENTITY-01' } },
    { name: 'COMMON の ID だけが 2 つ', ids: ['PT-COMMON-02', 'PT-COMMON-14'], file: FILE, expected: { feature: 'pecot-tools 共通', story: 'PT-COMMON-02' } },
    { name: '定義書に無い ID', ids: ['PT-UNKNOWN-01'], file: FILE, expected: { feature: 'PT-UNKNOWN', story: 'PT-UNKNOWN-01' } },
    { name: '別の接頭辞の COMMON の ID', ids: ['PW-COMMON-01'], file: FILE, expected: { feature: 'PW-COMMON', story: 'PW-COMMON-01' } },
  ])('$name とき、feature と story を 1 組返す', async ({ name, ids, file, expected }) => {
    await explains(`\`feature\` と \`story\` の値を決める \`featureStory\` のテストです。渡した ID が「${name}」の場合に、決まった \`feature\` と \`story\` を 1 組返すことを確認します。`)
    stepSync('feature と story を決めて比べる', () => {
      expect(featureStory(ids, file, TABLE)).toEqual(expected)
    })
  })

  it.for([
    { name: '項目の ID', ids: ['SM-ONE-02'], expected: { feature: 'SM-ONE', story: 'SM-ONE-02' } },
    { name: 'COMMON の ID', ids: ['SM-COMMON-01'], expected: { feature: 'SM-COMMON', story: 'SM-COMMON-01' } },
  ])('定義書の無い project の $name は、末尾の -NN を除いた項目の ID を feature にする', async ({ name, ids, expected }) => {
    await explains(`定義書の無い project の ID を扱う \`featureStory\` のテストです。${name}を渡した場合に、末尾の \`-NN\` を除いた項目の ID が \`feature\` になることを確認します。`)
    stepSync('feature と story を決めて比べる', () => {
      expect(featureStory(ids, 'libs/sample/tests/a.test.ts', undefined)).toEqual(expected)
    })
  })
})

describe('severityOf', () => {
  it.for([
    { name: 'githooks のテスト', project: 'githooks', lane: 'test-ci', hasIds: false, expected: Severity.MINOR },
    { name: 'interface-spec の ID を持つテスト', project: 'interface-spec', lane: 'test-unit', hasIds: true, expected: Severity.MINOR },
    { name: 'test-release のレーンのテスト', project: 'pecot-tools', lane: 'test-release', hasIds: false, expected: Severity.BLOCKER },
    { name: 'test-release のレーンの ID を持つテスト', project: 'pecot-workflow', lane: 'test-release', hasIds: true, expected: Severity.BLOCKER },
    { name: 'nx-release のテスト', project: 'nx-release', lane: 'test-unit', hasIds: false, expected: Severity.BLOCKER },
    { name: 'pecot-tools の ID を持つテスト', project: 'pecot-tools', lane: 'test-cli', hasIds: true, expected: Severity.CRITICAL },
    { name: 'pecot-actions の ID を持つテスト', project: 'pecot-actions', lane: 'test-unit', hasIds: true, expected: Severity.CRITICAL },
    { name: 'pecot-tools の ID を持たないテスト', project: 'pecot-tools', lane: 'test-cli', hasIds: false, expected: Severity.NORMAL },
    { name: 'text-rules のテスト', project: 'text-rules', lane: 'test-unit', hasIds: false, expected: Severity.NORMAL },
    { name: 'project とレーンの無いテスト', project: '', lane: '', hasIds: false, expected: Severity.NORMAL },
  ])('$name には、段階 $expected を返す', async ({ name, project, lane, hasIds, expected }) => {
    await explains(`テストの重大度を決める \`severityOf\` のテストです。${name}の場合に、表の上から読んで最初に当てはまる段階の \`${expected}\` を返すことを確認します。`)
    stepSync('段階を決めて比べる', () => {
      expect(severityOf(project, lane, hasIds)).toBe(expected)
    })
  })
})

describe('loadItemTable', () => {
  it.for([
    { name: 'pecot-tools', project: 'plugins/pecot-tools', item: 'PT-AWS-S3-LS', expected: 'aws_s3_ls' },
    { name: 'pecot-workflow', project: 'plugins/pecot-workflow', item: 'PW-ISSUE-CHECK', expected: 'issue_check' },
  ])('$name の generated.json から、項目の ID で name を引ける表を作る', async ({ name, project, item, expected }) => {
    await explains(`定義書の項目の表を作る \`loadItemTable\` のテストです。${name} の \`interface/generated.json\` から、項目の ID で \`name\` を引ける表ができることを確認します。`)
    const table = stepSync('表を作る', () => loadItemTable(path.join(REPO_ROOT, project)))
    stepSync('表を比べる', () => {
      expect(table?.plugin).toBe(name)
      expect(table?.names.get(item)).toBe(expected)
    })
  })

  it.for([
    { name: '配列', content: [], message: 'がオブジェクトでない' },
    { name: 'entries の name が無い', content: { prefix: 'SM', plugin: 'sample', entries: [{ id: 'SM-ONE' }] }, message: 'に prefix・plugin・entries（id と name）が無い' },
  ])('generated.json が$name だと、ファイルの名前を添えて止める', async ({ name, content, message }) => {
    await explains(`定義書の項目の表を作る \`loadItemTable\` のテストです。\`generated.json\` が「${name}」の場合に、ファイルの名前を含むエラーで止まることを確認します。`)
    const project = stepSync('generated.json を置く', () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'interface-spec-report-labels-table-'))
      mkdirSync(path.join(directory, 'interface'))
      writeFileSync(path.join(directory, 'interface', 'generated.json'), JSON.stringify(content))
      return directory
    })
    try {
      stepSync('表を作り、止まるかを比べる', () => {
        expect(() => loadItemTable(project)).toThrow(`${path.join(project, 'interface', 'generated.json')} ${message}`)
      })
    }
    finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('interface/generated.json の無い project では、表を返さない', async () => {
    await explains('定義書の項目の表を作る `loadItemTable` のテストです。`interface/generated.json` の無い project の場合に、`undefined` を返すことを確認します。')
    stepSync('表を作り、未定義かを比べる', () => {
      expect(loadItemTable(LIB_ROOT)).toBeUndefined()
    })
  })
})

describe('findUp', () => {
  it.for([
    { name: 'project.json', file: 'project.json', expected: 'plugins/pecot-tools' },
    { name: 'nx.json', file: 'nx.json', expected: '.' },
  ])('テストのファイルのディレクトリから上へたどり、$name を持つ最初のディレクトリを返す', async ({ name, file, expected }) => {
    await explains(`上位のディレクトリを探す \`findUp\` のテストです。テストのファイルのディレクトリから上へ探し、\`${name}\` を持つ最初のディレクトリを返すことを確認します。`)
    stepSync('ディレクトリを探して比べる', () => {
      expect(findUp(path.join(REPO_ROOT, 'plugins/pecot-tools/cli/tests/integration'), file)).toBe(path.join(REPO_ROOT, expected))
    })
  })

  it('どこにも無いと、undefined を返す', async () => {
    await explains('上位のディレクトリを探す `findUp` のテストです。探すファイルがどの上位のディレクトリにも存在しない場合に、`undefined` を返すことを確認します。')
    stepSync('ディレクトリを探し、未定義かを比べる', () => {
      expect(findUp(REPO_ROOT, 'no-such-file-for-report-labels.json')).toBeUndefined()
    })
  })
})

describe('reportLabelsListener', () => {
  it('ID を持つ結果に、ID の属する定義書の項目の name と ID を足す', async () => {
    await explains('結果を書き出す前に呼ぶ `reportLabelsListener` のテストです。要件の ID を持つ結果に、定義書の項目の `name` の `feature` と、ID の `story` が付くことを確認します。')
    const result = stepSync('結果を作る', () => testResult(PARENT_SUITE, ['PT-COMMON-14', 'PT-AWS-S3-LS-03']))
    stepSync('listener を呼ぶ', () => {
      reportLabelsListener().beforeTestResultWrite?.(result)
    })
    stepSync('ラベルを比べる', () => {
      expect(hierarchy(result.labels)).toEqual([
        { name: LabelName.FEATURE, value: 'aws_s3_ls' },
        { name: LabelName.STORY, value: 'PT-AWS-S3-LS-03' },
      ])
    })
  })

  it('ID を持たない結果に、リポのルートからのディレクトリとファイルを足す', async () => {
    await explains('結果を書き出す前に呼ぶ `reportLabelsListener` のテストです。要件の ID を持たない結果に、リポのルートからのディレクトリとファイルのパスが付くことを確認します。')
    const result = stepSync('結果を作る', () => testResult(PARENT_SUITE, []))
    stepSync('listener を呼ぶ', () => {
      reportLabelsListener().beforeTestResultWrite?.(result)
    })
    stepSync('ラベルを比べる', () => {
      expect(hierarchy(result.labels)).toEqual([
        { name: LabelName.FEATURE, value: 'plugins/pecot-tools/cli/tests/integration' },
        { name: LabelName.STORY, value: FILE },
      ])
    })
  })

  it.for([
    { name: 'feature', label: { name: LabelName.FEATURE, value: 'given' } },
    { name: 'story', label: { name: LabelName.STORY, value: 'given' } },
  ])('$name を持つ結果には、足さない', async ({ name, label }) => {
    await explains(`結果を書き出す前に呼ぶ \`reportLabelsListener\` のテストです。\`${name}\` のラベルを既に持つ結果の場合に、ラベルを追加しないことを確認します。`)
    const result = stepSync('結果を作る', () => testResult(PARENT_SUITE, ['PT-AWS-S3-LS-03'], [label]))
    stepSync('listener を呼ぶ', () => {
      reportLabelsListener().beforeTestResultWrite?.(result)
    })
    stepSync('ラベルを比べる', () => {
      expect(hierarchy(result.labels)).toEqual([label])
    })
  })

  it.for([
    { name: 'pecot-tools の test-cli で ID を持つ', project: 'pecot-tools', lane: 'test-cli', ids: ['PT-AWS-S3-LS-03'], expected: Severity.CRITICAL },
    { name: 'pecot-tools の test-cli で ID を持たない', project: 'pecot-tools', lane: 'test-cli', ids: [], expected: Severity.NORMAL },
    { name: 'nx-release の test-unit で ID を持たない', project: 'nx-release', lane: 'test-unit', ids: [], expected: Severity.BLOCKER },
    { name: 'githooks の test-ci で ID を持つ', project: 'githooks', lane: 'test-ci', ids: ['PT-AWS-S3-LS-03'], expected: Severity.MINOR },
    { name: 'pecot-tools の test-release で ID を持つ', project: 'pecot-tools', lane: 'test-release', ids: ['PT-AWS-S3-LS-03'], expected: Severity.BLOCKER },
  ])('severity の無い結果が $name とき、結果の project・レーンと ID から決めた段階を 1 つ足す', async ({ name, project, lane, ids, expected }) => {
    await explains(`結果を書き出す前に呼ぶ \`reportLabelsListener\` のテストです。severity の無い、${name}結果に、結果のラベルから読んだ project とレーンで決めた \`${expected}\` が 1 つ付くことを確認します。`)
    const result = stepSync('project とレーンのラベルを持つ結果を作る', () => testResult(PARENT_SUITE, ids, [{ name: 'project', value: project }, { name: 'lane', value: lane }]))
    stepSync('listener を呼ぶ', () => {
      reportLabelsListener().beforeTestResultWrite?.(result)
    })
    stepSync('severity を比べる', () => {
      expect(severities(result.labels)).toEqual([expected])
    })
  })

  it('severity を持つ結果には、段階を足さず、テストに書いた段階を残す', async () => {
    await explains('結果を書き出す前に呼ぶ `reportLabelsListener` のテストです。テストに書いた `trivial` の severity を持つ結果の場合に、段階を追加せず `trivial` だけが残ることを確認します。')
    const result = stepSync('trivial の severity を持つ結果を作る', () => testResult(PARENT_SUITE, ['PT-AWS-S3-LS-03'], [...LANE_LABELS, { name: LabelName.SEVERITY, value: Severity.TRIVIAL }]))
    stepSync('listener を呼ぶ', () => {
      reportLabelsListener().beforeTestResultWrite?.(result)
    })
    stepSync('severity を比べる', () => {
      expect(severities(result.labels)).toEqual([Severity.TRIVIAL])
    })
  })

  it('feature と story を持つ結果にも、severity は足す', async () => {
    await explains('結果を書き出す前に呼ぶ `reportLabelsListener` のテストです。`feature` と `story` を既に持つ結果の場合も、severity が 1 つ付き、機能の階層のラベルは変わらないことを確認します。')
    const given: Label[] = [{ name: LabelName.FEATURE, value: 'given' }, { name: LabelName.STORY, value: 'given' }]
    const result = stepSync('feature と story を持つ結果を作る', () => testResult(PARENT_SUITE, [], [...LANE_LABELS, ...given]))
    stepSync('listener を呼ぶ', () => {
      reportLabelsListener().beforeTestResultWrite?.(result)
    })
    stepSync('severity と機能の階層を比べる', () => {
      expect(severities(result.labels)).toEqual([Severity.NORMAL])
      expect(hierarchy(result.labels)).toEqual(given)
    })
  })

  it('parentSuite を持たない結果には、足さない', async () => {
    await explains('結果を書き出す前に呼ぶ `reportLabelsListener` のテストです。`parentSuite` のラベルを持たない結果の場合に、ラベルを追加しないことを確認します。')
    const result = stepSync('結果を作る', () => testResult(undefined, ['PT-AWS-S3-LS-03']))
    stepSync('listener を呼ぶ', () => {
      reportLabelsListener().beforeTestResultWrite?.(result)
    })
    stepSync('ラベルを比べる', () => {
      expect(hierarchy(result.labels)).toEqual([])
    })
  })

  it('generated.json は、ID を持つ最初の結果で project ごとに 1 回だけ読み、ID の無い結果では読まない', async () => {
    await explains('定義書の読み込みの回数についての `reportLabelsListener` のテストです。`generated.json` を、ID を持つ結果のときだけ project ごとに 1 回読むことを確認します。')
    const loaded: string[] = []
    const listener = stepSync('読んだ project を記録する listener を作る', () => reportLabelsListener((project) => {
      loaded.push(path.relative(REPO_ROOT, project))
      return loadItemTable(project)
    }))
    stepSync('ID の無い結果と、ID を持つ 2 つの結果を渡す', () => {
      for (const ids of [[], ['PT-AWS-S3-LS-03'], ['PT-COMMON-14']]) listener.beforeTestResultWrite?.(testResult(PARENT_SUITE, ids))
    })
    stepSync('読んだ project を比べる', () => {
      expect(loaded).toEqual(['plugins/pecot-tools'])
    })
  })

  it('layer を持たない結果に、project の層の表で引いた層を足し、表は project ごとに 1 回だけ読む', async () => {
    await explains('層の表から `layer` を付ける `reportLabelsListener` のテストです。結果のファイルに当たる規則の層が付き、表の読み込みが project ごとに 1 回であることを確認します。')
    const loaded: string[] = []
    const listener = stepSync('層の表を差し替えた listener を作る', () => reportLabelsListener(loadItemTable, (project) => {
      loaded.push(path.relative(REPO_ROOT, project))
      return [{ layer: 'unit', path: 'cli/' }, { layer: 'integration', path: 'cli/tests/integration/' }]
    }))
    const results = stepSync('2 つの結果を渡す', () => [testResult(PARENT_SUITE, []), testResult(PARENT_SUITE, [])])
    stepSync('listener を呼ぶ', () => {
      for (const result of results) listener.beforeTestResultWrite?.(result)
    })
    stepSync('layer と、読んだ project を比べる', () => {
      expect(results.map(result => result.labels.filter(label => label.name === 'layer'))).toEqual([
        [{ name: LabelName.LAYER, value: 'integration' }],
        [{ name: LabelName.LAYER, value: 'integration' }],
      ])
      expect(loaded).toEqual(['plugins/pecot-tools'])
    })
  })

  it.for([
    { name: 'feature', label: { name: LabelName.FEATURE, value: 'given' } },
    { name: 'story', label: { name: LabelName.STORY, value: 'given' } },
  ])('$name を持つ結果にも、機能の階層は足さずに、表で引いた layer を足す', async ({ name, label }) => {
    await explains(`層の表から \`layer\` を付ける \`reportLabelsListener\` のテストです。\`${name}\` のラベルを既に持つ結果の場合に、機能の階層のラベルは変えずに、表の層の \`layer\` を追加することを確認します。`)
    const result = stepSync('結果を作る', () => testResult(PARENT_SUITE, [], [label]))
    stepSync('層の表を差し替えた listener を呼ぶ', () => {
      reportLabelsListener(loadItemTable, () => [{ layer: 'integration', path: 'cli/tests/integration/' }]).beforeTestResultWrite?.(result)
    })
    stepSync('機能の階層と layer を比べる', () => {
      expect(hierarchy(result.labels)).toEqual([label])
      expect(result.labels.filter(item => item.name === 'layer')).toEqual([{ name: LabelName.LAYER, value: 'integration' }])
    })
  })

  it.for([
    { name: 'layer を持つ結果', labels: [{ name: LabelName.LAYER, value: 'e2e' }], table: [{ layer: 'unit', path: 'cli/' }], expected: [{ name: LabelName.LAYER, value: 'e2e' }] },
    { name: '層の表の無い project の結果', labels: [], table: undefined, expected: [] },
    { name: '表のどの規則にも当たらない結果', labels: [], table: [{ layer: 'unit', path: 'scripts/' }], expected: [] },
  ])('$name には、layer を足さない', async ({ name, labels, table, expected }) => {
    await explains(`層の表から \`layer\` を付ける \`reportLabelsListener\` のテストです。${name}の場合に、\`layer\` を追加しないことを確認します。`)
    const result = stepSync('結果を作る', () => testResult(PARENT_SUITE, [], labels))
    stepSync('listener を呼ぶ', () => {
      reportLabelsListener(loadItemTable, () => table).beforeTestResultWrite?.(result)
    })
    stepSync('layer を比べる', () => {
      expect(result.labels.filter(label => label.name === 'layer')).toEqual(expected)
    })
  })
})

describe('layerOf', () => {
  const table: LayerRule[] = [
    { layer: 'unit', path: 'cli/' },
    { layer: 'integration', path: 'cli/tests/' },
    { layer: 'e2e', path: 'cli/tests/parity.test.ts' },
  ]

  it.for([
    { name: 'ディレクトリの規則だけに当たるファイル', file: 'cli/src/a.test.ts', expected: 'unit' },
    { name: '長いディレクトリの規則にも当たるファイル', file: 'cli/tests/b.test.ts', expected: 'integration' },
    { name: 'ファイルの規則に当たるファイル', file: 'cli/tests/parity.test.ts', expected: 'e2e' },
    { name: 'ファイルの規則と名前の先頭だけが同じファイル', file: 'cli/tests/parity.test.ts.bak', expected: 'integration' },
  ])('$name には、当たる規則のうちパスの長いものの層を返す', async ({ name, file, expected }) => {
    await explains(`層の表から層を引く \`layerOf\` のテストです。${name}の場合に、層 \`${expected}\` を返すことを確認します。`)
    stepSync('層を引いて比べる', () => {
      expect(layerOf(table, file)).toBe(expected)
    })
  })

  it('どの規則にも当たらないファイルには、undefined を返す', async () => {
    await explains('層の表から層を引く `layerOf` のテストです。ディレクトリの名前の先頭だけが同じファイルのように、どの規則にも当たらない場合に `undefined` を返すことを確認します。')
    stepSync('層を引いて比べる', () => {
      expect(layerOf(table, 'cli-extra/a.test.ts')).toBeUndefined()
    })
  })
})

describe('loadLayerTable', () => {
  it('コメントと空行と、2 つに分かれない行を読み飛ばし、規則を書いた順に返す', async () => {
    await explains('project の root の `test-layers.txt` を読む `loadLayerTable` のテストです。`#` の行・空行・欄の数の違う行を除き、残りの行を層とパスの規則として返すことを確認します。')
    const directory = stepSync('層の表を一時のディレクトリに書く', () => {
      const created = mkdtempSync(path.join(tmpdir(), 'interface-spec-layer-table-'))
      writeFileSync(path.join(created, 'test-layers.txt'), '# 層の表\n\nunit src/\n  integration   tests/a.test.ts  \nunit\ne2e tests/b.test.ts extra\n')
      return created
    })
    try {
      stepSync('表を読んで比べる', () => {
        expect(loadLayerTable(directory)).toEqual([{ layer: 'unit', path: 'src/' }, { layer: 'integration', path: 'tests/a.test.ts' }])
      })
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('test-layers.txt の無い project では、表を返さない', async () => {
    await explains('project の root の `test-layers.txt` を読む `loadLayerTable` のテストです。ファイルが存在しない場合に `undefined` を返すことを確認します。')
    stepSync('表を読んで比べる', () => {
      expect(loadLayerTable(FIXTURES)).toBeUndefined()
    })
  })
})

const child: { root?: string, directory?: string, results?: z.infer<typeof childResultSchema>[] } = {}

function childResults(): z.infer<typeof childResultSchema>[] {
  if (child.results === undefined) throw new Error('子の vitest を動かしていない')
  return child.results
}

describe('子の vitest の結果', () => {
  beforeAll(() => {
    const root = mkdtempSync(path.join(tmpdir(), 'interface-spec-report-labels-'))
    child.root = root
    const result = spawnSync(process.execPath, [VITEST, 'run', '--config', path.join(FIXTURES, 'vitest.config.mjs')], {
      cwd: FIXTURES,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', NO_COLOR: '1', NX_TASK_TARGET_PROJECT: 'fixture-project', NX_TASK_TARGET_TARGET: 'test-release', REPORT_LABELS_ROOT: root },
    })
    attachOutput('vitest run（report-labels の fixture）', result.status ?? undefined, result.stdout, result.stderr)
    const directory = path.join(root, 'test-results', 'test-release', 'allure-results')
    child.directory = directory
    child.results = readdirSync(directory)
      .filter(file => file.endsWith('-result.json'))
      .map(file => readChildResult(path.join(directory, file)))
  })

  afterAll(() => {
    if (child.root !== undefined) rmSync(child.root, { recursive: true, force: true })
  })

  it.for([
    { name: '通る', status: Status.PASSED, file: 'outcomes.fixture.ts' },
    { name: '落ちる', status: Status.FAILED, file: 'outcomes.fixture.ts' },
    { name: '本体で skip する', status: Status.SKIPPED, file: 'outcomes.fixture.ts' },
    { name: 'beforeAll の後に動く', status: Status.SKIPPED, file: 'before-all.fixture.ts' },
  ])('「$name」の結果は、epic・feature・story を 1 つずつ持つ', async ({ name, status, file }) => {
    await explains(`子の vitest を Allure の reporter 付きで実行したときの結果のテストです。「${name}」の結果が、epic・feature・story のラベルを 1 つずつ持つことを確認します。`)
    const found = stepSync('結果を探す', () => childResults().find(result => result.name === name))
    stepSync('結果を添付する', () => {
      attachJson(`「${name}」の結果のラベル`, found?.labels)
    })
    stepSync('状態とラベルを比べる', () => {
      expect(found?.status).toBe(status)
      expect(hierarchy(found?.labels ?? [])).toEqual([
        { name: 'epic', value: 'fixture-project' },
        { name: LabelName.FEATURE, value: FIXTURE_DIRECTORY },
        { name: LabelName.STORY, value: `${FIXTURE_DIRECTORY}/${file}` },
      ])
    })
  })

  it('COMMON の ID の後に項目の ID を持つ結果は、項目の ID で feature と story を 1 組持つ', async () => {
    await explains('子の vitest を Allure の reporter 付きで実行したときの結果のテストです。COMMON の ID と項目の ID を持つ結果が、項目の ID の `feature` と `story` を持つことを確認します。')
    const found = stepSync('結果を探す', () => childResults().find(result => result.name === 'COMMON の ID の後に項目の ID を持つ'))
    stepSync('結果を添付する', () => {
      attachJson('結果のラベル', found?.labels)
    })
    stepSync('ラベルを比べる', () => {
      expect(hierarchy(found?.labels ?? [])).toEqual([
        { name: 'epic', value: 'fixture-project' },
        { name: LabelName.FEATURE, value: 'SM-ONE' },
        { name: LabelName.STORY, value: 'SM-ONE-02' },
      ])
    })
  })

  it.for([
    { name: '通る', expected: Severity.BLOCKER },
    { name: '落ちる', expected: Severity.BLOCKER },
    { name: '本体で skip する', expected: Severity.BLOCKER },
    { name: 'beforeAll の後に動く', expected: Severity.BLOCKER },
    { name: 'COMMON の ID の後に項目の ID を持つ', expected: Severity.BLOCKER },
    { name: 'テストに段階を書く', expected: Severity.TRIVIAL },
  ])('「$name」の結果は、severity を 1 つだけ持つ', async ({ name, expected }) => {
    await explains(`子の vitest を Allure の reporter 付きで実行したときの結果のテストです。「${name}」の結果が、severity のラベルを \`${expected}\` の 1 つだけ持つことを確認します。`)
    const found = stepSync('結果を探す', () => childResults().find(result => result.name === name))
    stepSync('結果を添付する', () => {
      attachJson(`「${name}」の結果のラベル`, found?.labels)
    })
    stepSync('severity を比べる', () => {
      expect(severities(found?.labels ?? [])).toEqual([expected])
    })
  })

  it('結果のディレクトリに、OS と Node.js の版を書いた environment.properties を置く', async () => {
    await explains('子の vitest を Allure の reporter 付きで実行したときの、結果のディレクトリのテストです。`environment.properties` に、`OS` と `Node.js` の版だけが allure-js-commons と同じ形で書かれていることを確認します。')
    const text = stepSync('environment.properties を読む', () => {
      if (child.directory === undefined) throw new Error('子の vitest を動かしていない')
      return readFileSync(path.join(child.directory, 'environment.properties'), 'utf8')
    })
    stepSync('ファイルの中身を添付する', () => {
      attachJson('environment.properties', text)
    })
    stepSync('中身を比べる', () => {
      expect(text).toBe(stringifyEnvInfo({ 'OS': osName(), 'Node.js': process.version }))
    })
  })

  it('どの結果も、Node.js の版のラベルを 1 つだけ持つ', async () => {
    await explains('子の vitest を Allure の reporter 付きで実行したときの結果のテストです。すべての結果が、`Node.js` のラベルを、動かした Node.js の版の 1 つだけ持つことを確認します。')
    const results = stepSync('結果を集める', () => childResults())
    stepSync('結果のラベルを添付する', () => {
      attachJson('結果ごとの Node.js のラベル', results.map(result => ({ name: result.name, labels: result.labels.filter(label => label.name === 'Node.js') })))
    })
    stepSync('Node.js のラベルを比べる', () => {
      expect(results.length).toBeGreaterThan(0)
      for (const result of results) {
        expect({ name: result.name, versions: result.labels.filter(label => label.name === 'Node.js').map(label => label.value) }).toEqual({ name: result.name, versions: [process.version] })
      }
    })
  })
})
