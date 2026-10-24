// 寵物、配件、蛋、場景的像素畫。
// 寵物用 16 單位的「設計座標」畫（身體在 16×16 的方框內、中心 x = 8），
// 依階段放大：寶寶 ×1（16 px）、少年 ×1.5（24 px）、成年 ×2（32 px），所以同一套形狀越長越細緻。
import { cached, Px } from './pixel'

export type Species = 'mochi' | 'pip' | 'nori' | 'drako'
export type Branch = 'listen' | 'scholar' | 'grit' | 'balance'
export type Mood = 'happy' | 'normal' | 'miss'

export const SPECIES: Species[] = ['mochi', 'pip', 'nori', 'drako']
export const SPECIES_INFO: Record<Species, { name: string; desc: string }> = {
  mochi: { name: '麻糬', desc: '軟Q的史萊姆，頭上會長出新芽' },
  pip: { name: '啾啾', desc: '圓滾滾的小鳥，羽冠越長越帥' },
  nori: { name: '煤球', desc: '黑色小貓，尾巴很有個性' },
  drako: { name: '小龍', desc: '還飛不起來的小龍，角和翅膀會慢慢長大' },
}
export const BRANCH_INFO: Record<Branch, { name: string; hint: string }> = {
  listen: { name: '聽力型', hint: '少年期多做「聽發音拼字」「句子聽力」' },
  scholar: { name: '學者型', hint: '少年期答對很多罕見字' },
  grit: { name: '毅力型', hint: '少年期幾乎每天都有複習' },
  balance: { name: '均衡型', hint: '各方面都差不多' },
}
export const STAGE_NAME = ['', '寶寶', '少年', '成年']

interface Pal {
  base: string
  shade: string
  light: string
  outline: string
  eye: string
  cheek: string
  extra: string // 每個物種自己的重點色（嘴、內耳、翅膀…）
  extra2: string
}

const PAL: Record<Species, [Pal, Pal]> = {
  mochi: [
    { base: '#9be8b4', shade: '#63c48d', light: '#e2fbe9', outline: '#2f5d47', eye: '#1f2a2a', cheek: '#ff9fb3', extra: '#5cb85c', extra2: '#3e8e41' },
    { base: '#ffb3d9', shade: '#e57fb5', light: '#ffe4f2', outline: '#6b2f50', eye: '#3a1f2e', cheek: '#ff7aa2', extra: '#ffd166', extra2: '#e0a930' },
  ],
  pip: [
    { base: '#ffd95a', shade: '#f0ad32', light: '#fff3b8', outline: '#6b4a14', eye: '#2a1f12', cheek: '#ff9f80', extra: '#ff8a3d', extra2: '#d9622b' },
    { base: '#bfe6ff', shade: '#86c3ea', light: '#eef8ff', outline: '#2c4d66', eye: '#1b2a3a', cheek: '#ffa3c4', extra: '#ffb347', extra2: '#e08a1e' },
  ],
  nori: [
    { base: '#4b4e6d', shade: '#34364f', light: '#6f7396', outline: '#191a26', eye: '#ffe066', cheek: '#ff8fa8', extra: '#ff9fb3', extra2: '#8a8db0' },
    { base: '#f2f2f7', shade: '#c9c9d9', light: '#ffffff', outline: '#55556b', eye: '#6ec3ff', cheek: '#ffb0c4', extra: '#ffb0c4', extra2: '#e3e3ee' },
  ],
  drako: [
    { base: '#b9a2ff', shade: '#8b6fe6', light: '#e6dcff', outline: '#3b2a73', eye: '#221a40', cheek: '#ff9fc8', extra: '#ff9fc8', extra2: '#ffe7a8' },
    { base: '#9ff0d0', shade: '#5fcca5', light: '#e0fff3', outline: '#1f5c47', eye: '#12332a', cheek: '#ffa3b8', extra: '#ffd36b', extra2: '#fff1c2' },
  ],
}

const SCALE = [0, 1, 1.5, 2]

