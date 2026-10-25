// Rust 指令的回傳型別（serde camelCase）。改 Rust struct 時這裡要同步。

export interface DictEntry {
  word: string
  phonetic: string | null
  translation: string | null
  definition: string | null
  tag: string | null
  collins: number
  oxford: number
}

export interface LookupResult {
  entry: DictEntry | null
  lemma: DictEntry | null
}

export interface OnlineInfo {
  audioUrl: string | null
  audioUrls: string[] // 所有真人錄音（-us / -uk / -au）
  phonetic: string | null
  senses: { pos: string; definition: string; example: string | null }[]
}

export type ItemKind = 'word' | 'sentence'

export interface ItemInput {
  kind: ItemKind
  text: string
  phonetic?: string | null
  meaningZh?: string | null
  context?: string | null
  contextZh?: string | null
  videoId?: string | null
  videoTitle?: string | null
  t?: number | null
  audioUrls?: string[] // 單字的真人錄音網址
}

export interface Item {
  id: number
  kind: ItemKind
  text: string
  phonetic: string | null
  meaningZh: string | null
  context: string | null
  contextZh: string | null
  videoId: string | null
  videoTitle: string | null
  t: number | null
  createdAt: number
  dueAt: number
  intervalDays: number
  ease: number
  reps: number
  lapses: number
  audioUrls: string[]
  suspended: boolean // 暫停複習
}

export interface Stats {
  words: number
  sentences: number
  due: number // 今天要複習的（複習過、到期的＋今天新字額度內的新字）
  newWaiting: number // 超過每天新字上限、之後再出的新字
  reviewedToday: number
  streakDays: number
}

export interface Example {
  en: string
  zh: string | null
}

export interface DictStatus {
  installed: boolean
  path: string | null
  hasFreq: boolean
  hasExamples: boolean
  downloadUrl: string
  downloadSize: number
}

export interface RankedWord {
  lemma: string
  rank: number
  status: 'known' | 'learning' | 'ignore' | null
  seen: boolean
}

export interface LevelCounts {
  known: number
  auto: number
  learning: number
  suggested: number
  ignored: number
  rare: number
  vocabSize: number
}

// AI 翻譯存檔（exe 同目錄 subtitles\<影片ID>.json）
export interface SavedSubs {
  videoId: string
  title: string
  model: string
  savedAt?: number
  complete: boolean
  lines: { start: number; end: number; en: string; zh: string | null }[]
  path?: string
}

export interface Bookmark {
  url: string
  title: string
  createdAt: number
}

// Kokoro 離線語音的下載狀態
export interface TtsStatus {
  supported: boolean // 這個平台的版本有沒有 Kokoro（Intel Mac 沒有）
  installed: boolean
  dir: string // 下載位置
  downloadSize: number // 還要下載多少 bytes（裝好為 0）
  totalSize: number
  diskSize: number // 實際占用（含念過的句子快取）
}
