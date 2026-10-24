// 設定 → 發音 → Kokoro：說明、下載（顯示下載位置）、選聲音（內建試聽樣本，不用下載也能聽）、刪除
import { useEffect, useRef, useState } from 'react'
import { api, errorText } from '../shared/api'
import { KOKORO_VOICES, resetKokoro, speakSentence } from '../shared/speak'
import { listen } from '../shared/tauri'
import type { TtsStatus } from '../shared/types'

interface Progress {
  file: string
  received: number
  total: number
  stage: 'download' | 'done'
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(0)

export function KokoroSetup({
  engine,
  voice,
  accent,
  update,
}: {
  engine: string
  voice: string
  accent: string
  update: (patch: Record<string, unknown>) => Promise<void>
}) {
  const [status, setStatus] = useState<TtsStatus | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const sample = useRef<HTMLAudioElement | null>(null)

  const load = () => api.ttsStatus().then(setStatus).catch((e) => setMsg(errorText(e)))
  useEffect(() => {
    void load()
    const off = listen<Progress>('tts-progress', setProgress)
    return () => {
      void off.then((f) => f())
      sample.current?.pause()
    }
  }, [])

  const chosen = voice || (accent === 'uk' ? 'bf_emma' : 'af_heart')

  // 內建的試聽樣本（App 裡就有，不用下載）
  function play(id: string) {
    sample.current?.pause()
    if (playing === id) return setPlaying(null)
    const a = new Audio(`./voice-samples/${id}.ogg`)
    a.onended = () => setPlaying(null)
    sample.current = a
    setPlaying(id)
    void a.play().catch(() => setPlaying(null))
  }

  async function download() {
    setBusy(true)
    setMsg(null)
    try {
      const dir = await api.ttsDownload()
      resetKokoro()
      await update({ engine: 'kokoro' })
      setMsg(`下載完成，已改用 Kokoro。檔案在：${dir}`)
    } catch (e) {
      setMsg(errorText(e))
    }
    setBusy(false)
    setProgress(null)
    void load()
  }

  async function remove() {
    if (!confirm('刪除 Kokoro 語音（含念過的句子快取）？之後改用系統語音，要用時可以再下載。')) return
    try {
      await api.ttsRemove()
      await update({ engine: 'system' })
      setMsg('已刪除，改用系統語音。')
    } catch (e) {
      setMsg(errorText(e))
    }
    void load()
  }

  if (status && !status.supported) {
    return (
      <div className="kokoro">
        <p className="muted small">這個平台的版本不支援 Kokoro（ONNX Runtime 沒有 Intel Mac 版），請改用系統語音。</p>
      </div>
    )
  }

  const pct = progress?.total ? Math.min(100, (progress.received / progress.total) * 100) : 0
  const installed = !!status?.installed

  return (
    <div className="kokoro">
      <p className="muted small">
        Kokoro 是開源的英文語音模型（Apache-2.0），在你的電腦上產生自然的英文語音，不用網路、不用帳號。
        要用的話需要下載約 {status ? mb(status.totalSize) : 173} MB（模型 156 MB、發音詞典 12 MB、10 種聲音 5 MB）；
        不想用就把引擎改回「系統語音」，不會下載任何東西。
      </p>

      <div className="kokoro-status">
        {installed ? (
          <>
            <b>✓ 已下載</b>{' '}
            <span className="muted small">占用 {status && mb(status.diskSize)} MB（含念過的句子快取，上限 200 MB）</span>
          </>
        ) : (
          <b>尚未下載（目前用系統語音念）</b>
        )}
        <div className="small">
          下載位置：<code className="path">{status?.dir ?? '…'}</code>
        </div>
      </div>

      {progress && busy && (
        <div className="dl">
          <div className="dl-bar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <span className="muted small">
            下載中 {mb(progress.received)} / {mb(progress.total)} MB{progress.file && `（${progress.file}）`}
          </span>
        </div>
      )}
      {msg && <p className="msg">{msg}</p>}

      <div className="row-btns left">
        {!installed && (
          <button className="primary" onClick={download} disabled={busy}>
            {busy ? '下載中…' : `⬇ 下載 Kokoro 語音（約 ${status ? mb(status.downloadSize || status.totalSize) : 173} MB）`}
          </button>
        )}
        {installed && engine !== 'kokoro' && <button onClick={() => update({ engine: 'kokoro' })}>改用 Kokoro</button>}
        {installed && (
          <button onClick={() => speakSentence('Practice makes perfect, so keep listening every day.')}>
            🔊 用選的聲音念一句
          </button>
        )}
        {installed && (
          <button className="danger-btn" onClick={remove}>
            刪除 Kokoro
          </button>
        )}
      </div>

      <div className="small muted kokoro-label">聲音（▶ 是 App 內建的試聽片段，不用下載也能聽）</div>
      <div className="kokoro-voices">
        {KOKORO_VOICES.map((v) => (
          <label key={v.id} className={chosen === v.id ? 'kvoice on' : 'kvoice'}>
            <input type="radio" name="kvoice" checked={chosen === v.id} onChange={() => update({ kokoroVoice: v.id })} />
            <button
              type="button"
              className="icon"
              title="試聽"
              onClick={(e) => {
                e.preventDefault()
                play(v.id)
              }}
            >
              {playing === v.id ? '⏹' : '▶'}
            </button>
            <span>
              <b>{v.name}</b> <span className="muted small">{v.desc}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
