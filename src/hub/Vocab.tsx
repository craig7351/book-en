import { useEffect, useState } from 'react'
import { api, errorText } from '../shared/api'
import { speakItem } from '../shared/speak'
import type { Item, ItemKind } from '../shared/types'

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function dueText(item: Item): string {
  const diff = item.dueAt - Date.now()
  if (diff <= 0) return '待複習'
  const days = Math.round(diff / 86_400_000)
  if (days >= 1) return `${days} 天後複習`
  const hours = Math.round(diff / 3_600_000)
  return hours >= 1 ? `${hours} 小時後複習` : `${Math.max(1, Math.round(diff / 60_000))} 分鐘後複習`
}

export function SourceLink({ item }: { item: Item }) {
  if (!item.videoId) return null
  return (
    <button className="link" title="在主視窗播放這段" onClick={() => api.playSource(item.videoId!, Math.max(0, (item.t ?? 0) - 0.5))}>
      ▶ {item.videoTitle || item.videoId} · {fmtTime(item.t ?? 0)}
    </button>
  )
}

export function Vocab({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | ItemKind>('all')
  const [msg, setMsg] = useState<string | null>(null)

  const load = () => api.itemList(query).then(setItems).catch((e) => setMsg(errorText(e)))
  useEffect(() => {
    void load()
  }, [query])
  useEffect(() => {
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [query])

  async function remove(item: Item) {
    if (!confirm(`刪除「${item.text}」？複習紀錄也會一併刪除。`)) return
    await api.itemDelete(item.id)
    await load()
    onChanged()
  }

  async function exportAs(format: 'csv' | 'anki') {
    try {
      setMsg(`已匯出到 ${await api.exportItems(format)}`)
    } catch (e) {
      setMsg(errorText(e))
    }
  }

  const shown = items.filter((i) => kind === 'all' || i.kind === kind)

  return (
    <section>
      <div className="toolbar">
        <input placeholder="搜尋單字、中文、原句…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="all">全部</option>
          <option value="word">單字</option>
          <option value="sentence">句子</option>
        </select>
        <button onClick={() => exportAs('csv')} disabled={!items.length}>
          匯出 CSV
        </button>
        <button onClick={() => exportAs('anki')} disabled={!items.length}>
          匯出 Anki
        </button>
      </div>
      {msg && <p className="msg">{msg}</p>}
      {shown.length === 0 && (
        <p className="empty">
          {items.length ? '沒有符合的項目。' : '還沒有收藏。看影片時點字幕裡的單字 → ⭐ 收藏，或點句子旁的 ☆ 收藏整句。'}
        </p>
      )}
      <div className="grid">
        {shown.map((item) => (
          <article key={item.id} className={'item ' + item.kind}>
            <div className="item-head">
              <span className="item-text" onClick={() => speakItem(item)} title="發音">
                {item.text}
              </span>
              {item.phonetic && <span className="phonetic">/{item.phonetic}/</span>}
            </div>
            {item.kind === 'word' && item.meaningZh && <div className="meaning">{item.meaningZh}</div>}
            {item.context && item.kind === 'word' && (
              <div className="ctx">
                <div>{item.context}</div>
                {item.contextZh && <div className="muted">{item.contextZh}</div>}
              </div>
            )}
            {item.kind === 'sentence' && item.contextZh && <div className="muted">{item.contextZh}</div>}
            <SourceLink item={item} />
            <div className="item-foot">
              <span className="muted">
                {item.reps > 0 ? `已複習 ${item.reps} 次 · ` : ''}
                {dueText(item)}
              </span>
              <button className="link danger" onClick={() => remove(item)}>
                刪除
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
