import { useEffect, useRef } from 'react'
import { api, errorText } from '../../shared/api'
import { MODELS } from '../../shared/types'
import { nextCue, prevCue, replayCue, refreshSaved, seekCue, setPrefs } from '../controller'
import type { Cue } from '../cues'
import { cuesOf, store, useStore, type CaptionState, type Prefs } from '../store'
import { selectZhSource, startTranslation } from '../translator'
import { getVideoTitle } from '../youtube'
import { Line } from './Line'
import { WordCard } from './WordCard'
import { WordsTab } from './WordsTab'

export const PANEL_W = 420

export function Panel() {
  const open = useStore((s) => s.open)
  const captions = useStore((s) => s.captions)
  const fullscreen = useStore((s) => s.fullscreen)
  const due = useStore((s) => s.due)
  const tab = useStore((s) => s.tab)

  useEffect(() => {
    document.documentElement.classList.toggle('be-open', open)
    window.dispatchEvent(new Event('resize')) // 讓 YouTube 播放器重算尺寸
  }, [open])

  if (!open || fullscreen) {
    return fullscreen ? null : (
      <button className="fab" title="打開 book-en 面板" onClick={() => store.set({ open: true })}>
        EN
      </button>
    )
  }

  return (
    <aside className="panel" style={{ width: PANEL_W }}>
      <header>
        <span className="brand">book-en</span>
        <span className="meta">{metaText(captions)}</span>
        <button className="hub-btn" title="單字庫、複習、設定" onClick={() => api.openHub(due ? 'review' : 'vocab')}>
          學習中心{due > 0 && <span className="badge">{due}</span>}
        </button>
        <button className="icon" title="收起面板" onClick={() => store.set({ open: false })}>
          ⟩
        </button>
      </header>
      {captions.status === 'ready' && <Controls />}
      {captions.status === 'ready' && <Tabs />}
      {captions.status === 'ready' && tab === 'words' ? <WordsTab /> : <Body state={captions} />}
      <WordCard />
    </aside>
  )
}

function Tabs() {
  const tab = useStore((s) => s.tab)
  return (
    <nav className="ptabs">
      <button className={tab === 'subs' ? 'ptab on' : 'ptab'} onClick={() => store.set({ tab: 'subs' })}>
        字幕
      </button>
      <button className={tab === 'words' ? 'ptab on' : 'ptab'} onClick={() => store.set({ tab: 'words' })}>
        詞語
      </button>
    </nav>
  )
}

function metaText(s: CaptionState): string {
  if (s.status !== 'ready') return ''
  const { cues, isAsr } = s.result
  return `${cues.length} 句 · ${isAsr ? '自動字幕' : '人工字幕'}`
}

function Toggle({ k, label, title }: { k: keyof Prefs; label: string; title: string }) {
  const on = useStore((s) => s.prefs[k]) as boolean
  return (
    <button className={on ? 'chip on' : 'chip'} title={title} onClick={() => setPrefs({ [k]: !on })}>
      {label}
    </button>
  )
}

function Controls() {
  const rate = useStore((s) => s.prefs.rate)
  const showZh = useStore((s) => s.prefs.showZh)

  return (
    <section className="controls">
      <div className="nav">
        <button onClick={prevCue} title="上一句（A）">
          ◀ 上一句 <kbd>A</kbd>
        </button>
        <button onClick={replayCue} title="重播這句（S）">
          ⟲ 重播 <kbd>S</kbd>
        </button>
        <button onClick={nextCue} title="下一句（D）">
          下一句 ▶ <kbd>D</kbd>
        </button>
      </div>
      <div className="chips">
        <Toggle k="autoPause" label="每句暫停" title="每句播完自動暫停，按 D 或空白鍵繼續" />
        <Toggle k="loop" label="單句循環" title="重複播放目前這一句" />
        <Toggle k="blur" label="盲聽" title="影片上的字幕模糊，滑鼠移過去才顯示" />
        <Toggle k="showZh" label="中文" title="顯示中文翻譯" />
        <Toggle k="layer" label="影片字幕" title="在影片上顯示 book-en 雙語字幕（取代 YouTube 字幕）" />
        <select value={rate} title="播放速度" onChange={(e) => setPrefs({ rate: Number(e.target.value) })}>
          {[0.5, 0.65, 0.75, 0.85, 1, 1.25, 1.5].map((r) => (
            <option key={r} value={r}>
              {r}x
            </option>
          ))}
        </select>
      </div>
      {showZh && <ZhControls />}
    </section>
  )
}

