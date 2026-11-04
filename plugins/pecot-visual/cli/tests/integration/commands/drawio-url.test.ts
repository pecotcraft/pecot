// commands/drawio/url.ts の integration test。
// DI override で readFile をスタブし、view/edit、--json ON/OFF、エラー時の出力を網羅する。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DrawioUrlRuntimeError,
  DrawioUrlUsageError,
  createDrawioUrlCommand,
  drawioUrlDefaultDependencies,
  runDrawioUrl,
} from '../../../src/commands/drawio/url.js'
import type { LintText } from '../../../src/domain/_shared/text-check.js'
import { defaultLintText } from '../../../src/infra/text-lint.js'

const failingLintText: LintText = () => Promise.reject(new Error('辞書を読めません'))

// 違反文を literal で持たない。語を分けて組み立てる。
const HYPE = ['ゲーム', 'チェンジャー', 'となる基盤です。'].join('')

const HERE = import.meta.dirname
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const FIXTURES = path.resolve(HERE, '..', '..', 'fixtures', 'drawio')
const MINIMAL_FIXTURE = path.join(FIXTURES, 'minimal.drawio')
const ICON_INCLUDED_FIXTURE = path.join(FIXTURES, 'icon-included.drawio')
// 未解決 icon 2 種（うち 1 種は 2 つの mxCell から参照）。警告の dedupe 粒度を pin する。
const ICON_UNRESOLVED_MULTI_FIXTURE = path.join(FIXTURES, 'icon-unresolved-multi.drawio')
// 生成 URL が 8,000 文字超になる大型 fixture（長大 URL の欠損検知用）。icon:// 13 件を含む。
// スキルの samples は見た目の規範で入れ替わるため、サイズ条件はテスト専用 fixture で担保する。
const LONG_URL_FIXTURE = path.join(FIXTURES, 'long-url.drawio')

interface CapturedStream {
  readonly chunks: string[]
  write: (data: string) => boolean
}

function makeStream(): CapturedStream {
  const chunks: string[] = []
  return {
    chunks,
    write(data: string): boolean {
      chunks.push(data)
      return true
    },
  }
}

const META_REFRESH_REGEX = /<meta http-equiv="refresh" content="0;url=([^"]*)">/
const TARGET_ANCHOR_REGEX = /<a id="target" href="([^"]*)">/

/**
表示用 HTML が URL を持つ 2 箇所（meta refresh / 可視リンク）から URL を取り出し、
HTML 属性エスケープを戻す。長大 URL の途中欠損はここで byte 比較して検出する。
*/
function extractUrls(html: string): readonly [string, string] {
  const meta = META_REFRESH_REGEX.exec(html)?.[1]
  const anchor = TARGET_ANCHOR_REGEX.exec(html)?.[1]
  if (meta === undefined || anchor === undefined) {
    throw new Error('表示用 HTML から URL を取り出せません')
  }
  return [unescapeHtmlAttribute(meta), unescapeHtmlAttribute(anchor)]
}

function unescapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- write を持つ stub
function asStream(captured: CapturedStream): NodeJS.WritableStream {
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream として narrowing
  return captured as unknown as NodeJS.WritableStream
}

function buildDependencies(overrides: Partial<{
  readonly readFile: (filePath: string) => Promise<string>
  readonly writeFile: (filePath: string, content: string) => Promise<void>
  readonly capturePng: (xmlString: string, outputPath: string, fonts: readonly string[]) => Promise<void>
  readonly lintText: LintText
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly pluginRoot: string
}> = {}): ReturnType<typeof drawioUrlDefaultDependencies> {
  return {
    pluginRoot: overrides.pluginRoot ?? PLUGIN_ROOT,
    stdout: overrides.stdout ?? asStream(makeStream()),
    stderr: overrides.stderr ?? asStream(makeStream()),
    readFile: overrides.readFile ?? ((filePath: string) => Promise.resolve(readFileSync(filePath, 'utf8'))),
    writeFile: overrides.writeFile ?? ((filePath: string, content: string) => fsWriteFile(filePath, content, 'utf8')),
    capturePng: overrides.capturePng ?? (() => Promise.resolve()),
    lintText: overrides.lintText ?? defaultLintText,
    now: () => 0,
  }
}

