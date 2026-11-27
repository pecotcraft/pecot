// @pecot/workflow-core の dataDirectory が、環境変数の組み合わせごとに決める置き場所。
import { describe, expect, it } from 'vitest'

import { dataDirectory } from '@pecot/workflow-core/infra/paths.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { explains } from '../../../tests/_helpers/explains.js'

useIsolatedEnvironment()

const HOME_DIRECTORY = '/home/u/.local/share/pecot/pecot-workflow'

describe('dataDirectory', () => {
  it.for([
    { name: 'CLAUDE_PLUGIN_DATA が絶対パス', values: { CLAUDE_PLUGIN_DATA: '/data/claude', PLUGIN_DATA: '/data/plugin', HOME: '/home/u' }, expected: '/data/claude' },
    { name: 'CLAUDE_PLUGIN_DATA の末尾に改行がある', values: { CLAUDE_PLUGIN_DATA: '/data/claude\n\n', HOME: '/home/u' }, expected: '/data/claude' },
    { name: 'CLAUDE_PLUGIN_DATA の末尾に CR と改行がある', values: { CLAUDE_PLUGIN_DATA: '/data/claude\r\n', HOME: '/home/u' }, expected: '/data/claude' },
    { name: 'CLAUDE_PLUGIN_DATA が相対パス', values: { CLAUDE_PLUGIN_DATA: 'relative/dir', PLUGIN_DATA: '/data/plugin', HOME: '/home/u' }, expected: '/data/plugin' },
    { name: 'CLAUDE_PLUGIN_DATA が変数展開の書式', values: { CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}', PLUGIN_DATA: '/data/plugin' }, expected: '/data/plugin' },
    { name: 'CLAUDE_PLUGIN_DATA が空', values: { CLAUDE_PLUGIN_DATA: '', PLUGIN_DATA: '/data/plugin' }, expected: '/data/plugin' },
    { name: 'PLUGIN_DATA と XDG_DATA_HOME がある', values: { PLUGIN_DATA: '/data/plugin', XDG_DATA_HOME: '/xdg', HOME: '/home/u' }, expected: '/data/plugin' },
    { name: 'XDG_DATA_HOME が絶対パス', values: { XDG_DATA_HOME: '/xdg', HOME: '/home/u' }, expected: '/xdg/pecot/pecot-workflow' },
    { name: 'XDG_DATA_HOME が相対パス', values: { XDG_DATA_HOME: 'xdg', HOME: '/home/u' }, expected: HOME_DIRECTORY },
    { name: 'HOME だけがある', values: { HOME: '/home/u' }, expected: HOME_DIRECTORY },
    { name: 'HOME の末尾に改行がある', values: { HOME: '/home/u\n' }, expected: HOME_DIRECTORY },
    { name: 'HOME が相対パス', values: { HOME: 'relative' }, expected: undefined },
    { name: 'HOME が変数展開の書式', values: { HOME: '${HOME}' }, expected: undefined },
    { name: 'どの変数も無い', values: {}, expected: undefined },
    { name: 'パスの末尾に空白がある', values: { CLAUDE_PLUGIN_DATA: '/data/with space ' }, expected: '/data/with space ' },
  ])('$name とき、$expected を返す', async ({ values, expected }) => {
    await explains('データ置き場を求める `dataDirectory` のテストです。環境変数の組み合わせごとに、期待する場所を返し、解決できない場合は `undefined` を返すことを確認します。')
    setEnvironment({ CLAUDE_PLUGIN_DATA: undefined, PLUGIN_DATA: undefined, XDG_DATA_HOME: undefined, HOME: undefined })
    setEnvironment(values)
    expect(dataDirectory()).toBe(expected)
  })
})
