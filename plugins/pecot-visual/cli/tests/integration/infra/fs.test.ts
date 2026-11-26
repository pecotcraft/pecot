// infra/slidev-project/fs.ts の追加検証。
// setupPublicSlides / assertDependencyRootAvailable の各分岐を網羅する。
// node_modules の組み立て（linkNodeModules）は src/infra/slidev-project/tests/node-modules.test.ts が見る。
// 特に外周ケースを見る。

/* eslint-disable security/detect-non-literal-fs-filename */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assertDependencyRootAvailable,
  listSkippedSymlinkPageDirectories,
  setupPublicSlides,
} from '../../../src/infra/slidev-project/fs.js'
import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import { SlideCreateRuntimeError } from '../../../src/domain/slidev-project/errors.js'
import { seedDependencyRoot } from '../../_helpers/dependency-probes.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { explains } from '../../_helpers/explains.js'

const temporaryRoot = useTemporaryDirectory('pecotv-fs-test-')

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

describe('assertDependencyRootAvailable', () => {
  it('node_modules が存在しない依存ルートを検証すると、理由付きで symlink-failed の例外が発生する', async () => {
    await explains('`assertDependencyRootAvailable` のテストです。`node_modules` が存在しない依存ルートを渡した場合に、`SlideCreateRuntimeError` の例外が発生することを確認します。')
    const root = temporaryRoot('no-node-modules')
    mkdirSync(root)
    const check = (): void => {
      assertDependencyRootAvailable(root)
    }
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    expect(check).toThrow(SlideCreateRuntimeError)
    expect(check).toThrow(/node_modules not found/)
  })

  it('node_modules が存在する依存ルートを検証しても、例外が発生しない', async () => {
    await explains('`assertDependencyRootAvailable` のテストです。`node_modules` を用意した依存ルートを渡した場合に、例外が発生しないことを確認します。')
    const root = temporaryRoot('plugin')
    seedDependencyRoot(root)
    const check = (): void => {
      assertDependencyRootAvailable(root)
    }

    expect(check).not.toThrow()
  })
})

describe('setupPublicSlides', () => {
  it('public/slides の下に images・diagrams・html を作成し、public/assets は作成しない', async () => {
    await explains('`setupPublicSlides` のテストです。生成先を渡した場合に、`public` の下が `slides` だけで、`slides` の下が `diagrams`・`html`・`images` になることを確認します。')
    const destination = temporaryRoot('dest')
    mkdirSync(destination)

    await setupPublicSlides(destination)

    expect(readdirSync(path.join(destination, 'public'))).toEqual(['slides'])
    expect(readdirSync(path.join(destination, 'public', 'slides')).toSorted(compareStrings)).toEqual(['diagrams', 'html', 'images'])
  })

  it('生成先がまだ存在しなくても、親のディレクトリから作成する', async () => {
    await explains('`setupPublicSlides` のテストです。親のディレクトリを含めて存在しない生成先を渡した場合に、`public/slides/images` が作成されることを確認します。')
    const destination = temporaryRoot('not-yet', 'dest')

    await setupPublicSlides(destination)

    expect(existsSync(path.join(destination, 'public', 'slides', 'images'))).toBe(true)
  })
})

function makeTalk(name: string): string {
  const talk = temporaryRoot(name)
  mkdirSync(path.join(talk, 'pages'), { recursive: true })
  return talk
}

