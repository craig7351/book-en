// 播放控制：載字幕、追蹤目前句、每句自動暫停 / 單句循環、快捷鍵、偏好設定。
import { api } from '../shared/api'
import type { WordInfo } from '../shared/levels'
import { normWord, tokenize } from '../shared/tokenize'
import { cueIndexAt } from './cues'
import { cuesOf, DEFAULT_PREFS, store, type Prefs } from './store'
import { initZh, stopTranslation } from './translator'
import { getPlayerElement, getVideo, loadEnglishCaptions, onVideoChange } from './youtube'

const ERRORS: Record<string, string> = {
  'no-player': '找不到播放器，請重新整理頁面',
  'no-english': '這支影片沒有英文字幕',
  empty: '字幕載入失敗',
}

// ---- 換影片 → 載字幕 ----

let loadToken = 0
function onVideo(id: string | null): void {
  const my = ++loadToken
  stopTranslation()
  store.set({ zh: [], zhSource: null, zhStatus: null, aiMissing: 0, active: -1, card: null, transError: null, words: new Map() })
  if (!id) return store.set({ captions: { status: 'idle' } })
  store.set({ captions: { status: 'loading', videoId: id } })
  loadEnglishCaptions(id).then((r) => {
    if (my !== loadToken) return // 已換到別支影片
    if (typeof r === 'string') {
      store.set({ captions: { status: 'error', videoId: id, message: ERRORS[r] ?? r } })
      return
    }
    store.set({ captions: { status: 'ready', videoId: id, result: r }, zh: new Array(r.cues.length).fill(undefined) })
    applyRate()
    void initZh()
    void loadWordInfo(id, my)
  })
  void seekToUrlTime(id, my)
}

// ---- 詞頻分級：本片所有字一次查原形、排名、個人狀態 ----

async function loadWordInfo(videoId: string, my: number): Promise<void> {
  const cues = cuesOf(store.get())
  const words = new Set<string>()
  for (const c of cues) for (const t of tokenize(c.text)) if (t.word) words.add(normWord(t.word))
  try {
    const infos = await api.wordInfo([...words], videoId)
    if (my !== loadToken) return
    store.set({ words: new Map(infos.map((i) => [i.word, i])) })
  } catch {
    /* 查不到就不分級 */
  }
}

// 例句裡的字：查原形 / 排名 / 狀態來上色，但不算進「看過的字」
export async function loadExtraWords(texts: string[]): Promise<void> {
  const known = store.get().words
  const missing = new Set<string>()
  for (const text of texts) for (const t of tokenize(text)) if (t.word && !known.has(normWord(t.word))) missing.add(normWord(t.word))
  if (!missing.size) return
  try {
    const infos = await api.wordInfo([...missing], null, false)
    store.set((st) => {
      const words = new Map(st.words)
      for (const i of infos) if (!words.has(i.word)) words.set(i.word, i)
      return { words }
    })
  } catch {
    /* 不上色就算了 */
  }
}

