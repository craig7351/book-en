// 網頁 AI 翻譯（免費的 ChatGPT、Gemini、Claude、DeepSeek…）：組題目讓使用者複製到網頁上，再把回覆依編號對回字幕。
// 每句加全片編號（從 1 開始）→ AI 漏句、合併、多寫說明都只影響那幾句；缺的可以單獨再出題。
// 這個檔案只有純函式（不碰 DOM、store），方便單獨測試。

export const DEFAULT_CHUNK = 120 // 免費版回覆太長會被截斷 → 分段
export const CHUNK_OPTIONS = [60, 80, 100, 120, 150, 200, 300]

export const AI_SITES = [
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Gemini', url: 'https://gemini.google.com/app' },
  { name: 'Claude', url: 'https://claude.ai/new' },
  { name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
]

export interface Line {
  n: number // 全片編號（從 1 開始）
  en: string
}

// 示範格式的例句、規則；AI 把它們原樣抄回來時要認得出來、不能當成真的翻譯
const EXAMPLE_IN = ['>> So, um, I went there yesterday.', 'It was a real, real faff.', 'You know what I mean?']
const EXAMPLE_OUT = ['>> 所以，嗯，我昨天去了那裡。', '真的超麻煩的。', '你懂我的意思吧？']
const RULES = [
  '每行格式是「編號| 英文」，請輸出「編號| 中文」，一行一句，編號照原樣保留。',
  '不要合併或拆分句子、不要漏行；字幕常把一句話切成好幾行，句子不完整也照行翻。',
  '口語自然即可；人名、地名、品牌保留英文；「>>」（換人說話）照原樣保留。',
  '只輸出翻譯結果，全部放在一個程式碼區塊內，不要加任何說明。',
]

export function buildPrompt(title: string, lines: Line[]): string {
  const ex = (rows: string[]) => rows.map((t, i) => `${i + 7}| ${t}`)
  return [
    '你是專業的影片字幕翻譯。請把下面的英文字幕翻成台灣繁體中文（使用台灣慣用語）。',
    ...(title ? [`影片標題：「${oneLine(title)}」`] : []),
    '',
    '規則：',
    ...RULES.map((r, i) => `${i + 1}. ${r}`),
    '',
    '範例（只是示範格式，不要翻譯這段）：',
    '輸入：',
    ...ex(EXAMPLE_IN),
    '輸出：',
    ...ex(EXAMPLE_OUT),
    '',
    `以下是要翻譯的 ${lines.length} 行：`,
    ...lines.map((l) => `${l.n}| ${oneLine(l.en)}`),
  ].join('\n')
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 依每段句數切成 [起, 迄)（0 起算的索引） */
export function chunks(total: number, size: number): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < total; i += size) out.push([i, Math.min(total, i + size)])
  return out
}

const CJK = /[㐀-鿿豈-﫿]/
const SEP = '[|｜.．:：、,，\\t]'
// 「12| 中文」「**12.** 中文」「[12] 中文」「12) 中文」「１２｜中文」都接受
const LINE = new RegExp(`^[\\s*_#>\`]*[\\[(（【]?\\s*(\\d{1,5})\\s*(?:[\\])）】]\\s*${SEP}?|[*_]*\\s*${SEP})\\s*(.*)$`)

/** 讀 AI 的回覆：編號 → 中文。開場白、結語、程式碼區塊符號、抄回來的範例都略過 */
export function parseReply(text: string): Map<number, string> {
  const out = new Map<number, string>()
  const normalized = text.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
  for (const raw of normalized.split(/\r?\n/)) {
    const m = LINE.exec(raw)
    if (!m) continue
    let zh = m[2].replace(/^[*_\s]+|[*_\s]+$/g, '')
    // 「英文 | 中文」或「英文 → 中文」：AI 把原文也抄了一份 → 取後半
    const parts = zh.split(/\s*(?:[|｜]|→|=>)\s*/)
    if (parts.length > 1 && CJK.test(parts[parts.length - 1]) && !CJK.test(parts[0])) zh = parts[parts.length - 1]
    if (!zh || EXAMPLE_OUT.includes(zh) || RULES.includes(zh)) continue
    // 沒有中文、又是好幾個英文字 → 是抄回來的英文原句，不是翻譯（「OK」「Tim Urban」這種短的照收）
    if (!CJK.test(zh) && (zh.match(/[A-Za-z]+/g)?.length ?? 0) >= 3) continue
    out.set(Number(m[1]), zh)
  }
  return out
}

/** 這行能不能當作翻譯：AI 沒翻（原文照抄）就不算 */
export function usable(en: string, zh: string): boolean {
  return oneLine(zh).toLowerCase() !== oneLine(en).toLowerCase()
}

export interface TimedLine {
  start: number
  end: number
  text: string
}

/** 上傳的 .srt / .vtt；不是字幕檔就回 null */
export function parseSrt(text: string): TimedLine[] | null {
  if (!text.includes('-->')) return null
  const time = (t: string) => {
    const p = t.trim().replace(',', '.').split(':').map(Number)
    return p.reduce((acc, x) => acc * 60 + x, 0)
  }
  const out: TimedLine[] = []
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const rows = block.split('\n')
    const at = rows.findIndex((r) => r.includes('-->'))
    if (at < 0) continue
    const [a, b] = rows[at].split('-->')
    const body = rows
      .slice(at + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim()
    const start = time(a)
    const end = time(b.trim().split(/\s/)[0])
    if (body && !Number.isNaN(start) && !Number.isNaN(end)) out.push({ start, end, text: body })
  }
  return out.length ? out : null
}
