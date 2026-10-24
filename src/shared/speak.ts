// 發音：所有地方（YouTube 面板、學習中心、複習）都走這裡，依「設定 → 發音」決定。
// - 單字：字典的真人錄音（依口音挑；沒有就用語音合成），或一律用語音合成
// - 句子：語音合成。引擎可選「系統語音」（電腦上安裝的語音）或 Kokoro（下載後離線產生的自然語音）
import { api } from './api'
import { invoke } from './tauri'

export type WordSource = 'recording' | 'tts'
export type Accent = 'us' | 'uk' | 'au'
export type TtsEngine = 'system' | 'kokoro'

export interface VoicePrefs {
  wordSource: WordSource
  accent: Accent
  voiceName: string // 指定的系統語音；空字串 = 依口音自動挑
  voiceRate: number // 基本語速；慢速等選項是在這之上乘一個倍率
  engine: TtsEngine
  kokoroVoice: string // 空字串 = 依口音（美式 Heart、英式 Emma）
}

export const DEFAULT_VOICE: VoicePrefs = {
  wordSource: 'recording',
  accent: 'us',
  voiceName: '',
  voiceRate: 0.9,
  engine: 'system',
  kokoroVoice: '',
}

/** Kokoro 的聲音（下載包裡有這 10 個；試聽樣本內建在 App 裡，不用下載也能聽） */
export const KOKORO_VOICES: { id: string; name: string; desc: string }[] = [
  { id: 'af_heart', name: 'Heart', desc: '美式・女・溫暖自然（品質最好）' },
  { id: 'af_bella', name: 'Bella', desc: '美式・女・活潑' },
  { id: 'af_nicole', name: 'Nicole', desc: '美式・女・輕柔' },
  { id: 'am_michael', name: 'Michael', desc: '美式・男・沉穩' },
  { id: 'am_fenrir', name: 'Fenrir', desc: '美式・男・低沉' },
  { id: 'am_puck', name: 'Puck', desc: '美式・男・明亮' },
  { id: 'bf_emma', name: 'Emma', desc: '英式・女' },
  { id: 'bf_isabella', name: 'Isabella', desc: '英式・女' },
  { id: 'bm_george', name: 'George', desc: '英式・男' },
  { id: 'bm_fable', name: 'Fable', desc: '英式・男' },
]

export const ACCENT_LABEL: Record<Accent, string> = { us: '美式', uk: '英式', au: '澳洲' }
const ACCENT_LANG: Record<Accent, string> = { us: 'en-US', uk: 'en-GB', au: 'en-AU' }

let prefs: VoicePrefs = DEFAULT_VOICE

/** 讀到設定（prefs JSON）時呼叫；只取發音相關的欄位 */
export function setVoicePrefs(p: Partial<VoicePrefs> | null | undefined): void {
  prefs = {
    wordSource: p?.wordSource === 'tts' ? 'tts' : 'recording',
    accent: p?.accent && p.accent in ACCENT_LANG ? p.accent : DEFAULT_VOICE.accent,
    voiceName: typeof p?.voiceName === 'string' ? p.voiceName : '',
    voiceRate: typeof p?.voiceRate === 'number' && p.voiceRate > 0 ? p.voiceRate : DEFAULT_VOICE.voiceRate,
    engine: p?.engine === 'kokoro' ? 'kokoro' : 'system',
    kokoroVoice: KOKORO_VOICES.some((v) => v.id === p?.kokoroVoice) ? p!.kokoroVoice! : '',
  }
}

function kokoroVoice(): string {
  return prefs.kokoroVoice || (prefs.accent === 'uk' ? 'bf_emma' : 'af_heart')
}

// ---- 系統語音 ----

export function englishVoices(): SpeechSynthesisVoice[] {
  try {
    return speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'))
  } catch {
    return []
  }
}