/** 各物種的錨點（設計座標），配件和分支特徵依此擺放 */
interface Anchor {
  top: number // 頭頂
  eyeY: number
  eyeDx: number // 眼睛離中線
  headRx: number
  neckY: number
}

const ANCHOR: Record<Species, Anchor> = {
  mochi: { top: 4.3, eyeY: 9.6, eyeDx: 2.5, headRx: 6.4, neckY: 12.4 },
  pip: { top: 4.0, eyeY: 8.4, eyeDx: 2.3, headRx: 5.6, neckY: 12 },
  nori: { top: 3.5, eyeY: 7.6, eyeDx: 2.6, headRx: 5.6, neckY: 11.4 },
  drako: { top: 4.4, eyeY: 8.6, eyeDx: 2.4, headRx: 5.6, neckY: 12 },
}

/** 設計座標 → 像素的畫筆。畫布四周留空間給帽子、翅膀、尾巴 */
class Pen {
  readonly g: Px
  constructor(
    readonly k: number,
    readonly ox = 3,
    readonly oy = 5,
  ) {
    this.g = new Px(Math.round((16 + ox * 2) * k), Math.round((16 + oy + 1) * k))
  }
  X = (v: number) => (v + this.ox) * this.k
  Y = (v: number) => (v + this.oy) * this.k
  ellipse(cx: number, cy: number, rx: number, ry: number, c: string | null) {
    this.g.ellipse(this.X(cx), this.Y(cy), rx * this.k, ry * this.k, c)
  }
  /** 左右對稱的一對橢圓（cx 為左邊那個） */
  ellipse2(cx: number, cy: number, rx: number, ry: number, c: string | null) {
    this.ellipse(cx, cy, rx, ry, c)
    this.ellipse(16 - cx, cy, rx, ry, c)
  }
  poly(pts: [number, number][], c: string) {
    this.g.poly(
      pts.map(([x, y]) => [this.X(x), this.Y(y)]),
      c,
    )
  }
  poly2(pts: [number, number][], c: string) {
    this.poly(pts, c)
    this.poly(
      pts.map(([x, y]) => [16 - x, y]),
      c,
    )
  }
  rect(x: number, y: number, w: number, h: number, c: string | null) {
    this.g.rect(this.X(x), this.Y(y), w * this.k, h * this.k, c)
  }
  /** 以設計座標的點，畫 1 像素 */
  dot(x: number, y: number, c: string) {
    this.g.set(Math.floor(this.X(x)), Math.floor(this.Y(y)), c)
  }
  /** 新的一層（同尺寸），畫完再疊回來 */
  layer(): Pen {
    return new Pen(this.k, this.ox, this.oy)
  }
}

/** 有陰影的身體：先畫整個陰影色，再往左上縮一點畫本色，最後點高光 */
function blob(p: Pen, cx: number, cy: number, rx: number, ry: number, pal: Pal, light = true) {
  p.ellipse(cx, cy, rx, ry, pal.shade)
  p.ellipse(cx - 0.35, cy - 0.35, rx - 0.55, ry - 0.55, pal.base)
  if (light) p.ellipse(cx - rx * 0.42, cy - ry * 0.48, Math.max(0.6, rx * 0.22), Math.max(0.5, ry * 0.16), pal.light)
}

