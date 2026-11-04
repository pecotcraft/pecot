import path from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createProgram, main } from '../cli.js'
import { suggestedNodeVersion } from '../node-runtime.js'
import { loadVersionFromPluginJson, readVersion } from '../version.js'

// 実行中の Node.js の版に結果を左右させないため、main() には許可される版を明示して渡す。
const allowedNodeVersion = suggestedNodeVersion()

async function withPluginRoot(version: string, function_: () => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'pecotv-plugin-root-'))
  // path is constructed from tmpdir() and a known suffix.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
  // path is constructed from tmpdir() and a known suffix.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pecot-v', version }))
  const previous = process.env['CLAUDE_PLUGIN_ROOT']
  process.env['CLAUDE_PLUGIN_ROOT'] = root
  try {
    await function_()
  }
  finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, 'CLAUDE_PLUGIN_ROOT')
    }
    else {
      process.env['CLAUDE_PLUGIN_ROOT'] = previous
    }
    rmSync(root, { recursive: true, force: true })
  }
}

function withEnvironment(value: string | undefined, function_: () => void): void {
  const previous = process.env['CLAUDE_PLUGIN_ROOT']
  if (value === undefined) {
    Reflect.deleteProperty(process.env, 'CLAUDE_PLUGIN_ROOT')
  }
  else {
    process.env['CLAUDE_PLUGIN_ROOT'] = value
  }
  try {
    function_()
  }
  finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, 'CLAUDE_PLUGIN_ROOT')
    }
    else {
      process.env['CLAUDE_PLUGIN_ROOT'] = previous
    }
  }
}

const GROUPS: readonly string[] = ['pptx', 'slide', 'drawio', 'evidence']

