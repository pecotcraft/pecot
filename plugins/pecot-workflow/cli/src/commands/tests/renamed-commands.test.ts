import { describe, expect, it } from 'vitest'

import { COMMANDS, findCommand } from '../registry.js'
import { findRenamedCommand, findRenamedInput, RENAMED_COMMANDS, RENAMED_INPUTS, renamedInputNote } from '../renamed-commands.js'

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
  it('18 個の古い名前を持ち、新しい名前の先頭の 2 語は登録したコマンドにある', () => {
    const registered = new Set(COMMANDS.map(command => command.path.join(' ')))
    expect(RENAMED_COMMANDS.size).toBe(18)
    expect([...RENAMED_COMMANDS].filter(([, newName]) => !registered.has(newName.split(' ').slice(0, 2).join(' '))).map(([oldName]) => oldName)).toEqual([])
  })

  it('issue quick は issue create --freeform に案内する', () => {
    expect(findRenamedCommand(['issue', 'quick'])).toEqual(['issue quick', 'issue create --freeform'])
  })

  it('古い名前は、どれも今のコマンド名と重ならない', () => {
    const registered = new Set(COMMANDS.map(command => command.path.join(' ')))
    expect([...RENAMED_COMMANDS].filter(([oldName]) => registered.has(oldName)).map(([oldName]) => oldName)).toEqual([])
  })
})

describe('RENAMED_INPUTS', () => {
  it('どの行も、コマンドが今の入力名を持ち、古い入力名を持たない', () => {
    const problems = RENAMED_INPUTS.filter(({ command, oldName, newName }) => {
      const inputs = Object.keys(findCommand(command.split(' '))?.input.shape ?? {})
      return !inputs.includes(newName) || inputs.includes(oldName)
    }).map(({ command, oldName, newName }) => `${command}: ${oldName} -> ${newName}`)
    expect(problems).toEqual([])
  })

  it.for([
    { name: '表にある古い入力名', path: ['project', 'link'], input: 'owner_repo', expected: 'repo' },
    { name: '別のコマンドの古い入力名', path: ['issue', 'show'], input: 'issue', expected: undefined },
    { name: '表に無い入力名', path: ['issue', 'comment'], input: 'message', expected: undefined },
  ])('$name では、今の入力名か undefined を返す', ({ path, input, expected }) => {
    expect(findRenamedInput(path, input)).toBe(expected)
  })

  it('案内の文は、古い名前と今の名前を引用符で包む', () => {
    expect(renamedInputNote('--plan', '--dry-run')).toBe(' (\'--plan\' was renamed to \'--dry-run\')')
  })
})