function face(p: Pen, a: Anchor, pal: Pal, mood: Mood, opts: { pupil?: boolean } = {}) {
  const { g, k } = p
  const ew = k < 1.5 ? 1 : 2
  const eh = k < 1.5 ? 2 : k < 2 ? 2 : 3
  const ex = Math.round(p.X(8 - a.eyeDx) - ew / 2)
  const ey = Math.round(p.Y(a.eyeY) - eh / 2)
  if (mood === 'happy') {
    // ^ ^ 瞇眼
    const w = ew + 2
    for (let i = 0; i < w; i++) {
      const up = i === 0 || i === w - 1 ? 1 : 0
      g.sym(ex - 1 + i, ey + up + (eh > 2 ? 1 : 0), pal.eye)
    }
  } else {
    for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) g.sym(ex + x, ey + y, pal.eye)
    if (opts.pupil) for (let y = 0; y < eh; y++) g.sym(ex + ew - 1, ey + y, '#1a1a1a')
    else if (ew >= 2) g.sym(ex, ey, '#ffffff')
    if (mood === 'miss') g.set(ex + ew - 1, ey + eh + 1, '#7ec8ff') // 一滴淚
  }
  // 腮紅
  const cy = ey + eh + (k < 1.5 ? 0 : 1)
  const cx = ex - (k < 1.5 ? 1 : 2)
  g.sym(cx, cy, pal.cheek)
  if (k >= 2) g.sym(cx + 1, cy, pal.cheek)
  // 嘴巴：開心時大一點
  const mx = Math.floor((g.w - 1) / 2)
  const my = ey + eh + (k < 1.5 ? 0 : 1)
  if (mood === 'happy' && k >= 1.5) {
    g.sym(mx, my + 1, pal.outline)
    g.sym(mx - 1, my, pal.outline)
  } else if (mood === 'miss') {
    g.sym(mx, my + 1, pal.outline)
  } else {
    g.sym(mx, my, pal.outline)
  }
}

// ---- 物種 ----

function drawMochi(p: Pen, stage: number, pal: Pal) {
  blob(p, 8, 10, 6.8, 5.8, pal)
  p.rect(-3, 15.2, 22, 4, null) // 平底
  if (stage >= 2) {
    // 頭上的新芽
    p.rect(7.7, 2.2, 0.6, 2.2, pal.extra2)
    p.ellipse(9.4, 2.4, 1.4, 0.75, pal.extra)
    if (stage >= 3) p.ellipse(6.4, 2.0, 1.3, 0.7, pal.extra)
  }
  if (stage >= 3) {
    p.ellipse2(2.0, 14.6, 1.0, 0.8, pal.shade) // 兩側往下滴
  }
}

function drawPip(p: Pen, stage: number, pal: Pal) {
  if (stage >= 3) p.poly([[13, 12.5], [15.6, 10.4], [15.4, 12.6], [13.6, 14]], pal.shade) // 尾羽
  p.ellipse2(2.4, 10.8, 1.5, stage >= 3 ? 3.0 : 2.4, pal.shade) // 翅膀
  blob(p, 8, 9.6, 6, 5.8, pal)
  p.ellipse(8, 12, 3.2, 2.3, pal.light) // 肚子
  // 羽冠
  p.poly([[7.1, 4.4], [7.8, stage >= 2 ? 1.6 : 2.4], [8.9, 4.4]], pal.base)
  if (stage >= 2) p.poly([[8.2, 4.4], [9.8, 2.4], [9.6, 4.6]], pal.shade)
  if (stage >= 3) p.poly([[6.4, 4.6], [6.0, 2.6], [7.6, 4.2]], pal.shade)
  // 嘴與腳
  p.poly([[7.1, 10.1], [8, 9.3], [8.9, 10.1], [8, 11]], pal.extra)
  p.rect(5.6, 15.1, 1, 0.8, pal.extra2)
  p.rect(9.4, 15.1, 1, 0.8, pal.extra2)
}

function drawNori(p: Pen, stage: number, pal: Pal) {
  // 尾巴（越大越長）
  const tail: [number, number][] =
    stage >= 3
      ? [[12.6, 14], [14.4, 13], [15.4, 11], [15.4, 8.6], [14.6, 7.4]]
      : stage >= 2
        ? [[12.6, 14], [14.4, 12.8], [15, 10.6], [14.6, 9.4]]
        : [[12.4, 14], [13.8, 13], [14.2, 11.6]]
  for (const [x, y] of tail) p.ellipse(x, y, 0.95, 0.95, pal.base)
  blob(p, 8, 12.4, 5, 3.4, pal, false) // 身體
  p.poly2([[2.6, 6], [3.2, 1.8], [6.6, 4.2]], pal.base) // 耳朵
  p.poly2([[3.6, 5.2], [3.9, 3.0], [5.6, 4.4]], pal.extra) // 內耳
  blob(p, 8, 8, 5.9, 4.6, pal) // 頭
  p.ellipse(8, 9.9, 1.9, 1.1, pal.extra2) // 嘴邊
  p.dot(7.75, 9.2, pal.extra)
  p.rect(5.2, 15.2, 1.2, 0.7, pal.light) // 腳
  p.rect(9.6, 15.2, 1.2, 0.7, pal.light)
  if (stage >= 3) {
    // 鬍鬚
    const { g } = p
    for (const dy of [0, 1.2]) {
      g.line(p.X(2.6), p.Y(9.4 + dy), p.X(0.8), p.Y(9 + dy * 1.4), pal.light)
      g.line(p.X(13.4), p.Y(9.4 + dy), p.X(15.2), p.Y(9 + dy * 1.4), pal.light)
    }
  }
}

