// toPosixPath の変換規則 (#1094)。
//
// env は基本的に引数で渡す。
// process.env を直接汚すと、同一プロセスで動く他のテスト (contract / 各ツール) の mount root まで動かしうる。
// そのため既定引数のルートを見る 1 件だけ、vi.stubEnv + afterEach(vi.unstubAllEnvs) で隔離して確認する。
// vitest は describe 単位ではプロセスを分離しない。stub の後始末はテストの責務になる。

import { afterEach, describe, expect, it, vi } from 'vitest'

import { toPosixPath } from '../windows-path.js'

/**
WSL 実機で実行しても `/mnt` を掴まないよう、既定と違う合成パスを注入する。
*/
const TEST_ENV = { PECOTV_WSL_MOUNT_ROOT: '/pecotv-mount', WSL_DISTRO_NAME: 'Ubuntu-24.04' }

describe('toPosixPath', () => {
  it('ドライブレターをバックスラッシュ表記から mount root 配下へ畳む', () => {
    expect(toPosixPath(String.raw`C:\Users\alice\deck`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/pecotv-mount/c/Users/alice/deck' })
  })

  it('ドライブレターをスラッシュ表記でも同じ結果に畳む', () => {
    expect(toPosixPath('C:/Users/alice/deck', TEST_ENV))
      .toEqual({ kind: 'converted', path: '/pecotv-mount/c/Users/alice/deck' })
  })

  it('ドライブレターは小文字化する (mount 先のディレクトリ名は小文字)', () => {
    expect(toPosixPath(String.raw`D:\work`, TEST_ENV)).toEqual({ kind: 'converted', path: '/pecotv-mount/d/work' })
    expect(toPosixPath(String.raw`d:\work`, TEST_ENV)).toEqual({ kind: 'converted', path: '/pecotv-mount/d/work' })
  })

  it('ドライブ直下と末尾区切りを保つ', () => {
    expect(toPosixPath('C:\\', TEST_ENV)).toEqual({ kind: 'converted', path: '/pecotv-mount/c/' })
    expect(toPosixPath('C:\\work\\', TEST_ENV)).toEqual({ kind: 'converted', path: '/pecotv-mount/c/work/' })
  })

  it('`..` と連続区切りを normalize する (mount root の外へも出る)', () => {
    expect(toPosixPath(String.raw`C:\work\..\deck`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/pecotv-mount/c/deck' })
    expect(toPosixPath(String.raw`C:\\work\\deck`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/pecotv-mount/c/work/deck' })
    // サンドボックス境界ではないので mount root の外へ抜ける入力も拒否しない (FR-011 と同じ立場)。
    expect(toPosixPath(String.raw`C:\..\..\..\etc\passwd`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/etc/passwd' })
  })

  it('自 distro を指す UNC を WSL 内の絶対パスへ畳む', () => {
    expect(toPosixPath(String.raw`\\wsl$\Ubuntu-24.04\home\alice\deck`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice/deck' })
    expect(toPosixPath(String.raw`\\wsl.localhost\Ubuntu-24.04\home\alice\deck`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice/deck' })
  })

  it('UNC の distro 名は大文字小文字を無視して一致確認する', () => {
    expect(toPosixPath(String.raw`\\wsl.localhost\ubuntu-24.04\home\alice`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice' })
  })

  it('UNC のホスト部 (wsl$ / wsl.localhost) も大文字小文字を無視する (F-01)', () => {
    // Windows のホスト名は大文字小文字を区別しない。distro 名の一致確認 (toLowerCase) と
    // 非対称にならないよう、接頭辞の一致も case-insensitive にする。
    expect(toPosixPath(String.raw`\\WSL$\Ubuntu-24.04\home\alice`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice' })
    expect(toPosixPath(String.raw`\\WSL.LOCALHOST\Ubuntu-24.04\home\alice`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice' })
  })

  it('distro 名の後ろの区切りが混在していても解決する (F-02)', () => {
    // ドライブレター形式は `[/\\]` で両区切りを受理している。
    // distro 名の後ろだけバックスラッシュ限定だと、混在表記が誤って解釈される。
    // 例は `\\wsl.localhost\Ubuntu-24.04/home/alice` で、distro 名に `/home/alice` まで巻き込んでしまう。
    expect(toPosixPath(String.raw`\\wsl.localhost\Ubuntu-24.04/home/alice`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice' })
  })

  it('スラッシュ表記の WSL UNC もバックスラッシュ表記と同じ結果に畳む (F-03)', () => {
    expect(toPosixPath('//wsl.localhost/Ubuntu-24.04/home/alice', TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice' })
    expect(toPosixPath('//wsl$/Ubuntu-24.04/home/alice', TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice' })
  })

  it('スラッシュ表記の一般 UNC も解決不能にする (F-03)', () => {
    const conversion = toPosixPath('//fileserver/share/deck', TEST_ENV)

    expect(conversion.kind).toBe('unsupported')
    expect(conversion.kind === 'unsupported' ? conversion.reason : '').toContain('UNC')
  })

  it('distro のルートだけを指す UNC は / に畳む', () => {
    expect(toPosixPath(String.raw`\\wsl$\Ubuntu-24.04`, TEST_ENV)).toEqual({ kind: 'converted', path: '/' })
  })

  it('他 distro を指す UNC は理由付きで解決不能にする', () => {
    const conversion = toPosixPath(String.raw`\\wsl.localhost\Debian\home\alice`, TEST_ENV)

    expect(conversion.kind).toBe('unsupported')
    expect(conversion.kind === 'unsupported' ? conversion.reason : '').toContain('Ubuntu-24.04')
    expect(conversion.kind === 'unsupported' ? conversion.reason : '').toContain('Debian')
  })

  it('WSL_DISTRO_NAME unsetなら UNC は解決不能にする', () => {
    const conversion = toPosixPath(String.raw`\\wsl$\Ubuntu-24.04\home`, { PECOTV_WSL_MOUNT_ROOT: '/pecotv-mount' })

    expect(conversion.kind).toBe('unsupported')
    expect(conversion.kind === 'unsupported' ? conversion.reason : '').toContain('unset')
  })

  it('ドライブ相対パスは解決不能にする', () => {
    const conversion = toPosixPath(String.raw`C:relative\deck`, TEST_ENV)

    expect(conversion.kind).toBe('unsupported')
    expect(conversion.kind === 'unsupported' ? conversion.reason : '').toContain(String.raw`C:relative\deck`)
  })

  it('一般 UNC は解決不能にする', () => {
    const conversion = toPosixPath(String.raw`\\fileserver\share\deck`, TEST_ENV)

    expect(conversion.kind).toBe('unsupported')
    expect(conversion.kind === 'unsupported' ? conversion.reason : '').toContain('UNC')
  })

  it('POSIX 絶対パスは変換しない', () => {
    expect(toPosixPath('/home/alice/deck', TEST_ENV)).toEqual({ kind: 'unchanged' })
  })

  it('相対パスは変換しない (絶対パス確認に委ねる)', () => {
    expect(toPosixPath('deck/slides.md', TEST_ENV)).toEqual({ kind: 'unchanged' })
    expect(toPosixPath('./deck', TEST_ENV)).toEqual({ kind: 'unchanged' })
    // ルート相対の Windows 表記もドライブが決まらないため変換しない。
    expect(toPosixPath(String.raw`\deck\slides.md`, TEST_ENV)).toEqual({ kind: 'unchanged' })
  })

  it('PECOTV_WSL_MOUNT_ROOT がunset・空・非絶対のときは /mnt へ倒す', () => {
    expect(toPosixPath(String.raw`C:\work`, { WSL_DISTRO_NAME: 'Ubuntu' }))
      .toEqual({ kind: 'converted', path: '/mnt/c/work' })
    expect(toPosixPath(String.raw`C:\work`, { PECOTV_WSL_MOUNT_ROOT: '' }))
      .toEqual({ kind: 'converted', path: '/mnt/c/work' })
    expect(toPosixPath(String.raw`C:\work`, { PECOTV_WSL_MOUNT_ROOT: 'relative/mnt' }))
      .toEqual({ kind: 'converted', path: '/mnt/c/work' })
  })

  it('PECOTV_WSL_MOUNT_ROOT の末尾区切りは正規化して吸収する', () => {
    expect(toPosixPath(String.raw`C:\work`, { PECOTV_WSL_MOUNT_ROOT: '/pecotv-mount/' }))
      .toEqual({ kind: 'converted', path: '/pecotv-mount/c/work' })
  })

  describe('env 省略時', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('process.env を読む', () => {
      // 既定引数 (第 2 引数省略) のルートそのものを確認する。stub した値が変換後パスへ
      // そのまま出ることを見て、既定引数がダミー値の {} 等で通っていないことを保証する。
      vi.stubEnv('PECOTV_WSL_MOUNT_ROOT', '/pecotv-mount-env-default')

      expect(toPosixPath(String.raw`C:\work`)).toEqual({ kind: 'converted', path: '/pecotv-mount-env-default/c/work' })
    })
  })
})
