// 中文來源：YouTube 中文字幕 / Google 自動翻譯（YouTube 內建）/ AI 翻譯（claude -p）/ 網頁 AI（使用者複製貼上）。
// YouTube 來源免費又快 → 選了就載入；AI 只先讀快取，按「開始 AI 翻譯」才呼叫 claude。
import { api, errorText } from '../shared/api'
import type { SavedSubs } from '../shared/types'
import { alignTo, looksChinese } from './cues'
import { cuesOf, store } from './store'
import { parseReply, parseSrt, usable, type Line } from '../shared/webai'
import { getVideoTitle, loadYoutubeZh, type ZhSource } from './youtube'

const BATCH = 40
const CONCURRENCY = 2

let runToken = 0

export function stopTranslation(): void {
  runToken++
  store.set({ translating: false })
}

function sources(): ZhSource[] {
  const c = store.get().captions
  return c.status === 'ready' ? c.result.zhSources : []
}

// ---- AI 翻譯存檔（exe 同目錄 subtitles\<影片ID>.json）----

let saved: SavedSubs | null = null

function savedLabel(s: SavedSubs): string {
  const d = s.savedAt ? new Date(s.savedAt) : null
  const date = d ? `${d.getMonth() + 1}/${d.getDate()}` : ''
  return `已存的 AI 字幕（${s.model === 'web' ? '網頁 AI' : s.model}${date ? '・' + date : ''}${s.complete ? '' : '・未完成'}）`
}

// 把存檔放進來源清單最前面（已有就更新標籤）
function upsertSavedSource(s: SavedSubs): void {
  saved = s
  store.set((st) => {
    if (st.captions.status !== 'ready') return {}
    const rest = st.captions.result.zhSources.filter((x) => x.kind !== 'saved')
    const zhSources: ZhSource[] = [{ id: 'saved', kind: 'saved', label: savedLabel(s) }, ...rest]
    return { captions: { ...st.captions, result: { ...st.captions.result, zhSources } } }
  })
}

// 目前的 AI 譯文寫成檔案（每翻完一批就寫，中途停掉也不會白翻）；model = 'web' 是網頁 AI 貼回來的
async function persistAi(model = store.get().prefs.model): Promise<string | null> {
  const s = store.get()
  if (s.captions.status !== 'ready') return null
  const cues = s.captions.result.cues
  const lines = cues.map((c, i) => ({ start: c.start, end: c.end, en: c.text, zh: typeof s.zh[i] === 'string' ? (s.zh[i] as string) : null }))
  if (!lines.some((l) => l.zh)) return null
  const subs: SavedSubs = {
    videoId: s.captions.videoId,
    title: getVideoTitle(),
    model,
    complete: lines.every((l) => l.zh),
    lines,
  }
  try {
    const path = await api.saveSubtitles(subs)
    upsertSavedSource({ ...subs, savedAt: Date.now(), path })
    return path
  } catch {
    return null
  }
}

// 存檔的中文對回字幕：同一位置的英文一樣就直接用；對不上（字幕斷句規則改過）再依英文原句找。
// 「(Laughter)」這種重複的句子只拿有翻譯的來對，免得被沒翻的那幾行蓋掉
function fromSaved(file: SavedSubs, cues: { text: string }[]): (string | undefined)[] {
  const byText = new Map<string, string>()
  for (const l of file.lines) if (l.zh && !byText.has(l.en)) byText.set(l.en, l.zh)
  return cues.map((c, i) => {
    const same = file.lines[i]
    return (same?.en === c.text ? same.zh : null) ?? byText.get(c.text) ?? undefined
  })
}

// 換影片後挑預設來源：上次選的種類 → 有存檔就用 → YouTube 中文字幕 → Google 自動翻譯 → AI（只讀快取）
export async function initZh(): Promise<void> {
  const s = store.get()
  if (s.captions.status !== 'ready') return
  const videoId = s.captions.videoId
  saved = null
  try {
    const file = await api.loadSubtitles(videoId)
    if (file && cuesOf(store.get()).length && store.get().captions.status === 'ready') upsertSavedSource(file)
  } catch {
    /* 沒有存檔 */
  }
  const list = sources()
  // 上次選 AI 而且有存檔 → 直接用存檔（就是 AI 的結果，不用再翻）
  const pref = store.get().prefs.zhKind === 'ai' && saved ? 'saved' : store.get().prefs.zhKind
  const pick =
    list.find((x) => x.kind === pref) ??
    list.find((x) => x.kind === 'saved') ??
    list.find((x) => x.kind === 'yt') ??
    list.find((x) => x.kind === 'auto') ??
    list[0]
  if (pick) void selectZhSource(pick.id)
}