function drawDrako(p: Pen, stage: number, pal: Pal) {
  const wing: [number, number][] =
    stage >= 3 ? [[4, 9], [-0.6, 3.6], [0.2, 9.8], [3.4, 11.4]] : stage >= 2 ? [[4, 9], [0.4, 5.4], [1, 10], [3.6, 11]] : [[4.2, 9.4], [1.6, 7.2], [2, 10.4], [4, 11]]
  p.poly2(wing, pal.extra)
  p.poly(
    stage >= 2
      ? [[11.6, 13], [15.8, 12.8], [16.6, 10.2], [14.6, 12]]
      : [[11.6, 13.2], [14.6, 13.4], [15, 11.6]],
    pal.shade,
  ) // 尾巴
  blob(p, 8, 10, 5.8, 5.6, pal)
  p.ellipse(8, 12.2, 3.2, 2.6, pal.extra2) // 肚子
  const horn: [number, number][] = stage >= 3 ? [[4.8, 5.4], [3.6, 1.6], [6.6, 4.6]] : [[5.2, 5.2], [4.8, 2.8], [6.6, 4.6]]
  p.poly2(horn, '#fff4d6')
  p.dot(7.2, 10.6, pal.outline) // 鼻孔
  p.dot(8.8, 10.6, pal.outline)
  p.rect(5.4, 15.1, 1.2, 0.8, pal.shade)
  p.rect(9.4, 15.1, 1.2, 0.8, pal.shade)
}

const DRAW: Record<Species, (p: Pen, stage: number, pal: Pal) => void> = {
  mochi: drawMochi,
  pip: drawPip,
  nori: drawNori,
  drako: drawDrako,
}

// ---- 成年分支的特徵 ----

function branchBack(p: Pen, branch: Branch, a: Anchor) {
  if (branch === 'grit') p.poly([[3.4, a.neckY], [12.6, a.neckY], [15.2, 16], [0.8, 16]], '#e8505b') // 披風
}

function branchFront(p: Pen, branch: Branch, a: Anchor, hasHat: boolean) {
  const gold = '#ffcf40'
  switch (branch) {
    case 'listen':
      // 音波和音符在描邊之後畫（branchFx），這裡只加耳朵上的小耳機墊
      p.ellipse2(8 - a.headRx + 0.2, a.eyeY - 0.6, 0.9, 1.3, '#3cc8c8')
      break
    case 'scholar': {
      // 學士帽＋書
      const ink = '#2b2b40'
      p.poly([[3.6, a.top - 0.8], [8, a.top - 2.6], [12.4, a.top - 0.8], [8, a.top + 0.6]], ink)
      p.rect(6, a.top - 0.4, 4, 1.2, ink)
      p.rect(11.4, a.top - 0.9, 0.5, 2.4, gold)
      p.rect(1.2, 12.6, 3.4, 2.6, '#e0565b')
      p.rect(1.6, 12.6, 0.5, 2.6, '#fff3e0')
      break
    }
    case 'grit': {
      // 頭帶（披風在身體後面畫）
      p.rect(8 - a.headRx + 0.4, a.top + 1.6, (a.headRx - 0.4) * 2, 0.9, '#e8505b')
      p.poly([[13.2, a.top + 1.6], [15.4, a.top + 1.2], [15, a.top + 2.8], [13.2, a.top + 2.5]], '#e8505b')
      break
    }
    case 'balance': {
      // 光環（戴帽子時不畫，星星在描邊後畫）
      if (hasHat) break
      const halo = p.layer()
      halo.ellipse(8, a.top - 2.6, 3.4, 1.0, gold)
      halo.ellipse(8, a.top - 2.6, 2.3, 0.4, null)
      p.g.draw(halo.g)
      break
    }
  }
}