describe('runDrawioUrl', () => {
  it('minimal fixture から URL を生成する (view)', async () => {
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', json: false, png: true },
      buildDependencies(),
    )
    expect(summary.url.startsWith('https://app.diagrams.net/?viewbox=')).toBe(true)
    expect(summary.url).toContain('#R')
    expect(summary.mode).toBe('view')
    expect(summary.inputFile).toBe(MINIMAL_FIXTURE)
  })

  it('mode は view と edit で同一 URL を返す（no-op）', async () => {
    const view = await runDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', json: false, png: true }, buildDependencies())
    const edit = await runDrawioUrl(MINIMAL_FIXTURE, { mode: 'edit', json: false, png: true }, buildDependencies())
    expect(view.url).toBe(edit.url)
  })

  it('入力ファイル不存在で DrawioUrlRuntimeError(input-not-found) を投げる', async () => {
    await expect(runDrawioUrl(
      '/nonexistent/path/file.drawio',
      { mode: 'view', json: false, png: true },
      buildDependencies(),
    )).rejects.toThrow(DrawioUrlRuntimeError)
  })

  it('HTML 警告は stderr に流れ、warningCount に反映される', async () => {
    const stderr = makeStream()
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', json: false, png: true },
      buildDependencies({
        stderr: asStream(stderr),
        // 警告を発生させる XML をスタブ経由で渡す
        readFile: () => Promise.resolve(`<root><mxCell id="x" style="fontFamily=sans-serif;" value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;"/></root>`),
      }),
    )
    expect(stderr.chunks.join('')).toContain('非対応属性')
    expect(summary.warningCount).toBe(1)
  })

  it('whiteSpace=wrap 抜け XML で stderr に [warn] を出し、warningCount に反映される', async () => {
    const stderr = makeStream()
    const wrapMissingXml = `<root><mxCell id="cellA" vertex="1" style="rounded=1;fillColor=#fff;fontFamily=sans-serif;" value="日本語テキスト"/></root>`
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', json: false, png: true },
      buildDependencies({
        stderr: asStream(stderr),
        readFile: () => Promise.resolve(wrapMissingXml),
      }),
    )
    expect(stderr.chunks.join('')).toContain('whiteSpace=wrap')
    expect(stderr.chunks.join('')).toContain('mxCell id=cellA')
    expect(summary.warningCount).toBe(1)
  })

  it('whiteSpace=wrap 付き XML では wrap 警告が出ない', async () => {
    const stderr = makeStream()
    const wrapPresentXml = `<root><mxCell id="cellA" vertex="1" style="rounded=1;whiteSpace=wrap;fillColor=#fff;fontFamily=sans-serif;" value="日本語テキスト"/></root>`
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', json: false, png: true },
      buildDependencies({
        stderr: asStream(stderr),
        readFile: () => Promise.resolve(wrapPresentXml),
      }),
    )
    expect(stderr.chunks.join('')).not.toContain('whiteSpace=wrap')
    expect(summary.warningCount).toBe(0)
  })

  it('icon が見つからない時は stderr に警告を出し、warningCount に反映される', async () => {
    const stderr = makeStream()
    const summary = await runDrawioUrl(
      ICON_INCLUDED_FIXTURE,
      { mode: 'view', json: false, png: true },
      buildDependencies({ stderr: asStream(stderr) }),
    )
    const stderrText = stderr.chunks.join('')
    expect(stderrText.match(/アイコンが見つかりません/g)).toHaveLength(1)
    expect(summary.warningCount).toBe(1)
  })

  it('未解決 icon の警告はアイコン 1 種につき 1 件に畳まれる', async () => {
    const stderr = makeStream()
    const summary = await runDrawioUrl(
      ICON_UNRESOLVED_MULTI_FIXTURE,
      { mode: 'view', json: false, png: true },
      buildDependencies({ stderr: asStream(stderr) }),
    )
    const stderrText = stderr.chunks.join('')
    expect(stderrText.match(/アイコンが見つかりません/g)).toHaveLength(2)
    expect(summary.warningCount).toBe(2)
  })

  it('警告無しの正常系では warningCount が 0', async () => {
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', json: false, png: true },
      buildDependencies(),
    )
    expect(summary.warningCount).toBe(0)
  })
})

