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

function makeSink(): { sink: LoggerSink, stdout: CollectingStream, stderr: CollectingStream } {
  const stdout = new CollectingStream()
  const stderr = new CollectingStream()
  return { sink: { stdout, stderr }, stdout, stderr }
}

describe('createLogger', () => {
  it('level=normal は info のみ出力し、verbose / debug は捨てる', () => {
    const { sink, stdout, stderr } = makeSink()
    const logger = createLogger('normal', sink)

    logger.info('info-msg')
    logger.verbose('verbose-msg')
    logger.debug('debug-msg')

    expect(stdout.text()).toBe('info-msg\n')
    expect(stderr.text()).toBe('')
  })

  it('level=verbose は info / verbose を出力し、debug は捨てる', () => {
    const { sink, stdout } = makeSink()
    const logger = createLogger('verbose', sink)

    logger.info('a')
    logger.verbose('b')
    logger.debug('c')

    expect(stdout.text()).toBe('a\nb\n')
  })

  it('level=debug は info / verbose / debug をすべて stdout に出力する', () => {
    const { sink, stdout } = makeSink()
    const logger = createLogger('debug', sink)

    logger.info('a')
    logger.verbose('b')
    logger.debug('c')

    expect(stdout.text()).toBe('a\nb\nc\n')
  })

  it('warn / error は level を問わず stderr に出力する', () => {
    const { sink, stdout, stderr } = makeSink()
    const logger = createLogger('normal', sink)

    logger.warn('warn-msg')
    logger.error('error-msg')

    expect(stdout.text()).toBe('')
    expect(stderr.text()).toBe('warn-msg\nerror-msg\n')
  })

  it('未知の level は normal 扱いになる', () => {
    const { sink, stdout } = makeSink()
    const logger = createLogger('unknown-level', sink)

    logger.info('shown')
    logger.verbose('hidden')

    expect(stdout.text()).toBe('shown\n')
  })

  it('level / sink を省略した場合は process.stdout / process.stderr を sink にする', () => {
    const logger = createLogger()
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
  })

  it('複数引数は util.format でスペース区切り連結される', () => {
    const { sink, stdout } = makeSink()
    const logger = createLogger('debug', sink)

    logger.info('count', 3, { k: 'v' })

    expect(stdout.text()).toBe('count 3 { k: \'v\' }\n')
  })
})
