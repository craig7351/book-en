// YouTube 頁面相關：目前影片、換影片偵測、播放器字幕軌。YouTube 改版時主要改這支。
import { captionHits, onCaption, type CaptionHit } from './boot'
import { parseTimedText, type Cue } from './cues'

export function currentVideoId(): string | null {
  const u = new URL(location.href)
  if (u.pathname === '/watch') return u.searchParams.get('v')
  const m = u.pathname.match(/^\/shorts\/([\w-]{11})/)
  return m ? m[1] : null
}

// YouTube 是 SPA：換影片不會重新載入頁面。用官方事件 + 輪詢雙保險。
export function onVideoChange(fn: (id: string | null) => void): void {
  let last: string | null | undefined
  const check = () => {
    const id = currentVideoId()
    if (id !== last) {
      last = id
      fn(id)
    }
  }
  window.addEventListener('yt-navigate-finish', check)
  setInterval(check, 1000)
  check()
}

// 網址列輸入 → 要去的網址：完整網址、youtu.be、11 碼影片 ID，其餘當成 YouTube 搜尋
export function resolveInput(input: string): string {
  const v = input.trim()
  if (/^[\w-]{11}$/.test(v)) return `https://www.youtube.com/watch?v=${v}`
  if (/^https?:\/\//i.test(v)) return v
  if (/^(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(v)) return `https://${v}`
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(v)}`
}

// 整頁跳轉。（試過塞一個 <a> 去點，YouTube 不會攔成 SPA 導覽，一樣整頁重載，所以直接 assign）
export function navigate(url: string): void {
  let u = new URL(url)
  if (u.hostname === 'youtu.be') {
    const t = u.searchParams.get('t')
    u = new URL(`https://www.youtube.com/watch?v=${u.pathname.slice(1)}${t ? `&t=${t}` : ''}`)
  }
  location.assign(u.href)
}

export function pageTitle(): string {
  return currentVideoId() ? getVideoTitle() : document.title.replace(/ - YouTube$/, '') || location.href
}

export function getVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video, #movie_player video')
}

// ---- 播放器（#movie_player 上的非公開 API；YouTube 自己的嵌入 API 也是同一組）----

interface CaptionTrack {
  baseUrl: string
  languageCode: string
  kind?: string // 'asr' = 自動產生
  isTranslatable?: boolean
  name?: { simpleText?: string; runs?: { text: string }[] }
}

interface TracklistRenderer {
  captionTracks?: CaptionTrack[]
  translationLanguages?: { languageCode: string }[]
}

interface YtPlayer extends HTMLElement {
  getPlayerResponse?: () => {
    videoDetails?: { videoId?: string; title?: string }
    captions?: { playerCaptionsTracklistRenderer?: TracklistRenderer }
  }
  loadModule?: (name: string) => void
  unloadModule?: (name: string) => void
  setOption?: (module: string, option: string, value: unknown) => void
}

function player(): YtPlayer | null {
  return document.getElementById('movie_player') as YtPlayer | null
}

export function getPlayerElement(): HTMLElement | null {
  return player()
}

export function getVideoTitle(): string {
  return player()?.getPlayerResponse?.()?.videoDetails?.title ?? document.title.replace(/ - YouTube$/, '')
}

// 播放器換到指定影片後才回傳它的字幕資訊（換影片初期 player response 還是上一支）
async function waitTracklist(videoId: string, timeoutMs = 15000): Promise<TracklistRenderer | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const pr = player()?.getPlayerResponse?.()
    if (pr?.videoDetails?.videoId === videoId) return pr.captions?.playerCaptionsTracklistRenderer ?? {}
    await sleep(300)
  }
  return null
}

