import { useEffect, useState } from 'react'
import { api, errorText } from '../../shared/api'
import { speak } from '../../shared/speak'
import type { DictEntry, LookupResult, OnlineInfo } from '../../shared/types'
import { fmtRank, LEVEL_LABEL, levelOf, rankBar } from '../../shared/levels'
import { infoOf, markLearning, refreshSaved, setWordStatus } from '../controller'
import { cuesOf, store, useStore } from '../store'
import { getVideoTitle } from '../youtube'

const TAGS: Record<string, string> = {
  zk: '國中',
  gk: '高中',
  cet4: 'CET4',
  cet6: 'CET6',
  ky: '考研',
  toefl: 'TOEFL',
  ielts: 'IELTS',
  gre: 'GRE',
}

// 字典的中文釋義取前幾行，存進單字庫用
const shortMeaning = (e: DictEntry | null) =>
  (e?.translation ?? '').split('\n').filter(Boolean).slice(0, 2).join('；') || null

export function WordCard() {
  const card = useStore((s) => s.card)
  const captions = useStore((s) => s.captions)
  const zh = useStore((s) => s.zh)
  const model = useStore((s) => s.prefs.model)
  const savedSet = useStore((s) => s.saved)
  useStore((s) => s.words) // 狀態改變時重繪
  const knownMax = useStore((s) => s.prefs.knownMax)
  const suggestMax = useStore((s) => s.prefs.suggestMax)
  const [dict, setDict] = useState<LookupResult | null>(null)
  const [online, setOnline] = useState<OnlineInfo | null>(null)
  const [ai, setAi] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!card) return
    let alive = true
    setDict(null)
    setOnline(null)
    setAi(null)
    setMsg(null)
    api
      .dictLookup(card.word)
      .then((r) => {
        if (!alive) return
        setDict(r)
        const head = r.lemma?.word ?? r.entry?.word ?? card.word
        return api.dictOnline(head).then((o) => alive && setOnline(o))
      })
      .catch((e) => alive && setMsg(errorText(e)))
    return () => {
      alive = false
    }
  }, [card?.word, card?.cueIdx])

  if (!card) return null
  const cues = cuesOf(store.get())
  const cue = cues[card.cueIdx]
  const entry = dict?.entry ?? null
  const lemma = dict?.lemma ?? null
  const head = lemma ?? entry // 收藏時用原形
  const headWord = (head?.word ?? card.word).toLowerCase()
  const isSaved = savedSet.has(headWord)
  const phonetic = entry?.phonetic ?? online?.phonetic ?? null
  const tags = (entry?.tag ?? lemma?.tag ?? '').split(' ').filter((t) => TAGS[t])
  const info = infoOf(card.word)
  const lemmaKey = info?.lemma ?? headWord
  const status = info?.status ?? (isSaved ? 'learning' : null)
  const level = info ? levelOf({ rank: info.rank, status }, { knownMax, suggestMax }) : null

  async function toggleStatus(s: 'known' | 'ignore') {
    try {
      await setWordStatus(lemmaKey, status === s ? null : s)
    } catch (e) {
      setMsg(errorText(e))
    }
  }

  async function save() {
    try {
      await api.itemAdd({
        kind: 'word',
        text: headWord,
        phonetic: head?.phonetic ?? phonetic,
        meaningZh: shortMeaning(head),
        context: cue?.text ?? null,
        contextZh: typeof zh[card!.cueIdx] === 'string' ? zh[card!.cueIdx] : null,
        videoId: captions.status === 'ready' ? captions.videoId : null,
        videoTitle: getVideoTitle(),
        t: cue?.start ?? null,
      })
      await refreshSaved()
      // 原本標成已知 / 不要學的字改為學習中
      if (status === 'known' || status === 'ignore') await setWordStatus(lemmaKey, null)
      markLearning(lemmaKey)
      setMsg(`已收藏「${headWord}」，會出現在複習中`)
    } catch (e) {
      setMsg(errorText(e))
    }
  }

  async function explain() {
    if (!cue) return
    setAiBusy(true)
    try {
      setAi(await api.aiExplain(card!.word, cue.text, model))
    } catch (e) {
      setAi(errorText(e))
    }
    setAiBusy(false)
  }

  return (
    <div className="card-backdrop" onClick={() => store.set({ card: null })}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div>
            <span className="card-word">{entry?.word ?? card.word}</span>
            {phonetic && <span className="card-phonetic">/{phonetic}/</span>}
          </div>
          <div className="card-actions">
            <button className="icon" title="發音" onClick={() => speak(entry?.word ?? card.word, online?.audioUrl)}>
              🔊
            </button>
            <button className="icon" title="關閉（Esc）" onClick={() => store.set({ card: null })}>
              ✕
            </button>
          </div>
        </div>

        {tags.length > 0 && (
          <div className="tags">
            {tags.map((t) => (
              <span key={t} className="tag">
                {TAGS[t]}
              </span>
            ))}
            {(entry?.collins ?? 0) > 0 && <span className="tag">{'★'.repeat(entry!.collins)}</span>}
          </div>
        )}

        {info && (
          <div className="rank">
            <div className="rank-bar" title="越長越常用">
              <span style={{ width: `${rankBar(info.rank) * 100}%` }} />
            </div>
            <span className="rank-text">{info.rank ? `第 ${fmtRank(info.rank)} 常用` : '無排名'}</span>
            {level && <span className={'level-pill ' + level}>{LEVEL_LABEL[level]}</span>}
          </div>
        )}

        <div className="card-body">
          {!dict && !msg && <p className="muted">查詢中…</p>}
          {dict && !entry && <p className="muted">字典查無此字，可試試 AI 解釋。</p>}
          {entry?.translation && <Meaning text={entry.translation} />}
          {lemma && (
            <div className="lemma">
              <div className="lemma-head">
                原形 <b>{lemma.word}</b>
                {lemma.phonetic && <span className="card-phonetic">/{lemma.phonetic}/</span>}
              </div>
              {lemma.translation && <Meaning text={lemma.translation} />}
            </div>
          )}
          {online && online.senses.length > 0 && (
            <ol className="senses">
              {online.senses.map((s, i) => (
                <li key={i}>
                  <i>{s.pos}</i> {s.definition}
                  {s.example && <div className="example">“{s.example}”</div>}
                </li>
              ))}
            </ol>
          )}
          {cue && (
            <div className="context">
              <div className="label">原句</div>
              <div>{cue.text}</div>
              {typeof zh[card.cueIdx] === 'string' && <div className="muted">{zh[card.cueIdx]}</div>}
            </div>
          )}
          {ai && <div className="ai">{ai}</div>}
        </div>

        {msg && <p className="card-msg">{msg}</p>}
        <div className="card-foot">
          <button onClick={explain} disabled={aiBusy || !cue}>
            {aiBusy ? 'AI 解釋中…' : '🤖 AI 句中解釋'}
          </button>
          <div className="status-btns">
            <button
              className={status === 'known' ? 'st on known' : 'st'}
              title="我已經會這個字（字幕不再標示）"
              onClick={() => toggleStatus('known')}
            >
              ✓ 已知
            </button>
            <button
              className={status === 'learning' ? 'st on learning' : 'st'}
              title="收藏並加入複習"
              onClick={save}
              disabled={status === 'learning'}
            >
              📖 學習中
            </button>
            <button
              className={status === 'ignore' ? 'st on ignore' : 'st'}
              title="不打算學（專有名詞、太冷門）"
              onClick={() => toggleStatus('ignore')}
            >
              ⊘ 不要學
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Meaning({ text }: { text: string }) {
  return (
    <ul className="meaning">
      {text
        .split('\n')
        .filter(Boolean)
        .map((l, i) => (
          <li key={i}>{l}</li>
        ))}
    </ul>
  )
}
