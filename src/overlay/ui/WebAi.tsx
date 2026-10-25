// 網頁 AI 翻譯：① 複製題目（分段）到免費的 ChatGPT 等網頁 → ② 把回覆貼回來（或上傳檔案）→ ③ 缺的句子再補
import { useEffect, useRef, useState } from 'react'
import { api, errorText } from '../../shared/api'
import { store, useStore } from '../store'
import { applyWebReply, webLines } from '../translator'
import { AI_SITES, buildPrompt, chunks, DEFAULT_CHUNK, type Line } from '../../shared/webai'
import { getVideoTitle } from '../youtube'

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 剪貼簿 API 被擋時的退路
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

// 收合狀態：這次開著 app 期間記住（換影片也沿用）
let openPref: boolean | null = null

export function WebAi() {
  const zh = useStore((s) => s.zh)
  // 還沒翻任何一句時預設展開，已經有翻譯就預設收合
  const [open, setOpenState] = useState(() => openPref ?? !store.get().zh.some((z) => typeof z === 'string'))
  const setOpen = (v: boolean) => {
    openPref = v
    setOpenState(v)
  }
  const [size, setSize] = useState(store.get().prefs.webAiChunk || DEFAULT_CHUNK)
  const [copied, setCopied] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const file = useRef<HTMLInputElement>(null)

  // 每段句數在學習中心設定，可能剛改過 → 打開時重讀
  useEffect(() => {
    api
      .getSetting('prefs')
      .then((raw) => {
        const n = raw ? Number(JSON.parse(raw).webAiChunk) : 0
        if (n > 0) setSize(n)
      })
      .catch(() => {})
  }, [])

  const lines = webLines()
  const done = zh.filter((z) => typeof z === 'string').length
  const missing = lines.filter((_, i) => typeof zh[i] !== 'string')
  const parts = chunks(lines.length, size)

  const prompt = (ls: Line[]) => buildPrompt(getVideoTitle(), ls)

  async function copy(key: string, ls: Line[]) {
    await copyText(prompt(ls))
    setCopied(key)
    setMsg({ text: `已複製 ${ls.length} 句的題目，貼到 AI 網頁送出，再把回覆整段複製回來貼在下面。` })
  }

  async function download() {
    const s = store.get()
    if (s.captions.status !== 'ready') return
    try {
      let path = ''
      for (const [k, [a, b]] of parts.entries()) path = await api.saveWebAiPrompt(s.captions.videoId, k + 1, prompt(lines.slice(a, b)))
      setMsg({ text: `已存 ${parts.length} 個檔案到下載資料夾（${path.replace(/[\\/][^\\/]*$/, '')}），可以當附件傳給 AI。` })
    } catch (e) {
      setMsg({ text: errorText(e), error: true })
    }
  }

  async function apply(text: string) {
    if (!text.trim()) return
    const before = done
    try {
      const { matched } = await applyWebReply(text)
      if (!matched) {
        setMsg({ text: '沒有讀到翻譯。請確認貼的是 AI 的回覆，每行像「12| 中文」這樣開頭。', error: true })
        return
      }
      setReply('')
      const now = store.get().zh.filter((z) => typeof z === 'string').length
      setMsg({ text: `讀到 ${matched} 句（新增 ${now - before} 句），已存檔。` })
    } catch (e) {
      setMsg({ text: errorText(e), error: true })
    }
  }

  async function upload(f: File | undefined) {
    if (f) await apply(await f.text())
    if (file.current) file.current.value = ''
  }

  const progress = missing.length ? `已翻 ${done} / ${lines.length} 句` : `✓ 全部 ${lines.length} 句都翻好了`
  const head = (
    <button className="webai-head" onClick={() => setOpen(!open)} title={open ? '收合' : '展開'}>
      <span className="caret">{open ? '▾' : '▸'}</span>
      <b>網頁 AI 翻譯</b>
      <span className={missing.length ? 'muted' : 'ok'}>{progress}</span>
      <span className="muted grow">{open ? '收合' : '展開'}</span>
    </button>
  )
  if (!open) return <div className="webai folded">{head}</div>

  return (
    <div className="webai">
      {head}
      <div className="webai-step">
        <b>① 複製題目</b>
        <span className="muted">每段 {size} 句（學習中心 → 設定可調）</span>
      </div>
      <div className="webai-btns">
        {parts.map(([a, b], k) => (
          <button key={k} className={copied === `p${k}` ? 'on' : ''} onClick={() => copy(`p${k}`, lines.slice(a, b))}>
            {copied === `p${k}` ? '✓ ' : '📋 '}
            {parts.length > 1 ? `第 ${k + 1} 段（${a + 1}–${b}）` : `複製題目（${b} 句）`}
          </button>
        ))}
        <button onClick={download} title="存成文字檔，給想用附件上傳的 AI">
          ⬇ 下載題目檔
        </button>
      </div>
      <div className="webai-btns">
        <span className="muted">開啟</span>
        {AI_SITES.map((s) => (
          <button key={s.name} className="link" onClick={() => api.openAiSite(s.url).catch((e) => setMsg({ text: errorText(e), error: true }))}>
            {s.name}
          </button>
        ))}
      </div>

      <div className="webai-step">
        <b>② 貼上 AI 的回覆</b>
        <span className="muted">可以分好幾次貼</span>
      </div>
      <textarea
        rows={3}
        value={reply}
        placeholder="把 AI 的回覆整段貼在這裡"
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()} // 別讓 YouTube 的快捷鍵吃掉
      />
      <div className="webai-btns">
        <button className="primary" disabled={!reply.trim()} onClick={() => apply(reply)}>
          套用
        </button>
        <button onClick={() => file.current?.click()} title="AI 給的文字檔，或 .srt / .vtt 字幕檔">
          ⬆ 上傳翻譯檔
        </button>
        <input ref={file} type="file" accept=".txt,.srt,.vtt,text/plain" hidden onChange={(e) => upload(e.target.files?.[0])} />
      </div>

      <div className="webai-step">
        <b>③ 進度</b>
        <span className={missing.length ? 'muted' : 'ok'}>{progress}</span>
        {missing.length > 0 && done > 0 && (
          <button
            className={copied === 'miss' ? 'on' : ''}
            onClick={() => copy('miss', missing.slice(0, size))}
            title="AI 漏掉或沒對上的句子，再出一次題"
          >
            {copied === 'miss' ? '✓ ' : '📋 '}複製缺的 {Math.min(size, missing.length)} 句
            {missing.length > size ? `（共缺 ${missing.length}）` : ''}
          </button>
        )}
      </div>
      {msg && <div className={msg.error ? 'error small' : 'muted small'}>{msg.text}</div>}
    </div>
  )
}