// 英文優先人工字幕，其次自動字幕
function pickEnglish(tracks: CaptionTrack[]): CaptionTrack | null {
  const en = tracks.filter((t) => t.languageCode === 'en' || t.languageCode.startsWith('en-'))
  return en.find((t) => t.kind !== 'asr') ?? en[0] ?? null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 要向播放器要的字幕：語言、是否自動產生、要不要 Google 自動翻譯成某語言
export interface TrackRequest {
  lang: string
  kind?: string
  tlang?: string
}

const trackOption = (req: TrackRequest) => ({
  languageCode: req.lang,
  ...(req.kind ? { kind: req.kind } : {}),
  ...(req.tlang ? { translationLanguage: { languageCode: req.tlang } } : {}),
})

function selectTrack(req: TrackRequest): void {
  try {
    player()?.setOption?.('captions', 'track', trackOption(req))
  } catch {
    /* 沒有就算了 */
  }
}

const hitMatches = (hit: CaptionHit, videoId: string, req: TrackRequest) => {
  const u = new URL(hit.url, location.origin)
  return (
    u.searchParams.get('v') === videoId &&
    u.searchParams.get('lang') === req.lang &&
    (u.searchParams.get('kind') ?? '') === (req.kind ?? '') &&
    (u.searchParams.get('tlang') ?? '') === (req.tlang ?? '')
  )
}

// 叫播放器載入某條字幕 → boot.ts 攔截到回應（帶播放器產生的參數，最不易被擋）。
// 影片剛載入時字幕模組還沒就緒，setOption 會被默默忽略 → 每秒重試直到攔到回應。
// 片頭廣告播放中字幕模組不可用 → 廣告期間不計入逾時。
async function requestTrack(videoId: string, req: TrackRequest): Promise<CaptionHit | null> {
  const already = [...captionHits].reverse().find((h) => hitMatches(h, videoId, req))
  if (already) return already
  return new Promise<CaptionHit | null>((resolve) => {
    let deadline = Date.now() + 12000
    const request = () => {
      const p = player()
      if (p?.classList.contains('ad-showing')) {
        deadline = Date.now() + 12000
        return
      }
      if (Date.now() > deadline) return finish(null)
      try {
        p?.loadModule?.('captions')
      } catch {
        /* API 不存在就靠備援 */
      }
      selectTrack(req)
    }
    const finish = (h: CaptionHit | null) => {
      off()
      clearInterval(retry)
      resolve(h)
    }
    const off = onCaption((h) => {
      if (hitMatches(h, videoId, req)) finish(h)
    })
    const retry = setInterval(request, 1000)
    request()
  })
}

// ---- 中文來源 ----

export type ZhKind = 'saved' | 'yt' | 'auto' | 'ai' | 'web'

export interface ZhSource {
  id: string
  kind: ZhKind
  label: string
  req?: TrackRequest // yt / auto 才有
}

const ZH_ORDER = ['zh-TW', 'zh-Hant', 'zh-HK', 'zh', 'zh-Hans', 'zh-CN', 'zh-SG']
const isTraditional = (lang: string) => /^zh-(TW|Hant|HK|MO)/i.test(lang)

function zhSources(info: TracklistRenderer, english: CaptionTrack): ZhSource[] {
  const out: ZhSource[] = []
  const zhTracks = (info.captionTracks ?? [])
    .filter((t) => t.languageCode.toLowerCase().startsWith('zh') && t.kind !== 'asr')
    .sort((a, b) => ZH_ORDER.indexOf(a.languageCode) - ZH_ORDER.indexOf(b.languageCode))
  for (const t of zhTracks) {
    out.push({
      id: `yt:${t.languageCode}`,
      kind: 'yt',
      label: `YouTube 中文字幕（${isTraditional(t.languageCode) ? '繁體' : t.languageCode === 'zh' ? '中文' : '簡體'}）`,
      req: { lang: t.languageCode },
    })
  }
  const canTranslate = english.isTranslatable && (info.translationLanguages ?? []).some((l) => l.languageCode === 'zh-Hant')
  if (canTranslate) {
    out.push({
      id: 'auto:zh-Hant',
      kind: 'auto',
      label: 'Google 自動翻譯（YouTube）',
      req: { lang: english.languageCode, kind: english.kind, tlang: 'zh-Hant' },
    })
  }
  out.push({ id: 'ai', kind: 'ai', label: 'AI 翻譯（Claude）' })
  out.push({ id: 'web', kind: 'web', label: '網頁 AI 翻譯（免費，複製貼上）' })
  return out
}

export interface CaptionResult {
  cues: Cue[]
  lang: string
  isAsr: boolean
  source: 'intercept' | 'fetch'
  english: TrackRequest // 載完中文後要切回來的英文字幕
  zhSources: ZhSource[]
}

export type CaptionError = 'no-player' | 'no-english' | 'empty'

// 取得英文字幕：
// 1. 叫播放器自己載入英文字幕並攔截（主方案）
// 2. 等不到就在頁面內同源 fetch baseUrl（通常缺 PO token 會拿到空的，保留當最後手段）
export async function loadEnglishCaptions(videoId: string): Promise<CaptionResult | CaptionError> {
  const info = await waitTracklist(videoId)
  if (!info) return 'no-player'
  const track = pickEnglish(info.captionTracks ?? [])
  if (!track) return 'no-english'
  const isAsr = track.kind === 'asr'
  const english: TrackRequest = { lang: track.languageCode, kind: track.kind }
  const base = { lang: track.languageCode, isAsr, english, zhSources: zhSources(info, track) }

  const hit = await requestTrack(videoId, english)
  if (hit) {
    const cues = parseTimedText(hit.body, hit.url)
    if (cues.length) return { ...base, cues, source: 'intercept' }
  }

  try {
    const url = track.baseUrl + (track.baseUrl.includes('fmt=') ? '' : '&fmt=json3')
    const res = await fetch(url, { credentials: 'include' })
    const cues = parseTimedText(await res.text(), url)
    if (cues.length) return { ...base, cues, source: 'fetch' }
  } catch {
    /* 落到下面 */
  }
  return 'empty'
}

// 取得 YouTube 的中文字幕（人工字幕或 Google 自動翻譯），完成後把播放器切回英文
export async function loadYoutubeZh(videoId: string, req: TrackRequest, english: TrackRequest): Promise<Cue[] | null> {
  const hit = await requestTrack(videoId, req)
  selectTrack(english) // 切回英文（原生 CC 被我們隱藏時沒差，但保持使用者的 CC 是英文）
  return hit ? parseTimedText(hit.body, hit.url) : null
}
