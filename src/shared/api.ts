// 型別化的 Rust 指令呼叫
import { invoke } from './tauri'
import type { WordInfo } from './levels'
import type { Bookmark, Item, ItemInput, LevelCounts, LookupResult, OnlineInfo, RankedWord, SavedSubs, Stats } from './types'

const startOfToday = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export const api = {
  translateBatch: (lines: string[], model: string) =>
    invoke<(string | null)[]>('translate_batch', { lines, model }),
  translationCached: (lines: string[]) => invoke<(string | null)[]>('translation_cached', { lines }),
  saveSubtitles: (subs: SavedSubs) => invoke<string>('save_subtitles', { subs }),
  loadSubtitles: (videoId: string) => invoke<SavedSubs | null>('load_subtitles', { videoId }),
  aiExplain: (word: string, sentence: string, model: string) =>
    invoke<string>('ai_explain', { word, sentence, model }),
  claudeStatus: () => invoke<string>('claude_status'),

  dictLookup: (word: string) => invoke<LookupResult>('dict_lookup', { word }),
  dictOnline: (word: string) => invoke<OnlineInfo>('dict_online', { word }),

  itemAdd: (item: ItemInput) => invoke<Item>('item_add', { item }),
  itemDelete: (id: number) => invoke<void>('item_delete', { id }),
  itemList: (query = '') => invoke<Item[]>('item_list', { query }),
  savedWords: () => invoke<string[]>('saved_words'),
  reviewDue: (limit: number) => invoke<Item[]>('review_due', { limit }),
  reviewGrade: (id: number, quality: number, quiz: string) => invoke<Item>('review_grade', { id, quality, quiz }),
  stats: () => invoke<Stats>('stats', { dayStart: startOfToday() }),
  quizDistractors: (exclude: string, n: number) => invoke<string[]>('quiz_distractors', { exclude, n }),
  exportItems: (format: 'csv' | 'anki') => invoke<string>('export_items', { format }),

  getSetting: (key: string) => invoke<string | null>('get_setting', { key }),
  setSetting: (key: string, value: string) => invoke<void>('set_setting', { key, value }),

  bookmarkList: () => invoke<Bookmark[]>('bookmark_list'),
  bookmarkToggle: (url: string, title: string) => invoke<boolean>('bookmark_toggle', { url, title }),
  bookmarkDelete: (url: string) => invoke<void>('bookmark_delete', { url }),

  wordInfo: (words: string[], videoId: string | null) => invoke<WordInfo[]>('word_info', { words, videoId }),
  setWordStatus: (lemmas: string[], status: 'known' | 'ignore' | null) =>
    invoke<void>('set_word_status', { lemmas, status }),
  vocabRanks: (from: number, to: number) => invoke<RankedWord[]>('vocab_ranks', { from, to }),
  levelCounts: (knownMax: number, suggestMax: number) => invoke<LevelCounts>('level_counts', { knownMax, suggestMax }),

  openHub: (tab?: string) => invoke<void>('open_hub', { tab }),
  playSource: (videoId: string, t: number) => invoke<void>('play_source', { videoId, t }),
}

// 錯誤訊息轉成給人看的中文
export function errorText(e: unknown): string {
  const s = String(e)
  if (s.includes('claude-not-found')) return '找不到 Claude Code CLI：請先安裝並在終端機執行 claude 登入'
  if (s.includes('claude-error') || s.includes('claude-failed')) return `Claude 回覆錯誤：${s.replace(/^.*?claude-(error|failed):?\s*/, '')}`
  if (s.includes('bad-reply')) return 'Claude 回覆格式不對，請重試'
  if (s.includes('no-tauri')) return '未連線到 book-en 主程式'
  return s
}