describe('createDrawioUrlCommand', () => {
  it('--json 成功時に drawio.url.done を stdout に出す', async () => {
    const stdout = makeStream()
    const command = createDrawioUrlCommand(() => buildDependencies({ stdout: asStream(stdout) }))
    await command.parseAsync([MINIMAL_FIXTURE, '--json'], { from: 'user' })
    const lines = stdout.chunks.join('').trim().split('\n').filter(l => l.length > 0)
    const last = lines.at(-1) ?? ''
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りを narrowing
    const parsed = JSON.parse(last) as { event: string, url: string }
    expect(parsed.event).toBe('drawio.url.done')
    expect(parsed.url.startsWith('https://app.diagrams.net/')).toBe(true)
  })

  it('--json なしでは URL を 1 行で stdout に出す', async () => {
    const stdout = makeStream()
    const command = createDrawioUrlCommand(() => buildDependencies({ stdout: asStream(stdout) }))
    await command.parseAsync([MINIMAL_FIXTURE], { from: 'user' })
    const written = stdout.chunks.join('')
    expect(written.startsWith('https://app.diagrams.net/')).toBe(true)
    expect(written.endsWith('\n')).toBe(true)
  })

  it('--mode edit でも 0 終了する', async () => {
    const stdout = makeStream()
    const command = createDrawioUrlCommand(() => buildDependencies({ stdout: asStream(stdout) }))
    const previousExit = process.exitCode
    // テスト前に exitCode をリセットして、前のテストの遺残を観測しないようにする
    process.exitCode = undefined
    try {
      await command.parseAsync([MINIMAL_FIXTURE, '--mode', 'edit'], { from: 'user' })
      // 成功時は exitCode を一度も設定しないので undefined のまま
      expect(process.exitCode).toBe(undefined)
    }
    finally {
      process.exitCode = previousExit
    }
  })

  it('不正 mode + --json で drawio.url.error(invalid-mode) + exit 2', async () => {
    const stdout = makeStream()
    const command = createDrawioUrlCommand(() => buildDependencies({ stdout: asStream(stdout) }))
    const previousExit = process.exitCode
    try {
      await command.parseAsync([MINIMAL_FIXTURE, '--mode', 'preview', '--json'], { from: 'user' })
      const last = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
      const parsed = JSON.parse(last) as { event: string, reason: string }
      expect(parsed.event).toBe('drawio.url.error')
      expect(parsed.reason).toBe('invalid-mode')
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExit
    }
  })

  it('不正 mode + --json なしは stderr にメッセージ + exit 2', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createDrawioUrlCommand(() => buildDependencies({
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))
    const previousExit = process.exitCode
    try {
      await command.parseAsync([MINIMAL_FIXTURE, '--mode', 'preview'], { from: 'user' })
      expect(stderr.chunks.join('')).toContain('pecotv drawio url:')
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExit
    }
  })

  it('入力ファイル不存在 + --json で drawio.url.error(input-not-found) + exit 1', async () => {
    const stdout = makeStream()
    const command = createDrawioUrlCommand(() => buildDependencies({ stdout: asStream(stdout) }))
    const previousExit = process.exitCode
    try {
      await command.parseAsync(['/no/such/file.drawio', '--json'], { from: 'user' })
      const last = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
      const parsed = JSON.parse(last) as { event: string, reason: string }
      expect(parsed.event).toBe('drawio.url.error')
      expect(parsed.reason).toBe('input-not-found')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExit
    }
  })

  it('入力ファイル不存在 + --json なしは stderr に流れる + exit 1', async () => {
    const stderr = makeStream()
    const command = createDrawioUrlCommand(() => buildDependencies({ stderr: asStream(stderr) }))
    const previousExit = process.exitCode
    try {
      await command.parseAsync(['/no/such/file.drawio'], { from: 'user' })
      expect(stderr.chunks.join('')).toContain('pecotv drawio url:')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExit
    }
  })

  it('文面の違反 + --json で text-violation と violations の全件を出し、HTML を書かず exit 1', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pecotv-drawio-text-'))
    const stdout = makeStream()
    const previousExit = process.exitCode
    try {
      const input = path.join(directory, 'd.drawio')
      await fsWriteFile(input, `<mxfile><diagram id="d" name="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n1" value="${HYPE}" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>`, 'utf8')
      const output = path.join(directory, 'd.drawio.html')
      const command = createDrawioUrlCommand(() => buildDependencies({ stdout: asStream(stdout) }))
      await command.parseAsync([input, '-o', output, '--no-png', '--json'], { from: 'user' })
      const last = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
      const parsed = JSON.parse(last) as { event: string, reason: string, detail: string, violations: { item: string, ruleId: string, text: string }[] }
      expect(parsed.event).toBe('drawio.url.error')
      expect(parsed.reason).toBe('text-violation')
      expect(parsed.violations).toMatchObject([{ item: 'mxCell id="n1"', ruleId: 'no-ai-hype-expressions', text: HYPE }])
      expect(parsed.detail).toContain('mxCell id="n1"')
      expect(existsSync(output)).toBe(false)
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExit
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('文面の違反 + --json なしは stderr に違反を列挙し exit 1', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pecotv-drawio-text-'))
    const stderr = makeStream()
    const previousExit = process.exitCode
    try {
      const input = path.join(directory, 'd.drawio')
      await fsWriteFile(input, `<mxfile><diagram id="d" name="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n1" value="${HYPE}" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>`, 'utf8')
      const command = createDrawioUrlCommand(() => buildDependencies({ stderr: asStream(stderr) }))
      await command.parseAsync([input], { from: 'user' })
      const written = stderr.chunks.join('')
      expect(written).toContain('pecotv drawio url: 文面の違反 1 件')
      expect(written).toContain('mxCell id="n1"')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExit
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('確認器が失敗したら text-lint-failed を投げ、violations を持たない', async () => {
    await expect(
      runDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', json: false, png: false }, buildDependencies({ lintText: failingLintText })),
    ).rejects.toMatchObject({
      name: 'DrawioUrlRuntimeError',
      reason: 'text-lint-failed',
      violations: undefined,
    })
    await expect(
      runDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', json: false, png: false }, buildDependencies({ lintText: failingLintText })),
    ).rejects.toThrow('辞書を読めません')
  })

  it('argument 未指定 + --json で commander が drawio.url.error(invalid-option) を stdout に出す', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createDrawioUrlCommand(() => buildDependencies({
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))
    const originalArgv = process.argv
    process.argv = ['node', 'cli.js', 'drawio', 'url', '--json']
    try {
      await expect(command.parseAsync(['--json'], { from: 'user' })).rejects.toThrow()
      const written = stdout.chunks.join('').trim()
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
      const parsed = JSON.parse(written) as { event: string, reason: string }
      expect(parsed.event).toBe('drawio.url.error')
      expect(parsed.reason).toBe('invalid-option')
      expect(stderr.chunks.length).toBe(0)
    }
    finally {
      process.argv = originalArgv
    }
  })

  it('argument 未指定 + --json なしは commander が stderr に英文を出す', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createDrawioUrlCommand(() => buildDependencies({
      stdout: asStream(stdout),
      stderr: asStream(stderr),
    }))
    const originalArgv = process.argv
    process.argv = ['node', 'cli.js', 'drawio', 'url']
    try {
      await expect(command.parseAsync([], { from: 'user' })).rejects.toThrow()
      expect(stderr.chunks.join('')).toContain('argument')
      expect(stdout.chunks.length).toBe(0)
    }
    finally {
      process.argv = originalArgv
    }
  })

  describe('警告時 exit code (3)', () => {
    const WARN_XML = `<root><mxCell id="x" style="fontFamily=sans-serif;" value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;"/></root>`

    it('警告ありの XML で stdout ルートでは exit 3', async () => {
      const stdout = makeStream()
      const stderr = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({
        stdout: asStream(stdout),
        stderr: asStream(stderr),
        readFile: () => Promise.resolve(WARN_XML),
      }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE], { from: 'user' })
        expect(process.exitCode).toBe(3)
        expect(stdout.chunks.join('').startsWith('https://app.diagrams.net/')).toBe(true)
        expect(stderr.chunks.join('')).toContain('[warn]')
      }
      finally {
        process.exitCode = previousExit
      }
    })

    it('警告ありの XML で --json ルートでは warnings:1 + exit 3', async () => {
      const stdout = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({
        stdout: asStream(stdout),
        readFile: () => Promise.resolve(WARN_XML),
      }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE, '--json'], { from: 'user' })
        const last = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
        // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
        const parsed = JSON.parse(last) as { event: string, url: string, warnings: number }
        expect(parsed.event).toBe('drawio.url.done')
        expect(parsed.warnings).toBe(1)
        expect(process.exitCode).toBe(3)
      }
      finally {
        process.exitCode = previousExit
      }
    })

    it('警告ありの XML で -o ルートではファイル書き出し成功 + exit 3', async () => {
      const workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-warn-test-'))
      const outPath = path.join(workDirectory, 'out.drawio.html')
      const stdout = makeStream()
      const stderr = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({
        stdout: asStream(stdout),
        stderr: asStream(stderr),
        readFile: () => Promise.resolve(WARN_XML),
      }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath], { from: 'user' })
        const written = readFileSync(outPath, 'utf8')
        for (const url of extractUrls(written)) {
          expect(url.startsWith('https://app.diagrams.net/')).toBe(true)
        }
        expect(process.exitCode).toBe(3)
      }
      finally {
        process.exitCode = previousExit
        rmSync(workDirectory, { recursive: true, force: true })
      }
    })

    it('whiteSpace=wrap 抜け XML で exit 3 + stderr に [warn]', async () => {
      const wrapMissingXml = `<root><mxCell id="cellA" vertex="1" style="rounded=1;fillColor=#fff;fontFamily=sans-serif;" value="日本語テキスト"/></root>`
      const stdout = makeStream()
      const stderr = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({
        stdout: asStream(stdout),
        stderr: asStream(stderr),
        readFile: () => Promise.resolve(wrapMissingXml),
      }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE], { from: 'user' })
        expect(process.exitCode).toBe(3)
        expect(stderr.chunks.join('')).toContain('[warn]')
        expect(stderr.chunks.join('')).toContain('whiteSpace=wrap')
      }
      finally {
        process.exitCode = previousExit
      }
    })

    it('whiteSpace=wrap 抜け XML で --json ルートでは warnings:1 + exit 3', async () => {
      const wrapMissingXml = `<root><mxCell id="cellA" vertex="1" style="rounded=1;fillColor=#fff;fontFamily=sans-serif;" value="日本語テキスト"/></root>`
      const stdout = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({
        stdout: asStream(stdout),
        readFile: () => Promise.resolve(wrapMissingXml),
      }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE, '--json'], { from: 'user' })
        const last = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
        // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
        const parsed = JSON.parse(last) as { event: string, warnings: number }
        expect(parsed.event).toBe('drawio.url.done')
        expect(parsed.warnings).toBe(1)
        expect(process.exitCode).toBe(3)
      }
      finally {
        process.exitCode = previousExit
      }
    })

    it('警告無しの正常系では exit code を変更しない (regression 防止)', async () => {
      const stdout = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({ stdout: asStream(stdout) }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE], { from: 'user' })
        expect(process.exitCode).toBe(undefined)
      }
      finally {
        process.exitCode = previousExit
      }
    })

    it('--json 警告無しでも warnings:0 が JSON に常時含まれる', async () => {
      const stdout = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({ stdout: asStream(stdout) }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE, '--json'], { from: 'user' })
        const last = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
        // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
        const parsed = JSON.parse(last) as { event: string, warnings: number }
        expect(parsed.warnings).toBe(0)
        expect(process.exitCode).toBe(undefined)
      }
      finally {
        process.exitCode = previousExit
      }
    })
  })

  describe('-o / --output オプション', () => {
    // 各ケースで一時ディレクトリを作って後始末する
    let workDirectory = ''

    afterEach(() => {
      if (workDirectory === '') {
        return
      }

      rmSync(workDirectory, { recursive: true, force: true })
      workDirectory = ''
    })

    it('-o 指定時 stdout は空、stderr に wrote HTML、ファイルは表示用 HTML', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-test-'))
      const outPath = path.join(workDirectory, 'out.drawio.html')
      const stdout = makeStream()
      const stderr = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({
        stdout: asStream(stdout),
        stderr: asStream(stderr),
      }))
      await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath], { from: 'user' })
      expect(stdout.chunks.join('')).toBe('')
      expect(stderr.chunks.join('')).toBe(`wrote HTML to ${outPath}\n`)
      const written = readFileSync(outPath, 'utf8')
      expect(written.startsWith('<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n')).toBe(true)
      for (const url of extractUrls(written)) {
        expect(url.startsWith('https://app.diagrams.net/?viewbox=')).toBe(true)
      }
      expect(written.endsWith('</html>\n')).toBe(true)
      expect(written).not.toContain('\r')
    })

    it('-o + --json 指定時 stdout に {event,file} (url キーなし)、ファイルは表示用 HTML', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-test-'))
      const outPath = path.join(workDirectory, 'out.drawio.html')
      const stdout = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({ stdout: asStream(stdout) }))
      await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath, '--json'], { from: 'user' })
      const written = stdout.chunks.join('').trim()
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
      const parsed = JSON.parse(written) as Record<string, unknown>
      expect(parsed['event']).toBe('drawio.url.done')
      expect(parsed['file']).toBe(outPath)
      expect(Object.prototype.hasOwnProperty.call(parsed, 'url')).toBe(false)
      const fileContent = readFileSync(outPath, 'utf8')
      for (const url of extractUrls(fileContent)) {
        expect(url.startsWith('https://app.diagrams.net/?viewbox=')).toBe(true)
      }
      expect(fileContent.endsWith('</html>\n')).toBe(true)
    })

    it('-o の拡張子が .html でないと exit 2 で落ち、ファイルを書き出さない', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-test-'))
      const outPath = path.join(workDirectory, 'out.txt')
      const stderr = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({ stderr: asStream(stderr) }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath, '--no-png'], { from: 'user' })
        expect(stderr.chunks.join('')).toContain('pecotv drawio url:')
        expect(stderr.chunks.join('')).toContain('.html')
        expect(process.exitCode).toBe(2)
        expect(existsSync(outPath)).toBe(false)
      }
      finally {
        process.exitCode = previousExit
      }
    })

    // 旧規約 (.url = InternetShortcut) の呼び出しが警告なしに通ると、中身が HTML の
    // ファイルに .url が付いたまま配布される。名指しで exit 2 を pin する。
    it('旧規約の -o *.drawio.url は exit 2 で弾かれ .url を残さない', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-test-'))
      const outPath = path.join(workDirectory, 'out.drawio.url')
      const stderr = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({ stderr: asStream(stderr) }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath, '--no-png'], { from: 'user' })
        expect(process.exitCode).toBe(2)
        expect(existsSync(outPath)).toBe(false)
      }
      finally {
        process.exitCode = previousExit
      }
    })

    it('-o に拡張子が無い場合も exit 2 で弾かれる', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-test-'))
      const outPath = path.join(workDirectory, 'foo')
      const command = createDrawioUrlCommand(() => buildDependencies())
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath, '--no-png'], { from: 'user' })
        expect(process.exitCode).toBe(2)
        expect(existsSync(outPath)).toBe(false)
      }
      finally {
        process.exitCode = previousExit
      }
    })

    it('--json 併用時の拡張子エラーは reason invalid-output-extension で stdout に出る', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-test-'))
      const outPath = path.join(workDirectory, 'out.drawio.url')
      const stdout = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({ stdout: asStream(stdout) }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath, '--no-png', '--json'], { from: 'user' })
        // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
        const parsed = JSON.parse(stdout.chunks.join('').trim()) as Record<string, unknown>
        expect(parsed['event']).toBe('drawio.url.error')
        expect(parsed['reason']).toBe('invalid-output-extension')
        expect(process.exitCode).toBe(2)
      }
      finally {
        process.exitCode = previousExit
      }
    })

    it('-o の拡張子が .html なら拡張子由来の [warn] は出ない', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-test-'))
      const outPath = path.join(workDirectory, 'out.drawio.html')
      const stderr = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({ stderr: asStream(stderr) }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath, '--no-png'], { from: 'user' })
        expect(stderr.chunks.join('')).not.toContain('[warn]')
        expect(process.exitCode).toBe(undefined)
      }
      finally {
        process.exitCode = previousExit
      }
    })

    it('--output (long form) は -o と byte 一致する出力を生成する', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-test-'))
      const shortPath = path.join(workDirectory, 'short.drawio.html')
      const longPath = path.join(workDirectory, 'long.drawio.html')
      const shortCommand = createDrawioUrlCommand(() => buildDependencies())
      await shortCommand.parseAsync([MINIMAL_FIXTURE, '-o', shortPath], { from: 'user' })
      const longCommand = createDrawioUrlCommand(() => buildDependencies())
      await longCommand.parseAsync([MINIMAL_FIXTURE, '--output', longPath], { from: 'user' })
      const shortContent = readFileSync(shortPath, 'utf8')
      const longContent = readFileSync(longPath, 'utf8')
      expect(longContent).toBe(shortContent)
    })

    it('長大 URL (8,000 文字超) でも表示用 HTML の 2 箇所に欠損なく書き出される', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-long-test-'))
      const outPath = path.join(workDirectory, 'long-url.drawio.html')

      // 書き出し先ファイルと同じ生成ロジック (generateDrawioUrl) を通して URL 本体を取得する。
      const summary = await runDrawioUrl(LONG_URL_FIXTURE, { mode: 'view', json: false, png: false }, buildDependencies())
      expect(summary.url.length).toBeGreaterThan(8000)

      const command = createDrawioUrlCommand(() => buildDependencies())
      await command.parseAsync([LONG_URL_FIXTURE, '-o', outPath, '--no-png'], { from: 'user' })

      const written = readFileSync(outPath, 'utf8')
      // meta refresh と可視リンクの両方が生成 URL と byte 一致する（途中欠損が無い）ことを pin する。
      const [metaUrl, anchorUrl] = extractUrls(written)
      expect(metaUrl).toBe(summary.url)
      expect(anchorUrl).toBe(summary.url)
      expect(metaUrl).toBe(anchorUrl)
    })

    it('書き込み不能な path 指定時 exit 1 / reason output-write-failed', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-test-'))
      const badPath = path.join(workDirectory, 'nonexistent-dir', 'out.drawio.html')
      const stdout = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({ stdout: asStream(stdout) }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE, '-o', badPath, '--json'], { from: 'user' })
        const last = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
        // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
        const parsed = JSON.parse(last) as { event: string, reason: string }
        expect(parsed.event).toBe('drawio.url.error')
        expect(parsed.reason).toBe('output-write-failed')
        expect(process.exitCode).toBe(1)
      }
      finally {
        process.exitCode = previousExit
      }
    })
  })

  describe('--no-png / PNG 出力', () => {
    let workDirectory = ''

    afterEach(() => {
      if (workDirectory === '') {
        return
      }

      rmSync(workDirectory, { recursive: true, force: true })
      workDirectory = ''
    })

    it('-o + 既定 (--png) で capturePng が <-o path 拡張子置換>.png 引数で呼ばれる', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-png-test-'))
      const outPath = path.join(workDirectory, 'out.drawio.html')
      const expectedPngPath = path.join(workDirectory, 'out.drawio.png')
      const capturePng = vi.fn<(xmlString: string, outputPath: string, fonts: readonly string[]) => Promise<void>>(() => Promise.resolve())
      const command = createDrawioUrlCommand(() => buildDependencies({ capturePng }))
      await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath], { from: 'user' })
      expect(capturePng).toHaveBeenCalledTimes(1)
      const call = capturePng.mock.calls[0]
      // 第 1 引数は viewerUrl ではなく入力 XML 文字列 (embed.diagrams.net に post message で渡すため)
      expect(call?.[0]).toMatch(/<mxfile/)
      expect(call?.[1]).toBe(expectedPngPath)
    })

    it('-o diagram.drawio.html は diagram.drawio.png に拡張子置換される（最後の拡張子のみ置換）', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-png-test-'))
      const outPath = path.join(workDirectory, 'diagram.drawio.html')
      const expectedPngPath = path.join(workDirectory, 'diagram.drawio.png')
      const capturePng = vi.fn<(xmlString: string, outputPath: string, fonts: readonly string[]) => Promise<void>>(() => Promise.resolve())
      const command = createDrawioUrlCommand(() => buildDependencies({ capturePng }))
      await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath], { from: 'user' })
      expect(capturePng).toHaveBeenCalledTimes(1)
      expect(capturePng.mock.calls[0]?.[1]).toBe(expectedPngPath)
    })

    it('-o 指定時に capturePng へ渡る XML は icon:// が data URI に解決済 (回帰防止)', async () => {
      // embed.diagrams.net editor は pecotv 独自スキーム `icon://` を解決できない。
      // このため capturePng へ渡す前の段階で、resolveIconsInStyle が data URI に変換する必要がある。
      // 変換し忘れると、editor 側で fallback アイコン (緑の画像破損マーク) が出る。
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-png-test-'))
      const outPath = path.join(workDirectory, 'out.drawio.html')
      const capturePng = vi.fn<(xmlString: string, outputPath: string, fonts: readonly string[]) => Promise<void>>(() => Promise.resolve())
      const command = createDrawioUrlCommand(() => buildDependencies({ capturePng }))
      await command.parseAsync([ICON_INCLUDED_FIXTURE, '-o', outPath], { from: 'user' })
      expect(capturePng).toHaveBeenCalledTimes(1)
      const passedXml = capturePng.mock.calls[0]?.[0] ?? ''
      // 解決可能な icon (science/brain-circuit, weather/cloud) は data URI に置換されている
      expect(passedXml).toContain('data:image/svg+xml')
      // 解決済 icon の元参照は消えている
      expect(passedXml).not.toContain('icon://science/brain-circuit')
      expect(passedXml).not.toContain('icon://weather/cloud')
    })

    it('拡張子ガードで弾かれた -o では capturePng も呼ばれない', async () => {
      // PNG は表示用 HTML の兄弟ファイルなので、HTML を書かない実行では PNG も作らない。
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-png-test-'))
      const outPath = path.join(workDirectory, 'out.tar.gz')
      const capturePng = vi.fn<(xmlString: string, outputPath: string, fonts: readonly string[]) => Promise<void>>(() => Promise.resolve())
      const command = createDrawioUrlCommand(() => buildDependencies({ capturePng }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath], { from: 'user' })
        expect(capturePng).not.toHaveBeenCalled()
        expect(process.exitCode).toBe(2)
      }
      finally {
        process.exitCode = previousExit
      }
    })

    it('-o + --no-png で capturePng が呼ばれない', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-png-test-'))
      const outPath = path.join(workDirectory, 'out.drawio.html')
      const capturePng = vi.fn<(xmlString: string, outputPath: string, fonts: readonly string[]) => Promise<void>>(() => Promise.resolve())
      const command = createDrawioUrlCommand(() => buildDependencies({ capturePng }))
      await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath, '--no-png'], { from: 'user' })
      expect(capturePng).not.toHaveBeenCalled()
    })

    it('-o 未指定では capturePng が呼ばれない (stdout モードは PNG 抑止)', async () => {
      const capturePng = vi.fn<(xmlString: string, outputPath: string, fonts: readonly string[]) => Promise<void>>(() => Promise.resolve())
      const command = createDrawioUrlCommand(() => buildDependencies({ capturePng }))
      await command.parseAsync([MINIMAL_FIXTURE], { from: 'user' })
      expect(capturePng).not.toHaveBeenCalled()
    })

    it('capturePng reject 時 表示用 HTML は生成・stderr に warning・exit 3・--json で pngFailed:true / png:null', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-png-test-'))
      const outPath = path.join(workDirectory, 'out.drawio.html')
      const stdout = makeStream()
      const stderr = makeStream()
      const capturePng = vi.fn<(xmlString: string, outputPath: string, fonts: readonly string[]) => Promise<void>>(
        () => Promise.reject(new Error('chromium 未インストール')),
      )
      const command = createDrawioUrlCommand(() => buildDependencies({
        stdout: asStream(stdout),
        stderr: asStream(stderr),
        capturePng,
      }))
      const previousExit = process.exitCode
      process.exitCode = undefined
      try {
        await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath, '--json'], { from: 'user' })
        expect(capturePng).toHaveBeenCalledTimes(1)
        const written = readFileSync(outPath, 'utf8')
        for (const url of extractUrls(written)) {
          expect(url.startsWith('https://app.diagrams.net/')).toBe(true)
        }
        expect(stderr.chunks.join('')).toContain('[warn] PNG 生成失敗')
        expect(stderr.chunks.join('')).toContain('chromium 未インストール')
        const last = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
        // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
        const parsed = JSON.parse(last) as Record<string, unknown>
        expect(parsed['event']).toBe('drawio.url.done')
        expect(parsed['file']).toBe(outPath)
        // eslint-disable-next-line unicorn/no-null -- JSON スキーマで PNG 失敗時に `png: null` を pin する
        expect(parsed['png']).toBe(null)
        expect(parsed['pngFailed']).toBe(true)
        expect(parsed['warnings']).toBe(1)
        expect(process.exitCode).toBe(3)
      }
      finally {
        process.exitCode = previousExit
      }
    })

    it('-o + --json + --png 成功時に png:<拡張子置換後> + pngFailed:false', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-png-test-'))
      const outPath = path.join(workDirectory, 'out.drawio.html')
      const expectedPngPath = path.join(workDirectory, 'out.drawio.png')
      const stdout = makeStream()
      const capturePng = vi.fn<(xmlString: string, outputPath: string, fonts: readonly string[]) => Promise<void>>(() => Promise.resolve())
      const command = createDrawioUrlCommand(() => buildDependencies({
        stdout: asStream(stdout),
        capturePng,
      }))
      await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath, '--json'], { from: 'user' })
      const last = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
      const parsed = JSON.parse(last) as Record<string, unknown>
      expect(parsed['event']).toBe('drawio.url.done')
      expect(parsed['file']).toBe(outPath)
      expect(parsed['png']).toBe(expectedPngPath)
      expect(parsed['pngFailed']).toBe(false)
      expect(parsed['warnings']).toBe(0)
    })

    it('-o + --no-png + --json では png / pngFailed キーが省略される', async () => {
      workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-png-test-'))
      const outPath = path.join(workDirectory, 'out.drawio.html')
      const stdout = makeStream()
      const command = createDrawioUrlCommand(() => buildDependencies({ stdout: asStream(stdout) }))
      await command.parseAsync([MINIMAL_FIXTURE, '-o', outPath, '--no-png', '--json'], { from: 'user' })
      const last = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
      const parsed = JSON.parse(last) as Record<string, unknown>
      expect(parsed['event']).toBe('drawio.url.done')
      expect(Object.prototype.hasOwnProperty.call(parsed, 'png')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(parsed, 'pngFailed')).toBe(false)
    })
  })
})

