// toPosixPath の変換規則 (#1094)。
//
// env は基本的に引数で渡す。
// process.env を直接汚すと、同一プロセスで動く他のテスト (contract / 各ツール) の mount root まで動かしうる。
// そのため既定引数のルートを見る 1 件だけ、vi.stubEnv + afterEach(vi.unstubAllEnvs) で隔離して確認する。
// vitest は describe 単位ではプロセスを分離しない。stub の後始末はテストの責務になる。

import { afterEach, describe, expect, it, vi } from 'vitest'

import { toPosixPath } from '../windows-path.js'
import { explains } from '../../../tests/_helpers/explains.js'

/**
WSL 実機で実行しても `/mnt` を掴まないよう、既定と違う合成パスを注入する。
*/
const TEST_ENV = { PECOTV_WSL_MOUNT_ROOT: '/pecotv-mount', WSL_DISTRO_NAME: 'Ubuntu-24.04' }

describe('toPosixPath', () => {
  it('バックスラッシュで書いたドライブレターのパスは、マウントルートの配下のパスに変換する', async () => {
    await explains('Windows 形式のパスを WSL のパスに変換する `toPosixPath` のテストです。`C:\\Users\\alice\\deck` のように、バックスラッシュで書いたパスが、`/pecotv-mount/c/Users/alice/deck` に変換されることを確認します。')
    expect(toPosixPath(String.raw`C:\Users\alice\deck`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/pecotv-mount/c/Users/alice/deck' })
  })

  it('スラッシュで書いたドライブレターのパスも、同じように変換する', async () => {
    await explains('`C:/Users/alice/deck` のように、スラッシュで書いたドライブレターのパスを渡した場合のテストです。バックスラッシュで書いた場合と同じく、`/pecotv-mount/c/Users/alice/deck` に変換されることを確認します。')
    expect(toPosixPath('C:/Users/alice/deck', TEST_ENV))
      .toEqual({ kind: 'converted', path: '/pecotv-mount/c/Users/alice/deck' })
  })

  it('ドライブレターは小文字に変換する', async () => {
    await explains('大文字と小文字のドライブレター（`D:` と `d:`）を渡した場合のテストです。どちらもマウント先のディレクトリ名と同じ小文字の `d` に変換されることを確認します。')
    expect(toPosixPath(String.raw`D:\work`, TEST_ENV)).toEqual({ kind: 'converted', path: '/pecotv-mount/d/work' })
    expect(toPosixPath(String.raw`d:\work`, TEST_ENV)).toEqual({ kind: 'converted', path: '/pecotv-mount/d/work' })
  })

  it('ドライブ直下のパスと、末尾の区切り文字を保つ', async () => {
    await explains('`C:\\` と `C:\\work\\` を渡した場合のテストです。ドライブ直下のパスと、末尾の区切り文字（`/`）が、変換後も保たれることを確認します。')
    expect(toPosixPath('C:\\', TEST_ENV)).toEqual({ kind: 'converted', path: '/pecotv-mount/c/' })
    expect(toPosixPath('C:\\work\\', TEST_ENV)).toEqual({ kind: 'converted', path: '/pecotv-mount/c/work/' })
  })

  it('`..` と連続した区切り文字を正規化し、マウントルートの外へも出られる', async () => {
    await explains('`..` や連続した区切り文字を含むパスを渡した場合のテストです。パスが正規化され、`..` がマウントルートの外まで遡る場合も拒否されず、`/etc/passwd` に変換されることを確認します。')
    expect(toPosixPath(String.raw`C:\work\..\deck`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/pecotv-mount/c/deck' })
    expect(toPosixPath(String.raw`C:\\work\\deck`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/pecotv-mount/c/work/deck' })
    // サンドボックス境界ではないので mount root の外へ抜ける入力も拒否しない (FR-011 と同じ立場)。
    expect(toPosixPath(String.raw`C:\..\..\..\etc\passwd`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/etc/passwd' })
  })

  it('自分のディストリビューションを指す UNC パスは、WSL 内の絶対パスに変換する', async () => {
    await explains('`\\\\wsl$\\` と `\\\\wsl.localhost\\` で始まる、自分のディストリビューションを指す UNC パスを渡した場合のテストです。どちらも `/home/alice/deck` のような WSL 内の絶対パスに変換されることを確認します。')
    expect(toPosixPath(String.raw`\\wsl$\Ubuntu-24.04\home\alice\deck`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice/deck' })
    expect(toPosixPath(String.raw`\\wsl.localhost\Ubuntu-24.04\home\alice\deck`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice/deck' })
  })

  it('UNC パスのディストリビューション名は、大文字と小文字を区別せずに比較する', async () => {
    await explains('ディストリビューション名を小文字で書いた UNC パスを渡した場合のテストです。大文字と小文字を区別せずに一致と判定され、`/home/alice` に変換されることを確認します。')
    expect(toPosixPath(String.raw`\\wsl.localhost\ubuntu-24.04\home\alice`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice' })
  })

  it('UNC パスのホスト名（wsl$ と wsl.localhost）も、大文字と小文字を区別しない', async () => {
    await explains('ホスト名を大文字で書いた UNC パス（`\\\\WSL$\\` と `\\\\WSL.LOCALHOST\\`）を渡した場合のテストです。どちらも `/home/alice` に変換されることを確認します。')
    // Windows のホスト名は大文字小文字を区別しない。distro 名の一致確認 (toLowerCase) と
    // 非対称にならないよう、接頭辞の一致も case-insensitive にする。
    expect(toPosixPath(String.raw`\\WSL$\Ubuntu-24.04\home\alice`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice' })
    expect(toPosixPath(String.raw`\\WSL.LOCALHOST\Ubuntu-24.04\home\alice`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice' })
  })

  it('ディストリビューション名の後ろの区切り文字が混在していても、変換できる', async () => {
    await explains('ディストリビューション名の後ろだけスラッシュで書いた UNC パスを渡した場合のテストです。ディストリビューション名に後続のパスが含まれず、`/home/alice` に変換されることを確認します。')
    // ドライブレター形式は `[/\\]` で両区切りを受理している。
    // distro 名の後ろだけバックスラッシュ限定だと、混在表記が誤って解釈される。
    // 例は `\\wsl.localhost\Ubuntu-24.04/home/alice` で、distro 名に `/home/alice` まで巻き込んでしまう。
    expect(toPosixPath(String.raw`\\wsl.localhost\Ubuntu-24.04/home/alice`, TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice' })
  })

  it('スラッシュで書いた WSL の UNC パスも、バックスラッシュで書いた場合と同じように変換する', async () => {
    await explains('`//wsl.localhost/` と `//wsl$/` で始まる UNC パスを渡した場合のテストです。バックスラッシュで書いた場合と同じく、`/home/alice` に変換されることを確認します。')
    expect(toPosixPath('//wsl.localhost/Ubuntu-24.04/home/alice', TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice' })
    expect(toPosixPath('//wsl$/Ubuntu-24.04/home/alice', TEST_ENV))
      .toEqual({ kind: 'converted', path: '/home/alice' })
  })

  it('スラッシュで書いた WSL 以外の UNC パスも、変換できないものとして扱う', async () => {
    await explains('WSL 以外のサーバーを指す UNC パス（`//fileserver/share/deck`）を渡した場合のテストです。変換できない（`unsupported`）と判定され、その理由に `UNC` が含まれることを確認します。')
    const conversion = toPosixPath('//fileserver/share/deck', TEST_ENV)

    expect(conversion.kind).toBe('unsupported')
    expect(conversion.kind === 'unsupported' ? conversion.reason : '').toContain('UNC')
  })

  it('ディストリビューションのルートだけを指す UNC パスは、/ に変換する', async () => {
    await explains('ディストリビューション名だけの UNC パス（`\\\\wsl$\\Ubuntu-24.04`）を渡した場合のテストです。`/` に変換されることを確認します。')
    expect(toPosixPath(String.raw`\\wsl$\Ubuntu-24.04`, TEST_ENV)).toEqual({ kind: 'converted', path: '/' })
  })

  it('ほかのディストリビューションを指す UNC パスは、理由を付けて変換できないものとして扱う', async () => {
    await explains('自分とは別のディストリビューション（`Debian`）を指す UNC パスを渡した場合のテストです。変換できない（`unsupported`）と判定され、その理由に自分のディストリビューション名と `Debian` が含まれることを確認します。')
    const conversion = toPosixPath(String.raw`\\wsl.localhost\Debian\home\alice`, TEST_ENV)

    expect(conversion.kind).toBe('unsupported')
    expect(conversion.kind === 'unsupported' ? conversion.reason : '').toContain('Ubuntu-24.04')
    expect(conversion.kind === 'unsupported' ? conversion.reason : '').toContain('Debian')
  })

  it('WSL_DISTRO_NAME が設定されていない場合は、UNC パスを変換できないものとして扱う', async () => {
    await explains('環境変数 `WSL_DISTRO_NAME` を設定していない状態で、UNC パスを渡した場合のテストです。変換できない（`unsupported`）と判定され、その理由に `unset` が含まれることを確認します。')
    const conversion = toPosixPath(String.raw`\\wsl$\Ubuntu-24.04\home`, { PECOTV_WSL_MOUNT_ROOT: '/pecotv-mount' })

    expect(conversion.kind).toBe('unsupported')
    expect(conversion.kind === 'unsupported' ? conversion.reason : '').toContain('unset')
  })

  it('ドライブ相対のパスは、変換できないものとして扱う', async () => {
    await explains('`C:relative\\deck` のような、ドライブ相対のパスを渡した場合のテストです。変換できない（`unsupported`）と判定され、その理由に渡したパスが含まれることを確認します。')
    const conversion = toPosixPath(String.raw`C:relative\deck`, TEST_ENV)

    expect(conversion.kind).toBe('unsupported')
    expect(conversion.kind === 'unsupported' ? conversion.reason : '').toContain(String.raw`C:relative\deck`)
  })

  it('WSL 以外の UNC パスは、変換できないものとして扱う', async () => {
    await explains('WSL 以外のサーバーを指す UNC パス（`\\\\fileserver\\share\\deck`）を渡した場合のテストです。変換できない（`unsupported`）と判定され、その理由に `UNC` が含まれることを確認します。')
    const conversion = toPosixPath(String.raw`\\fileserver\share\deck`, TEST_ENV)

    expect(conversion.kind).toBe('unsupported')
    expect(conversion.kind === 'unsupported' ? conversion.reason : '').toContain('UNC')
  })

  it('POSIX の絶対パスは、変換しない', async () => {
    await explains('`/home/alice/deck` のような POSIX の絶対パスを渡した場合のテストです。変換せずに、`unchanged` を返すことを確認します。')
    expect(toPosixPath('/home/alice/deck', TEST_ENV)).toEqual({ kind: 'unchanged' })
  })

  it('相対パスは、変換しない', async () => {
    await explains('`deck/slides.md` や `./deck`、ルート相対の Windows 形式のパスを渡した場合のテストです。ドライブが決まらないため変換せず、すべて `unchanged` を返すことを確認します。')
    expect(toPosixPath('deck/slides.md', TEST_ENV)).toEqual({ kind: 'unchanged' })
    expect(toPosixPath('./deck', TEST_ENV)).toEqual({ kind: 'unchanged' })
    // ルート相対の Windows 表記もドライブが決まらないため変換しない。
    expect(toPosixPath(String.raw`\deck\slides.md`, TEST_ENV)).toEqual({ kind: 'unchanged' })
  })

  it('PECOTV_WSL_MOUNT_ROOT が設定されていない、空、または絶対パスでない場合は、/mnt をマウントルートにする', async () => {
    await explains('環境変数 `PECOTV_WSL_MOUNT_ROOT` が、未設定、空、相対パスのいずれかである場合のテストです。どの場合も、マウントルートが `/mnt` になり、`/mnt/c/work` に変換されることを確認します。')
    expect(toPosixPath(String.raw`C:\work`, { WSL_DISTRO_NAME: 'Ubuntu' }))
      .toEqual({ kind: 'converted', path: '/mnt/c/work' })
    expect(toPosixPath(String.raw`C:\work`, { PECOTV_WSL_MOUNT_ROOT: '' }))
      .toEqual({ kind: 'converted', path: '/mnt/c/work' })
    expect(toPosixPath(String.raw`C:\work`, { PECOTV_WSL_MOUNT_ROOT: 'relative/mnt' }))
      .toEqual({ kind: 'converted', path: '/mnt/c/work' })
  })

  it('PECOTV_WSL_MOUNT_ROOT の末尾の区切り文字は、正規化して取り除く', async () => {
    await explains('環境変数 `PECOTV_WSL_MOUNT_ROOT` の末尾に `/` が付いている場合のテストです。区切り文字が重複せず、`/pecotv-mount/c/work` に変換されることを確認します。')
    expect(toPosixPath(String.raw`C:\work`, { PECOTV_WSL_MOUNT_ROOT: '/pecotv-mount/' }))
      .toEqual({ kind: 'converted', path: '/pecotv-mount/c/work' })
  })

  describe('env 省略時', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('第 2 引数を省略した場合は、現在の環境変数を使う', async () => {
      await explains('`toPosixPath` の第 2 引数（環境変数）を省略した場合のテストです。`PECOTV_WSL_MOUNT_ROOT` に設定した値が、変換後のパスのマウントルートとして使われることを確認します。')
      // 既定引数 (第 2 引数省略) のルートそのものを確認する。stub した値が変換後パスへ
      // そのまま出ることを見て、既定引数がダミー値の {} 等で通っていないことを保証する。
      vi.stubEnv('PECOTV_WSL_MOUNT_ROOT', '/pecotv-mount-env-default')

      expect(toPosixPath(String.raw`C:\work`)).toEqual({ kind: 'converted', path: '/pecotv-mount-env-default/c/work' })
    })
  })
})
