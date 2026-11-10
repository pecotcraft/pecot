import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { parseDocument } from 'yaml'
import { compareText } from '../domain/finding.js'
import type { SourceFile } from '../domain/environment-names.js'
import type { FileState, PluginInput, SyntaxProblem } from '../domain/validate.js'

const run = promisify(execFile)

// 検証を続けられない読み込みの失敗。cli が error: の 1 行にして終了コード 2 で終わる。
export class LoadError extends Error {}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  }
  catch (error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
    if (code === 'ENOENT') return undefined
    throw new LoadError(`${file}: ${code ?? (error instanceof Error ? error.message : 'unknown')}`)
  }
}

export async function loadJson(file: string): Promise<FileState> {
  const text = await readText(file)
  if (text === undefined) return { kind: 'missing' }
  try {
    const data: unknown = JSON.parse(text)
    return { kind: 'ok', data }
  }
  catch (error) {
    const line = /\(line (\d+) column \d+\)/u.exec(error instanceof Error ? error.message : '')?.[1]
    return { kind: 'syntax', problems: [{ ...(line !== undefined && { line: Number(line) }), message: 'is not valid JSON' }] }
  }
}

export async function loadYaml(file: string): Promise<FileState> {
  const text = await readText(file)
  if (text === undefined) return { kind: 'missing' }
  const document = parseDocument(text)
  if (document.errors.length > 0) {
    const problems = document.errors.map((error): SyntaxProblem => {
      const message = (error.message.split('\n', 1)[0] ?? '').replace(/ at line \d+, column \d+:?$/u, '')
      const line = error.linePos?.[0].line
      return { ...(line !== undefined && { line }), message: message.charAt(0).toLowerCase() + message.slice(1) }
    })
    return { kind: 'syntax', problems }
  }
  try {
    const data: unknown = document.toJS()
    return { kind: 'ok', data }
  }
  catch (error) {
    const message = error instanceof Error ? (error.message.split('\n', 1)[0] ?? '') : 'cannot be read'
    return { kind: 'syntax', problems: [{ message: message.charAt(0).toLowerCase() + message.slice(1) }] }
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    const found = await stat(directory)
    return found.isDirectory()
  }
  catch {
    return false
  }
}

// git に追跡されたファイルのうち、glob に当たるものを読む。node_modules や .gitignore のものは入らない。
export async function loadSources(root: string, plugin: string, globs: readonly string[]): Promise<SourceFile[]> {
  if (globs.length === 0) return []
  let stdout: string
  try {
    ;({ stdout } = await run('git', ['ls-files', '-z', '--', `plugins/${plugin}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }))
  }
  catch {
    throw new LoadError(`${root}: git ls-files failed (is it a git repository?)`)
  }
  const files = stdout.split('\0').filter(file => file !== '')
    .filter(file => globs.some(glob => path.posix.matchesGlob(file.slice(`plugins/${plugin}/`.length), glob)))
    .toSorted((left, right) => compareText(left, right))
  // index に残って作業ツリーから消えたファイルは飛ばす。
  const read = await Promise.all(files.map(async file => ({ path: file, text: await readText(path.join(root, file)) })))
  return read.filter(file => file.text !== undefined).map(file => ({ path: file.path, text: file.text ?? '' }))
}

export async function loadPlugin(root: string, name: string, setting: { readonly entries: 'complete' | 'partial', readonly sources: readonly string[] }): Promise<PluginInput> {
  const directory = path.join(root, 'plugins', name, 'interface')
  const hasDirectory = await isDirectory(directory)
  return {
    name,
    dirExists: hasDirectory,
    mode: setting.entries,
    generated: hasDirectory ? await loadJson(path.join(directory, 'generated.json')) : { kind: 'missing' },
    authored: hasDirectory ? await loadYaml(path.join(directory, 'authored.yaml')) : { kind: 'missing' },
    sources: hasDirectory && setting.entries === 'complete' ? await loadSources(root, name, setting.sources) : [],
  }
}
