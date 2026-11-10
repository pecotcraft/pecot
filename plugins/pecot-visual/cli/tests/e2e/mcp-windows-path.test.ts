// CUJ: Windows の MCP クライアントが、パス引数に Windows 形式のまま値を渡して成果物を得る。
//
// 配布 README は、Windows のクライアントに WSL2 経由 (`wsl npx ...`) での起動を案内している。
// そのクライアントが組み立てるパスは、`C:\...` と `\\wsl.localhost\<distro>\...` になる。
// 変換はサーバプロセスの中で起きる。
// そのため in-process のハンドラテストでは、「dist に載ったサーバが実際にそのパスへ書くか」までは観測できない。
//
// devcontainer は WSL ではなく、`/mnt` も書けない。
// そこで mount root は PECOTV_WSL_MOUNT_ROOT で tmp に差し替え、distro 名は WSL_DISTRO_NAME で固定して実プロセスへ注入する。
//
// mcp-tools.test.ts へ足さず、別ファイルにする。
// 理由は、あちらが slide_create を 3 回呼び、e2e lane の最長側に寄っているため。
// これは #1084 の E2E 分割方針。
// 呼ぶツールは、Chromium と Slidev のどちらも起こさない evidence_create だけに絞る。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MOUNT_ROOT_ENV } from '../../src/mcp/windows-path.js'
import { buildPng } from '../_helpers/image-fixture.js'
import { CLI_DIST, drainStderr, makeTransport } from '../_helpers/mcp-stdio.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

/**
SDK の request timeout。mcp-tools.test.ts と同値 (hang を it の timeout まで持ち越さない)。
*/
const REQUEST_TIMEOUT_MS = 15_000

/**
注入する distro 名。UNC 形式の distro 一致ガードを通すための固定値。
*/
const DISTRO = 'e2e'

/**
変換後の out_path。`C:\pecotv-1094\out.xlsx` が畳まれる先 (mount root は tmp に差し替える)。
*/
const OUT_DRIVE_PATH = String.raw`C:\pecotv-1094\out.xlsx`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function structuredOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const structured = result['structuredContent']
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

const mountRoot = useTemporaryDirectory('pecotv-1094-e2e-', { hook: 'all' })
const specPath = (): string => mountRoot('spec.json')

beforeAll(() => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`cli dist が存在しません: ${CLI_DIST}\n先に \`pnpm build\` を実行してください`)
  }
  const imagePath = mountRoot('01-login.png')
  writeFileSync(imagePath, buildPng(80, 60))
  writeFileSync(specPath(), JSON.stringify({
    title: 'Windows 形式のパスで作るエビデンス',
    createdDate: '2026-09-08',
    items: [{ imagePath, caption: 'ログイン画面' }],
  }), 'utf8')
  // 変換後の書き出し先の親を用意する。evidence_create は out_path の親までは作らない。
  mkdirSync(mountRoot('c', 'pecotv-1094'), { recursive: true })
})

afterAll(() => {
  if (mountRoot() !== '') rmSync(mountRoot(), { recursive: true, force: true })
})

