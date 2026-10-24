import { useEffect, useMemo, useState } from 'react'
import { api, errorText } from '../../shared/api'
import { speakSentence } from '../../shared/speak'
import { normWord, tokenize } from '../../shared/tokenize'
import type { Example } from '../../shared/types'
import { loadExtraWords, playCueOnce } from '../controller'
import { cuesOf, store, useStore, type CardTarget } from '../store'
import { WordText } from './WordText'

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// 點例句裡的字：換成那個字的單字卡，記下目前這張以便「← 返回」
function openWord(target: CardTarget): void {
  store.set((s) => ({ cardHistory: s.card ? [...s.cardHistory, s.card] : s.cardHistory, card: target }))
}

// 單字卡的例句區：本片 / 例句庫（Tatoeba）/ AI 例句。每句可發音，字依分級上色、可點。
export function Examples({ lemma, excludeCue }: { lemma: string; excludeCue: number }) {
  const cues = useStore(cuesOf)
  const words = useStore((s) => s.words)
  const zh = useStore((s) => s.zh)
  const model = useStore((s) => s.prefs.model)
  const knownMax = useStore((s) => s.prefs.knownMax)
  const [slow, setSlow] = useState(false)
  const [lib, setLib] = useState<Example[] | null>(null)
  const [ai, setAi] = useState<Example[] | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiErr, setAiErr] = useState<string | null>(null)
  const rate = slow ? 0.75 : 1 // 乘在設定語速上的倍率

  // 本片其他含這個字（同原形）的句子
  const videoIdx = useMemo(() => {
    const out: number[] = []
    cues.forEach((c, i) => {
      if (i === excludeCue || out.length >= 5) return
      const hit = tokenize(c.text).some((t) => t.word && (words.get(normWord(t.word))?.lemma ?? normWord(t.word)) === lemma)
      if (hit) out.push(i)
    })
    return out
  }, [cues, words, lemma, excludeCue])

  useEffect(() => {
    let alive = true
    setLib(null)
    setAi(null)
    setAiErr(null)
    api
      .examplesFor(lemma, 3)
      .then((r) => {
        if (!alive) return
        setLib(r)
        void loadExtraWords(r.map((e) => e.en))
      })
      .catch(() => alive && setLib([]))
    return () => {
      alive = false
    }
  }, [lemma])

  async function genAi(refresh = false) {
    setAiBusy(true)
    setAiErr(null)
    try {
      const r = await api.aiExamples(lemma, knownMax, model, refresh)
      setAi(r)
      void loadExtraWords(r.map((e) => e.en))
    } catch (e) {
      setAiErr(errorText(e))
    }
    setAiBusy(false)
  }

  const empty = videoIdx.length === 0 && lib?.length === 0 && !ai

  return (
    <div className="examples">
      <div className="ex-head">
        <span className="label">例句</span>
        <label className="ex-slow" title="例句朗讀放慢">
          <input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} /> 慢速
        </label>
      </div>

      {videoIdx.length > 0 && (
        <ExGroup title={`本片（${videoIdx.length}）`}>
          {videoIdx.map((i) => (
            <ExRow
              key={i}
              en={cues[i].text}
              zh={typeof zh[i] === 'string' ? (zh[i] as string) : null}
              lemma={lemma}
              rate={rate}
              meta={fmt(cues[i].start)}
              onPlay={() => playCueOnce(i)}
              onPick={(word) => openWord({ word, cueIdx: i })}
            />
          ))}
        </ExGroup>
      )}

      {lib && lib.length > 0 && (
        <ExGroup title="例句庫">
          {lib.map((e, k) => (
            <ExRow key={k} en={e.en} zh={e.zh} lemma={lemma} rate={rate} onPick={(word) => openWord({ word, cueIdx: excludeCue, context: e })} />
          ))}
        </ExGroup>
      )}

      {ai && (
        <ExGroup title="AI 例句">
          {ai.map((e, k) => (
            <ExRow key={k} en={e.en} zh={e.zh} lemma={lemma} rate={rate} onPick={(word) => openWord({ word, cueIdx: excludeCue, context: e })} />
          ))}
        </ExGroup>
      )}

      {empty && <p className="muted small">本片與例句庫都沒有這個字的例句，可以請 AI 產生。</p>}
      <div className="ex-ai">
        <button onClick={() => genAi(!!ai)} disabled={aiBusy}>
          {aiBusy ? 'AI 產生中…' : ai ? '🤖 換一組 AI 例句' : '🤖 AI 例句'}
        </button>
        {aiErr && <span className="error small">{aiErr}</span>}
      </div>
    </div>
  )
}

function ExGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ex-group">
      <div className="ex-title">{title}</div>
      {children}
    </div>
  )
}

function ExRow(props: {
  en: string
  zh: string | null
  lemma: string
  rate: number
  meta?: string
  onPlay?: () => void
  onPick: (word: string) => void
}) {
  const [speakingAt, setSpeakingAt] = useState(-1)
  return (
    <div className="ex-row">
      <div className="ex-btns">
        <button className="icon" title="朗讀這句" onClick={() => speakSentence(props.en, props.rate, setSpeakingAt)}>
          🔊
        </button>
        {props.onPlay && (
          <button className="icon" title="播放影片中的這一句" onClick={props.onPlay}>
            ▶
          </button>
        )}
      </div>
      <div className="ex-text">
        <WordText text={props.en} target={props.lemma} speakingAt={speakingAt} onPick={props.onPick} />
        {props.zh && <div className="muted">{props.zh}</div>}
      </div>
      {props.meta && <span className="ex-meta">{props.meta}</span>}
    </div>
  )
}
