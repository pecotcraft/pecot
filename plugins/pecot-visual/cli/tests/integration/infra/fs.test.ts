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

const temporaryRoot = useTemporaryDirectory('pecotv-fs-test-')

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

describe('assertDependencyRootAvailable', () => {
  it('node_modules の実体が無い依存ルートは、理由付きで symlink-failed を投げる', () => {
    const root = temporaryRoot('no-node-modules')
    mkdirSync(root)
    const check = (): void => {
      assertDependencyRootAvailable(root)
    }
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))

    expect(check).toThrow(SlideCreateRuntimeError)
    expect(check).toThrow(/node_modules が見つかりません/)
  })

  it('実体があれば何も投げない', () => {
    const root = temporaryRoot('plugin')
    seedDependencyRoot(root)
    const check = (): void => {
      assertDependencyRootAvailable(root)
    }

    expect(check).not.toThrow()
  })
})

describe('setupPublicSlides', () => {
  it('public/slides/{images,diagrams,html} を作り、public/assets は作らない', async () => {
    const destination = temporaryRoot('dest')
    mkdirSync(destination)

    await setupPublicSlides(destination)

    expect(readdirSync(path.join(destination, 'public'))).toEqual(['slides'])
    expect(readdirSync(path.join(destination, 'public', 'slides')).toSorted(compareStrings)).toEqual(['diagrams', 'html', 'images'])
  })

  it('生成先がまだ無くても、親から作る', async () => {
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
  it('pages/ が無い talk-dir は空配列を返す', async () => {
    const talk = temporaryRoot('no-pages')
    mkdirSync(talk)
    expect(await listSkippedSymlinkPageDirectories(talk)).toStrictEqual([])
  })

  it('symlink を含まない pages/ は空配列を返す', async () => {
    const talk = makeTalk('plain')
    mkdirSync(path.join(talk, 'pages', 'sub'))
    writeFileSync(path.join(talk, 'pages', 'sub', 'a.md'), 'x')
    expect(await listSkippedSymlinkPageDirectories(talk)).toStrictEqual([])
  })

  it('解決先が dir の symlink を talk-dir 相対パスで返す', async () => {
    const talk = makeTalk('symlinked')
    const external = temporaryRoot('external')
    mkdirSync(external)
    symlinkSync(external, path.join(talk, 'pages', 'sub'), 'dir')
    expect(await listSkippedSymlinkPageDirectories(talk))
      .toStrictEqual([path.join('pages', 'sub')])
  })

  it('物理サブディレクトリは再帰し、その中の symlink dir も検出する', async () => {
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
  it('解決先がファイルの symlink は報告しない', async () => {
    const talk = makeTalk('linked-file')
    const externalFile = temporaryRoot('external.md')
    writeFileSync(externalFile, 'x')
    symlinkSync(externalFile, path.join(talk, 'pages', 'linked.md'), 'file')
    expect(await listSkippedSymlinkPageDirectories(talk)).toStrictEqual([])
  })

  it('dangling symlink は報告しない', async () => {
    const talk = makeTalk('dangling-link')
    symlinkSync(temporaryRoot('gone'), path.join(talk, 'pages', 'dangling'), 'dir')
    expect(await listSkippedSymlinkPageDirectories(talk)).toStrictEqual([])
  })

  it('複数の symlink dir は名前順で返す', async () => {
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
  it('reason フィールドを name や message とは独立に取得できる', () => {
    const error = new SlideCreateRuntimeError('msg', 'some-reason')
    expect(error.reason).toBe('some-reason')
    expect(error.message).toBe('msg')
    expect(error.name).toBe('SlideCreateRuntimeError')
  })
})
