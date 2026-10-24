import { useEffect, useState } from 'react'
import { api, errorText } from '../../shared/api'
import { speakSentence, speakWord } from '../../shared/speak'
import { lemmaCandidates } from '../../shared/tokenize'
import { Examples } from './Examples'
import { WordText } from './WordText'
import type { DictEntry, LookupResult, OnlineInfo } from '../../shared/types'
import { fmtRank, LEVEL_LABEL, levelOf, rankBar } from '../../shared/levels'
import { cheerPet, infoOf, markLearning, refreshSaved, setWordStatus } from '../controller'
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

const close = () => store.set({ card: null, cardHistory: [] })
const back = () =>
  store.set((s) => ({ card: s.cardHistory[s.cardHistory.length - 1] ?? null, cardHistory: s.cardHistory.slice(0, -1) }))

export function WordCard() {
  const card = useStore((s) => s.card)
  const history = useStore((s) => s.cardHistory)
  const [ctxSpeaking, setCtxSpeaking] = useState(-1)
  const captions = useStore((s) => s.captions)
  const zh = useStore((s) => s.zh)
  const model = useStore((s) => s.prefs.model)
  const savedSet = useStore((s) => s.saved)
  useStore((s) => s.words) // 狀態改變時重繪
  const knownMax = useStore((s) => s.prefs.knownMax)
  const suggestMax = useStore((s) => s.prefs.suggestMax)
  const dictMissing = useStore((s) => s.dictMissing)
  const [dict, setDict] = useState<LookupResult | null>(null)
  const [online, setOnline] = useState<OnlineInfo | null>(null)
  const [onlineWord, setOnlineWord] = useState<string | null>(null) // online 查的是哪個字（點 running 查的是原形 run）
  const [ai, setAi] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!card) return
    let alive = true
    setDict(null)
    setOnline(null)
    setOnlineWord(null)
    setAi(null)
    setMsg(null)
    const online = (word: string) =>
      api.dictOnline(word).then((o) => {
        if (!alive) return
        setOnline(o)
        setOnlineWord(word.toLowerCase())
      })
    // 沒有離線字典就不知道原形 → 線上字典依序試可能的原形（rhythms → rhythm）
    const onlineGuess = async (word: string) => {
      for (const w of lemmaCandidates(word)) {
        const o = await api.dictOnline(w).catch(() => null)
        if (!alive) return
        if (o && (o.senses.length || o.audioUrl)) {
          setOnlineWord(w.toLowerCase())
          return setOnline(o)
        }
      }
      setOnline(null)
    setOnlineWord(null)
    }
    api
      .dictLookup(card.word)
      .then((r) => {
        if (!alive) return
        setDict(r)
        return online(r.lemma?.word ?? r.entry?.word ?? card.word)
      })
      .catch((e) => {
        if (!alive) return
        // 沒有離線字典：仍查線上英英釋義與發音（卡片上另有「下載字典」提示）
        if (String(e).includes('no-dict')) return onlineGuess(card.word)
        setMsg(errorText(e))
      })
    return () => {
      alive = false
    }
  }, [card?.word, card?.cueIdx, card?.context?.en])

  if (!card) return null
  const cues = cuesOf(store.get())
  const cue = cues[card.cueIdx]
  // 原句：從例句點過來的字用例句，否則用字幕那一句
  const ctxEn = card.context?.en ?? cue?.text ?? null
  const ctxZh = card.context ? card.context.zh : typeof zh[card.cueIdx] === 'string' ? (zh[card.cueIdx] as string) : null
  const entry = dict?.entry ?? null
  const lemma = dict?.lemma ?? null
  const head = lemma ?? entry // 收藏時用原形
  const headWord = (head?.word ?? card.word).toLowerCase()
  const isSaved = savedSet.has(headWord)
  const shownWord = entry?.word ?? card.word
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
        context: ctxEn,
        contextZh: ctxZh,
        // 例句裡的字沒有影片出處
        videoId: !card!.context && captions.status === 'ready' ? captions.videoId : null,
        videoTitle: card!.context ? null : getVideoTitle(),
        t: card!.context ? null : cue?.start ?? null,
        // 收藏的是原形：線上字典查的正好是原形才存它的錄音
        audioUrls: onlineWord === headWord ? online?.audioUrls ?? [] : [],
      })
      await refreshSaved()
      // 原本標成已知 / 不要學的字改為學習中
      if (status === 'known' || status === 'ignore') await setWordStatus(lemmaKey, null)
      markLearning(lemmaKey)
      cheerPet()
      setMsg(`已收藏「${headWord}」，會出現在複習中`)
    } catch (e) {
      setMsg(errorText(e))
    }
  }

  async function explain() {
    if (!ctxEn) return
    setAiBusy(true)
    try {
      setAi(await api.aiExplain(card!.word, ctxEn, model))
    } catch (e) {
      setAi(errorText(e))
    }
    setAiBusy(false)
  }

  return (
    <div className="card-backdrop" onClick={close}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div>
            {history.length > 0 && (
              <button className="icon back" title={`返回「${history[history.length - 1].word}」`} onClick={back}>
                ←
              </button>
            )}
            <span className="card-word">{entry?.word ?? card.word}</span>
            {phonetic && <span className="card-phonetic">/{phonetic}/</span>}
          </div>
          <div className="card-actions">
            <button className="icon" title="發音" onClick={() => void speakWord(shownWord, onlineWord === shownWord.toLowerCase() ? online?.audioUrls : null)}>
              🔊
            </button>
            <button className="icon" title="關閉（Esc）" onClick={close}>
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

        {info && !dictMissing && (
          <div className="rank">
            <div className="rank-bar" title="越長越常用">
              <span style={{ width: `${rankBar(info.rank) * 100}%` }} />
            </div>
            <span className="rank-text">{info.rank ? `第 ${fmtRank(info.rank)} 常用` : '無排名'}</span>
            {level && <span className={'level-pill ' + level}>{LEVEL_LABEL[level]}</span>}
          </div>
        )}

        <div className="card-body">
          {!dict && !msg && !dictMissing && <p className="muted">查詢中…</p>}
          {dict && !entry && <p className="muted">字典查無此字，可試試 AI 解釋。</p>}
          {dictMissing && (
            <div className="no-dict">
              尚未安裝離線字典：沒有中文釋義、詞頻與例句庫（英英釋義、發音、AI 解釋仍可用）。
              <button onClick={() => api.openHub('dict')}>下載字典</button>
            </div>
          )}
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
                  {s.example && (
                    <div className="example">
                      <button className="icon tiny" title="朗讀例句" onClick={() => speakSentence(s.example!)}>
                        🔊
                      </button>
                      “{s.example}”
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {ctxEn && (
            <div className="context">
              <div className="label">
                {card.context ? '例句' : '原句'}
                <button className="icon tiny" title="朗讀" onClick={() => speakSentence(ctxEn, 1, setCtxSpeaking)}>
                  🔊
                </button>
              </div>
              <WordText
                text={ctxEn}
                picked={card.word}
                speakingAt={ctxSpeaking}
                onPick={(word) =>
                  word !== card.word &&
                  store.set((s) => ({ cardHistory: [...s.cardHistory, card], card: { ...card, word } }))
                }
              />
              {ctxZh && <div className="muted">{ctxZh}</div>}
            </div>
          )}
          {ai && <div className="ai">{ai}</div>}
          {/* 沒有字典時例句庫是空的，本片例句與 AI 例句照常 */}
          <Examples lemma={lemmaKey} excludeCue={card.context ? -1 : card.cueIdx} />
        </div>

        {msg && <p className="card-msg">{msg}</p>}
        <div className="card-foot">
          <button onClick={explain} disabled={aiBusy || !ctxEn}>
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
