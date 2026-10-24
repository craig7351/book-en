// 像素畫布：用基本形狀（橢圓、矩形、多邊形）畫在格子上，自動描邊後輸出成圖片。
// 所有寵物、配件、場景都是程式畫的（沒有外部圖檔、沒有授權問題），換調色盤就是另一種配色。

export type Color = string | null

export class Px {
  readonly data: Color[]
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Array(w * h).fill(null)
  }

  get(x: number, y: number): Color {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.data[y * this.w + x]
  }

  set(x: number, y: number, c: Color) {
    x = Math.round(x)
    y = Math.round(y)
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.data[y * this.w + x] = c
  }

  /** 左右對稱各點一個（x 是左半邊的座標） */
  sym(x: number, y: number, c: Color) {
    this.set(x, y, c)
    this.set(this.w - 1 - Math.round(x), y, c)
  }

  rect(x: number, y: number, w: number, h: number, c: Color) {
    for (let j = Math.round(y); j < Math.round(y + h); j++)
      for (let i = Math.round(x); i < Math.round(x + w); i++) this.set(i, j, c)
  }

  /** 以像素中心判斷是否在橢圓內 */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: Color) {
    if (rx <= 0 || ry <= 0) return
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx
        const dy = (y + 0.5 - cy) / ry
        if (dx * dx + dy * dy <= 1) this.set(x, y, c)
      }
  }

  /** 多邊形（點以像素座標給，判斷像素中心） */
  poly(pts: [number, number][], c: Color) {
    const ys = pts.map((p) => p[1])
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++)
      for (let x = 0; x < this.w; x++) if (inside(pts, x + 0.5, y + 0.5)) this.set(x, y, c)
  }

  line(x0: number, y0: number, x1: number, y1: number, c: Color) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= n; i++) this.set(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c)
  }

  /** 把 src 疊上來（null 為透明） */
  draw(src: Px, ox = 0, oy = 0) {
    for (let y = 0; y < src.h; y++)
      for (let x = 0; x < src.w; x++) {
        const c = src.get(x, y)
        if (c) this.set(x + ox, y + oy, c)
      }
  }

  /** 外框：透明、但上下左右有實心像素的格子塗上 color */
  outline(color: string) {
    const add: number[] = []
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++)
        if (!this.get(x, y) && (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)))
          add.push(y * this.w + x)
    for (const i of add) this.data[i] = color
  }

  /** 剪影（圖鑑未發現）：所有實心像素換成同一色 */
  silhouette(color: string): Px {
    const out = new Px(this.w, this.h)
    this.data.forEach((c, i) => (out.data[i] = c ? color : null))
    return out
  }

  toDataURL(): string {
    const canvas = document.createElement('canvas')
    canvas.width = this.w
    canvas.height = this.h
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(this.w, this.h)
    this.data.forEach((c, i) => {
      if (!c) return
      const [r, g, b] = hex(c)
      img.data.set([r, g, b, 255], i * 4)
    })
    ctx.putImageData(img, 0, 0)
    return canvas.toDataURL()
  }
}

function inside(pts: [number, number][], x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// 產生圖片很便宜，但同一張圖會在畫面上重複出現 → 依 key 快取
const cache = new Map<string, { url: string; w: number; h: number }>()

export function cached(key: string, make: () => Px) {
  let hit = cache.get(key)
  if (!hit) {
    const px = make()
    hit = { url: px.toDataURL(), w: px.w, h: px.h }
    cache.set(key, hit)
  }
  return hit
}
