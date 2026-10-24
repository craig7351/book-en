import { useMemo, useState } from 'react'
import { fmtRank, LEVEL_LABEL, levelOf, type Level } from '../../shared/levels'
import { tokenize, normWord } from '../../shared/tokenize'
import { pauseVideo, seekCue, setWordStatus } from '../controller'
import { cuesOf, store, useStore } from '../store'

interface Entry {
  lemma: string
  rank: number | null
  level: Level
  count: number
  form: string // 第一次出現的字面
  cueIdx: number // 第一次出現的句子
}

// 顯示順序；基礎 / 已知 / 不要學 / 未分級 只顯示數量，可展開
const SECTIONS: { level: Level; open: boolean; hint: string }[] = [
  { level: 'suggest', open: true, hint: '常用、值得背' },
  { level: 'learning', open: true, hint: '已收藏，會出現在複習' },
  { level: 'rare', open: true, hint: '少見，有興趣再學' },
  { level: 'basic', open: false, hint: '最常用的字，預設當成已會' },
  { level: 'known', open: false, hint: '你標為已知' },
  { level: 'ignore', open: false, hint: '你標為不要學' },
]

// 面板「詞語」分頁：本片出現的字依分級分組
export function WordsTab() {
  const cues = useStore(cuesOf)
  const words = useStore((s) => s.words)
  const knownMax = useStore((s) => s.prefs.knownMax)
  const suggestMax = useStore((s) => s.prefs.suggestMax)
  const [expanded, setExpanded] = useState<Partial<Record<Level, boolean>>>({})

  const groups = useMemo(() => {
    const byLemma = new Map<string, Entry>()
    cues.forEach((c, cueIdx) => {
      for (const t of tokenize(c.text)) {
        if (!t.word) continue
        const info = words.get(normWord(t.word))
        if (!info) continue
        const e = byLemma.get(info.lemma)
        if (e) e.count++
        else
          byLemma.set(info.lemma, {
            lemma: info.lemma,
            rank: info.rank,
            level: levelOf(info, { knownMax, suggestMax }),
            count: 1,
            form: t.word,
            cueIdx,
          })
      }
    })
    const out = new Map<Level, Entry[]>()
    for (const e of byLemma.values()) {
      if (e.level === 'none') continue // 沒排名（多半是專有名詞）
      out.set(e.level, [...(out.get(e.level) ?? []), e])
    }
    for (const list of out.values()) list.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
    return out
  }, [cues, words, knownMax, suggestMax])

  if (!words.size) return <p className="empty">分析本片詞彙中…</p>

  return (
    <div className="words">
      <p className="words-summary">
        本片建議學習 <b>{groups.get('suggest')?.length ?? 0}</b> 字 · 罕見 {groups.get('rare')?.length ?? 0} · 學習中{' '}
        {groups.get('learning')?.length ?? 0}
      </p>
      {SECTIONS.map(({ level, open, hint }) => {
        const list = groups.get(level) ?? []
        if (!list.length) return null
        const show = expanded[level] ?? open
        return (
          <section key={level} className={'wsec ' + level}>
            <button className="wsec-head" onClick={() => setExpanded({ ...expanded, [level]: !show })}>
              <span>{show ? '▾' : '▸'}</span>
              <b>{LEVEL_LABEL[level]}</b> <span className="muted">{list.length} 字 · {hint}</span>
            </button>
            {show && (
              <ul>
                {list.map((e) => (
                  <li key={e.lemma} className="wrow">
                    <span
                      className={'wl ' + level}
                      title="看單字卡"
                      onClick={() => {
                        seekCue(e.cueIdx)
                        pauseVideo()
                        store.set({ card: { word: e.form, cueIdx: e.cueIdx } })
                      }}
                    >
                      {e.lemma}
                    </span>
                    <span className="muted small-num">{e.rank ? `#${fmtRank(e.rank)}` : ''}</span>
                    {e.count > 1 && <span className="muted small-num">×{e.count}</span>}
                    <span className="wrow-btns">
                      <button title="已知" className={level === 'known' ? 'on' : ''} onClick={() => setWordStatus(e.lemma, level === 'known' ? null : 'known')}>
                        ✓
                      </button>
                      <button title="不要學" className={level === 'ignore' ? 'on' : ''} onClick={() => setWordStatus(e.lemma, level === 'ignore' ? null : 'ignore')}>
                        ⊘
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
