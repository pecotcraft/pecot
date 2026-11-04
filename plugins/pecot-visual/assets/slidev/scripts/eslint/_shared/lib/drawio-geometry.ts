/**
 * draw.io（.drawio）XML の幾何を、描画結果を見ずに XML だけから求める純関数群。
 *
 * - セル解決: セル ID → 図座標の絶対矩形（入れ子 parent の offset を加算）。
 * - 外接矩形: 表示される vertex の矩形（枠線の半幅を含む）と edge の経由点の和。
 * - フィットモデル: diagrams.net viewer が図をパネルへ収める規則を再現する。
 *   viewer は LDrawioDiagramBare の srcdoc 設定 border: 20 で動く。
 *   図座標を、パネル座標へ写す。
 *
 * フィット規則（viewer-static.min.js の描画を計測して確定）:
 * - 図座標 x はキャンバス座標 x + tx に置かれる。tx = floor(20 - minX)。
 * - キャンバス幅 = ceil(maxX + tx + 40)（外接矩形が整数なら W + 60）。高さも同様。
 * - 各図形は線幅 max(1, round(strokeWidth)) が奇数のとき (0.5, 0.5) ずれて描かれる。
 * - s = min(1, パネル幅 / キャンバス幅, パネル高 / キャンバス高)。キャンバスはパネル中央。
 * - 描画上の外接矩形は、枠線のある vertex で線幅の半分だけ広がる。
 *   edge の経由点では線幅だけ広がる（枠線なしは半分。shape=flexArrow は 0）。
 *   矢じり・影・図形からはみ出すラベルによる広がりは扱わない。
 *   （図の外周に置かなければ影響しない）。
 *
 * DOMParser に依存しない。
 * アルゴリズムはテーマ側のレイアウトの実行時が使う実装と同じ結果を返す（同値テストで固定している）。
 * 非対応の図・解決できないセルは DrawioGeometryError（code 付き）を投げる。
 */

/** srcdoc の viewer 設定 border。図の原点を置くキャンバス上の位置 */
export const VIEWER_BORDER = 20

/**
 * 縮小なしで描ける外接矩形（線幅を含む）の上限。
 * パネルの寸法はテーマの宣言（drawio.panels）が持つ。
 * fitDiagram の式に合わせ、キャンバスは外接矩形の左に tx（= VIEWER_BORDER）を足す。
 * 右には VIEWER_BORDER × 2 を足す。
 * そのためパネルから、3 × VIEWER_BORDER = 60 を引く。
 */
export function maxDiagramBounds(panel: Panel): Size {
  const margin = VIEWER_BORDER * 3
  return { width: panel.width - margin, height: panel.height - margin }
}

export type DrawioGeometryErrorCode =
  | 'empty-xml'
  | 'no-model'
  | 'compressed'
  | 'wrapped-cell'
  | 'multi-page'
  | 'unknown-cell'
  | 'edge-cell'
  | 'not-vertex'
  | 'hidden-cell'
  | 'relative-cell'

export class DrawioGeometryError extends Error {
  readonly code: DrawioGeometryErrorCode

  constructor(code: DrawioGeometryErrorCode, message: string) {
    super(message)
    this.name = 'DrawioGeometryError'
    this.code = code
  }
}

export interface Size {
  width: number
  height: number
}

export type Panel = Size

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface CellRect extends Rect {
  /** viewer 描画での画素格子合わせ量（0 または 0.5） */
  crisp: number
}

export interface DiagramFit {
  tx: number
  ty: number
  scale: number
  canvasWidth: number
  canvasHeight: number
  offsetX: number
  offsetY: number
}

interface Point {
  x: number
  y: number
}

interface Geometry {
  x: number
  y: number
  width: number
  height: number
  relative: boolean
  sourcePoint: Point | null
  targetPoint: Point | null
  points: Point[]
}

interface Cell {
  id: string | undefined
  parent: string | null
  vertex: boolean
  edge: boolean
  visible: boolean
  source: string | null
  target: string | null
  style: string
  geometry: Geometry | null
}

export interface DrawioModel {
  readonly byId: ReadonlyMap<string, Cell>
  /** 図形の geometry だけの外接矩形。表示される図形が無ければ null */
  readonly bounds: Rect | null
  /** 枠線・線幅の広がりを含めた描画上の外接矩形。表示される図形が無ければ null */
  readonly visualBounds: Rect | null
  isHidden(cell: Cell): boolean
  vertexRect(cell: Cell): Rect | null
}

const ENTITY_RE = /&(?:#(\d+)|#x([0-9A-Fa-f]+)|(lt|gt|amp|quot|apos));/g
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (_match, dec?: string, hex?: string, name?: string) => {
    if (dec) return String.fromCodePoint(Number(dec))
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    return NAMED_ENTITIES[name as string]
  })
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(source)) !== null) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '')
  }
  return attrs
}

