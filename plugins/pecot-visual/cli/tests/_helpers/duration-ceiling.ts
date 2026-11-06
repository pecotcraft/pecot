// 24 CPU で決めた e2e の ceiling を、4 CPU の CI で伸ばす倍率（CI は 3）。
// 上限 4 は、最大の ceiling 130 秒の 4 倍が spawnSync の 600 秒より手前で落ちるため。

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