describe('pecotv CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('hello コマンドが stdout に正しい文字列を出力する', () => {
    const isWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const program = createProgram()
    program.exitOverride()
    program.parse(['node', 'cli.js', 'hello'])

    expect(isWriteSpy).toHaveBeenCalledWith('hello from pecotv (ts)\n')
  })

  it('--version が CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json の version を返す', async () => {
    await withPluginRoot('9.9.9', () => {
      const isWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const program = createProgram()
      program.exitOverride()
      try {
        try {
          program.parse(['node', 'cli.js', '--version'])
        }
        catch {
          // commander throws on --version with exitOverride
        }
        const calls = isWriteSpy.mock.calls.map(call => call[0]).join('')
        expect(calls.trim()).toBe('9.9.9')
      }
      finally {
        isWriteSpy.mockRestore()
      }
    })
  })

  it('main() は修正版未満の Node.js では案内を stderr に出し exitCode 1 で終える', () => {
    const writes: string[] = []
    const isStderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    const isStdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const originalArgv = process.argv
    const previousExit = process.exitCode
    process.argv = ['node', 'cli.js', 'hello']
    try {
      main('24.20.0')
      expect(process.exitCode).toBe(1)
      expect(writes.join('')).toContain('pecotv: Node.js 24.20.0 は既知の脆弱性の修正を含まない')
      expect(isStdoutSpy).not.toHaveBeenCalled()
    }
    finally {
      isStderrSpy.mockRestore()
      isStdoutSpy.mockRestore()
      process.argv = originalArgv
      process.exitCode = previousExit
    }
  })

  it('main() が process.argv をパースして hello を実行する', () => {
    const isWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const originalArgv = process.argv
    process.argv = ['node', 'cli.js', 'hello']
    try {
      main(allowedNodeVersion)
    }
    finally {
      process.argv = originalArgv
    }
    expect(isWriteSpy).toHaveBeenCalledWith('hello from pecotv (ts)\n')
  })

  it('main() は --version を CommanderError として捕捉し exitCode 0 を維持する', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const originalArgv = process.argv
    const previousExit = process.exitCode
    process.argv = ['node', 'cli.js', '--version']
    try {
      main(allowedNodeVersion)
      expect(process.exitCode).toBe(0)
    }
    finally {
      process.argv = originalArgv
      process.exitCode = previousExit
    }
  })

  it('pecotv slide --help は exit 0 + Usage を含む', () => {
    const isWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const originalArgv = process.argv
    const previousExit = process.exitCode
    process.argv = ['node', 'cli.js', 'slide', '--help']
    process.exitCode = undefined
    try {
      // group の --help は CommanderError (exitCode 0) として main() に捕捉される。
      // 素の process.exit ルートへ退行すると main() が exit 2 に変換してしまう。
      main(allowedNodeVersion)
      expect(process.exitCode).toBe(0)
      const out = isWriteSpy.mock.calls.map(c => c[0]).join('')
      expect(out).toContain('Usage:')
      expect(out).toContain('create')
      expect(out).toContain('convert')
    }
    finally {
      process.argv = originalArgv
      process.exitCode = previousExit
    }
  })

  it.each(GROUPS)('main() は %s の未知サブコマンドで exitCode 2 を立てる', (group) => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const isErrorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const originalArgv = process.argv
    const previousExit = process.exitCode
    process.argv = ['node', 'cli.js', group, 'bogus']
    // commander の help() は ambient な process.exitCode を引き継ぐ（command.js が未設定なら 0 として読む）。
    // この test は Command#error() 経由（exitCode 1 固定・ambient を読まない）で通る。
    // ただし他 test からの残留値の混入を防ぐため、防御的にクリアする。
    process.exitCode = undefined
    try {
      main(allowedNodeVersion)
      expect(process.exitCode).toBe(2)
      const errorOutput = isErrorSpy.mock.calls.map(c => String(c[0])).join('')
      expect(errorOutput).toContain('unknown command \'bogus\'')
    }
    finally {
      process.argv = originalArgv
      process.exitCode = previousExit
    }
  })

  it('pecotv --help は exit 0 + stdout に Usage を含み stderr 空', () => {
    const isWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const isErrorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const program = createProgram()
    program.exitOverride()
    try {
      program.parse(['node', 'cli.js', '--help'])
    }
    catch {
      // commander throws on --help with exitOverride
    }
    const out = isWriteSpy.mock.calls.map(c => c[0]).join('')
    expect(out).toContain('Usage:')
    expect(out).toContain('hello')
    expect(isErrorSpy).not.toHaveBeenCalled()
  })

  it('pecotv --help は evidence サブコマンドを説明文言つきで案内し stderr 空', () => {
    const isWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const isErrorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const program = createProgram()
    program.exitOverride()
    try {
      program.parse(['node', 'cli.js', '--help'])
    }
    catch {
      // commander throws on --help with exitOverride
    }
    const out = isWriteSpy.mock.calls.map(c => c[0]).join('')
    expect(out).toContain('evidence')
    expect(out).toContain('エビデンス xlsx に対する操作')
    expect(isErrorSpy).not.toHaveBeenCalled()
  })

  it('未知コマンドは exit 非ゼロ + stderr に error: unknown command を含む', () => {
    const program = createProgram()
    program.exitOverride()
    expect(() => program.parse(['node', 'cli.js', 'unknown-cmd'])).toThrow(/unknown command/i)
  })

  it('hello は stderr に何も書かない', () => {
    const isErrorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const program = createProgram()
    program.exitOverride()
    program.parse(['node', 'cli.js', 'hello'])
    expect(isErrorSpy).not.toHaveBeenCalled()
  })

  it('createProgram() を 2 回呼んでも独立したインスタンスを返す', () => {
    const a = createProgram()
    const b = createProgram()
    expect(a).not.toBe(b)
  })

  describe('readVersion', () => {
    it('CLAUDE_PLUGIN_ROOT 配下に plugin.json があれば version を返す', async () => {
      await withPluginRoot('1.2.3', () => {
        expect(readVersion()).toBe('1.2.3')
      })
    })

    it('CLAUDE_PLUGIN_ROOT が空文字列なら env ルートをスキップする（ルート 2 または dev）', () => {
      withEnvironment('', () => {
        // ルート 2 が実際の plugin.json を見つける場合は実際の version、なければ dev
        const version = readVersion()
        expect(typeof version).toBe('string')
        expect(version.length).toBeGreaterThan(0)
      })
    })

    it('plugin.json が存在しない CLAUDE_PLUGIN_ROOT では dev を返す', () => {
      // プラグインルートの決定は resolvePluginRoot() に一本化されており、env が立っていれば
      // そこで確定する（source 相対へは戻らない）。読めなければ既定値。
      const root = mkdtempSync(path.join(tmpdir(), 'pecotv-empty-root-'))
      withEnvironment(root, () => {
        try {
          expect(readVersion()).toBe('0.0.0+dev')
        }
        finally {
          rmSync(root, { recursive: true, force: true })
        }
      })
    })
  })

  describe('loadVersionFromPluginJson', () => {
    it('有効な plugin.json から version 文字列を返す', () => {
      const root = mkdtempSync(path.join(tmpdir(), 'pecotv-valid-'))
      // path is constructed from tmpdir() and a known suffix.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
      const manifestPath = path.join(root, '.claude-plugin', 'plugin.json')
      // path is constructed from tmpdir() and a known suffix.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      writeFileSync(manifestPath, JSON.stringify({ name: 'pecotv', version: '2.3.4' }))
      try {
        expect(loadVersionFromPluginJson(manifestPath)).toBe('2.3.4')
      }
      finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('plugin.json が JSON 不正なら undefined を返す', () => {
      const root = mkdtempSync(path.join(tmpdir(), 'pecotv-bad-json-'))
      // path is constructed from tmpdir() and a known suffix.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
      const manifestPath = path.join(root, '.claude-plugin', 'plugin.json')
      // path is constructed from tmpdir() and a known suffix.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      writeFileSync(manifestPath, 'NOT JSON {{{')
      try {
        expect(loadVersionFromPluginJson(manifestPath)).toBeUndefined()
      }
      finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('plugin.json の version が数値なら undefined を返す', () => {
      const root = mkdtempSync(path.join(tmpdir(), 'pecotv-num-ver-'))
      // path is constructed from tmpdir() and a known suffix.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
      const manifestPath = path.join(root, '.claude-plugin', 'plugin.json')
      // path is constructed from tmpdir() and a known suffix.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      writeFileSync(manifestPath, JSON.stringify({ name: 'pecotv', version: 123 }))
      try {
        expect(loadVersionFromPluginJson(manifestPath)).toBeUndefined()
      }
      finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('ファイルが存在しない場合は undefined を返す', () => {
      expect(loadVersionFromPluginJson('/nonexistent/path/plugin.json')).toBeUndefined()
    })
  })
})