function num(value: string | undefined, fallback = 0): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function point(attrs: Record<string, string>): Point {
  return { x: num(attrs.x), y: num(attrs.y) }
}

/** style 文字列（"text;html=1;strokeColor=none;"）を名前付きスタイルとキー値に分ける */
function parseStyle(style: string | undefined): { names: string[]; values: Record<string, string> } {
  const names: string[] = []
  const values: Record<string, string> = {}
  for (const token of (style ?? '').split(';')) {
    if (!token) continue
    const eq = token.indexOf('=')
    if (eq < 0) names.push(token)
    else values[token.slice(0, eq)] = token.slice(eq + 1)
  }
  return { names, values }
}

// デフォルトで枠線を描かない名前付きスタイル・shape（draw.io のデフォルトスタイルシート）
const STROKELESS_STYLES = new Set(['text', 'image', 'label', 'edgeLabel', 'group'])

function strokeOf(style: string): { width: number; stroked: boolean } {
  const { names, values } = parseStyle(style)
  const width = num(values.strokeWidth, 1)
  let stroked: boolean
  if (values.strokeColor !== undefined) stroked = values.strokeColor !== 'none'
  else stroked = !names.some((n) => STROKELESS_STYLES.has(n)) && !STROKELESS_STYLES.has(values.shape)
  return { width, stroked }
}

/** mxShape の画素格子合わせ。線幅（枠線の有無によらない）が奇数なら 0.5 */
function crispOffsetOf(strokeWidth: number): number {
  return Math.max(1, Math.round(strokeWidth)) % 2 === 1 ? 0.5 : 0
}

const TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g

/**
 * XML 文字列を mxCell の一覧に分解する。
 */
function scanCells(xml: string): Cell[] {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new DrawioGeometryError('empty-xml', 'draw.io の XML が空です')
  }
  const source = xml.replace(/<!--[\s\S]*?-->/g, '')

  const cells: Cell[] = []
  let diagramCount = 0
  let modelCount = 0
  const stack: { name: string; hasChild: boolean }[] = [] // 開いている要素。diagram 直下に要素が無い（= 圧縮）かの判定に使う
  let current: Cell | null = null // 開いている mxCell
  let geometry: Geometry | null = null // 開いている mxGeometry
  let inPoints = false // <Array as="points"> の中

  TAG_RE.lastIndex = 0
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(source)) !== null) {
    const [whole, closing, name, attrSource, selfClosing] = m as unknown as [string, string, string, string, string]
    const between = source.slice(lastIndex, m.index)
    lastIndex = m.index + whole.length

    if (closing) {
      const top = stack.pop()
      if (top?.name === 'diagram' && !top.hasChild && between.trim() !== '') {
        throw new DrawioGeometryError(
          'compressed',
          '圧縮形式の <diagram> は非対応です。draw.io の「ファイル → プロパティ → 圧縮」を外して保存してください'
        )
      }
      if (name === 'mxCell') current = null
      else if (name === 'mxGeometry') geometry = null
      else if (name === 'Array') inPoints = false
      continue
    }

    const parent = stack[stack.length - 1]
    if (parent) parent.hasChild = true

    if (name === 'object' || name === 'UserObject') {
      throw new DrawioGeometryError(
        'wrapped-cell',
        `<${name}> で包んだセルは非対応です（セルにプロパティやリンクを付けると生成されます）。プロパティを外した mxCell にしてください`
      )
    }
    if (name === 'diagram') {
      diagramCount += 1
      if (diagramCount > 1) {
        throw new DrawioGeometryError(
          'multi-page',
          '複数ページの draw.io ファイルは非対応です。1 ページだけのファイルにしてください'
        )
      }
    }
    if (name === 'mxGraphModel') modelCount += 1

    const attrs = parseAttrs(attrSource)
    if (name === 'mxCell') {
      const cell: Cell = {
        id: attrs.id,
        parent: attrs.parent ?? null,
        vertex: attrs.vertex === '1',
        edge: attrs.edge === '1',
        visible: attrs.visible !== '0',
        source: attrs.source ?? null,
        target: attrs.target ?? null,
        style: attrs.style ?? '',
        geometry: null
      }
      cells.push(cell)
      if (!selfClosing) current = cell
    } else if (name === 'mxGeometry' && current) {
      const g: Geometry = {
        x: num(attrs.x),
        y: num(attrs.y),
        width: num(attrs.width),
        height: num(attrs.height),
        relative: attrs.relative === '1',
        sourcePoint: null,
        targetPoint: null,
        points: []
      }
      current.geometry = g
      if (!selfClosing) geometry = g
    } else if (name === 'Array' && geometry && attrs.as === 'points') {
      if (!selfClosing) inPoints = true
    } else if (name === 'mxPoint' && geometry) {
      if (inPoints) geometry.points.push(point(attrs))
      else if (attrs.as === 'sourcePoint') geometry.sourcePoint = point(attrs)
      else if (attrs.as === 'targetPoint') geometry.targetPoint = point(attrs)
    }

    if (!selfClosing) stack.push({ name, hasChild: false })
  }

  if (modelCount === 0) {
    throw new DrawioGeometryError('no-model', 'draw.io の XML に <mxGraphModel> がありません')
  }
  return cells
}

