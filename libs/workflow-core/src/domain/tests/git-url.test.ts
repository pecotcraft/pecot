import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'
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
  ])('%j を渡すと、host・owner・repository に分けて返す', async (url, host, owner, repository) => {
    await explains(`Git のリモート URL を分解する、\`parseRemoteUrl\` のテストです。\`${JSON.stringify(url)}\` を渡した場合に、host・owner・repository に分けた結果を返すことを確認します。`)
    stepSync('parseRemoteUrl を呼び、結果を比べる', () => {
      expect(parseRemoteUrl(url)).toEqual({ host, owner, repository })
    })
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
  ])('%j を渡すと、形式が不正として例外が発生する', async (url) => {
    await explains(`Git のリモート URL を分解する、\`parseRemoteUrl\` のテストです。形式が不正な \`${JSON.stringify(url)}\` を渡した場合に、\`RemoteUrlFormatError\` の例外が発生することを確認します。`)
    stepSync('parseRemoteUrl を呼び、結果を比べる', () => {
      expect(() => parseRemoteUrl(url)).toThrow(RemoteUrlFormatError)
      expect(() => parseRemoteUrl(url)).toThrow(/^unexpected remote URL format: /u)
    })
  })

  it('https の URL に userinfo がある場合は、host に含めない', async () => {
    await explains('Git のリモート URL を分解する、`parseRemoteUrl` のテストです。`https` の URL にユーザー名やトークンが含まれる場合に、host にそれらを含めず分解することを確認します。')
    stepSync('parseRemoteUrl を呼び、結果を比べる', () => {
      expect(parseRemoteUrl('https://user:ghp_secret@ghes.example.com/owner/repo.git')).toEqual({ host: 'ghes.example.com', owner: 'owner', repository: 'repo' })
      expect(parseRemoteUrl('https://token@github.com/owner/repo')).toEqual({ host: 'github.com', owner: 'owner', repository: 'repo' })
    })
  })

  it('エラー文には userinfo（トークン）を表示しない', async () => {
    await explains('Git のリモート URL を分解する、`parseRemoteUrl` のテストです。形式が不正でトークンを含む URL を渡した場合に、例外のメッセージにトークンが含まれないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(parseWithSecret).toThrow(RemoteUrlFormatError)
      expect(parseWithSecret).toThrow('unexpected remote URL format: https://github.com/owner')
      expect(parseWithSecret).toThrow(/^(?!.*ghp_secret)/su)
    })
  })

  it('エラー文には、前後の空白を除いた URL を含める（Python と同じ）', async () => {
    await explains('Git のリモート URL を分解する、`parseRemoteUrl` のテストです。前後に空白がある不正な URL を渡した場合に、例外のメッセージに空白を除いた URL が含まれることを確認します。')
    stepSync('parseRemoteUrl を呼び、結果を比べる', () => {
      expect(() => parseRemoteUrl('  foo  ')).toThrow('unexpected remote URL format: foo')
    })
  })
})