/** 描邊之後才畫的特效（不要黑框）：音波、星星 */
function branchFx(p: Pen, branch: Branch, a: Anchor) {
  if (branch === 'listen') {
    const c = '#3cc8c8'
    for (const r of [7.6, 9.2])
      for (let deg = -28; deg <= 28; deg += 4) {
        const t = (deg * Math.PI) / 180
        const y = a.eyeY + r * Math.sin(t) * 0.9
        p.dot(8 - r * Math.cos(t), y, c)
        p.g.set(p.g.w - 1 - Math.floor(p.X(8 - r * Math.cos(t))), Math.floor(p.Y(y)), c)
      }
    p.rect(13.2, a.top - 3.6, 0.5, 2.8, c)
    p.rect(13.2, a.top - 3.6, 1.5, 0.5, c)
    p.ellipse(12.9, a.top - 0.8, 0.8, 0.6, c)
  }
  if (branch === 'balance') {
    const gold = '#ffcf40'
    for (const [x, y] of [[1.4, a.top + 0.8], [14.6, a.top + 2.8], [14, 14]] as [number, number][]) {
      p.dot(x, y, gold)
      p.dot(x - 0.5, y, gold)
      p.dot(x + 0.5, y, gold)
      p.dot(x, y - 0.5, gold)
      p.dot(x, y + 0.5, gold)
    }
  }
}

// ---- 配件（商店）----

export const ACCESSORY_INFO: Record<string, { name: string; slot: 'head' | 'face' | 'neck' }> = {
  cap: { name: '棒球帽', slot: 'head' },
  bow: { name: '蝴蝶結', slot: 'head' },
  flower: { name: '小花', slot: 'head' },
  beanie: { name: '毛帽', slot: 'head' },
  headphones: { name: '耳機', slot: 'head' },
  wizard: { name: '巫師帽', slot: 'head' },
  crown: { name: '皇冠', slot: 'head' },
  glasses: { name: '圓框眼鏡', slot: 'face' },
  shades: { name: '墨鏡', slot: 'face' },
  scarf: { name: '圍巾', slot: 'neck' },
}

