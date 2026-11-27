import os from 'node:os'
import path from 'node:path'
import AllureVitestReporter from 'allure-vitest/reporter'
import { describe, expect, it } from 'vitest'
import { allureReporter, allureReporterConfig, isAllureEnabled, osName } from '../src/vitest/allure-reporter.js'
import { stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

const ROOT = path.join(path.sep, 'repo', 'plugins', 'pecot-tools')
const NX_ENV = { NX_TASK_TARGET_PROJECT: 'pecot-tools', NX_TASK_TARGET_TARGET: 'test-cli' }
const ETC = '/etc/os-release'
const USR_LIB = '/usr/lib/os-release'

// 渡したファイルの中身だけを返し、ほかは ENOENT で失敗する読み手。読んだパスを順に残す。
function fakeReader(files: Readonly<Record<string, string>>): { readonly read: (file: string) => string, readonly calls: string[] } {
  const calls: string[] = []
  const read = (file: string): string => {
    calls.push(file)
    const content = files[file]
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
    return content
  }
  return { read, calls }
}

describe('isAllureEnabled', () => {
  it.for([
    { name: '未設定', environment: { NX_TASK_TARGET_PROJECT: 'pecot-tools' }, expected: false },
    { name: '空文字', environment: { ...NX_ENV, NX_TASK_TARGET_TARGET: '' }, expected: false },
    { name: '設定済み', environment: NX_ENV, expected: true },
  ])('NX_TASK_TARGET_TARGET が $name のとき、isAllureEnabled は $expected を返す', async ({ name, environment, expected }) => {
    await explains(`Allure の reporter を使うかどうかを判定する \`isAllureEnabled\` のテストです。環境変数 \`NX_TASK_TARGET_TARGET\` が${name}の場合に、\`${String(expected)}\` を返すことを確認します。`)
    stepSync('Allure の有効かを判定して比べる', () => {
      expect(isAllureEnabled(environment)).toBe(expected)
    })
  })
})

describe('osName', () => {
  it('/etc/os-release があると、そのファイルだけを読み、PRETTY_NAME の値を返す', async () => {
    await explains('テストを動かした OS の名前を求める `osName` のテストです。`/etc/os-release` がある場合に、`/usr/lib/os-release` を読まずにその `PRETTY_NAME` を返すことを確認します。')
    const reader = stepSync('2 つの os-release を用意する', () => fakeReader({ [ETC]: 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n', [USR_LIB]: 'PRETTY_NAME="Other"\n' }))
    const name = stepSync('OS の名前を求める', () => osName(reader.read))
    stepSync('名前と読んだファイルを比べる', () => {
      expect(name).toBe('Ubuntu 24.04.3 LTS')
      expect(reader.calls).toEqual([ETC])
    })
  })

  it('/etc/os-release が存在しないと、/usr/lib/os-release の PRETTY_NAME の値を返す', async () => {
    await explains('テストを動かした OS の名前を求める `osName` のテストです。`/etc/os-release` が存在しない場合に、`/usr/lib/os-release` を読んでその `PRETTY_NAME` を返すことを確認します。')
    const reader = stepSync('/usr/lib/os-release だけを用意する', () => fakeReader({ [USR_LIB]: 'PRETTY_NAME=\'Debian GNU/Linux 12 (bookworm)\'\n' }))
    const name = stepSync('OS の名前を求める', () => osName(reader.read))
    stepSync('名前と読んだファイルを比べる', () => {
      expect(name).toBe('Debian GNU/Linux 12 (bookworm)')
      expect(reader.calls).toEqual([ETC, USR_LIB])
    })
  })

  it.for([
    { name: 'ダブルクオートとエスケープ', line: 'PRETTY_NAME="Say \\"Hi\\" \\$HOME \\`x\\` \\\\"', expected: 'Say "Hi" $HOME `x` \\' },
    { name: 'シングルクオート', line: 'PRETTY_NAME=\'Fedora Linux 43\'', expected: 'Fedora Linux 43' },
    { name: 'クオート無し', line: 'PRETTY_NAME=Alpine', expected: 'Alpine' },
  ])('PRETTY_NAME が $name の値だと、クオートとエスケープを外した値を返す', async ({ name, line, expected }) => {
    await explains(`os-release の \`PRETTY_NAME\` を読む \`osName\` のテストです。値が${name}で書かれた場合に、シェルの形のクオートとエスケープを外した値を返すことを確認します。`)
    const reader = stepSync('os-release を用意する', () => fakeReader({ [ETC]: `# comment\n${line}\n` }))
    stepSync('OS の名前を求めて比べる', () => {
      expect(osName(reader.read)).toBe(expected)
    })
  })

  it.for([
    { name: 'どちらの os-release も存在しない', files: {} },
    { name: 'PRETTY_NAME が存在しない', files: { [ETC]: 'NAME="Ubuntu"\n' } },
  ])('$name ときは、OS の種類と版をつないだ値を返す', async ({ name, files }) => {
    await explains(`テストを動かした OS の名前を求める \`osName\` のテストです。${name}場合に、\`os.type()\` と \`os.release()\` を空白でつないだ値を返すことを確認します。`)
    const reader = stepSync('os-release を用意する', () => fakeReader(files))
    stepSync('OS の名前を求めて比べる', () => {
      expect(osName(reader.read)).toBe(`${os.type()} ${os.release()}`)
    })
  })
})

describe('allureReporterConfig', () => {
  it('NX_TASK_TARGET_TARGET が設定されていないと、Allure の reporter の設定を返さない', async () => {
    await explains('Allure の reporter の設定を作成する `allureReporterConfig` のテストです。`NX_TASK_TARGET_TARGET` が設定されていない場合に、設定を返さず `undefined` になることを確認します。')
    stepSync('設定を作り、未定義かを比べる', () => {
      expect(allureReporterConfig(ROOT, { NX_TASK_TARGET_PROJECT: 'pecot-tools' })).toBeUndefined()
    })
  })

  it('NX_TASK_TARGET_TARGET が空文字だと、Allure の reporter の設定を返さない', async () => {
    await explains('Allure の reporter の設定を作成する `allureReporterConfig` のテストです。`NX_TASK_TARGET_TARGET` が空文字の場合に、設定を返さず `undefined` になることを確認します。')
    stepSync('設定を作り、未定義かを比べる', () => {
      expect(allureReporterConfig(ROOT, { ...NX_ENV, NX_TASK_TARGET_TARGET: '' })).toBeUndefined()
    })
  })

  it('Allure の結果の出力先を、project の root の下の test-results/<target>/allure-results にする', async () => {
    await explains('Allure の結果ファイルの出力先を決める、`allureReporterConfig` のテストです。nx の環境変数が設定されている場合に、出力先が project の root の下の `test-results/test-cli/allure-results` になることを確認します。')
    stepSync('設定を作り、結果の置き場を比べる', () => {
      expect(allureReporterConfig(ROOT, NX_ENV)?.resultsDir).toBe(path.join(ROOT, 'test-results', 'test-cli', 'allure-results'))
    })
  })

  it('project・lane のラベルと、project の名前の epic と、Node.js の版のラベルを付ける', async () => {
    await explains('Allure の結果に付けるラベルを決める、`allureReporterConfig` のテストです。nx の task の環境変数の値が `project`・`lane`・`epic` のラベルに、テストを動かした版が `Node.js` のラベルに設定されることを確認します。')
    stepSync('設定を作り、グローバルラベルを比べる', () => {
      expect(allureReporterConfig(ROOT, NX_ENV)?.globalLabels).toEqual([
        { name: 'project', value: 'pecot-tools' },
        { name: 'lane', value: 'test-cli' },
        { name: 'epic', value: 'pecot-tools' },
        { name: 'Node.js', value: process.version },
      ])
    })
  })

  it('書き出す前の結果に feature と story を足す listener を 1 つ渡す', async () => {
    await explains('Allure の結果を書き出す前に呼ぶ listener を決める、`allureReporterConfig` のテストです。`beforeTestResultWrite` を持つ listener が 1 つ設定されることを確認します。')
    const listeners = stepSync('設定を作る', () => allureReporterConfig(ROOT, NX_ENV)?.listeners)
    stepSync('listener を比べる', () => {
      expect(listeners).toHaveLength(1)
      expect(listeners?.[0]?.beforeTestResultWrite).toBeTypeOf('function')
    })
  })

  it('レポートのメタデータに、OS の名前と Node.js の版を渡す', async () => {
    await explains('実行全体で同じ環境の値を決める、`allureReporterConfig` のテストです。`environmentInfo` に、`osName` の値の `OS` と、`Node.js` の版が設定されることを確認します。')
    const config = stepSync('設定を作る', () => allureReporterConfig(ROOT, NX_ENV))
    stepSync('environmentInfo を比べる', () => {
      expect(config?.environmentInfo).toEqual({ 'OS': osName(), 'Node.js': process.version })
    })
  })

  it('PECOT_REPORT_SITE_URL が設定されていないと、tms のリンクを手元のサイトに向ける', async () => {
    await explains('テスト管理システムへのリンク（`tms`）を決める、`allureReporterConfig` のテストです。`PECOT_REPORT_SITE_URL` が設定されていない場合に、URL が `http://localhost:8000/permalink.html?id=%s` になることを確認します。')
    stepSync('設定を作り、tms のリンクを比べる', () => {
      expect(allureReporterConfig(ROOT, NX_ENV)?.links).toEqual({
        tms: { urlTemplate: 'http://localhost:8000/permalink.html?id=%s', nameTemplate: '%s' },
      })
    })
  })

  it('PECOT_REPORT_SITE_URL が設定されていると、tms のリンクをその URL に向ける', async () => {
    await explains('テスト管理システムへのリンク（`tms`）を決める、`allureReporterConfig` のテストです。`PECOT_REPORT_SITE_URL` に URL を設定した場合に、リンクの URL がその URL の `permalink.html?id=%s` になることを確認します。')
    const config = stepSync('設定を作る', () => allureReporterConfig(ROOT, { ...NX_ENV, PECOT_REPORT_SITE_URL: 'https://example.github.io/pecot/' }))
    stepSync('tms のリンクを比べる', () => {
      expect(config?.links?.tms?.urlTemplate).toBe('https://example.github.io/pecot/permalink.html?id=%s')
    })
  })

  it('PECOT_REPORT_SITE_URL が空文字だと、tms のリンクを手元のサイトに向ける', async () => {
    await explains('テスト管理システムへのリンク（`tms`）を決める、`allureReporterConfig` のテストです。`PECOT_REPORT_SITE_URL` が空文字の場合に、`http://localhost:8000/permalink.html?id=%s` になることを確認します。')
    const config = stepSync('設定を作る', () => allureReporterConfig(ROOT, { ...NX_ENV, PECOT_REPORT_SITE_URL: '' }))
    stepSync('tms のリンクを比べる', () => {
      expect(config?.links?.tms?.urlTemplate).toBe('http://localhost:8000/permalink.html?id=%s')
    })
  })

  it('PECOT_REPORT_SITE_URL の末尾に / が含まれていないと、/ を補ってリンクを作成する', async () => {
    await explains('テスト管理システムへのリンク（`tms`）を決める、`allureReporterConfig` のテストです。`PECOT_REPORT_SITE_URL` の末尾に `/` が含まれていない場合に、`/` を補った `…/pecot/permalink.html?id=%s` になることを確認します。')
    const config = stepSync('設定を作る', () => allureReporterConfig(ROOT, { ...NX_ENV, PECOT_REPORT_SITE_URL: 'https://example.github.io/pecot' }))
    stepSync('tms のリンクを比べる', () => {
      expect(config?.links?.tms?.urlTemplate).toBe('https://example.github.io/pecot/permalink.html?id=%s')
    })
  })
})

describe('allureReporter', () => {
  it('NX_TASK_TARGET_TARGET が設定されていないと、reporter を追加しない', async () => {
    await explains('vitest に追加する reporter を作成する `allureReporter` のテストです。`NX_TASK_TARGET_TARGET` が設定されていない場合に、空の配列を返すことを確認します。')
    stepSync('reporter を作り、空かを比べる', () => {
      expect(allureReporter(ROOT, { NX_TASK_TARGET_PROJECT: 'pecot-tools' })).toEqual([])
    })
  })

  it('NX_TASK_TARGET_TARGET が設定されていると、allure-vitest の reporter を、同じ環境変数から作った設定で 1 つ返す', async () => {
    await explains('vitest に追加する reporter を作成する `allureReporter` のテストです。`NX_TASK_TARGET_TARGET` が設定されている場合に、`allureReporterConfig` と同じ設定の reporter を 1 つ返すことを確認します。')
    const reporters = stepSync('reporter を作る', () => allureReporter(ROOT, NX_ENV))
    stepSync('結果を比べる', () => {
      expect(reporters).toHaveLength(1)
      expect(reporters[0]).toBeInstanceOf(AllureVitestReporter)
      expect(reporters[0]).toHaveProperty('config', allureReporterConfig(ROOT, NX_ENV))
    })
  })
})
