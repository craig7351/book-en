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
}

export interface Stats {
  words: number
  sentences: number
  due: number
  reviewedToday: number
  streakDays: number
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

export const MODELS = [
  { id: 'haiku', label: 'Haiku（快、省）' },
  { id: 'sonnet', label: 'Sonnet（品質較好）' },
  { id: 'opus', label: 'Opus（最好、較慢）' },
] as const
