import { describe, expect, it } from 'vitest'

import { COMMANDS } from '../registry.js'
import { findRenamedCommand, RENAMED_COMMANDS } from '../renamed-commands.js'

describe('findRenamedCommand', () => {
  it.for([
    { name: '最上位の古い名前', path: ['create-branch'], expected: ['create-branch', 'session start'] },
    { name: 'グループの下の古い名前', path: ['pr', 'cleanup'], expected: ['pr cleanup', 'session finish'] },
    { name: '2 語の古い名前の 1 語目', path: ['dependabot'], expected: ['dependabot sync', 'tracker sync dependabot'] },
    { name: '2 語の古い名前の全部', path: ['security', 'sync'], expected: ['security sync', 'tracker sync security'] },
  ])('$name で止まると、古い名前と新しい名前を返す', ({ path, expected }) => {
    expect(findRenamedCommand(path)).toEqual(expected)
  })

  it.for([
    { name: '表に無い名前', path: ['nosuch'] },
    { name: 'この PR の途中の名前', path: ['branch', 'create'] },
    { name: '古い名前の途中までと違う語', path: ['depend'] },
  ])('$name では undefined を返す', ({ path }) => {
    expect(findRenamedCommand(path)).toBeUndefined()
  })
})

describe('RENAMED_COMMANDS', () => {
  it('main の 17 個の古い名前を持ち、新しい名前の先頭の 2 語は登録したコマンドにある', () => {
    const registered = new Set(COMMANDS.map(command => command.path.join(' ')))
    expect(RENAMED_COMMANDS.size).toBe(17)
    expect([...RENAMED_COMMANDS].filter(([, newName]) => !registered.has(newName.split(' ').slice(0, 2).join(' '))).map(([oldName]) => oldName)).toEqual([])
  })

  it('古い名前は、どれも今のコマンド名と重ならない', () => {
    const registered = new Set(COMMANDS.map(command => command.path.join(' ')))
    expect([...RENAMED_COMMANDS].filter(([oldName]) => registered.has(oldName)).map(([oldName]) => oldName)).toEqual([])
  })
})
