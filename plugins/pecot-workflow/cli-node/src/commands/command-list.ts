// 移植済みのコマンドの一覧。Phase 4〜7 で足す。registry.ts に置くと、各コマンドが defineCommand を import して循環する。
import { prCleanup, prCreate, prPreflight, prRead } from './pr.js'
import type { CommandDefinition } from './registry.js'

export const COMMANDS: readonly CommandDefinition[] = [prCleanup, prCreate, prPreflight, prRead]