// note：載入完成後要顯示的說明（例如「原本的中文字幕其實是英文，已改用…」）
export async function selectZhSource(id: string, note: string | null = null): Promise<void> {
  const my = ++runToken
  const s = store.get()
  const cues = cuesOf(s)
  const source = sources().find((x) => x.id === id)
  if (!source || s.captions.status !== 'ready') return
  const videoId = s.captions.videoId
  const english = s.captions.result.english
  store.set({ zhSource: id, zh: new Array(cues.length).fill(undefined), translating: false, transError: null, aiMissing: 0 })

  if (source.kind === 'ai') return loadAiCached(my, note)
  if (source.kind === 'web') {
    // 之前貼過的（存檔是網頁 AI 的）接著用，可以繼續補缺的句子
    const web = saved?.model === 'web' ? saved : null
    store.set({ zh: web ? fromSaved(web, cues) : cues.map(() => undefined), zhStatus: web?.path ? `存檔：${web.path}` : note })
    return
  }
  if (source.kind === 'saved') {
    store.set({ zh: saved ? fromSaved(saved, cues) : [], zhStatus: saved?.path ? `存檔：${saved.path}` : null })
    return
  }

  store.set({ zhStatus: '載入中文字幕中…' })
  const zhCues = await loadYoutubeZh(videoId, source.req!, english)
  if (my !== runToken) return
  if (!zhCues?.length) {
    store.set({ zhStatus: '中文字幕載入失敗，可改選其他來源' })
    return
  }
  // 有些影片標成中文的字幕軌其實是英文 → 拿掉這個選項，改用下一個來源
  if (source.kind === 'yt' && !looksChinese(zhCues)) {
    dropSource(id)
    const next = sources().find((x) => x.kind === 'yt') ?? sources().find((x) => x.kind === 'auto') ?? sources().find((x) => x.kind === 'ai')
    if (next) await selectZhSource(next.id, `影片標示的「${source.label}」其實不是中文，已改用「${next.label}」`)
    return
  }
  store.set({ zh: alignTo(cues, zhCues), zhStatus: note })
}

function dropSource(id: string): void {
  store.set((st) => {
    if (st.captions.status !== 'ready') return {}
    const result = { ...st.captions.result, zhSources: st.captions.result.zhSources.filter((x) => x.id !== id) }
    return { captions: { ...st.captions, result } }
  })
}

// AI 來源：先讀 SQLite 快取（不呼叫 claude）
async function loadAiCached(my: number, note: string | null): Promise<void> {
  const cues = cuesOf(store.get())
  try {
    const cached = await api.translationCached(cues.map((c) => c.text))
    if (my !== runToken) return
    const zh = cached.map((z) => z ?? undefined)
    const aiMissing = zh.filter((z) => z === undefined).length
    store.set({ zh, aiMissing, zhStatus: note })
    // 快取已經全部翻好（以前翻過）但還沒存檔 → 補存一份
    if (aiMissing === 0 && !saved?.complete) {
      const path = await persistAi()
      if (path && my === runToken) store.set({ zhStatus: note ?? `已存檔：${path}` })
    }
  } catch (e) {
    store.set({ zhStatus: errorText(e) })
  }
}

// 按「開始 AI 翻譯」：分批（每批 40 句）、先翻目前播放位置附近、同時最多 2 批
export async function startTranslation(): Promise<void> {
  const my = ++runToken
  const s = store.get()
  const cues = cuesOf(s)
  if (!cues.length) return
  const missing = (i: number) => typeof store.get().zh[i] !== 'string'

  const batches: number[][] = []
  for (let i = 0; i < cues.length; i += BATCH) {
    batches.push(Array.from({ length: Math.min(BATCH, cues.length - i) }, (_, k) => i + k))
  }
  const here = Math.max(0, Math.floor(s.active / BATCH))
  const queue = batches
    .map((idx, b) => ({ idx, dist: b >= here ? b - here : (here - b) * 2 })) // 往後優先
    .sort((a, b) => a.dist - b.dist)
    .map((x) => x.idx)
    .filter((idx) => idx.some(missing))
  if (!queue.length) return

  store.set({ translating: true, transError: null })
  const worker = async () => {
    while (queue.length) {
      const idx = queue.shift()!
      try {
        const out = await api.translateBatch(
          idx.map((i) => cues[i].text),
          store.get().prefs.model,
        )
        if (my !== runToken) return
        store.set((st) => {
          const zh = st.zh.slice()
          idx.forEach((i, k) => (zh[i] = out[k] ?? null))
          return { zh, aiMissing: zh.filter((z) => typeof z !== 'string').length }
        })
        const path = await persistAi()
        if (path && my === runToken) store.set({ zhStatus: `已存檔：${path}` })
      } catch (e) {
        if (my !== runToken) return
        store.set((st) => {
          const zh = st.zh.slice()
          idx.forEach((i) => (zh[i] = zh[i] ?? null))
          return { zh, transError: errorText(e), aiMissing: zh.filter((z) => typeof z !== 'string').length }
        })
        // 找不到 claude 時其他批次也不用試了
        if (String(e).includes('claude-not-found')) queue.length = 0
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  if (my === runToken) store.set({ translating: false })
}

// ---- 網頁 AI（使用者把題目複製到 ChatGPT 等網頁，再把回覆貼回來）----

export function webLines(): Line[] {
  return cuesOf(store.get()).map((c, i) => ({ n: i + 1, en: c.text }))
}

/** 貼回來的回覆（或上傳的檔案）併進目前的中文，存檔；回傳這次對上幾句 */
export async function applyWebReply(text: string): Promise<{ matched: number; path: string | null }> {
  const cues = cuesOf(store.get())
  const srt = parseSrt(text)
  let found: (string | null)[]
  if (srt) found = alignTo(cues, srt) // 字幕檔：依時間對
  else {
    const m = parseReply(text)
    found = cues.map((c, i) => {
      const zh = m.get(i + 1)
      return zh && usable(c.text, zh) ? zh : null
    })
  }
  const matched = found.filter(Boolean).length
  if (!matched) return { matched, path: null }
  store.set((st) => {
    const zh = st.zh.slice()
    found.forEach((z, i) => {
      if (z) zh[i] = z
    })
    return { zh }
  })
  const path = await persistAi('web')
  if (path) store.set({ zhStatus: `已存檔：${path}` })
  return { matched, path }
}
