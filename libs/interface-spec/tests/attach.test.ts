import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AttachmentOptions } from 'allure-js-commons'
import type { RuntimeMessage } from 'allure-js-commons/sdk'
import { getGlobalTestRuntime, MessageHolderTestRuntime, setGlobalTestRuntime } from 'allure-js-commons/sdk/runtime'
import type { SyncTestRuntime, TestRuntime } from 'allure-js-commons/sdk/runtime'
import { afterEach, beforeEach, describe, expect, it, TestRunner, vi } from 'vitest'
import { attachContent, attachFile, attachJson, attachJsonInTest, attachOutput, attachText, readOutput } from '../src/vitest/attach.js'
import { stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

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

interface Recorded<T> {
  readonly messages: readonly RuntimeMessage[]
  readonly value?: T
  readonly error?: unknown
}

// 差し替えの間に呼んだ step は reporter でなくここに入るので、差し替えは操作だけに限り、終わったら戻す。
async function recorded<T>(target: string, body: () => T | Promise<T>): Promise<Recorded<T>> {
  const previous: TestRuntime = getGlobalTestRuntime()
  const runtime = new HolderRuntime()
  setGlobalTestRuntime(runtime)
  vi.stubEnv('NX_TASK_TARGET_TARGET', target)
  try {
    const value = await body()
    return { messages: runtime.messages(), value }
  }
  catch (error) {
    return { messages: runtime.messages(), error }
  }
  finally {
    setGlobalTestRuntime(previous)
    vi.unstubAllEnvs()
  }
}

describe('attach', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'interface-spec-attach-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  describe('Allure の reporter が動くレーンの中', () => {
    it.for(TYPES)('attachFile に拡張子 $extension のファイルを渡すと、中身と拡張子と型 $contentType を持つ添付を 1 つ追加する', async ({ extension, contentType }) => {
      await explains(`ファイルを Allure の添付として追加する \`attachFile\` のテストです。拡張子 \`${extension}\` のファイルを渡した場合に、ファイルの中身と型 \`${contentType}\` と拡張子を持つ添付が 1 つだけ追加されることを確認します。`)
      const file = path.join(directory, `artifact${extension}`)
      writeFileSync(file, `中身 ${extension}`)
      const { messages } = await recorded('test-unit', () => attachFile('作った成果物', file))
      stepSync('残した添付を比べる', () => {
        expect(attachments(messages)).toEqual([
          { name: '作った成果物', content: `中身 ${extension}`, contentType, fileExtension: extension },
        ])
      })
    })

    it('対応表にない拡張子のファイルを渡すと、拡張子を含むメッセージで例外が発生する', async () => {
      await explains('ファイルを Allure の添付として追加する `attachFile` のテストです。`.txt` のように型の対応表にない拡張子のファイルを渡した場合に、拡張子を含むメッセージの例外が発生し、添付が追加されないことを確認します。')
      const file = path.join(directory, 'artifact.csv')
      writeFileSync(file, '中身')
      const { messages, error } = await recorded('test-unit', () => attachFile('作った成果物', file))
      stepSync('throw の文言と残した添付を比べる', () => {
        expect(String(error)).toContain('.csv')
        expect(attachments(messages)).toEqual([])
      })
    })

    it('attachContent に中身と拡張子を渡すと、その中身を拡張子に対応する型で添付に追加する', async () => {
      await explains('バイト列を Allure の添付として追加する `attachContent` のテストです。中身と `.png` を渡した場合に、その中身が `image/png` の添付として 1 つ追加されることを確認します。')
      const { messages } = await recorded('test-unit', () => attachContent('撮った画面', new TextEncoder().encode('画素'), '.png'))
      stepSync('残した添付を比べる', () => {
        expect(attachments(messages)).toEqual([
          { name: '撮った画面', content: '画素', contentType: 'image/png', fileExtension: '.png' },
        ])
      })
    })

    it('対応表にない拡張子で attachContent を呼ぶと、拡張子を含むメッセージで例外が発生する', async () => {
      await explains('バイト列を Allure の添付として追加する `attachContent` のテストです。`.jpg` のように型の対応表にない拡張子を渡した場合に、拡張子を含むメッセージの例外が発生し、添付が追加されないことを確認します。')
      const { messages, error } = await recorded('test-unit', () => attachContent('撮った画面', new Uint8Array(), '.jpg'))
      stepSync('throw の文言と残した添付を比べる', () => {
        expect(String(error)).toContain('.jpg')
        expect(attachments(messages)).toEqual([])
      })
    })

    it('渡したファイルが存在しないと、添付を追加せず、例外も発生しない', async () => {
      await explains('ファイルを Allure の添付として追加する `attachFile` のテストです。存在しないファイルを渡した場合に、添付を追加せず、例外も発生しないことを確認します。')
      const { messages, error } = await recorded('test-unit', () => attachFile('作った成果物', path.join(directory, 'missing.png')))
      stepSync('throw しないことと残した添付を比べる', () => {
        expect(error).toBeUndefined()
        expect(attachments(messages)).toEqual([])
      })
    })

    it('attachText に文字列を渡すと、待たずにその文字列を拡張子の型で残す', async () => {
      await explains('文字列を Allure の添付として追加する `attachText` のテストです。nx のレーンの中で文字列と拡張子 `.json` を渡した場合に、その文字列が `application/json` の添付として 1 つ追加されることを確認します。')
      const { messages } = await recorded('test-unit', () => {
        attachText('出力', '{"a":1}', '.json')
      })
      stepSync('残した添付を比べる', () => {
        expect(attachments(messages)).toEqual([
          { name: '出力', content: '{"a":1}', contentType: 'application/json', fileExtension: '.json' },
        ])
      })
    })

    it('attachJson に値を渡すと、字下げした JSON で残す', async () => {
      await explains('値を JSON の添付として追加する `attachJson` のテストです。nx のレーンの中でオブジェクトを渡した場合に、字下げした JSON 文字列が `application/json` の添付として 1 つ追加されることを確認します。')
      const { messages } = await recorded('test-unit', () => {
        attachJson('応答', { isError: true })
      })
      stepSync('残した添付を比べる', () => {
        expect(attachments(messages)).toEqual([
          { name: '応答', content: '{\n  "isError": true\n}', contentType: 'application/json', fileExtension: '.json' },
        ])
      })
    })

    it('attachJsonInTest は、動いているテストの中では attachJson と同じく残す', async () => {
      await explains('テストの中で JSON の添付を追加する `attachJsonInTest` のテストです。動作中のテストの中で呼んだ場合に、`attachJson` と同じ内容の添付が 1 つ追加されることを確認します。')
      const { messages } = await recorded('test-unit', () => {
        attachJsonInTest('tools/list の結果', { tools: [] })
      })
      stepSync('残した添付を比べる', () => {
        expect(attachments(messages)).toEqual([
          { name: 'tools/list の結果', content: '{\n  "tools": []\n}', contentType: 'application/json', fileExtension: '.json' },
        ])
      })
    })

    it('attachJsonInTest は、テストの外（beforeAll など）では何も残さない', async () => {
      await explains('テストの中で JSON の添付を追加する `attachJsonInTest` のテストです。`beforeAll` のようにテストの外で呼んだ場合に、添付が追加されないことを確認します。')
      const { messages } = await recorded('test-unit', () => {
        const current = vi.spyOn(TestRunner, 'getCurrentTest').mockReturnValue(undefined)
        try {
          attachJsonInTest('tools/list の結果', { tools: [] })
        }
        finally {
          current.mockRestore()
        }
      })
      stepSync('残した添付を比べる', () => {
        expect(attachments(messages)).toEqual([])
      })
    })

    it.for([
      { name: 'stdout だけがある', stdout: '出た', stderr: '', expected: [['stdout', '出た']] },
      { name: 'stderr だけがある', stdout: '', stderr: '誤り', expected: [['stderr', '誤り']] },
      { name: '両方ある', stdout: '出た', stderr: '誤り', expected: [['stdout', '出た'], ['stderr', '誤り']] },
      { name: '両方空', stdout: '', stderr: '', expected: [['stdout', '']] },
    ])('attachOutput の出力が $name とき、名前にコマンドと終了コードを持つ添付を残す', async ({ name, stdout, stderr, expected }) => {
      await explains(`コマンドの出力を Allure の添付として追加する \`attachOutput\` のテストです。出力が「${name}」の場合に、コマンドと終了コードを名前に持つ添付が、出力ごとに追加されることを確認します。`)
      const { messages } = await recorded('test-unit', () => {
        attachOutput('pecot issue show 12', 1, stdout, stderr)
      })
      stepSync('残した添付を比べる', () => {
        expect(attachments(messages)).toEqual(expected.map(([stream, content]) => (
          { name: `pecot issue show 12（終了コード 1） ${String(stream)}`, content, contentType: 'text/plain', fileExtension: '.txt' }
        )))
      })
    })

    it('attachOutput に終了コードを渡さないと、名前に終了コードを書かない', async () => {
      await explains('コマンドの出力を Allure の添付として追加する `attachOutput` のテストです。終了コードを渡さなかった場合に、添付の名前に終了コードが含まれないことを確認します。')
      const { messages } = await recorded('test-unit', () => {
        attachOutput('capture', undefined, '出た', '')
      })
      stepSync('残した添付の名前を比べる', () => {
        expect(attachments(messages).map(item => item.name)).toEqual(['capture stdout'])
      })
    })

    it('attachOutput のコマンドが 200 字を超えると、先頭の 200 字を名前に使う', async () => {
      await explains('コマンドの出力を Allure の添付として追加する `attachOutput` のテストです。コマンドが 200 字を超える場合に、添付の名前にはコマンドの先頭 200 字だけが使われることを確認します。')
      const { messages } = await recorded('test-unit', () => {
        attachOutput('a'.repeat(300), 0, '出た', '')
      })
      stepSync('残した添付の名前を比べる', () => {
        expect(attachments(messages).map(item => item.name)).toEqual([`${'a'.repeat(200)}（終了コード 0） stdout`])
      })
    })

    it.for([
      { file: 'slides.md', extension: '.md', contentType: 'text/markdown' },
      { file: 'result.json', extension: '.json', contentType: 'application/json' },
      { file: 'diagram.svg', extension: '.svg', contentType: 'image/svg+xml' },
      { file: 'vite.config.ts', extension: '.txt', contentType: 'text/plain' },
    ])('readOutput に $file を渡すと、読んだ中身を返し、型 $contentType で残す', async ({ file, extension, contentType }) => {
      await explains(`ファイルを読んで Allure の添付として追加する \`readOutput\` のテストです。\`${file}\` を渡した場合に、読み込んだ中身を返し、型 \`${contentType}\` の添付が 1 つ追加されることを確認します。`)
      const filePath = path.join(directory, file)
      writeFileSync(filePath, `中身 ${file}`)
      const { messages, value } = await recorded('test-unit', () => readOutput(filePath))
      stepSync('返した中身と残した添付を比べる', () => {
        expect(value).toBe(`中身 ${file}`)
        expect(attachments(messages)).toEqual([
          { name: file, content: `中身 ${file}`, contentType, fileExtension: extension },
        ])
      })
    })

    it('readOutput のファイルが無いと、何も残さず読み込みの誤りを投げる', async () => {
      await explains('ファイルを読んで Allure の添付として追加する `readOutput` のテストです。存在しないファイルを渡した場合に、添付が追加されず、読み込みの例外が発生することを確認します。')
      const { messages, error } = await recorded('test-unit', () => readOutput(path.join(directory, 'missing.md')))
      stepSync('投げた誤りと残した添付を比べる', () => {
        expect(String(error)).toContain('ENOENT')
        expect(attachments(messages)).toEqual([])
      })
    })
  })

  it('NX_TASK_TARGET_TARGET が空だと、添付を追加せず、console.log も呼び出さない', async () => {
    await explains('nx のレーンの外（`NX_TASK_TARGET_TARGET` が空）では、`attachFile` と `attachContent` が添付を追加せず、`console.log` も呼ばないことを確認します。')
    const log = vi.spyOn(console, 'log')
    const file = path.join(directory, 'artifact.png')
    writeFileSync(file, '中身')
    writeFileSync(path.join(directory, 'slides.md'), '中身')
    const { messages, value } = await recorded('', async () => {
      await attachFile('作った成果物', file)
      await attachContent('撮った画面', new Uint8Array([1]), '.png')
      attachText('出力', '出た', '.txt')
      attachOutput('pecot', 0, '出た', '誤り')
      return readOutput(path.join(directory, 'slides.md'))
    })
    stepSync('読んだ中身・残した添付・console.log の呼び出しを比べる', () => {
      expect(value).toBe('中身')
      expect(attachments(messages)).toEqual([])
      expect(log).not.toHaveBeenCalled()
    })
  })
})
