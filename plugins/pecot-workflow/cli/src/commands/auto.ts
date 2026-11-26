// auto のコマンド群。Issue のラベルを契機にした自動処理の始めと終わりで、ワークフローとスキルが呼ぶ。
import { AUTO_FINISH_COMMANDS } from './auto-finish.js'
import { AUTO_GATE_COMMANDS } from './auto-gate.js'
import { AUTO_START_COMMANDS } from './auto-start.js'
import type { CommandDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'

export const AUTO_COMMANDS: readonly CommandDefinition[] = [...AUTO_GATE_COMMANDS, ...AUTO_START_COMMANDS, ...AUTO_FINISH_COMMANDS]
