import { useEffect, useState } from 'react'
import { api, errorText } from '../shared/api'
import { listen } from '../shared/tauri'
import type { DictStatus } from '../shared/types'

interface Progress {
  stage: 'download' | 'verify' | 'extract' | 'done'
  received: number
  total: number
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1)

const WORKS = [
  '看影片、英文字幕、雙語字幕層',
  '逐句精聽：上一句 / 重播 / 下一句、每句暫停、單句循環、盲聽、變速',
  '中文字幕：YouTube 中文字幕、Google 自動翻譯、AI 翻譯與存檔',
  '單字卡的英英釋義、發音（線上）、AI 句中解釋、AI 例句、本片例句',
  '收藏、單字庫、複習、匯出、書籤、網址列',
]

const MISSING = [
  '單字卡的中文釋義、音標、考試標籤、柯林斯星等',
  '原形還原（點 running 不會顯示 run，收藏會存成字面的形式）',
  '單字分級：字幕不標示「建議學習 / 罕見」、單字卡沒有詞頻排名',
  '學習中心「詞彙」頁、面板「詞語」分頁的分級',
  '例句庫（離線中英對照例句）',
  '複習的「看中文選英文」題型（沒有中文意思時會改出其他題型）',
]

// 學習中心「離線字典」：狀態、從 GitHub Release 下載、或不下載繼續使用
export function DictSetup({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<DictStatus | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = () => api.dictStatus().then(setStatus).catch((e) => setMsg(errorText(e)))
  useEffect(() => {
    void load()
    const off = listen<Progress>('dict-progress', setProgress)
    return () => {
      void off.then((f) => f())
    }
  }, [])

  async function download() {
    setBusy(true)
    setMsg(null)
    setProgress({ stage: 'download', received: 0, total: status?.downloadSize ?? 0 })
    try {
      const path = await api.dictDownload()
      await api.setSetting('dictPrompt', 'ask')
      setMsg(`安裝完成：${path}。YouTube 頁已重新載入，查字與分級已可使用。`)
      await load()
    } catch (e) {
      setMsg(errorText(e))
      setProgress(null)
    }
    setBusy(false)
  }

  async function skip() {
    await api.setSetting('dictPrompt', 'skip').catch(() => {})
    onDone()
  }

  const stageText = (p: Progress) =>
    p.stage === 'download'
      ? `下載中… ${mb(p.received)} / ${p.total ? mb(p.total) : '?'} MB`
      : p.stage === 'verify'
        ? '檢查檔案…'
        : p.stage === 'extract'
          ? '解壓縮中…'
          : '完成'
  const pct = progress ? (progress.stage === 'download' && progress.total ? (progress.received / progress.total) * 90 : progress.stage === 'done' ? 100 : 95) : 0

  return (
    <section className="dict-setup">
      <h2>離線字典</h2>
      {!status ? (
        <p className="muted">檢查中…</p>
      ) : status.installed ? (
        <div className="dict-ok">
          <b>✓ 已安裝</b>
          <div className="muted small">{status.path}</div>
          <div className="muted small">
            詞頻分級 {status.hasFreq ? '✓' : '✗（舊版字典）'} · 例句庫 {status.hasExamples ? '✓' : '✗（舊版字典，可重新下載）'}
          </div>
        </div>
      ) : (
        <div className="dict-missing">
          <p>
            找不到離線字典（<code>ecdict.db</code>）。安裝版會內建；如果是直接執行 exe 或檔案遺失，可以從 GitHub 下載
            {status.downloadSize ? `（約 ${mb(status.downloadSize)} MB，解壓後約 50 MB）` : ''}。
          </p>
        </div>
      )}

      {progress && (
        <div className="dl">
          <div className="dl-bar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <span className="muted small">{stageText(progress)}</span>
        </div>
      )}
      {msg && <p className="msg">{msg}</p>}

      <div className="row-btns left">
        <button className="primary" onClick={download} disabled={busy}>
          {busy ? '下載中…' : status?.installed ? '重新下載字典' : '⬇ 從 GitHub 下載字典'}
        </button>
        {!status?.installed && (
          <button onClick={skip} disabled={busy}>
            不下載，繼續使用
          </button>
        )}
      </div>
      {status && <p className="muted small">下載位置：{status.downloadUrl}</p>}

      <div className="features">
        <div>
          <h3>沒有字典時仍可使用</h3>
          <ul className="ok-list">
            {WORKS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3>沒有字典時無法使用</h3>
          <ul className="no-list">
            {MISSING.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="muted small">選「不下載」之後，隨時可以在「設定 → 一般 → 離線字典」回到這裡下載。</p>
    </section>
  )
}
