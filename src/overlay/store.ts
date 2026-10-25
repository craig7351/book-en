// 面板與字幕層共用的狀態（兩者是不同的 React root，用外部 store 同步）
import { useSyncExternalStore } from 'react'
import type { EggView, PetView } from '../shared/game'
import { DEFAULT_LEVELS, type WordInfo } from '../shared/levels'
import type { Mood } from '../shared/sprites'
import type { Cue } from './cues'
import { DEFAULT_CHUNK } from '../shared/webai'
import type { CaptionResult, ZhKind } from './youtube'

export interface Prefs {
  autoPause: boolean // 每句結束自動暫停
  loop: boolean // 單句循環
  blur: boolean // 盲聽：字幕模糊，滑過才顯示
  showZh: boolean // 顯示中文翻譯
  layer: boolean // 影片上顯示 book-en 字幕（取代原生 CC）
  rate: number
  model: string // AI 翻譯用的引擎與模型（shared/aicli.ts：「haiku」「codex:gpt-5.6-luna」…）
  zhKind: ZhKind | null // 上次選的中文來源；null = 自動（有 YouTube 中文就用）
  subSize: number // 影片字幕大小（%）
  knownMax: number // 詞頻分級：排名 ≤ 這個 = 基礎（自動已知）
  suggestMax: number // 排名 ≤ 這個 = 建議學習，更後面 = 罕見
  markLevels: boolean // 字幕上標示分級（建議學習加底線、罕見變淡）
  webAiChunk: number // 網頁 AI 翻譯：每段幾句（在學習中心設定）
}

export const DEFAULT_PREFS: Prefs = {
  autoPause: false,
  loop: false,
  blur: false,
  showZh: true,
  layer: true,
  rate: 1,
  model: 'haiku',
  zhKind: null,
  subSize: 100,
  knownMax: DEFAULT_LEVELS.knownMax,
  suggestMax: DEFAULT_LEVELS.suggestMax,
  markLevels: true,
  webAiChunk: DEFAULT_CHUNK,
}

export type CaptionState =
  | { status: 'idle' }
  | { status: 'loading'; videoId: string }
  | { status: 'ready'; videoId: string; result: CaptionResult }
  | { status: 'error'; videoId: string; message: string }

export interface CardTarget {
  word: string
  cueIdx: number // 字幕中的句子（從例句點過來時是原本那張卡的句子）
  context?: { en: string; zh: string | null } // 從例句點的字：原句改用例句
}

export interface State {
  open: boolean
  fullscreen: boolean
  captions: CaptionState
  zh: (string | null | undefined)[] // undefined = 還沒翻；null = 翻譯失敗 / 該句沒有對應中文
  zhSource: string | null // 目前中文來源的 id（ZhSource.id）
  zhStatus: string | null // 中文來源的狀態說明
  aiMissing: number // AI 來源：還沒翻譯（快取沒有）的句數
  translating: boolean
  transError: string | null
  active: number
  prefs: Prefs
  saved: Set<string> // 已收藏單字（小寫原形）
  savedSentences: Set<string>
  card: CardTarget | null
  cardHistory: CardTarget[] // 單字卡「← 返回」用
  dictMissing: boolean // 沒有離線字典（顯示提示）
  due: number
  words: Map<string, WordInfo> // 本片每個字（小寫字面）的原形、排名、個人狀態
  tab: 'subs' | 'words' // 面板分頁：字幕 / 詞語
  pet: PanelPet | null // 遊戲模式＋面板陪伴都開啟時才有
  petCheer: number // 每次收藏 +1，讓迷你寵物跳一下
}

export interface PanelPet {
  pet: PetView | null
  egg: EggView | null
  mood: Mood
  sound: boolean
}

type Listener = () => void
let state: State = {
  open: true,
  fullscreen: false,
  captions: { status: 'idle' },
  zh: [],
  zhSource: null,
  zhStatus: null,
  aiMissing: 0,
  translating: false,
  transError: null,
  active: -1,
  prefs: DEFAULT_PREFS,
  saved: new Set(),
  savedSentences: new Set(),
  card: null,
  cardHistory: [],
  dictMissing: false,
  due: 0,
  words: new Map(),
  tab: 'subs',
  pet: null,
  petCheer: 0,
}
const listeners = new Set<Listener>()

export const store = {
  get: () => state,
  set(patch: Partial<State> | ((s: State) => Partial<State>)) {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    listeners.forEach((l) => l())
  },
  subscribe(l: Listener) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
}

// selector 必須回傳既有的參考或原始值，不可每次建新物件
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(state))
}

export function cuesOf(s: State): Cue[] {
  return s.captions.status === 'ready' ? s.captions.result.cues : EMPTY
}
const EMPTY: Cue[] = []
