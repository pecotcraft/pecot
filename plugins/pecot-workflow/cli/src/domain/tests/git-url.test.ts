import { describe, expect, it } from 'vitest'

import { parseRemoteUrl, RemoteUrlFormatError } from '../git-url.js'

const parseWithSecret = (): unknown => parseRemoteUrl('https://user:ghp_secret@github.com/owner')

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/owner/repo.git', 'github.com', 'owner', 'repo'],
    ['https://github.com/owner/repo', 'github.com', 'owner', 'repo'],
    ['http://ghe.example/owner/repo.git', 'ghe.example', 'owner', 'repo'],
    ['git@ghes.example.com:owner/repo.git', 'ghes.example.com', 'owner', 'repo'],
    ['git@github.com:owner/repo', 'github.com', 'owner', 'repo'],
    ['https://github.com/o/foo.github.io.git', 'github.com', 'o', 'foo.github.io'],
    ['git@github.com:o/foo.github.io', 'github.com', 'o', 'foo.github.io'],
    ['  https://github.com/owner/repo.git\n', 'github.com', 'owner', 'repo'],
    ['ssh://git@ghes.example.com/acme-labs/aist-plugin.git', 'ghes.example.com', 'acme-labs', 'aist-plugin'],
    ['ssh://git@github.com:22/owner/repo.git', 'github.com', 'owner', 'repo'],
    ['ssh://github.com/owner/repo', 'github.com', 'owner', 'repo'],
    ['ssh://git@github.com/owner/repo.git/', 'github.com', 'owner', 'repo'],
    ['ssh://git@github.com/owner/repo/', 'github.com', 'owner', 'repo'],
    ['ssh://git@github.com/o/foo.github.io.git', 'github.com', 'o', 'foo.github.io'],
  ])('%j を (host, owner, repository) に分ける', (url, host, owner, repository) => {
    expect(parseRemoteUrl(url)).toEqual({ host, owner, repository })
  })

  it.each([
    'invalid-url',
    '/local/bare/repo',
    'https://github.com/owner',
    '',
    'ssh://git@github.com/owner',
    'ssh://git@github.com/a/b/c',
    'ssh://git@github.com:abc/owner/repo.git',
  ])('%j は形式不正', (url) => {
    expect(() => parseRemoteUrl(url)).toThrow(RemoteUrlFormatError)
    expect(() => parseRemoteUrl(url)).toThrow(/^unexpected remote URL format: /u)
  })

  it('https の userinfo は host に含めない', () => {
    expect(parseRemoteUrl('https://user:ghp_secret@ghes.example.com/owner/repo.git')).toEqual({ host: 'ghes.example.com', owner: 'owner', repository: 'repo' })
    expect(parseRemoteUrl('https://token@github.com/owner/repo')).toEqual({ host: 'github.com', owner: 'owner', repository: 'repo' })
  })

  it('エラー文には userinfo（トークン）を出さない', () => {
    expect(parseWithSecret).toThrow(RemoteUrlFormatError)
    expect(parseWithSecret).toThrow('unexpected remote URL format: https://github.com/owner')
    expect(parseWithSecret).toThrow(/^(?!.*ghp_secret)/su)
  })

  it('エラー文は空白を除いた URL を含む（Python と同じ）', () => {
    expect(() => parseRemoteUrl('  foo  ')).toThrow('unexpected remote URL format: foo')
  })
})
