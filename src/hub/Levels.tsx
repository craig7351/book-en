import { useEffect, useMemo, useState } from 'react'
import { api, errorText } from '../shared/api'
import { DEFAULT_LEVELS, fmtRank, LEVEL_LABEL, levelOf, type Level, type LevelPrefs } from '../shared/levels'
import { speak } from '../shared/speak'
import type { LevelCounts, LookupResult, RankedWord } from '../shared/types'

const PAGE = 1000 // 每頁 1000 名（10 區 × 100 字）
const JUMPS = [1, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 15000, 20000, 30000]

type Filter = 'all' | Level | 'seen'

// 學習中心「詞彙」頁：依詞頻排名列出所有字（每 100 字一區），可標已知 / 學習中 / 不要學
export function Levels({ onChanged }: { onChanged: () => void }) {
  const [prefs, setPrefsState] = useState<LevelPrefs>(DEFAULT_LEVELS)
  const [counts, setCounts] = useState<LevelCounts | null>(null)
  const [start, setStart] = useState(1)
  const [rows, setRows] = useState<RankedWord[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [picked, setPicked] = useState<RankedWord | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function loadPrefs(): Promise<LevelPrefs> {
    const raw = await api.getSetting('prefs').catch(() => null)
    const p = raw ? JSON.parse(raw) : {}
    const next = { knownMax: p.knownMax ?? DEFAULT_LEVELS.knownMax, suggestMax: p.suggestMax ?? DEFAULT_LEVELS.suggestMax }
    setPrefsState(next)
    return next
  }

  async function refresh(from = start) {
    try {
      const p = await loadPrefs()
      const [list, c] = await Promise.all([api.vocabRanks(from, from + PAGE - 1), api.levelCounts(p.knownMax, p.suggestMax)])
      setRows(list)
      setCounts(c)
    } catch (e) {
      setMsg(errorText(e))
    }
  }

  useEffect(() => {
    void refresh(start)
  }, [start])

  useEffect(() => {
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [start])

  const levelOfRow = (r: RankedWord) => levelOf(r, prefs)

  // 篩選：已知 / 學習中 / 不要學 看個人狀態；建議 / 罕見 只算看過的字（同 Language Reactor）
  const shown = useMemo(
    () =>
      rows.filter((r) => {
        const lv = levelOfRow(r)
        if (filter === 'all') return true
        if (filter === 'seen') return r.seen
        if (filter === 'suggest' || filter === 'rare') return r.seen && lv === filter
        return lv === filter
      }),
    [rows, filter, prefs],
  )

  const buckets = useMemo(() => {
    const out = new Map<number, RankedWord[]>()
    for (const r of shown) {
      const b = Math.floor((r.rank - 1) / 100) * 100 + 1
      out.set(b, [...(out.get(b) ?? []), r])
    }
    // 區內依字母排（wordfreq 頻率是分段的，同段排名其實並列）
    for (const list of out.values()) list.sort((a, b) => a.lemma.localeCompare(b.lemma))
    return [...out.entries()]
  }, [shown])

  async function setStatus(lemmas: string[], status: 'known' | 'ignore' | null) {
    await api.setWordStatus(lemmas, status)
    await refresh()
    onChanged()
  }

  const chip = (f: Filter, label: string, n: number | undefined, sub?: string, subN?: number) => (
    <button className={filter === f ? 'lchip on ' + f : 'lchip ' + f} onClick={() => setFilter(filter === f ? 'all' : f)}>
      {label} <b>{n ?? '–'}</b>
      {sub && (
        <span className="lchip-sub">
          {sub} {subN !== undefined ? fmtRank(subN) : ''}
        </span>
      )}
    </button>
  )

  return (
    <section className="levels">
      <div className="lchips">
        {chip('known', '✓ 已知', counts?.known, '自動', counts?.auto)}
        {chip('learning', '📖 學習中', counts?.learning, '建議', counts?.suggested)}
        {chip('ignore', '⊘ 不要學', counts?.ignored, '罕見', counts?.rare)}
        <button className={filter === 'suggest' ? 'lchip on suggest' : 'lchip suggest'} onClick={() => setFilter(filter === 'suggest' ? 'all' : 'suggest')}>
          看過的建議學習字
        </button>
        <button className={filter === 'seen' ? 'lchip on' : 'lchip'} onClick={() => setFilter(filter === 'seen' ? 'all' : 'seen')}>
          只看影片中出現過的
        </button>
        {counts && (
          <span className="vocab-size">
            估計詞彙量 <b>{fmtRank(counts.vocabSize)}</b>
          </span>
        )}
      </div>
      <p className="muted small">
        排名依 wordfreq（含影視字幕語料），以原形計（running、ran 都算 run）。前 {fmtRank(prefs.knownMax)} 名自動當成已會；
        到第 {fmtRank(prefs.suggestMax)} 名為建議學習；更後面為罕見。可在 YouTube 頁的 ⚙ 調整。
      </p>
      {msg && (
        <p className="msg">
          {msg} {msg.includes('離線字典') && <a href="#dict">前往下載</a>}
        </p>
      )}

      <div className="levels-body">
        <div className="lgrid">
          {buckets.length === 0 && <p className="empty">這個排名範圍沒有符合的字。</p>}
          {buckets.map(([b, list]) => (
            <div key={b} className="bucket">
              <div className="bucket-head">
                <span>
                  排名 {fmtRank(b)} – {fmtRank(b + 99)}
                </span>
                <button
                  className="link"
                  title="把這一區還沒標記的字都標為已知"
                  onClick={() => setStatus(list.filter((r) => !r.status).map((r) => r.lemma), 'known')}
                >
                  整區標為已知
                </button>
              </div>
              <div className="bucket-words">
                {list.map((r) => (
                  <span key={r.lemma} className={'lw ' + levelOfRow(r) + (r.seen ? ' seen' : '')} title={`#${fmtRank(r.rank)}`} onClick={() => setPicked(r)}>
                    {r.lemma}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <div className="pager">
            <button disabled={start <= 1} onClick={() => setStart(Math.max(1, start - PAGE))}>
              ◀ 前 {PAGE} 名
            </button>
            <span className="muted">
              排名 {fmtRank(start)} – {fmtRank(start + PAGE - 1)}
            </span>
            <button onClick={() => setStart(start + PAGE)}>後 {PAGE} 名 ▶</button>
          </div>
        </div>
        <nav className="jump">
          {JUMPS.map((j) => (
            <button key={j} className={start === (j === 1 ? 1 : j + 1) ? 'on' : ''} onClick={() => setStart(j === 1 ? 1 : j + 1)}>
              {j >= 1000 ? `${j / 1000}k` : j}
            </button>
          ))}
        </nav>
      </div>

      {picked && <WordPopover word={picked} level={levelOfRow(picked)} onClose={() => setPicked(null)} onStatus={setStatus} onSaved={() => refresh().then(onChanged)} />}
    </section>
  )
}

function WordPopover({
  word,
  level,
  onClose,
  onStatus,
  onSaved,
}: {
  word: RankedWord
  level: Level
  onClose: () => void
  onStatus: (lemmas: string[], s: 'known' | 'ignore' | null) => Promise<void>
  onSaved: () => void
}) {
  const [dict, setDict] = useState<LookupResult | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    api.dictLookup(word.lemma).then(setDict).catch(() => {})
  }, [word.lemma])
  const entry = dict?.entry
  const meaning = entry?.translation?.split('\n').filter(Boolean).slice(0, 2).join('；') ?? null

  async function learn() {
    try {
      if (word.status) await api.setWordStatus([word.lemma], null)
      await api.itemAdd({ kind: 'word', text: word.lemma, phonetic: entry?.phonetic ?? null, meaningZh: meaning })
      setMsg('已加入學習（複習）')
      onSaved()
    } catch (e) {
      setMsg(errorText(e))
    }
  }

  const toggle = async (s: 'known' | 'ignore') => {
    await onStatus([word.lemma], word.status === s ? null : s)
    onClose()
  }

  return (
    <div className="pop-backdrop" onClick={onClose}>
      <div className="pop" onClick={(e) => e.stopPropagation()}>
        <div className="pop-head">
          <span className="item-text" onClick={() => speak(word.lemma)} title="發音">
            🔊 {word.lemma}
          </span>
          {entry?.phonetic && <span className="phonetic">/{entry.phonetic}/</span>}
        </div>
        <div className="muted">
          第 {fmtRank(word.rank)} 常用 · {LEVEL_LABEL[level]}
          {word.seen ? ' · 在影片中出現過' : ''}
        </div>
        {meaning ? <div className="meaning">{meaning}</div> : dict && <div className="muted">字典查無中文釋義</div>}
        {msg && <p className="msg">{msg}</p>}
        <div className="pop-btns">
          <button className={word.status === 'known' ? 'on known' : ''} onClick={() => toggle('known')}>
            ✓ 已知
          </button>
          <button className={word.status === 'learning' ? 'on learning' : ''} onClick={learn} disabled={word.status === 'learning'}>
            📖 學習中
          </button>
          <button className={word.status === 'ignore' ? 'on ignore' : ''} onClick={() => toggle('ignore')}>
            ⊘ 不要學
          </button>
        </div>
      </div>
    </div>
  )
}
