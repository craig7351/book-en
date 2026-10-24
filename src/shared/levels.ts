// 詞頻分級（M9）：排名 + 個人狀態 → 有效分級。YouTube 面板與學習中心共用。

export type WordStatus = 'known' | 'learning' | 'ignore'
export type Tier = 'basic' | 'suggest' | 'rare'
export type Level = WordStatus | Tier | 'none' // none = 沒排名（多半是專有名詞），不分級

export interface LevelPrefs {
  knownMax: number // 排名 ≤ 這個 = 基礎（自動已知）
  suggestMax: number // 排名 ≤ 這個 = 建議學習；更後面 = 罕見
}

export const DEFAULT_LEVELS: LevelPrefs = { knownMax: 1500, suggestMax: 10000 }
export const KNOWN_MAX_OPTIONS = [500, 1000, 1500, 2000, 3000, 5000]
export const SUGGEST_MAX_OPTIONS = [5000, 8000, 10000, 15000, 20000]

export interface WordInfo {
  word: string
  lemma: string
  rank: number | null
  status: WordStatus | null
}

export function tierOf(rank: number | null, p: LevelPrefs): Tier | 'none' {
  if (rank === null) return 'none'
  if (rank <= p.knownMax) return 'basic'
  return rank <= p.suggestMax ? 'suggest' : 'rare'
}

export function levelOf(info: Pick<WordInfo, 'rank' | 'status'>, p: LevelPrefs): Level {
  return info.status ?? tierOf(info.rank, p)
}

export const LEVEL_LABEL: Record<Level, string> = {
  known: '已知',
  learning: '學習中',
  ignore: '不要學',
  basic: '基礎',
  suggest: '建議學習',
  rare: '罕見',
  none: '未分級',
}

// 排名長條：對數刻度（1 → 滿，6 萬 → 空），跟 Language Reactor 的進度條同概念
export function rankBar(rank: number | null): number {
  if (!rank) return 0
  return Math.max(0.03, 1 - Math.log(rank) / Math.log(60000))
}

export const fmtRank = (n: number) => n.toLocaleString('en-US')