/** 語音清單是非同步載入的：載好（或變動）時呼叫 cb */
export function onVoicesChanged(cb: () => void): () => void {
  try {
    speechSynthesis.addEventListener('voiceschanged', cb)
    return () => speechSynthesis.removeEventListener('voiceschanged', cb)
  } catch {
    return () => {}
  }
}

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = englishVoices()
  if (prefs.voiceName) {
    const v = voices.find((x) => x.name === prefs.voiceName)
    if (v) return v
  }
  const lang = ACCENT_LANG[prefs.accent].toLowerCase()
  const sameLang = voices.filter((v) => v.lang.toLowerCase().replace('_', '-') === lang)
  return sameLang.find((v) => /natural|neural|online/i.test(v.name)) ?? sameLang[0] ?? voices[0]
}

// ---- 播放 ----

let current: HTMLAudioElement | null = null
let speakToken = 0 // 每次開始念 +1；舊的（還在下載或產生中的）看到不同就放棄

// ---- Kokoro ----

const kokoroUrls = new Map<string, string>() // 這次開著 App 期間念過的（Rust 端另有磁碟快取）
let kokoroBroken = false // 沒下載或載入失敗：之後直接用系統語音，重開學習中心設定時會重設
const busyListeners = new Set<(busy: boolean) => void>()

/** Kokoro 產生語音中（第一次要載入模型約 1–2 秒） */
export function onTtsBusy(cb: (busy: boolean) => void): () => void {
  busyListeners.add(cb)
  return () => busyListeners.delete(cb)
}

export function resetKokoro(): void {
  kokoroBroken = false
}

async function speakKokoro(text: string, factor: number, token: number, onWord?: (i: number) => void): Promise<boolean> {
  if (kokoroBroken) return false
  // 設定的語速是照系統語音調的（預設 0.9），Kokoro 本身語速自然 → 換算成 1.0 為基準
  const speed = Math.round(((prefs.voiceRate * factor) / DEFAULT_VOICE.voiceRate) * 100) / 100
  const voice = kokoroVoice()
  const key = `${voice}|${speed}|${text}`
  let url = kokoroUrls.get(key)
  if (!url) {
    busyListeners.forEach((cb) => cb(true))
    try {
      const buf = await invoke<ArrayBuffer>('tts_speak', { text, voice, speed })
      url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
      if (kokoroUrls.size > 60) {
        const [first] = kokoroUrls.keys()
        URL.revokeObjectURL(kokoroUrls.get(first)!)
        kokoroUrls.delete(first)
      }
      kokoroUrls.set(key, url)
    } catch (e) {
      if (String(e).includes('tts-missing') || String(e).includes('tts-load-failed')) kokoroBroken = true
      return false
    } finally {
      busyListeners.forEach((cb) => cb(false))
    }
  }
  if (token !== speakToken) return true // 等的時候使用者已經按了別的
  const a = new Audio(url)
  current = a
  if (onWord) followWords(a, text, onWord)
  try {
    await a.play()
    return true
  } catch {
    onWord?.(-1)
    return false
  }
}

