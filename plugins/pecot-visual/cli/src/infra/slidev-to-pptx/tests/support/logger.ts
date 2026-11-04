import { vi, type Mock } from 'vitest'

import type { Logger } from '../../../../domain/slidev-to-pptx/logger.js'

export interface MockLogger extends Logger {
  readonly info: Mock
  readonly verbose: Mock
  readonly debug: Mock
  readonly warn: Mock
  readonly error: Mock
}

export function makeLogger(): MockLogger {
  return {
    info: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}
