// 字幕解析：YouTube timedtext（json3 / srv3）→ 句子陣列。
// 人工字幕：一個 event 就是一行，直接用。
// 自動字幕（ASR）：逐字滾動、多半沒標點 → 依標點、停頓、字數重新斷句。

export interface Cue {
  start: number // 秒
  end: number // 秒
  text: string
}

interface Json3Event {
  tStartMs?: number
  dDurationMs?: number
  aAppend?: number
  segs?: { utf8?: string; tOffsetMs?: number }[]
}

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

// 有樣式的字幕（如 MrBeast）會塞零寬空白 U+200B，\s 不會比對到 → 先拿掉
const clean = (s: string) =>
  decode(s)
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

export function parseTimedText(body: string, url: string): Cue[] {
  const trimmed = body.trimStart()
  if (trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed) as { events?: Json3Event[] }
    const events = (data.events ?? []).filter((e) => e.segs && !e.aAppend)
    const isAsr = /[?&]kind=asr\b/.test(url) || events.some((e) => e.segs!.some((s) => s.tOffsetMs !== undefined))
    return isAsr ? asrToSentences(events) : manualCues(events)
  }
  if (trimmed.startsWith('<')) return srv3Cues(trimmed)
  return []
}

// 中文片段重複（Google 自動翻譯有時把同一句吐兩次）→ 拿掉重複的片段。只處理含中文的片段，英文 "very very" 不動。
function dedupeCjkPieces(text: string): string {
  const seen = new Set<string>()
  return text
    .split(' ')
    .filter((p) => {
      if (!/[一-鿿]/.test(p)) return true
      if (seen.has(p)) return false
      seen.add(p)
      return true
    })
    .join(' ')
}

function manualCues(events: Json3Event[]): Cue[] {
  // 有樣式的字幕（例如 MrBeast）每行會出現兩次：同起點、同長度的兩個 event。
  // 英文兩份相同；Google 自動翻譯的兩份卻常常不同（一份是殘句、一份混了下一句）→ 這種影片只取每組第一個。
  // 一般影片同時段有多個 event（例如兩人同時說話）則全部串起來。
  const groups = new Map<string, string[]>()
  for (const e of events) {
    const key = `${e.tStartMs ?? 0}|${e.dDurationMs ?? 0}`
    const texts = groups.get(key) ?? []
    texts.push(clean(e.segs!.map((s) => s.utf8 ?? '').join('')))
    groups.set(key, texts)
  }
  const multi = [...groups.values()].filter((t) => t.length > 1).length
  const doubled = multi / Math.max(1, groups.size) > 0.5
  const cues: Cue[] = []
  for (const [key, texts] of groups) {
    const raw = doubled ? texts.find(Boolean) ?? '' : [...new Set(texts.filter(Boolean))].join(' ')
    const text = dedupeCjkPieces(raw)
    if (!text) continue
    const [startMs, durMs] = key.split('|').map(Number)
    const start = startMs / 1000
    cues.push({ start, end: start + durMs / 1000, text })
  }
  cues.sort((a, b) => a.start - b.start)
  // 時間重疊時，前一句提早結束，避免同時高亮兩句
  for (let i = 0; i + 1 < cues.length; i++) cues[i].end = Math.min(cues[i].end, cues[i + 1].start)
  return cues
}

const MAX_WORDS = 18
const GAP_SEC = 1.0

function asrToSentences(events: Json3Event[]): Cue[] {
  // 攤平成「字 + 絕對時間」
  const words: { t: number; w: string }[] = []
  for (const e of events) {
    const base = e.tStartMs ?? 0
    for (const s of e.segs!) {
      const w = clean(s.utf8 ?? '')
      if (w) words.push({ t: (base + (s.tOffsetMs ?? 0)) / 1000, w })
    }
  }
  const cues: Cue[] = []
  let buf: typeof words = []
  const flush = (end: number) => {
    if (!buf.length) return
    cues.push({ start: buf[0].t, end, text: buf.map((x) => x.w).join(' ') })
    buf = []
  }
  for (let i = 0; i < words.length; i++) {
    const cur = words[i]
    const next = words[i + 1]
    buf.push(cur)
    const endsSentence = /[.?!]["')\]]?$/.test(cur.w)
    const gap = next ? next.t - cur.t : Infinity
    if (!next || endsSentence || gap > GAP_SEC || buf.length >= MAX_WORDS) {
      flush(next ? Math.min(next.t, cur.t + 2) : cur.t + 2)
    }
  }
  return cues
}

// 備援：XML 格式 <p t="毫秒" d="毫秒">文字</p>（不用 DOMParser，YouTube 有 Trusted Types 限制）
function srv3Cues(xml: string): Cue[] {
  const cues: Cue[] = []
  for (const m of xml.matchAll(/<p\b[^>]*\bt="(\d+)"[^>]*\bd="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = clean(m[3].replace(/<[^>]+>/g, ''))
    if (!text) continue
    const start = Number(m[1]) / 1000
    cues.push({ start, end: start + Number(m[2]) / 1000, text })
  }
  return cues
}

// 有些「中文」字幕軌其實是英文（上傳者標錯語言）→ 檢查真的有中文字
export function looksChinese(cues: Cue[]): boolean {
  if (!cues.length) return false
  const cjk = cues.filter((c) => /[一-鿿]/.test(c.text)).length
  return cjk / cues.length > 0.3
}

// 把另一條字幕（中文）對到英文句子上：每個中文片段歸給時間重疊最多的英文句，同一句多段就串起來。
// 英文自動字幕會被我們重新斷句，所以不能假設兩邊一對一。
export function alignTo(en: Cue[], other: Cue[]): (string | null)[] {
  const parts: string[][] = en.map(() => [])
  for (const z of other) {
    let best = -1
    let bestOverlap = 0
    // 只看附近的英文句（兩邊都依時間排序）
    const from = Math.max(0, cueIndexAt(en, z.start) - 2)
    for (let i = from; i < en.length && en[i].start < z.end; i++) {
      const overlap = Math.min(en[i].end, z.end) - Math.max(en[i].start, z.start)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        best = i
      }
    }
    if (best < 0) best = Math.max(0, cueIndexAt(en, z.start))
    if (best < en.length) parts[best].push(z.text)
  }
  return parts.map((p) => (p.length ? p.join(' ') : null))
}

// 二分搜尋：目前時間落在哪一句（找不到回傳最後一個已開始的句子）
export function cueIndexAt(cues: Cue[], t: number): number {
  let lo = 0
  let hi = cues.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].start <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}
