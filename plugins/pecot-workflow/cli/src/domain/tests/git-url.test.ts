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
    ['user@ghe.example:o/r.git', 'ghe.example', 'o', 'r'],
    ['gh-alias:pecotcraft/pecot.git', 'gh-alias', 'pecotcraft', 'pecot'],
    ['git@github.com:/o/r.git', 'github.com', 'o', 'r'],
    ['gh-alias:/o/r', 'gh-alias', 'o', 'r'],
    ['git://github.com/pecotcraft/pecot.git', 'github.com', 'pecotcraft', 'pecot'],
    ['git://host:9418/o/r', 'host', 'o', 'r'],
    ['https://github.com/pecotcraft/pecot/', 'github.com', 'pecotcraft', 'pecot'],
    ['https://ghe.example:8443/o/r.git', 'ghe.example', 'o', 'r'],
    ['ftp://host/o/r.git', 'host', 'o', 'r'],
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
    'ftp://o/r',
    'https://o/r',
    'file:///srv/git/o/r.git',
    'ssh://git@github.com/~user/repo.git',
    'github.com/o:r',
    'https://github.com/a/b/c',
    'git@github.com:~user/repo.git',
    'git://host/~user/repo',
    'C:/o/r.git',
    'ssh://git@github.com:２２/o/r.git',
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