describe('drawioUrlDefaultDependencies', () => {
  // vi.stubEnv は単発テストの終端で必ずクリアし、並列テストへ env が残らないようにする
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('CLAUDE_PLUGIN_ROOT を読んで pluginRoot を構築する', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/tmp/x')
    const dependencies = drawioUrlDefaultDependencies()
    expect(dependencies.pluginRoot).toBe('/tmp/x')
    expect(typeof dependencies.now()).toBe('number')
  })

  it('readFile が実ファイルを読める', async () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', PLUGIN_ROOT)
    const dependencies = drawioUrlDefaultDependencies()
    const text = await dependencies.readFile(MINIMAL_FIXTURE)
    expect(text).toContain('<mxfile>')
  })
})

// 例外型がコンストラクタ経由で reason を保持することを pin
describe('error types', () => {
  it('DrawioUrlUsageError は reason を保持する', () => {
    const error = new DrawioUrlUsageError('m', 'invalid-mode')
    expect(error.reason).toBe('invalid-mode')
    expect(error.name).toBe('DrawioUrlUsageError')
  })

  it('DrawioUrlRuntimeError は reason を保持する', () => {
    const error = new DrawioUrlRuntimeError('m', 'input-not-found')
    expect(error.reason).toBe('input-not-found')
    expect(error.name).toBe('DrawioUrlRuntimeError')
  })
})

