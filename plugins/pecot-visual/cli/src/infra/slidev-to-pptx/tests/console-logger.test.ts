import { Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { createLogger, type LoggerSink } from '../console-logger.js'
import { explains } from '../../../../tests/_helpers/explains.js'

class CollectingStream extends Writable {
  public readonly chunks: string[] = []

  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は可変型
  public override _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    callback()
  }

  public text(): string {
    return this.chunks.join('')
  }
}

function makeSink(): { sink: LoggerSink, stderr: CollectingStream } {
  const stderr = new CollectingStream()
  return { sink: { stderr }, stderr }
}

describe('createLogger', () => {
  it('level=normal は warn / error だけを出し、info / verbose / debug は捨てる', async () => {
    await explains('ログレベルを `normal` にした場合の、標準エラー出力のテストです。`warn` と `error` だけが `warning:`・`error:` の接頭辞付きで出力され、`info`・`verbose`・`debug` は出力されないことを確認します。')
    const { sink, stderr } = makeSink()
    const logger = createLogger('normal', sink)

    logger.info('info-msg')
    logger.verbose('verbose-msg')
    logger.debug('debug-msg')
    logger.warn('warn-msg')
    logger.error('error-msg')

    expect(stderr.text()).toBe('warning: warn-msg\nerror: error-msg\n')
  })

  it('level=verbose は info / verbose を note として stderr に出し、debug は捨てる', async () => {
    await explains('ログレベルを `verbose` にした場合の、標準エラー出力のテストです。`info` と `verbose` が `note:` の接頭辞付きで出力され、`debug` は出力されないことを確認します。')
    const { sink, stderr } = makeSink()
    const logger = createLogger('verbose', sink)

    logger.info('a')
    logger.verbose('b')
    logger.debug('c')

    expect(stderr.text()).toBe('note: a\nnote: b\n')
  })

  it('level=debug は info / verbose / debug をすべて note として stderr に出す', async () => {
    await explains('ログレベルを `debug` にした場合の、標準エラー出力のテストです。`info`・`verbose`・`debug` のすべてが `note:` の接頭辞付きで出力されることを確認します。')
    const { sink, stderr } = makeSink()
    const logger = createLogger('debug', sink)

    logger.info('a')
    logger.verbose('b')
    logger.debug('c')

    expect(stderr.text()).toBe('note: a\nnote: b\nnote: c\n')
  })

  it('存在しない level を指定した場合は、normal と同じ扱いにする', async () => {
    await explains('存在しないログレベル（`unknown-level` など）を指定した場合のテストです。`info` と `verbose` の出力が表示されず、`normal` と同じ扱いになることを確認します。')
    const { sink, stderr } = makeSink()
    const logger = createLogger('unknown-level', sink)

    logger.info('hidden')
    logger.verbose('hidden')

    expect(stderr.text()).toBe('')
  })

  it('level と sink を省略した場合も、ロガーを作成できる', async () => {
    await explains('ログレベルと出力先を省略した場合のテストです。`createLogger()` が、`info` と `warn` を関数として持つロガーを返すことを確認します。')
    const logger = createLogger()
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
  })

  it('複数の引数を渡すと、util.format と同じく空白で区切って連結する', async () => {
    await explains('ロガーに複数の引数を渡した場合の、メッセージの整形のテストです。文字列・数値・オブジェクトを渡した場合に、空白区切りで連結されて出力されることを確認します。')
    const { sink, stderr } = makeSink()
    const logger = createLogger('debug', sink)

    logger.info('count', 3, { k: 'v' })

    expect(stderr.text()).toBe('note: count 3 { k: \'v\' }\n')
  })

  it('メッセージの先頭に改行がある場合は、改行を取り除き、空の note 行を出力しない', async () => {
    await explains('メッセージの先頭に改行がある場合のテストです。先頭の改行が取り除かれ、`note:` だけの空の行が出力されないことを確認します。')
    const { sink, stderr } = makeSink()
    const logger = createLogger('verbose', sink)

    logger.info('\nPhase 1完了')
    logger.warn('\n\nslow')

    expect(stderr.text()).toBe('note: Phase 1完了\nwarning: slow\n')
  })
})
