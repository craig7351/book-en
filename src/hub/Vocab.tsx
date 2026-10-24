import { useEffect, useMemo, useState } from 'react'
import { api, errorText } from '../shared/api'
import { speakItem, speakSentence } from '../shared/speak'
import type { Item, ItemKind } from '../shared/types'

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function dueText(item: Item): string {
  if (item.suspended) return '已暫停複習'
  if (isNew(item)) return '新字（還沒複習）'
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

// ---- 分類（和 Rust 端的規則一致：新字 = 還沒複習過）----

const MASTERED_DAYS = 21
const isNew = (i: Item) => i.reps === 0 && i.lapses === 0
const isDue = (i: Item) => !i.suspended && !isNew(i) && i.dueAt <= Date.now()

type Status = 'all' | 'due' | 'new' | 'learning' | 'hard' | 'mastered' | 'suspended'
const STATUS: { id: Status; label: string; test: (i: Item) => boolean; hint?: string }[] = [
  { id: 'all', label: '全部', test: () => true },
  { id: 'due', label: '待複習', test: isDue },
  { id: 'new', label: '新字', test: (i) => !i.suspended && isNew(i), hint: '收藏後還沒複習過' },
  { id: 'learning', label: '學習中', test: (i) => !i.suspended && !isNew(i) && i.intervalDays < MASTERED_DAYS },
  { id: 'hard', label: '常答錯', test: (i) => i.lapses >= 2, hint: '答錯 2 次以上' },
  { id: 'mastered', label: '已熟練', test: (i) => !i.suspended && i.intervalDays >= MASTERED_DAYS, hint: `複習間隔 ${MASTERED_DAYS} 天以上` },
  { id: 'suspended', label: '已暫停', test: (i) => i.suspended },
]

type Sort = 'newest' | 'oldest' | 'due' | 'lapses' | 'alpha'
const SORTS: { id: Sort; label: string; cmp: (a: Item, b: Item) => number }[] = [
  { id: 'newest', label: '最新收藏', cmp: (a, b) => b.createdAt - a.createdAt },
  { id: 'oldest', label: '最早收藏', cmp: (a, b) => a.createdAt - b.createdAt },
  { id: 'due', label: '最快到期', cmp: (a, b) => a.dueAt - b.dueAt },
  { id: 'lapses', label: '答錯最多', cmp: (a, b) => b.lapses - a.lapses || b.createdAt - a.createdAt },
  { id: 'alpha', label: '字母順序', cmp: (a, b) => a.text.localeCompare(b.text) },
]

const PAGE = 60

export function Vocab({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | ItemKind>('all')
  const [status, setStatus] = useState<Status>('all')
  const [video, setVideo] = useState('')
  const [sort, setSort] = useState<Sort>('newest')
  const [limit, setLimit] = useState(PAGE)
  const [selected, setSelected] = useState<Set<number>>(new Set())
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
  // 換篩選條件就回到第一頁
  useEffect(() => setLimit(PAGE), [query, kind, status, video, sort])

  const byKind = useMemo(() => items.filter((i) => kind === 'all' || i.kind === kind), [items, kind])
  const videos = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of byKind) if (i.videoId) m.set(i.videoTitle || i.videoId, (m.get(i.videoTitle || i.videoId) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [byKind])
  const filtered = useMemo(() => {
    const test = STATUS.find((s) => s.id === status)!.test
    const cmp = SORTS.find((s) => s.id === sort)!.cmp
    return byKind.filter((i) => test(i) && (!video || (i.videoTitle || i.videoId) === video)).sort(cmp)
  }, [byKind, status, video, sort])
  const shown = filtered.slice(0, limit)

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null)
    try {
      await fn()
      setMsg(ok)
    } catch (e) {
      setMsg(errorText(e))
    }
    setSelected(new Set())
    await load()
    onChanged()
  }

  const remove = (item: Item) =>
    confirm(`刪除「${item.text}」？複習紀錄也會一併刪除。`) && act(() => api.itemDelete(item.id), `已刪除「${item.text}」`)
  const suspend = (item: Item) =>
    act(() => api.itemSuspend([item.id], !item.suspended), item.suspended ? `「${item.text}」恢復複習` : `「${item.text}」暫停複習`)

  // ---- 批次 ----
  const picked = items.filter((i) => selected.has(i.id))
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const batchDelete = () =>
    confirm(`刪除選取的 ${picked.length} 個項目？複習紀錄也會一併刪除。`) &&
    act(() => api.itemDeleteMany(picked.map((i) => i.id)), `已刪除 ${picked.length} 個`)
  const batchSuspend = (on: boolean) =>
    act(() => api.itemSuspend(picked.map((i) => i.id), on), `${picked.length} 個${on ? '暫停' : '恢復'}複習`)
  function batchKnown() {
    const words = picked.filter((i) => i.kind === 'word')
    if (!words.length) return setMsg('選取的都是句子；「標成已知」只適用單字')
    if (!confirm(`把 ${words.length} 個單字標成「已知」？會移出單字庫（含複習紀錄），字幕不再標示這些字。`)) return
    void act(async () => {
      await api.setWordStatus(words.map((i) => i.text.toLowerCase()), 'known')
      await api.itemDeleteMany(words.map((i) => i.id))
    }, `${words.length} 個單字標成已知${words.length < picked.length ? '（句子不受影響）' : ''}`)
  }

  async function exportAs(format: 'csv' | 'anki') {
    try {
      setMsg(`已匯出到 ${await api.exportItems(format)}`)
    } catch (e) {
      setMsg(errorText(e))
    }
  }

  return (
    <section>
      <div className="toolbar">
        <input placeholder="搜尋單字、中文、原句…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="all">單字＋句子</option>
          <option value="word">單字</option>
          <option value="sentence">句子</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} title="排序">
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button onClick={() => exportAs('csv')} disabled={!items.length}>
          匯出 CSV
        </button>
        <button onClick={() => exportAs('anki')} disabled={!items.length}>
          匯出 Anki
        </button>
      </div>

      <div className="filters">
        {STATUS.map((s) => {
          const n = byKind.filter(s.test).length
          return (
            <button key={s.id} className={status === s.id ? 'chip on' : 'chip'} title={s.hint} onClick={() => setStatus(s.id)}>
              {s.label} <b>{n}</b>
            </button>
          )
        })}
        {videos.length > 0 && (
          <select className="video-filter" value={video} onChange={(e) => setVideo(e.target.value)} title="依影片篩選">
            <option value="">所有影片</option>
            {videos.map(([title, n]) => (
              <option key={title} value={title}>
                {title.length > 40 ? title.slice(0, 40) + '…' : title}（{n}）
              </option>
            ))}
          </select>
        )}
      </div>

      {selected.size > 0 && (
        <div className="batch">
          <b>已選 {selected.size} 個</b>
          <button onClick={() => setSelected(new Set(filtered.map((i) => i.id)))}>全選符合的 {filtered.length} 個</button>
          <button onClick={() => batchSuspend(true)}>暫停複習</button>
          <button onClick={() => batchSuspend(false)}>恢復複習</button>
          <button onClick={batchKnown}>標成已知</button>
          <button className="danger-btn" onClick={batchDelete}>
            刪除
          </button>
          <button className="link" onClick={() => setSelected(new Set())}>
            取消選取
          </button>
        </div>
      )}

      {msg && <p className="msg">{msg}</p>}
      {filtered.length === 0 && (
        <p className="empty">
          {items.length ? '沒有符合的項目。' : '還沒有收藏。看影片時點字幕裡的單字 → ⭐ 收藏，或點句子旁的 ☆ 收藏整句。'}
        </p>
      )}
      <div className="grid">
        {shown.map((item) => (
          <article
            key={item.id}
            className={'item ' + item.kind + (item.suspended ? ' suspended' : '') + (selected.has(item.id) ? ' picked' : '')}
          >
            <input
              type="checkbox"
              className="pick"
              title="選取（批次操作）"
              checked={selected.has(item.id)}
              onChange={() => toggle(item.id)}
            />
            <div className="item-head">
              <button className="say" title={item.kind === 'word' ? '念這個字' : '念這句'} onClick={() => speakItem(item)}>
                🔊
              </button>
              <span className="item-text" onClick={() => speakItem(item)} title="發音">
                {item.text}
              </span>
              {item.phonetic && <span className="phonetic">/{item.phonetic}/</span>}
            </div>
            {item.kind === 'word' && item.meaningZh && <div className="meaning">{item.meaningZh}</div>}
            {item.context && item.kind === 'word' && (
              <div className="ctx">
                <div>
                  <button className="say small" title="念原句" onClick={() => speakSentence(item.context!)}>
                    🔊
                  </button>
                  {item.context}
                </div>
                {item.contextZh && <div className="muted">{item.contextZh}</div>}
              </div>
            )}
            {item.kind === 'sentence' && item.contextZh && <div className="muted">{item.contextZh}</div>}
            <SourceLink item={item} />
            <div className="item-foot">
              <span className="muted">
                {item.reps > 0 ? `已複習 ${item.reps} 次 · ` : ''}
                {item.lapses >= 2 ? `答錯 ${item.lapses} 次 · ` : ''}
                {dueText(item)}
              </span>
              <span className="item-actions">
                <button className="link" onClick={() => suspend(item)} title={item.suspended ? '恢復出題' : '暫時不出題，資料保留'}>
                  {item.suspended ? '恢復' : '暫停'}
                </button>
                <button className="link danger" onClick={() => remove(item)}>
                  刪除
                </button>
              </span>
            </div>
          </article>
        ))}
      </div>
      {filtered.length > shown.length && (
        <div className="more">
          <button onClick={() => setLimit((n) => n + PAGE)}>
            顯示更多（還有 {filtered.length - shown.length} 個）
          </button>
        </div>
      )}
      {filtered.length > 0 && (
        <p className="muted small center">
          顯示 {shown.length} / {filtered.length} 個
        </p>
      )}
    </section>
  )
}
