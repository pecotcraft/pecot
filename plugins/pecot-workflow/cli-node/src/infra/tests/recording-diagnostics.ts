// infra の警告・エラーの受け口の記録。各行は `<level>: <message>` の形で lines に積む。
import type { Diagnostics } from '../diagnostics.js'

export interface RecordedDiagnostics {
  readonly diagnostics: Diagnostics
  /**
  受け口が受けた文。警告は `warning: <message>`、エラーは `error: <message>`
  */
  readonly lines: string[]
}

export function recordDiagnostics(): RecordedDiagnostics {
  const lines: string[] = []
  return {
    lines,
    diagnostics: {
      warning: (message) => {
        lines.push(`warning: ${message}`)
      },
      error: (message) => {
        lines.push(`error: ${message}`)
      },
    },
  }
}

/**
出力を確かめないケースが渡す受け口。何も記録しない
*/
export const ignoredDiagnostics: Diagnostics = {
  warning: () => {
    // 何も記録しない
  },
  error: () => {
    // 何も記録しない
  },
}