describe('listSkippedSymlinkPageDirectories', () => {
  // 本番トリガーは、worktree の `.pecot/work` が base への symlink になっている構成など。
  // talk-dir の `pages/` 配下に symlink dir を置くと、eslint が配下を 1 件も lint しない。
  it('pages が存在しない talk-dir では、空の配列を返す', async () => {
    await explains('`listSkippedSymlinkPageDirectories` のテストです。`pages` ディレクトリがない talk-dir を渡した場合に、空の配列が返ることを確認します。')
    const talk = temporaryRoot('no-pages')
    mkdirSync(talk)
    expect(await listSkippedSymlinkPageDirectories(talk)).toStrictEqual([])
  })

  it('symlink を含まない pages では、空の配列を返す', async () => {
    await explains('`listSkippedSymlinkPageDirectories` のテストです。実際のサブディレクトリだけがある `pages` を渡した場合に、空の配列が返ることを確認します。')
    const talk = makeTalk('plain')
    mkdirSync(path.join(talk, 'pages', 'sub'))
    writeFileSync(path.join(talk, 'pages', 'sub', 'a.md'), 'x')
    expect(await listSkippedSymlinkPageDirectories(talk)).toStrictEqual([])
  })

  it('リンク先がディレクトリの symlink は、talk-dir からの相対パスで返す', async () => {
    await explains('`listSkippedSymlinkPageDirectories` のテストです。`pages` の下に、外部のディレクトリを指す symlink がある場合に、`pages/sub` のような talk-dir からの相対パスが返ることを確認します。')
    const talk = makeTalk('symlinked')
    const external = temporaryRoot('external')
    mkdirSync(external)
    symlinkSync(external, path.join(talk, 'pages', 'sub'), 'dir')
    expect(await listSkippedSymlinkPageDirectories(talk))
      .toStrictEqual([path.join('pages', 'sub')])
  })

  it('実際のサブディレクトリは再帰して探索し、その中の symlink のディレクトリも検出する', async () => {
    await explains('`listSkippedSymlinkPageDirectories` のテストです。`pages/deep` の中に symlink のディレクトリがある場合に、`pages/deep/sub` が返ることを確認します。')
    const talk = makeTalk('nested')
    const external = temporaryRoot('external-nested')
    mkdirSync(external)
    mkdirSync(path.join(talk, 'pages', 'deep'))
    symlinkSync(external, path.join(talk, 'pages', 'deep', 'sub'), 'dir')
    expect(await listSkippedSymlinkPageDirectories(talk))
      .toStrictEqual([path.join('pages', 'deep', 'sub')])
  })

  // symlink→ファイルは eslint が実際に lint するため、報告不要。
  // lint される側は integration/commands/slide-lint.test.ts のトポロジ D が固定する。
  it('リンク先がファイルの symlink は、報告しない', async () => {
    await explains('`listSkippedSymlinkPageDirectories` のテストです。`pages` の下に、ファイルを指す symlink だけがある場合に、eslint はそのファイルを lint するため、空の配列が返ることを確認します。')
    const talk = makeTalk('linked-file')
    const externalFile = temporaryRoot('external.md')
    writeFileSync(externalFile, 'x')
    symlinkSync(externalFile, path.join(talk, 'pages', 'linked.md'), 'file')
    expect(await listSkippedSymlinkPageDirectories(talk)).toStrictEqual([])
  })

  it('リンク先が存在しない symlink は、報告しない', async () => {
    await explains('`listSkippedSymlinkPageDirectories` のテストです。`pages` の下に、存在しないパスを指す symlink がある場合に、空の配列が返ることを確認します。')
    const talk = makeTalk('dangling-link')
    symlinkSync(temporaryRoot('gone'), path.join(talk, 'pages', 'dangling'), 'dir')
    expect(await listSkippedSymlinkPageDirectories(talk)).toStrictEqual([])
  })

  it('symlink のディレクトリが複数ある場合は、名前順に並べて返す', async () => {
    await explains('`listSkippedSymlinkPageDirectories` のテストです。`zeta`・`alpha`・`mid` の順に作成した symlink のディレクトリが、`alpha`・`mid`・`zeta` の順に返ることを確認します。')
    const talk = makeTalk('sorted')
    const external = temporaryRoot('external-sorted')
    mkdirSync(external)
    for (const name of ['zeta', 'alpha', 'mid']) {
      symlinkSync(external, path.join(talk, 'pages', name), 'dir')
    }
    expect(await listSkippedSymlinkPageDirectories(talk)).toStrictEqual([
      path.join('pages', 'alpha'),
      path.join('pages', 'mid'),
      path.join('pages', 'zeta'),
    ])
  })
})

describe('SlideCreateRuntimeError', () => {
  it('reason の値を、name や message とは別に取得できる', async () => {
    await explains('`SlideCreateRuntimeError` のテストです。`reason` に `copy-failed` を指定して作成した場合に、`reason` がその値になり、`message` と `name` は別の値のままであることを確認します。')
    const error = new SlideCreateRuntimeError('msg', 'copy-failed')
    expect(error.reason).toBe('copy-failed')
    expect(error.message).toBe('msg')
    expect(error.name).toBe('SlideCreateRuntimeError')
  })
})