/**
 * draw.io XML を解析する。
 * bounds は図形の geometry だけの外接矩形、visualBounds は枠線の半幅を含めた描画上の外接矩形。
 */
export function parseDrawio(xml: string): DrawioModel {
  const cells = scanCells(xml)
  const byId = new Map<string, Cell>()
  for (const cell of cells) {
    if (cell.id !== undefined) byId.set(cell.id, cell)
  }

  const isRoot = (cell: Cell): boolean => !cell.parent || !byId.has(cell.parent)
  const isLayer = (cell: Cell): boolean => !isRoot(cell) && isRoot(byId.get(cell.parent as string) as Cell)

  // 祖先のどれかが visible="0" なら描画されない（レイヤ・グループの非表示を含む）
  function isHidden(cell: Cell): boolean {
    for (
      let c: Cell | undefined = cell, depth = 0;
      c && depth < 1000;
      c = c.parent === null ? undefined : byId.get(c.parent), depth += 1
    ) {
      if (!c.visible) return true
    }
    return false
  }

  // cell の子が使う座標系の原点（図座標）。座標を持たない親（edge・相対配置）なら null
  function childOrigin(cell: Cell, depth = 0): Point | null {
    if (depth > 1000) return null
    if (isRoot(cell) || isLayer(cell)) return { x: 0, y: 0 }
    if (!cell.vertex || !cell.geometry || cell.geometry.relative) return null
    const base = childOrigin(byId.get(cell.parent as string) as Cell, depth + 1)
    if (!base) return null
    return { x: base.x + cell.geometry.x, y: base.y + cell.geometry.y }
  }

  function originOf(cell: Cell): Point | null {
    const parent = cell.parent === null ? undefined : byId.get(cell.parent)
    return parent ? childOrigin(parent) : { x: 0, y: 0 }
  }

  /** vertex の絶対矩形。描画されない・座標を決められない vertex は null */
  function vertexRect(cell: Cell): Rect | null {
    if (!cell.vertex || !cell.geometry || cell.geometry.relative || isHidden(cell)) return null
    const origin = originOf(cell)
    if (!origin) return null
    return {
      x: origin.x + cell.geometry.x,
      y: origin.y + cell.geometry.y,
      width: cell.geometry.width,
      height: cell.geometry.height
    }
  }

  /** edge の経由点（図座標）。端点の座標は接続先が無いときだけ描画に使われる */
  function edgePoints(cell: Cell): Point[] {
    if (!cell.edge || !cell.geometry || isHidden(cell)) return []
    const origin = originOf(cell)
    if (!origin) return []
    const g = cell.geometry
    const pts = [...g.points]
    if (g.sourcePoint && !cell.source) pts.push(g.sourcePoint)
    if (g.targetPoint && !cell.target) pts.push(g.targetPoint)
    return pts.map((p) => ({ x: origin.x + p.x, y: origin.y + p.y }))
  }

  type Bounds = { minX: number; minY: number; maxX: number; maxY: number }
  const geo: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const vis: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const extend = (acc: Bounds, x0: number, y0: number, x1: number, y1: number): void => {
    acc.minX = Math.min(acc.minX, x0)
    acc.minY = Math.min(acc.minY, y0)
    acc.maxX = Math.max(acc.maxX, x1)
    acc.maxY = Math.max(acc.maxY, y1)
  }
  for (const cell of cells) {
    const rect = vertexRect(cell)
    if (rect) {
      extend(geo, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height)
      const { width, stroked } = strokeOf(cell.style)
      const half = stroked ? width / 2 : 0
      extend(vis, rect.x - half, rect.y - half, rect.x + rect.width + half, rect.y + rect.height + half)
    }
    const points = edgePoints(cell)
    if (points.length > 0) {
      // 線の描画上の広がり（計測: 枠線あり ±線幅、なし ±線幅/2、さらに格子合わせ分だけ
      // 右下へずれる）。shape=flexArrow は先端が終点ちょうどで広がらない（計測）。
      // 矢じり・flexArrow の胴の太さによる広がりは扱わない
      const { width, stroked } = strokeOf(cell.style)
      const flexArrow = parseStyle(cell.style).values.shape === 'flexArrow'
      const grow = flexArrow ? 0 : stroked ? width : width / 2
      const crisp = flexArrow ? 0 : crispOffsetOf(width)
      for (const p of points) {
        extend(geo, p.x, p.y, p.x, p.y)
        extend(vis, p.x - grow + crisp, p.y - grow + crisp, p.x + grow + crisp, p.y + grow + crisp)
      }
    }
  }
  const toRect = (acc: Bounds): Rect | null =>
    Number.isFinite(acc.minX)
      ? { x: acc.minX, y: acc.minY, width: acc.maxX - acc.minX, height: acc.maxY - acc.minY }
      : null

  return { byId, bounds: toRect(geo), visualBounds: toRect(vis), isHidden, vertexRect }
}