function accessory(p: Pen, id: string, a: Anchor) {
  const t = a.top
  const l = p.layer()
  switch (id) {
    case 'cap':
      l.poly([[4.3, t + 1.4], [5, t - 0.4], [8, t - 1.3], [11, t - 0.4], [11.7, t + 1.4]], '#4f8ef7')
      l.rect(8, t + 0.7, 5.4, 0.9, '#2f6ad8')
      l.dot(8, t - 1.1, '#ffffff')
      break
    case 'bow':
      l.poly([[5.4, t + 0.8], [3.3, t - 0.8], [3.3, t + 2.2]], '#ff7aa8')
      l.poly([[5.4, t + 0.8], [7.4, t - 0.8], [7.4, t + 2.2]], '#ff7aa8')
      l.ellipse(5.4, t + 0.8, 0.7, 0.7, '#e0477f')
      break
    case 'flower':
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) l.ellipse(10.8 + dx, t + 0.4 + dy, 0.8, 0.8, '#ffffff')
      l.ellipse(10.8, t + 0.4, 0.6, 0.6, '#ffcf40')
      break
    case 'beanie':
      l.poly([[4.4, t + 1.4], [5, t - 0.6], [8, t - 1.6], [11, t - 0.6], [11.6, t + 1.4]], '#e85d75')
      l.rect(4.2, t + 0.6, 7.6, 1.1, '#c03d58')
      l.ellipse(8, t - 1.9, 1.1, 1.1, '#ffffff')
      break
    case 'headphones': {
      const band = p.layer()
      band.ellipse(8, a.eyeY - 0.4, a.headRx + 0.5, a.eyeY - t + 1.4, '#3b3f58')
      band.ellipse(8, a.eyeY - 0.4, a.headRx - 0.4, a.eyeY - t + 0.6, null)
      band.rect(-3, a.eyeY - 1, 22, 10, null)
      l.g.draw(band.g)
      l.rect(8 - a.headRx - 1, a.eyeY - 1.6, 1.8, 3, '#ff6b6b')
      l.rect(8 + a.headRx - 0.8, a.eyeY - 1.6, 1.8, 3, '#ff6b6b')
      break
    }
    case 'wizard':
      l.poly([[4.2, t + 1.2], [11.8, t + 1.2], [9.4, t - 3.6], [8.6, t - 5.2]], '#6c4ad6')
      l.rect(4.4, t + 0.3, 7.2, 1, '#ffcf40')
      l.dot(8.4, t - 1.6, '#ffcf40')
      break
    case 'crown':
      l.poly([[5, t + 0.9], [5, t - 1.6], [6.4, t - 0.3], [8, t - 2.1], [9.6, t - 0.3], [11, t - 1.6], [11, t + 0.9]], '#ffcf40')
      l.ellipse(8, t + 0.1, 0.6, 0.6, '#e8505b')
      break
    case 'glasses': {
      const ring = p.layer()
      ring.ellipse2(8 - a.eyeDx, a.eyeY + 0.2, 1.7, 1.5, '#d9a441')
      ring.ellipse2(8 - a.eyeDx, a.eyeY + 0.2, 1.05, 0.9, null)
      l.g.draw(ring.g)
      l.rect(8 - a.eyeDx + 1.5, a.eyeY - 0.1, (a.eyeDx - 1.5) * 2, 0.5, '#d9a441')
      break
    }
    case 'shades':
      l.rect(8 - a.eyeDx - 1.5, a.eyeY - 0.8, 3, 1.8, '#1d1d24')
      l.rect(8 + a.eyeDx - 1.5, a.eyeY - 0.8, 3, 1.8, '#1d1d24')
      l.rect(8 - a.eyeDx + 1.4, a.eyeY - 0.6, (a.eyeDx - 1.4) * 2, 0.6, '#1d1d24')
      l.dot(8 - a.eyeDx - 1, a.eyeY - 0.6, '#6b6b80')
      break
    case 'scarf':
      l.rect(8 - a.headRx + 1.2, a.neckY, (a.headRx - 1.2) * 2, 1.3, '#e8505b')
      l.poly([[10.2, a.neckY + 0.8], [12, a.neckY + 0.8], [12.4, a.neckY + 3.6], [10.8, a.neckY + 3.4]], '#c93a47')
      break
  }
  p.g.draw(l.g)
}

// ---- 對外 ----

export interface PetLook {
  species: Species
  stage: number // 1 寶寶、2 少年、3 成年
  branch?: Branch | null
  shiny?: boolean
  mood?: Mood
  accessories?: string[]
}

function petPx(look: PetLook): Px {
  const { species, stage } = look
  const pal = PAL[species][look.shiny ? 1 : 0]
  const a = ANCHOR[species]
  const p = new Pen(SCALE[stage])
  const branch = stage >= 3 ? look.branch ?? 'balance' : null
  if (branch) branchBack(p, branch, a)
  DRAW[species](p, stage, pal)
  face(p, a, pal, look.mood ?? 'normal', { pupil: species === 'nori' })
  const acc = look.accessories ?? []
  if (branch) branchFront(p, branch, a, acc.some((id) => ACCESSORY_INFO[id]?.slot === 'head'))
  for (const id of acc) accessory(p, id, a)
  p.g.outline(pal.outline)
  if (branch) branchFx(p, branch, a)
  return p.g
}

