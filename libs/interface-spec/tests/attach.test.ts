import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AttachmentOptions } from 'allure-js-commons'
import type { RuntimeMessage } from 'allure-js-commons/sdk'
import { getGlobalTestRuntime, MessageHolderTestRuntime, setGlobalTestRuntime } from 'allure-js-commons/sdk/runtime'
import type { SyncTestRuntime, TestRuntime } from 'allure-js-commons/sdk/runtime'
import { afterEach, beforeEach, describe, expect, it, TestRunner, vi } from 'vitest'
import { attachContent, attachFile, attachJson, attachJsonInTest, attachOutput, attachText, readOutput } from '../src/vitest/attach.js'

// allure-js-commons 3.15.0 の sync の型（undefined を含む）は、exactOptionalPropertyTypes の下で TestRuntime に合わない。
// attachment は MessageHolderTestRuntime に無いので、allure-vitest の VitestTestRuntime と同じ形で送る。
class HolderRuntime extends MessageHolderTestRuntime {
  override get sync(): SyncTestRuntime {
    const sync = super.sync
    if (sync === undefined) throw new Error('MessageHolderTestRuntime に sync が無い')
    return sync
  }

  override async attachment(name: string, content: Buffer | Uint8Array | string, options: AttachmentOptions): Promise<void> {
    await this.sendMessage({
      type: 'attachment_content',
      data: {
        name,
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
        contentType: options.contentType,
        ...(options.fileExtension !== undefined && { fileExtension: options.fileExtension }),
      },
    })
  }
}

interface Attached {
  readonly name: string
  readonly content: string
  readonly contentType: string
  readonly fileExtension: string | undefined
}

// レーンの中では、allure-vitest の expect も step を runtime に送るので、attachment_content だけを見る。
function attachments(messages: readonly RuntimeMessage[]): Attached[] {
  const attached: Attached[] = []
  for (const message of messages) {
    if (message.type !== 'attachment_content') continue
    const { name, content, encoding, contentType, fileExtension } = message.data
    attached.push({ name, content: Buffer.from(content, encoding).toString('utf8'), contentType, fileExtension })
  }
  return attached
}

