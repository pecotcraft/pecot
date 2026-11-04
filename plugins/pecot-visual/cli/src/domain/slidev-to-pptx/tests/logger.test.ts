import { describe, expect, it, vi } from 'vitest'

import type { Logger } from '../logger.js'

describe('Logger interface', () => {
  it('info / verbose / debug / warn / error の 5 メソッドを持つ実装を受け入れる', () => {
    const logger: Logger = {
      info: vi.fn(),
      verbose: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    logger.info('a', 1)
    logger.verbose('b')
    logger.debug('c')
    logger.warn('d')
    logger.error('e')

    expect(logger.info).toHaveBeenCalledWith('a', 1)
    expect(logger.verbose).toHaveBeenCalledWith('b')
    expect(logger.debug).toHaveBeenCalledWith('c')
    expect(logger.warn).toHaveBeenCalledWith('d')
    expect(logger.error).toHaveBeenCalledWith('e')
  })
})