// 中文來源：YouTube 中文字幕 / Google 自動翻譯 / AI（按鈕才開始）
function ZhControls() {
  const captions = useStore((s) => s.captions)
  const zhSource = useStore((s) => s.zhSource)
  const zhStatus = useStore((s) => s.zhStatus)
  const model = useStore((s) => s.prefs.model)
  const translating = useStore((s) => s.translating)
  const transError = useStore((s) => s.transError)
  const aiMissing = useStore((s) => s.aiMissing)
  const zh = useStore((s) => s.zh)
  if (captions.status !== 'ready') return null
  const list = captions.result.zhSources
  const current = list.find((x) => x.id === zhSource)
  const done = zh.filter((z) => typeof z === 'string').length

  return (
    <div className="trans">
      <label className="muted">中文</label>
      <select
        value={zhSource ?? ''}
        title="中文翻譯的來源"
        onChange={(e) => {
          const next = list.find((x) => x.id === e.target.value)
          if (!next) return
          setPrefs({ zhKind: next.kind })
          void selectZhSource(next.id)
        }}
      >
        {list.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </select>
      {current?.kind === 'ai' && (
        <>
          <select value={model} title="翻譯用的 Claude 模型" onChange={(e) => setPrefs({ model: e.target.value })}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {translating ? (
            <span className="muted">
              AI 翻譯中… {done}/{zh.length}
            </span>
          ) : aiMissing > 0 ? (
            <button className="primary" onClick={() => void startTranslation()}>
              🤖 {done ? `繼續 AI 翻譯（剩 ${aiMissing} 句）` : `開始 AI 翻譯（${aiMissing} 句）`}
            </button>
          ) : (
            <span className="muted">AI 翻譯完成</span>
          )}
        </>
      )}
      {zhStatus && <div className="muted small">{zhStatus}</div>}
      {transError && <div className="error small">{transError}</div>}
    </div>
  )
}

function Body({ state }: { state: CaptionState }) {
  switch (state.status) {
    case 'idle':
      return <p className="empty">打開任一支 YouTube 影片，字幕會出現在這裡。</p>
    case 'loading':
      return <p className="empty">載入字幕中…</p>
    case 'error':
      return <p className="empty error">{state.message}</p>
    case 'ready':
      return <CueList />
  }
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

function CueList() {
  const cues = useStore(cuesOf)
  const active = useStore((s) => s.active)
  const zh = useStore((s) => s.zh)
  const showZh = useStore((s) => s.prefs.showZh)
  const savedSentences = useStore((s) => s.savedSentences)
  const listRef = useRef<HTMLOListElement>(null)
  const userScrollAt = useRef(0)

  // 自動捲動讓目前句保持在視野中；使用者剛手動捲過就先不搶
  useEffect(() => {
    if (active < 0 || Date.now() - userScrollAt.current < 4000) return
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [active])

  return (
    <ol className="cues" ref={listRef} onWheel={() => (userScrollAt.current = Date.now())}>
      {cues.map((c, i) => (
        <li key={i} className={i === active ? 'cue active' : 'cue'} onClick={() => seekCue(i)}>
          <span className="time">{fmt(c.start)}</span>
          <div className="cue-text">
            <Line text={c.text} cueIdx={i} />
            {showZh && typeof zh[i] === 'string' && <div className="zh">{zh[i]}</div>}
          </div>
          <SaveSentence cue={c} idx={i} saved={savedSentences.has(c.text)} />
        </li>
      ))}
    </ol>
  )
}

function SaveSentence({ cue, idx, saved }: { cue: Cue; idx: number; saved: boolean }) {
  async function save(e: React.MouseEvent) {
    e.stopPropagation()
    const s = store.get()
    try {
      await api.itemAdd({
        kind: 'sentence',
        text: cue.text,
        meaningZh: typeof s.zh[idx] === 'string' ? s.zh[idx] : null,
        context: cue.text,
        contextZh: typeof s.zh[idx] === 'string' ? s.zh[idx] : null,
        videoId: s.captions.status === 'ready' ? s.captions.videoId : null,
        videoTitle: getVideoTitle(),
        t: cue.start,
      })
      store.set((st) => ({ savedSentences: new Set(st.savedSentences).add(cue.text) }))
      void refreshSaved()
    } catch (err) {
      store.set({ transError: errorText(err) })
    }
  }
  return (
    <button className={saved ? 'star on' : 'star'} title={saved ? '已收藏這句' : '收藏這句'} onClick={save}>
      {saved ? '★' : '☆'}
    </button>
  )
}
