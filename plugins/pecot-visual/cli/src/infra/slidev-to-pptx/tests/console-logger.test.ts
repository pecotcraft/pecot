import { Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { createLogger, type LoggerSink } from '../console-logger.js'

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
  it('level=normal は warn / error だけを出し、info / verbose / debug は捨てる', () => {
    const { sink, stderr } = makeSink()
    const logger = createLogger('normal', sink)

    logger.info('info-msg')
    logger.verbose('verbose-msg')
    logger.debug('debug-msg')
    logger.warn('warn-msg')
    logger.error('error-msg')

    expect(stderr.text()).toBe('warning: warn-msg\nerror: error-msg\n')
  })

  it('level=verbose は info / verbose を note として stderr に出し、debug は捨てる', () => {
    const { sink, stderr } = makeSink()
    const logger = createLogger('verbose', sink)

    logger.info('a')
    logger.verbose('b')
    logger.debug('c')

    expect(stderr.text()).toBe('note: a\nnote: b\n')
  })

  it('level=debug は info / verbose / debug をすべて note として stderr に出す', () => {
    const { sink, stderr } = makeSink()
    const logger = createLogger('debug', sink)

    logger.info('a')
    logger.verbose('b')
    logger.debug('c')

    expect(stderr.text()).toBe('note: a\nnote: b\nnote: c\n')
  })

  it('未知の level は normal 扱いになる', () => {
    const { sink, stderr } = makeSink()
    const logger = createLogger('unknown-level', sink)

    logger.info('hidden')
    logger.verbose('hidden')

    expect(stderr.text()).toBe('')
  })

  it('level / sink を省略した場合は process.stderr を sink にする', () => {
    const logger = createLogger()
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
  })

  it('複数引数は util.format でスペース区切り連結される', () => {
    const { sink, stderr } = makeSink()
    const logger = createLogger('debug', sink)

    logger.info('count', 3, { k: 'v' })

    expect(stderr.text()).toBe('note: count 3 { k: \'v\' }\n')
  })

  it('先頭の改行は落とし、空の note の行を出さない', () => {
    const { sink, stderr } = makeSink()
    const logger = createLogger('verbose', sink)

    logger.info('\nPhase 1完了')
    logger.warn('\n\nslow')

    expect(stderr.text()).toBe('note: Phase 1完了\nwarning: slow\n')
  })
})
