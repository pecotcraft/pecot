import { describe, expect, it, vi } from 'vitest'

import type { Logger } from '../logger.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('Logger interface', () => {
  it('info・verbose・debug・warn・error の 5 つのメソッドを持つ実装を、Logger として受け付ける', async () => {
    await explains('ログ出力の型 `Logger` のテストです。5 つのメソッドを持つオブジェクトを `Logger` として使い、それぞれを呼び出した場合に、渡した引数どおりに呼び出されることを確認します。')
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
