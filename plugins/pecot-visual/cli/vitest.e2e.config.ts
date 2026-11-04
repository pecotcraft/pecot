import { availableParallelism } from 'node:os'

import { defineConfig } from 'vitest/config'

// E2E 専用 config。`pnpm test:e2e` でのみ起動する。
// 重い処理を含むため、`pnpm test` (unit + integration) からは隔離する (tech-advisor P3)。
// 重い処理は、実 npx slidev build / Playwright Chromium / pptx-postprocess。
//
// timeout 階層 (#506 で確定)。
//   it(..., 660_000) = vitest.testTimeout 660_000 > runPecotv spawnSync 600_000。
//   runPecotv spawnSync 600_000 = convert.ts の SLIDEV_BUILD_TIMEOUT_MS (600_000)。
//   pptx convert 側 (PPTX_CONVERT_IDLE_TIMEOUT_MS 600_000) は「進捗なし時間」の上限で、
//   合計時間を縛らない (#1097)。spawnSync 600_000 は、slidev build に対してのみ同値。
//   pptx convert の合計時間そのものの実効上限は、この spawnSync 600_000 (親プロセス側の固定 timeout) に依存する。
//   これは、e2e で使うテストデッキの規模 (スライド枚数・並列度) が spawnSync の枠内に収まる前提の上に成り立つ。
//   デッキが大きくなる等で前提が破れた場合、進捗が途切れず idle timeout には掛からない。
//   その場合は spawnSync 側の SIGTERM kill で強制終了する。
//   この場合は PipelineTimeoutError の elapsedMs / lastProgress のような差分情報を持たない。
//   spawnSync の timedOut フラグ止まりの、読み取りにくい失敗になる。
//   spawnSync と内部 timeout を同値にすると、spawnSync 側 SIGTERM kill で差分情報が消える。
//   差分情報とは timedOut フラグ等を指す。
//   そのため vitest 側 (it / testTimeout) に余裕を持たせる。
//   it 引数と testTimeout は同値 (どちらも 660_000)。
//
// pool: 'forks' + maxWorkers 制限の根拠:
//   各 test file が実 Chromium と実 slidev build を起こす。
//   vitest 既定の並列度に任せると、CPU / メモリを奪い合って実行時間が跳ね、timeout 判定が不安定になる。
//   既定の並列度は、availableParallelism() - 1 で、watch 時は floor(n/2)。
//   maxWorkers: 6 は、#1084 の計測で決めた値。
//   計測は、24 コア / 31 GB の devcontainer で、22 ファイル・75 テストを N = 4 / 5 / 6 / 8 で各 3 run。
//     N=4 wall 42.4s / N=5 34.7s / N=6 29.4s / N=8 29.8s（3 run 平均）。
//   N=6 で makespan が最長ファイルに張り付き、それ以上増やしても縮まない。
//   最長ファイルは cache-identity-full-vs-diff で約 27s。
//   N=8 は資源競合で、その最長ファイル自身が 29s へ延びる。
//   node / headless_shell の RSS 合計のピーク（3 run 平均）も、N=6 比で +1.49 GB 増えるだけ。所要は改善しない。
//   よって「最良と差が無い最小の N」として 6 を採る。
//   低コア環境では、実コア数にクランプする（Math.min(6, availableParallelism())）。
//   ファイル内に複数 it を持つテストは、ファイル単位で 1 worker に閉じる。
//   そのため実行順序は、ファイル間並列化の影響を受けない。
//   所要時間は資源競合の影響を受ける。
//   そのため各ファイルの duration ceiling は、この N での並列計測ベース。
//   pool: 'forks' は、Vitest 4 の default 変更予防と、Playwright Chromium 等の native binding hang 防止が目的。
//   これは Vitest 公式 common-errors.md の推奨。
//   #506 で観測した port 3002 の握り潰し由来のハングは、dist 配信サーバの ephemeral port 化 (既定 port=0) で解消済み。
//   そのため、直列化の根拠には含まれない。
export default defineConfig({
  test: {
    setupFiles: ['tests/_helpers/unset-plugin-data-environment.ts'],
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 660_000,
    pool: 'forks',
    maxWorkers: Math.min(6, availableParallelism()),
    isolate: true,
  },
})