// PECOTV_PLAYWRIGHT_AVAILABLE=1 環境でのみ動く、実 Chromium 経由の PNG smoke。
// devcontainer の通常 test 実行では skip し、`PECOTV_PLAYWRIGHT_AVAILABLE=1 pnpm ... test` で初めて評価される。
const IS_PLAYWRIGHT_AVAILABLE = process.env['PECOTV_PLAYWRIGHT_AVAILABLE'] === '1'
const playwrightOnlyDescribe = IS_PLAYWRIGHT_AVAILABLE ? describe : describe.skip

playwrightOnlyDescribe('capturePng smoke (実 embed.diagrams.net)', () => {
  it('日本語入り .drawio から PNG が生成され、非白ピクセル比率 > 1%', async () => {
    const { capturePng } = await import('../../../src/infra/drawio/screenshot.js')
    const workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-png-smoke-'))
    try {
      const xml = readFileSync(LONG_URL_FIXTURE, 'utf8')
      const outPath = path.join(workDirectory, 'smoke.png')
      await capturePng(xml, outPath, ['sans-serif'])
      const png = readFileSync(outPath)
      // PNG header 検証
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      // 非白ピクセル比率は単純化する。IDAT 圧縮後の byte size が 10 KB を超えていれば、
      // 描画コンテンツが豊富という proxy 指標として扱う (真の pixel 解凍は重いため避ける)。
      expect(png.byteLength).toBeGreaterThan(10_000)
      // XML 埋め込み PNG (draw.io 公式 .drawio.png) を確かめる。
      // tEXt チャンク keyword `mxfile` に XML が埋め込まれ、draw.io で開くと再編集できることを pin する。
      expect(png.includes(Buffer.from('tEXtmxfile\0'))).toBe(true)
    }
    finally {
      rmSync(workDirectory, { recursive: true, force: true })
    }
  }, 120_000)
})

