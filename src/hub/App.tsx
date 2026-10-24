import { useCallback, useEffect, useState } from 'react'
import { api } from '../shared/api'
import type { Stats } from '../shared/types'
import { Levels } from './Levels'
import { Review } from './Review'
import { Settings } from './Settings'
import { Vocab } from './Vocab'

type Tab = 'vocab' | 'levels' | 'review' | 'settings'
const TABS: { id: Tab; label: string }[] = [
  { id: 'vocab', label: '單字庫' },
  { id: 'levels', label: '詞彙' },
  { id: 'review', label: '複習' },
  { id: 'settings', label: '設定' },
]

declare global {
  interface Window {
    __bookEnTab?: string // 開窗時由 Rust 帶入的起始分頁
  }
}

const tabFromHash = (): Tab => {
  const h = location.hash.slice(1) || window.__bookEnTab || ''
  return TABS.some((t) => t.id === h) ? (h as Tab) : 'vocab'
}

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash)
  const [stats, setStats] = useState<Stats | null>(null)

  const refresh = useCallback(() => {
    api.stats().then(setStats).catch(() => {})
  }, [])

  useEffect(() => {
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHash)
    window.addEventListener('focus', refresh) // 從主視窗收藏後切回來時更新
    refresh()
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  return (
    <div className="app">
      <header className="top">
        <div className="brand">book-en 學習中心</div>
        <nav>
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} className={tab === t.id ? 'tab on' : 'tab'}>
              {t.label}
              {t.id === 'review' && !!stats?.due && <span className="badge">{stats.due}</span>}
            </a>
          ))}
        </nav>
        {stats && (
          <div className="stats">
            <span>單字 <b>{stats.words}</b></span>
            <span>句子 <b>{stats.sentences}</b></span>
            <span>今日複習 <b>{stats.reviewedToday}</b></span>
            <span>連續 <b>{stats.streakDays}</b> 天</span>
          </div>
        )}
      </header>
      <main>
        {tab === 'vocab' && <Vocab onChanged={refresh} />}
        {tab === 'levels' && <Levels onChanged={refresh} />}
        {tab === 'review' && <Review onChanged={refresh} />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  )
}