export function petSprite(look: PetLook) {
  const key = ['pet', look.species, look.stage, look.branch ?? '', look.shiny ? 1 : 0, look.mood ?? '', ...(look.accessories ?? [])].join(':')
  return cached(key, () => petPx(look))
}

/** 圖鑑還沒發現的型態 */
export function petSilhouette(species: Species, stage: number, branch?: Branch) {
  return cached(`sil:${species}:${stage}:${branch ?? ''}`, () =>
    petPx({ species, stage, branch }).silhouette('#9aa0b5'),
  )
}

/** 蛋：progress 0–1，越接近孵化裂痕越多 */
export function eggSprite(species: Species, progress = 0) {
  const crack = progress >= 0.85 ? 2 : progress >= 0.5 ? 1 : 0
  return cached(`egg:${species}:${crack}`, () => {
    const pal = PAL[species][0]
    const p = new Pen(1.5, 1, 1)
    p.ellipse(8, 9.6, 5.2, 6.4, '#e9e2d0')
    p.ellipse(7.6, 9.2, 4.7, 5.9, '#fffaf0')
    p.ellipse(5.8, 6.4, 0.9, 1.2, '#ffffff')
    for (const [x, y, r] of [[9.6, 7.2, 1.2], [6.4, 11.6, 1.0], [10.4, 12.2, 0.8], [7.6, 4.6, 0.7]])
      p.ellipse(x, y, r, r * 0.9, pal.base)
    const ink = '#6b5b4a'
    if (crack >= 1) for (const [x0, y0, x1, y1] of [[4, 9, 6, 8], [6, 8, 7.4, 9.6], [7.4, 9.6, 9, 8.2]]) p.g.line(p.X(x0), p.Y(y0), p.X(x1), p.Y(y1), ink)
    if (crack >= 2) for (const [x0, y0, x1, y1] of [[9, 8.2, 10.6, 9.4], [10.6, 9.4, 12, 8]]) p.g.line(p.X(x0), p.Y(y0), p.X(x1), p.Y(y1), ink)
    p.g.outline('#5a4a3a')
    return p.g
  })
}

/** 商店縮圖：配件戴在一個淡色的假人頭上 */
export function accessoryIcon(id: string) {
  return cached(`acc:${id}`, () => {
    const p = new Pen(1.5)
    const a = ANCHOR.mochi
    const pal: Pal = { ...PAL.mochi[0], base: '#eceff4', shade: '#d5dae3', light: '#ffffff', outline: '#9aa0b5' }
    drawMochi(p, 1, pal)
    face(p, a, pal, 'normal')
    accessory(p, id, a)
    p.g.outline('#7b8195')
    return p.g
  })
}

// ---- 場景（寵物小屋背景，96×56）----

export const SCENE_INFO: Record<string, string> = {
  room: '小房間',
  study: '書房',
  beach: '海邊',
  forest: '森林',
  space: '太空',
}

/** 固定種子的亂數（每次畫出來一樣） */
function seeded(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
}