/**
 * セル ID から vertex の絶対矩形（図座標）と描画時の格子合わせ量を返す。
 */
export function resolveCellRect(model: DrawioModel, cellId: string): CellRect {
  const cell = model.byId.get(cellId)
  if (!cell) {
    throw new DrawioGeometryError('unknown-cell', `セル "${cellId}" が図にありません`)
  }
  if (cell.edge) {
    throw new DrawioGeometryError(
      'edge-cell',
      `セル "${cellId}" は線（edge）です。マーカーは図形（vertex）の ID を指定してください`
    )
  }
  if (!cell.vertex) {
    throw new DrawioGeometryError(
      'not-vertex',
      `セル "${cellId}" はレイヤ等の図形でないセルです。図形（vertex）の ID を指定してください`
    )
  }
  if (model.isHidden(cell)) {
    throw new DrawioGeometryError('hidden-cell', `セル "${cellId}" は非表示（visible="0"）です`)
  }
  const rect = model.vertexRect(cell)
  if (!rect) {
    throw new DrawioGeometryError(
      'relative-cell',
      `セル "${cellId}" は親に対する相対配置（relative="1"）のため位置を決められません`
    )
  }
  return { ...rect, crisp: crispOffsetOf(strokeOf(cell.style).width) }
}

const EPS = 1e-6

/**
 * viewer のフィット規則で、描画上の外接矩形をパネルへ収める変換を求める。
 */
export function fitDiagram(visualBounds: Rect, panel: Panel): DiagramFit {
  const tx = Math.floor(VIEWER_BORDER - visualBounds.x + EPS)
  const ty = Math.floor(VIEWER_BORDER - visualBounds.y + EPS)
  const canvasWidth = Math.ceil(visualBounds.x + visualBounds.width + tx + VIEWER_BORDER * 2 - EPS)
  const canvasHeight = Math.ceil(visualBounds.y + visualBounds.height + ty + VIEWER_BORDER * 2 - EPS)
  const scale = Math.min(1, panel.width / canvasWidth, panel.height / canvasHeight)
  return {
    tx,
    ty,
    scale,
    canvasWidth,
    canvasHeight,
    // キャンバス左上のパネル座標
    offsetX: (panel.width - canvasWidth * scale) / 2,
    offsetY: (panel.height - canvasHeight * scale) / 2
  }
}

/**
 * 図座標の点をパネル座標へ写す。crisp はその図形の格子合わせ量（resolveCellRect の crisp）。
 */
export function toPanelPoint(fit: DiagramFit, x: number, y: number, crisp = 0): Point {
  return {
    x: fit.offsetX + (x + fit.tx + crisp) * fit.scale,
    y: fit.offsetY + (y + fit.ty + crisp) * fit.scale
  }
}

/**
 * 事前 export SVG（原点 = 描画上の外接矩形の左上）を viewer 描画と同じ位置に置く左上と縮尺。
 * export SVG の図形には格子合わせが掛からないため、線幅 1 の図形に合わせて 0.5 を足す。
 * 寸法は img の natural サイズ × scale で決める（export の外接矩形は矢印等を含み得る）。
 */
export function staticImageOrigin(
  fit: DiagramFit,
  visualBounds: Point,
): { x: number; y: number; scale: number } {
  const p = toPanelPoint(fit, visualBounds.x, visualBounds.y, 0.5)
  return { x: p.x, y: p.y, scale: fit.scale }
}

/**
 * セル中心をパネル矩形に対する百分率（0〜100）で返す。SMarkerOverlay の {px, py}。
 */
export function cellCenterPercent(
  model: DrawioModel,
  cellId: string,
  panel: Panel,
): { px: number; py: number } {
  const rect = resolveCellRect(model, cellId)
  // vertex を 1 つ解決できた時点で visualBounds は必ずある
  const fit = fitDiagram(model.visualBounds as Rect, panel)
  const center = toPanelPoint(fit, rect.x + rect.width / 2, rect.y + rect.height / 2, rect.crisp)
  return { px: (center.x / panel.width) * 100, py: (center.y / panel.height) * 100 }
}