/** Kokoro 不提供每個字的時間 → 依字的長度占整句的比例，對照播放進度估算念到哪個字 */
function followWords(a: HTMLAudioElement, text: string, onWord: (i: number) => void): void {
  const words = [...text.matchAll(/[A-Za-z0-9'’]+/g)].map((m) => ({ at: m.index ?? 0, len: m[0].length + 1 }))
  const total = words.reduce((n, w) => n + w.len, 0)
  let last = -2
  const tick = () => {
    if (current !== a || a.ended || a.paused) {
      onWord(-1)
      return
    }
    if (a.duration > 0) {
      // 頭尾各有一點靜音，估算時扣掉
      const p = Math.min(1, Math.max(0, (a.currentTime - 0.15) / Math.max(0.1, a.duration - 0.35))) * total
      let acc = 0
      const w = words.find((w) => (acc += w.len) > p) ?? words[words.length - 1]
      if (w && w.at !== last) {
        last = w.at
        onWord(w.at)
      }
    }
    requestAnimationFrame(tick)
  }
  a.addEventListener('playing', () => requestAnimationFrame(tick), { once: true })
}

/** 同時只念一個：開始新的之前先停掉舊的 */
export function stopSpeaking(): void {
  current?.pause()
  current = null
  try {
    speechSynthesis.cancel()
  } catch {
    /* 不支援就算了 */
  }
}

// 念一句英文；factor 是乘在設定語速上的倍率（慢速 < 1）。
// onWord(字元位置) 在念到每個字時呼叫（有些語音不提供），念完呼叫 onWord(-1)
export function speakSentence(text: string, factor = 1, onWord?: (charIndex: number) => void): void {
  stopSpeaking()
  const token = ++speakToken
  if (prefs.engine === 'kokoro') {
    void speakKokoro(text, factor, token, onWord).then((ok) => {
      if (!ok && token === speakToken) systemSpeak(text, factor, onWord) // 沒下載或出錯 → 改用系統語音
    })
    return
  }
  systemSpeak(text, factor, onWord)
}

function systemSpeak(text: string, factor: number, onWord?: (charIndex: number) => void): void {
  try {
    const u = new SpeechSynthesisUtterance(text)
    const v = pickVoice()
    u.lang = v?.lang ?? ACCENT_LANG[prefs.accent]
    if (v) u.voice = v
    u.rate = Math.min(2, Math.max(0.3, prefs.voiceRate * factor))
    if (onWord) {
      u.onboundary = (e) => {
        if (e.name === 'word') onWord(e.charIndex)
      }
      u.onend = () => onWord(-1)
      u.onerror = () => onWord(-1)
    }
    speechSynthesis.speak(u)
  } catch {
    onWord?.(-1) // 環境不支援 TTS 就安靜略過
  }
}

// 錄音檔名：dictionaryapi.dev 是 paper-us.mp3，維基共享資源是 en-us-paper.ogg
const ACCENT_FILE: Record<Accent, RegExp> = {
  us: /([-_]us\.\w+$|\/en-us[-_])/i,
  uk: /([-_](uk|gb)\.\w+$|\/en-(uk|gb)[-_])/i,
  au: /([-_]au\.\w+$|\/en-au[-_])/i,
}

/** 依口音排序錄音：符合口音的在前，其他口音的真人錄音在後（播不出來就試下一個） */
export function orderRecordings(urls: string[] | null | undefined): string[] {
  if (!urls?.length) return []
  const re = ACCENT_FILE[prefs.accent]
  return [...urls.filter((u) => re.test(u)), ...urls.filter((u) => !re.test(u))]
}

// 沒存錄音網址的單字（舊收藏、詞彙頁）念的時候才去線上字典查，查過的記住
const recordingCache = new Map<string, string[]>()

async function lookupRecordings(word: string): Promise<string[]> {
  const key = word.toLowerCase()
  const hit = recordingCache.get(key)
  if (hit) return hit
  const urls = await api
    .dictOnline(word)
    .then((o) => o.audioUrls ?? [])
    .catch(() => [])
  recordingCache.set(key, urls)
  return urls
}

function play(url: string, factor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const a = new Audio(url)
    a.playbackRate = Math.min(1.5, Math.max(0.5, factor))
    current = a
    a.onended = () => resolve()
    a.play().then(() => resolve(), reject)
  })
}

/** 念一個單字：依設定用真人錄音或語音合成。urls = 已知的錄音（例如收藏時存下的） */
export async function speakWord(word: string, urls?: string[] | null, factor = 1): Promise<void> {
  stopSpeaking()
  if (prefs.wordSource === 'recording') {
    const token = ++speakToken
    const tryAll = async (list: string[]) => {
      for (const url of list.slice(0, 4)) {
        if (token !== speakToken) return true // 已經在念別的了
        try {
          await play(url, factor)
          return true
        } catch {
          /* 這個播不出來，試下一個 */
        }
      }
      return false
    }
    if (await tryAll(orderRecordings(urls?.length ? urls : await lookupRecordings(word)))) return
    // 存下來的錄音都播不出來（例如音檔主機掛了）→ 再查一次線上字典（含維基共享資源的備援）
    if (urls?.length && (await tryAll(orderRecordings((await lookupRecordings(word)).filter((u) => !urls.includes(u))))))
      return
    if (token !== speakToken) return
  }
  speakSentence(word, factor)
}

/** 收藏的項目：單字用 speakWord，句子用 speakSentence */
export function speakItem(item: { kind: string; text: string; audioUrls?: string[] }, factor = 1): void {
  if (item.kind === 'word') void speakWord(item.text, item.audioUrls, factor)
  else speakSentence(item.text, factor)
}