const TYPES = [
  { extension: '.png', contentType: 'image/png' },
  { extension: '.svg', contentType: 'image/svg+xml' },
  { extension: '.pdf', contentType: 'application/pdf' },
  { extension: '.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  { extension: '.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { extension: '.txt', contentType: 'text/plain' },
  { extension: '.json', contentType: 'application/json' },
  { extension: '.md', contentType: 'text/markdown' },
] as const

describe('attach', () => {
  let previous: TestRuntime
  let runtime: HolderRuntime
  let directory: string

  beforeEach(() => {
    previous = getGlobalTestRuntime()
    runtime = new HolderRuntime()
    setGlobalTestRuntime(runtime)
    directory = mkdtempSync(path.join(tmpdir(), 'interface-spec-attach-'))
  })

  afterEach(() => {
    setGlobalTestRuntime(previous)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  describe('Allure の reporter が動くレーンの中', () => {
    beforeEach(() => {
      vi.stubEnv('NX_TASK_TARGET_TARGET', 'test-unit')
    })

    it.for(TYPES)('拡張子 $extension のファイルを渡すと、中身と型 $contentType と拡張子を持つ添付を 1 つ残す', async ({ extension, contentType }) => {
      const file = path.join(directory, `artifact${extension}`)
      writeFileSync(file, `中身 ${extension}`)
      await attachFile('作った成果物', file)
      expect(attachments(runtime.messages())).toEqual([
        { name: '作った成果物', content: `中身 ${extension}`, contentType, fileExtension: extension },
      ])
    })

    it('表に無い拡張子のファイルを渡すと、拡張子を含む文言で throw する', async () => {
      const file = path.join(directory, 'artifact.csv')
      writeFileSync(file, '中身')
      await expect(attachFile('作った成果物', file)).rejects.toThrow('.csv')
      expect(attachments(runtime.messages())).toEqual([])
    })

    it('attachContent に中身と拡張子を渡すと、その中身を拡張子の型で残す', async () => {
      await attachContent('撮った画面', new TextEncoder().encode('画素'), '.png')
      expect(attachments(runtime.messages())).toEqual([
        { name: '撮った画面', content: '画素', contentType: 'image/png', fileExtension: '.png' },
      ])
    })

    it('表に無い拡張子で attachContent を呼ぶと、拡張子を含む文言で throw する', async () => {
      await expect(attachContent('撮った画面', new Uint8Array(), '.jpg')).rejects.toThrow('.jpg')
      expect(attachments(runtime.messages())).toEqual([])
    })

    it('ファイルが無いと、何も残さず throw しない', async () => {
      await attachFile('作った成果物', path.join(directory, 'missing.png'))
      expect(attachments(runtime.messages())).toEqual([])
    })

    it('attachText に文字列を渡すと、待たずにその文字列を拡張子の型で残す', () => {
      attachText('出力', '{"a":1}', '.json')
      expect(attachments(runtime.messages())).toEqual([
        { name: '出力', content: '{"a":1}', contentType: 'application/json', fileExtension: '.json' },
      ])
    })

    it('attachJson に値を渡すと、字下げした JSON で残す', () => {
      attachJson('応答', { isError: true })
      expect(attachments(runtime.messages())).toEqual([
        { name: '応答', content: '{\n  "isError": true\n}', contentType: 'application/json', fileExtension: '.json' },
      ])
    })

    it('attachJsonInTest は、動いているテストの中では attachJson と同じく残す', () => {
      attachJsonInTest('tools/list の結果', { tools: [] })
      expect(attachments(runtime.messages())).toEqual([
        { name: 'tools/list の結果', content: '{\n  "tools": []\n}', contentType: 'application/json', fileExtension: '.json' },
      ])
    })

    it('attachJsonInTest は、テストの外（beforeAll など）では何も残さない', () => {
      vi.spyOn(TestRunner, 'getCurrentTest').mockReturnValue(undefined)
      attachJsonInTest('tools/list の結果', { tools: [] })
      expect(attachments(runtime.messages())).toEqual([])
    })

    it.for([
      { name: 'stdout だけがある', stdout: '出た', stderr: '', expected: [['stdout', '出た']] },
      { name: 'stderr だけがある', stdout: '', stderr: '誤り', expected: [['stderr', '誤り']] },
      { name: '両方ある', stdout: '出た', stderr: '誤り', expected: [['stdout', '出た'], ['stderr', '誤り']] },
      { name: '両方空', stdout: '', stderr: '', expected: [['stdout', '']] },
    ])('attachOutput の出力が $name とき、名前にコマンドと終了コードを持つ添付を残す', ({ stdout, stderr, expected }) => {
      attachOutput('pecot issue show 12', 1, stdout, stderr)
      expect(attachments(runtime.messages())).toEqual(expected.map(([stream, content]) => (
        { name: `pecot issue show 12（終了コード 1） ${String(stream)}`, content, contentType: 'text/plain', fileExtension: '.txt' }
      )))
    })

    it('attachOutput に終了コードを渡さないと、名前に終了コードを書かない', () => {
      attachOutput('capture', undefined, '出た', '')
      expect(attachments(runtime.messages()).map(item => item.name)).toEqual(['capture stdout'])
    })

    it('attachOutput のコマンドが 200 字を超えると、先頭の 200 字を名前に使う', () => {
      attachOutput('a'.repeat(300), 0, '出た', '')
      expect(attachments(runtime.messages()).map(item => item.name)).toEqual([`${'a'.repeat(200)}（終了コード 0） stdout`])
    })

    it.for([
      { file: 'slides.md', extension: '.md', contentType: 'text/markdown' },
      { file: 'result.json', extension: '.json', contentType: 'application/json' },
      { file: 'diagram.svg', extension: '.svg', contentType: 'image/svg+xml' },
      { file: 'vite.config.ts', extension: '.txt', contentType: 'text/plain' },
    ])('readOutput に $file を渡すと、読んだ中身を返し、型 $contentType で残す', ({ file, extension, contentType }) => {
      const filePath = path.join(directory, file)
      writeFileSync(filePath, `中身 ${file}`)
      expect(readOutput(filePath)).toBe(`中身 ${file}`)
      expect(attachments(runtime.messages())).toEqual([
        { name: file, content: `中身 ${file}`, contentType, fileExtension: extension },
      ])
    })

    it('readOutput のファイルが無いと、何も残さず読み込みの誤りを投げる', () => {
      expect(() => readOutput(path.join(directory, 'missing.md'))).toThrow('ENOENT')
      expect(attachments(runtime.messages())).toEqual([])
    })
  })

  it('NX_TASK_TARGET_TARGET が空だと、何も残さず console.log も呼ばない', async () => {
    vi.stubEnv('NX_TASK_TARGET_TARGET', '')
    const log = vi.spyOn(console, 'log')
    const file = path.join(directory, 'artifact.png')
    writeFileSync(file, '中身')
    await attachFile('作った成果物', file)
    await attachContent('撮った画面', new Uint8Array([1]), '.png')
    attachText('出力', '出た', '.txt')
    attachOutput('pecot', 0, '出た', '誤り')
    writeFileSync(path.join(directory, 'slides.md'), '中身')
    expect(readOutput(path.join(directory, 'slides.md'))).toBe('中身')
    expect(attachments(runtime.messages())).toEqual([])
    expect(log).not.toHaveBeenCalled()
  })
})