export function infoOf(word: string): WordInfo | undefined {
  return store.get().words.get(normWord(word).replace(/[^a-z'-]/g, ''))
}

// 同原形的字一起更新（running / ran 跟著 run 變）
function patchLemma(lemma: string, status: WordInfo['status']): void {
  store.set((st) => {
    const words = new Map(st.words)
    for (const [k, v] of words) if (v.lemma === lemma) words.set(k, { ...v, status })
    return { words }
  })
}

// ✓ 已知 / ⊘ 不要學 / null 清除；學習中走收藏（item_add）後呼叫 markLearning
export async function setWordStatus(lemma: string, status: 'known' | 'ignore' | null): Promise<void> {
  await api.setWordStatus([lemma], status)
  const saved = store.get().saved.has(lemma)
  patchLemma(lemma, status ?? (saved ? 'learning' : null))
}

export function markLearning(lemma: string): void {
  const manual = [...store.get().words.values()].find((v) => v.lemma === lemma)?.status
  if (manual !== 'known' && manual !== 'ignore') patchLemma(lemma, 'learning')
}

// 網址帶 t=（學習中心「回影片聽原句」）：YouTube 不一定會照做 → 影片就緒後自己跳過去
async function seekToUrlTime(id: string, my: number): Promise<void> {
  const t = Number.parseFloat(new URL(location.href).searchParams.get('t') ?? '')
  if (!Number.isFinite(t) || t <= 0) return
  for (let i = 0; i < 60 && my === loadToken; i++) {
    const v = getVideo()
    const ad = getPlayerElement()?.classList.contains('ad-showing')
    if (v && !ad && v.readyState >= 1 && currentVideoIdMatches(id)) {
      if (Math.abs(v.currentTime - t) > 2) v.currentTime = t
      return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

const currentVideoIdMatches = (id: string) => new URL(location.href).searchParams.get('v') === id

// ---- 每一幀：目前句、自動暫停、單句循環 ----

// 正在「守」的句子：播到它的結尾時要暫停或回到開頭。暫停過一次就放行（-1）。
let guard = -1
// 單字卡「▶ 原片段」：只播這一句，播完就停（不管有沒有開每句暫停）
let once = -1

function tick(): void {
  const s = store.get()
  const v = getVideo()
  const cues = cuesOf(s)
  if (v && cues.length) {
    const t = v.currentTime
    if (!v.paused && once >= 0 && once < cues.length && t >= cues[once].end - 0.08) {
      v.pause()
      once = -1
    }
    if (!v.paused && guard >= 0 && guard < cues.length) {
      const c = cues[guard]
      if (t >= c.end - 0.08 && t < c.end + 0.6) {
        if (s.prefs.loop) {
          v.currentTime = c.start
        } else if (s.prefs.autoPause) {
          v.pause()
          guard = -1
        }
      }
    }
    const i = cueIndexAt(cues, t)
    if (i !== s.active) {
      store.set({ active: i })
      guard = i
    }
  }
  requestAnimationFrame(tick)
}

// ---- 動作 ----

export function seekTo(t: number, idx?: number): void {
  const v = getVideo()
  if (!v) return
  v.currentTime = Math.max(0, t + 0.01)
  if (idx !== undefined) {
    guard = idx
    store.set({ active: idx })
  }
  if (v.paused) void v.play()
}

export function seekCue(idx: number): void {
  const cues = cuesOf(store.get())
  if (idx < 0 || idx >= cues.length) return
  seekTo(cues[idx].start, idx)
}

export function playCueOnce(idx: number): void {
  seekCue(idx)
  once = idx
}

export const prevCue = () => seekCue(Math.max(0, store.get().active - 1))
export const replayCue = () => seekCue(Math.max(0, store.get().active))
export const nextCue = () => seekCue(store.get().active + 1)

export function pauseVideo(): void {
  getVideo()?.pause()
}

function applyRate(): void {
  const v = getVideo()
  if (v) v.playbackRate = store.get().prefs.rate
}

// ---- 偏好設定（存在 Rust 端 SQLite）----

// 學習中心也會改設定（例如模型）→ 存檔時只寫入這裡改過的鍵，不覆蓋別處的修改
let saveTimer = 0
let pending: Partial<Prefs> = {}
export function setPrefs(patch: Partial<Prefs>): void {
  const before = store.get().prefs
  const prefs = { ...before, ...patch }
  store.set({ prefs })
  if (patch.rate !== undefined) applyRate()
  if (patch.layer !== undefined) document.documentElement.classList.toggle('be-layer', prefs.layer)
  pending = { ...pending, ...patch }
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    const changes = pending
    pending = {}
    try {
      const raw = await api.getSetting('prefs')
      const latest = raw ? (JSON.parse(raw) as Partial<Prefs>) : {}
      await api.setSetting('prefs', JSON.stringify({ ...DEFAULT_PREFS, ...latest, ...changes }))
    } catch {
      /* 存不了就算了，本次使用期間仍有效 */
    }
  }, 500)
}

async function loadPrefs(): Promise<void> {
  try {
    const raw = await api.getSetting('prefs')
    if (raw) store.set({ prefs: { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } })
  } catch {
    /* 用預設值 */
  }
  document.documentElement.classList.toggle('be-layer', store.get().prefs.layer)
}

export async function refreshSaved(): Promise<void> {
  try {
    const [words, stats] = await Promise.all([api.savedWords(), api.stats()])
    store.set({ saved: new Set(words.map((w) => w.toLowerCase())), due: stats.due })
  } catch {
    /* 沒連到 Rust 時保持空集合 */
  }
}

// ---- 快捷鍵：A 上一句、S 重播、D 下一句（YouTube 沒用到這三個鍵）----

function isTyping(e: KeyboardEvent): boolean {
  return e.composedPath().some((el) => {
    if (!(el instanceof HTMLElement)) return false
    return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
  })
}

function onKey(e: KeyboardEvent): void {
  if (e.ctrlKey || e.altKey || e.metaKey || isTyping(e)) return
  const s = store.get()
  if (e.key === 'Escape' && s.card) {
    store.set({ card: null, cardHistory: [] })
    return
  }
  if (s.captions.status !== 'ready') return
  const action = { a: prevCue, s: replayCue, d: nextCue }[e.key.toLowerCase()]
  if (!action) return
  e.preventDefault()
  e.stopImmediatePropagation()
  action()
}

export function startController(): void {
  void loadPrefs()
  void refreshSaved()
  api
    .dictStatus()
    .then((d) => store.set({ dictMissing: !d.installed }))
    .catch(() => {})
  setInterval(refreshSaved, 60_000)
  // 從學習中心切回來：同步設定（模型）與已收藏 / 待複習數
  window.addEventListener('focus', () => {
    void loadPrefs()
    void refreshSaved()
  })
  onVideoChange(onVideo)
  window.addEventListener('keydown', onKey, true)
  document.addEventListener('fullscreenchange', () => store.set({ fullscreen: !!document.fullscreenElement }))
  requestAnimationFrame(tick)
}
