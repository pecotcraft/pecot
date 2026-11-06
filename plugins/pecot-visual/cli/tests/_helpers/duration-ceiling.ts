// e2e の所要の上限（ceiling）に掛ける倍率。
//
// ceiling は 24 CPU の手元で計測して決めた。4 CPU の CI で全レーンを同時に動かすと超える。
// 目的は性能目標ではなく、hang の検知に置く。
//
// CI は環境変数 PECOTV_E2E_CEILING_SCALE に 3 を渡す。
// CI の ceiling は大きな劣化と hang だけを拾う。細かい劣化は倍率 1 の手元で見る。
//
// 倍率の上限は 4 とする。最大の ceiling は 130 秒で、4 倍は 520 秒になる。
// この値は runPecotv の spawnSync の 600 秒と testTimeout の 660 秒より手前で落ちる。
// 上限を超えると、ceiling の判定より先に timeout が働き、原因が読めなくなる。

const SCALE_ENV = 'PECOTV_E2E_CEILING_SCALE'
const SCALE_MIN = 1
const SCALE_MAX = 4

function readScale(): number {
  const raw = process.env['PECOTV_E2E_CEILING_SCALE']
  if (raw === undefined || raw.trim() === '') return 1
  const scale = Number(raw)
  if (!Number.isFinite(scale) || scale < SCALE_MIN || scale > SCALE_MAX) {
    throw new Error(
      `${SCALE_ENV}=${JSON.stringify(raw)} は使えない。${String(SCALE_MIN)} 以上 ${String(SCALE_MAX)} 以下の数を指定する。`,
    )
  }
  return scale
}

export function durationCeilingMs(baseMs: number): number {
  return Math.round(baseMs * readScale())
}