describe('pecotv mcp が Windows 形式のパス引数を変換する (stdio)', () => {
  it('evidence_create が UNC の spec を読み、ドライブ形式の out_path へ xlsx を書く', async () => {
    // 実クライアントが送る形に寄せて、区切りは全てバックスラッシュにする。
    const inputPath = `\\\\wsl.localhost\\${DISTRO}${specPath().replaceAll('/', '\\')}`
    const expectedOut = mountRoot('c', 'pecotv-1094', 'out.xlsx')

    const transport = makeTransport({ [MOUNT_ROOT_ENV]: mountRoot(), WSL_DISTRO_NAME: DISTRO })
    const readStderr = drainStderr(transport.stderr)
    const client = new Client({ name: 'pecotv-e2e-windows-path', version: '0.0.0' })
    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
      const called = await client.callTool(
        { name: 'evidence_create', arguments: { input_path: inputPath, out_path: OUT_DRIVE_PATH } },
        { timeout: REQUEST_TIMEOUT_MS },
      )

      expect(called.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      const structured = structuredOf(called)
      expect(structured['ok']).toBe(true)
      expect(structured['exitCode']).toBe(0)
      // 変換に失敗していれば入り口のガードで弾かれ、ここに invalidPaths が載る。
      expect(structured['data']).not.toHaveProperty('invalidPaths')
      expect(structured['artifacts']).toEqual([expectedOut])
      expect(existsSync(expectedOut)).toBe(true)
      expect(statSync(expectedOut).size).toBeGreaterThan(0)

      // 別 distro の UNC は解決不能として exitCode 2 で拒否される (#1094 F-14)。
      // 同一 spawn 内に呼び出しを 1 本足すだけなので、この E2E の増分コストはほぼゼロ。
      const otherDistro = `${DISTRO}-other`
      const otherDistroPath = `\\\\wsl.localhost\\${otherDistro}${specPath().replaceAll('/', '\\')}`
      const rejected = await client.callTool(
        { name: 'evidence_create', arguments: { input_path: otherDistroPath, out_path: OUT_DRIVE_PATH } },
        { timeout: REQUEST_TIMEOUT_MS },
      )

      expect(rejected.isError, `子プロセス stderr: ${readStderr()}`).toBe(true)
      const rejectedStructured = structuredOf(rejected)
      expect(rejectedStructured['exitCode']).toBe(2)
      expect(rejectedStructured['message']).toContain('cannot resolve Windows-style path')
      expect(rejectedStructured['message']).toContain(otherDistro)
    }
    finally {
      await client.close()
    }
  }, 120_000)

  it('spec 内の imagePath は変換対象外で、Windows 形式のまま渡ると not-found で除外される (#1094 F-11)', async () => {
    // 変換が働くのはツール引数 (input_path / out_path) のみで、EvidenceSpec の中身 (imagePath) までは変換しない。
    // この境界を越えて imagePath に Windows 形式を書くと、全件なら exitCode 1 (配置できる画像がありません)。
    // POSIX と混在なら ok: true のまま、当該画像だけ data.skipped に入る (成果物が静かに欠ける)。
    // 混在ケースを pin する。
    const mixedRoot = mkdtempSync(path.join(tmpdir(), 'pecotv-1094-e2e-mixed-'))
    const validImagePath = path.join(mixedRoot, '01-login.png')
    writeFileSync(validImagePath, buildPng(80, 60))
    const missingWindowsImagePath = String.raw`C:\shots\02-missing.png`
    const mixedSpecPath = path.join(mixedRoot, 'spec.json')
    writeFileSync(mixedSpecPath, JSON.stringify({
      title: 'ツール引数だけが変換対象であることの境界',
      createdDate: '2026-09-08',
      items: [
        { imagePath: validImagePath, caption: 'ログイン画面' },
        { imagePath: missingWindowsImagePath, caption: '変換されないはずの画像' },
      ],
    }), 'utf8')
    const outPath = path.join(mixedRoot, 'out.xlsx')

    const transport = makeTransport()
    const readStderr = drainStderr(transport.stderr)
    const client = new Client({ name: 'pecotv-e2e-windows-path-spec-boundary', version: '0.0.0' })
    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
      const called = await client.callTool(
        { name: 'evidence_create', arguments: { input_path: mixedSpecPath, out_path: outPath } },
        { timeout: REQUEST_TIMEOUT_MS },
      )

      expect(called.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      const structured = structuredOf(called)
      expect(structured['ok']).toBe(true)
      expect(structured['exitCode']).toBe(0)
      expect(structured['data']).toMatchObject({
        skipped: [{ path: missingWindowsImagePath, reason: 'not-found' }],
      })
      expect(existsSync(outPath)).toBe(true)
    }
    finally {
      await client.close()
      rmSync(mixedRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