export function sceneSprite(id: string) {
  return cached(`scene:${id}`, () => {
    const g = new Px(96, 56)
    const rnd = seeded(7)
    switch (id) {
      case 'study':
        g.rect(0, 0, 96, 40, '#dfe7f2')
        g.rect(0, 40, 96, 16, '#8d6e63')
        for (let x = 0; x < 96; x += 12) g.rect(x, 40, 1, 16, '#7a5c52')
        g.rect(6, 6, 28, 34, '#7b5236')
        for (const y of [8, 19, 30]) {
          g.rect(8, y + 9, 24, 1, '#5d3c26')
          let x = 9
          while (x < 30) {
            const w = 2 + Math.floor(rnd() * 2)
            const h = 6 + Math.floor(rnd() * 3)
            g.rect(x, y + 9 - h, w, h, ['#e57373', '#64b5f6', '#81c784', '#ffd54f', '#ba68c8'][Math.floor(rnd() * 5)])
            x += w + 1
          }
        }
        g.rect(62, 8, 24, 16, '#ffffff')
        g.rect(63, 9, 22, 14, '#bfe3ff')
        g.rect(73, 9, 1, 14, '#ffffff')
        g.rect(66, 30, 22, 3, '#a1887f')
        g.rect(68, 33, 2, 7, '#8d6e63')
        g.rect(84, 33, 2, 7, '#8d6e63')
        g.rect(80, 24, 1, 6, '#5d4037')
        g.ellipse(80.5, 23, 3, 2, '#ffd54f')
        break
      case 'beach':
        g.rect(0, 0, 96, 14, '#7fd3ff')
        g.rect(0, 14, 96, 16, '#a8e3ff')
        g.ellipse(78, 12, 6, 6, '#ffd54f')
        g.rect(0, 30, 96, 9, '#3fa7d6')
        for (let i = 0; i < 18; i++) g.rect(Math.floor(rnd() * 92), 31 + Math.floor(rnd() * 7), 3, 1, '#9fe0ff')
        g.rect(0, 39, 96, 17, '#f4d58d')
        for (let i = 0; i < 40; i++) g.set(Math.floor(rnd() * 96), 40 + Math.floor(rnd() * 16), '#e3c070')
        g.ellipse(14, 44, 3, 1.4, '#ff8a80')
        g.rect(84, 34, 1, 10, '#795548')
        g.poly([[76, 34], [85, 28], [92, 34]], '#ef5350')
        break
      case 'forest':
        g.rect(0, 0, 96, 40, '#bfe9ff')
        for (let i = 0; i < 9; i++) {
          const x = i * 11 + Math.floor(rnd() * 4)
          const h = 18 + Math.floor(rnd() * 10)
          g.poly([[x - 7, 40], [x, 40 - h], [x + 7, 40]], i % 2 ? '#2e7d32' : '#388e3c')
          g.rect(x - 1, 36, 2, 4, '#5d4037')
        }
        g.rect(0, 40, 96, 16, '#7cc96b')
        for (let i = 0; i < 30; i++) g.set(Math.floor(rnd() * 96), 41 + Math.floor(rnd() * 15), '#5fae52')
        g.ellipse(16, 46, 2.5, 1.5, '#e53935')
        g.rect(15, 46, 2, 3, '#fff3e0')
        g.set(15, 45, '#ffffff')
        break
      case 'space':
        g.rect(0, 0, 96, 56, '#1b1d3a')
        for (let i = 0; i < 60; i++) g.set(Math.floor(rnd() * 96), Math.floor(rnd() * 42), rnd() > 0.8 ? '#ffd54f' : '#ffffff')
        g.ellipse(76, 14, 7, 7, '#ff8a65')
        g.ellipse(74, 12, 2, 1.5, '#ffab91')
        g.rect(64, 14, 24, 1, '#ffe0b2')
        g.ellipse(48, 62, 60, 20, '#9aa0b5')
        for (const [x, y, r] of [[20, 48, 3], [60, 50, 2], [78, 46, 2.5]]) g.ellipse(x, y, r, r * 0.5, '#7d8399')
        break
      default:
        // 小房間
        g.rect(0, 0, 96, 40, '#f6e7cf')
        for (let x = 4; x < 96; x += 8) g.rect(x, 0, 1, 40, '#eedbbd')
        g.rect(0, 38, 96, 2, '#d7b98e')
        g.rect(0, 40, 96, 16, '#c9925f')
        for (let y = 44; y < 56; y += 4) g.rect(0, y, 96, 1, '#b07c4c')
        g.rect(60, 8, 22, 16, '#ffffff')
        g.rect(61, 9, 20, 14, '#9fd6ff')
        g.rect(70, 9, 1, 14, '#ffffff')
        g.rect(61, 15, 20, 1, '#ffffff')
        g.rect(10, 22, 12, 2, '#a1887f')
        g.rect(12, 16, 3, 6, '#66bb6a')
        g.rect(16, 18, 3, 4, '#ffb74d')
        g.ellipse(48, 49, 24, 4, '#e57373')
        g.ellipse(48, 49, 20, 2.6, '#ef9a9a')
    }
    return g
  })
}