function isDiagramsNet(url: Readonly<URL>): boolean {
  return url.hostname === 'app.diagrams.net'
}

playwrightOnlyDescribe('表示用 HTML の遷移 smoke (実 Chromium・file://)', () => {
  // app.diagrams.net へは出さず、ナビゲーション要求を stub で fulfill して遷移先 URL だけを見る。
  // 見るのは「file:// から開いて生成 URL へそのまま届くか」までで、描画の妥当性は対象外。
  // PECOTV_PLAYWRIGHT_AVAILABLE=1 を立てる処理は run-tests.sh と githooks に無い。
  // そのため常用の pre-push と scripts/ci/run-tests.sh では skip される。
  // 上の capturePng smoke と同じ扱いで受け入れ、実行はリリース前の手動確認に委ねる。
  const STUB_BODY = '<!doctype html><title>stub</title>'
  const NAVIGATION_TIMEOUT_MS = 15_000

  async function navigatedUrl(htmlPath: string, isJavaScriptEnabled: boolean): Promise<string> {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ javaScriptEnabled: isJavaScriptEnabled })
      const page = await context.newPage()
      await page.route(isDiagramsNet, async (route) => {
        await route.fulfill({ status: 200, contentType: 'text/html', body: STUB_BODY })
      })
      await page.goto(pathToFileURL(htmlPath).href)
      await page.waitForURL(isDiagramsNet, { timeout: NAVIGATION_TIMEOUT_MS })
      return page.url()
    }
    finally {
      await browser.close()
    }
  }

  it.each([
    { label: 'JS 有効 (location.replace)', javaScriptEnabled: true },
    // MOTW 等で JS が止まる環境でも meta refresh のフォールバック層が働くことを見る。
    { label: 'JS 無効 (meta refresh)', javaScriptEnabled: false },
  ])('$label で生成 URL へ byte 一致のまま遷移する', async ({ javaScriptEnabled }) => {
    const smokeDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-redirect-smoke-'))
    try {
      const outPath = path.join(smokeDirectory, 'smoke.drawio.html')
      const summary = await runDrawioUrl(LONG_URL_FIXTURE, { mode: 'view', json: false, png: false }, buildDependencies())
      const command = createDrawioUrlCommand(() => buildDependencies())
      await command.parseAsync([LONG_URL_FIXTURE, '-o', outPath, '--no-png'], { from: 'user' })

      expect(await navigatedUrl(outPath, javaScriptEnabled)).toBe(summary.url)
    }
    finally {
      rmSync(smokeDirectory, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('talk-dir の外で --theme 無し（本体の既定値）', () => {
  const SWIMLANE_SAMPLE = path.resolve(HERE, '..', '..', '..', '..', 'skills', 'v-drawio', 'references', 'poster', 'swimlane-flow', 'samples', 'swimlane-flow.drawio')
  // poster 相当（52px の sans-serif）と aws の iconLabel（11px・書体指定なし）
  const OFF_STEPS_XML = `<mxfile><diagram><mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="poster" vertex="1" parent="1" value="Title" style="text;html=1;fontFamily=sans-serif;fontSize=52;"><mxGeometry width="100" height="40" as="geometry"/></mxCell>
    <mxCell id="mono" vertex="1" parent="1" value="node" style="text;html=1;fontFamily='Noto Sans Mono', monospace;fontSize=14;"><mxGeometry width="100" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram></mxfile>`

  it('既定値の書体（sans-serif）と等幅の並びは、52px や 14px でも警告 0（サイズは確かめない）', async () => {
    const stderr = makeStream()
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', json: false, png: true },
      buildDependencies({ stderr: asStream(stderr), readFile: () => Promise.resolve(OFF_STEPS_XML) }),
    )
    expect(stderr.chunks.join('')).toBe('')
    expect(summary.warningCount).toBe(0)
    expect(summary.theme).toEqual({ source: 'default', fonts: { body: ['sans-serif'] } })
  })

  it('書体指定なし（draw.io 既定の Helvetica）は既定値でも警告する', async () => {
    const stderr = makeStream()
    const xml = OFF_STEPS_XML.replace('fontFamily=sans-serif;', '')
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', json: false, png: true },
      buildDependencies({ stderr: asStream(stderr), readFile: () => Promise.resolve(xml) }),
    )
    expect(summary.warningCount).toBe(1)
    expect(stderr.chunks.join('')).toContain('Helvetica')
    expect(stderr.chunks.join('')).toContain('既定の書体')
  })

  it('同梱の poster swimlane-flow 見本は警告 0', async () => {
    const stderr = makeStream()
    const summary = await runDrawioUrl(
      SWIMLANE_SAMPLE,
      { mode: 'view', json: false, png: true },
      buildDependencies({ stderr: asStream(stderr) }),
    )
    expect(stderr.chunks.join('')).toBe('')
    expect(summary.warningCount).toBe(0)
  })
})
