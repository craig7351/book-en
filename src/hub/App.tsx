import { useCallback, useEffect, useState } from 'react'
import { api } from '../shared/api'
import { game, type GameState } from '../shared/game'
import { setVoicePrefs } from '../shared/speak'
import { EggPixel, PetPixel } from '../shared/PixelArt'
import type { Stats } from '../shared/types'
import { DictSetup } from './DictSetup'
import { Levels } from './Levels'
import { Pet } from './Pet'
import { Review } from './Review'
import { Settings } from './Settings'
import { SpritePreview } from './SpritePreview'
import { Vocab } from './Vocab'

type Tab = 'vocab' | 'levels' | 'review' | 'pet' | 'settings' | 'dict' | 'sprites'
const TABS: { id: Tab; label: string }[] = [
  { id: 'vocab', label: '單字庫' },
  { id: 'levels', label: '詞彙' },
  { id: 'review', label: '複習' },
  { id: 'pet', label: '寵物' }, // 遊戲模式開啟時才顯示
  { id: 'settings', label: '設定' },
]
const PAGES: Tab[] = [...TABS.map((t) => t.id), 'dict', 'sprites'] // dict：離線字典畫面、sprites：像素圖預覽（都不在分頁列）

declare global {
  interface Window {
    __bookEnTab?: string // 開窗時由 Rust 帶入的起始分頁
  }
}

const tabFromHash = (): Tab => {
  const h = location.hash.slice(1) || window.__bookEnTab || ''
  return PAGES.includes(h as Tab) ? (h as Tab) : 'vocab'
}

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash)
  const [stats, setStats] = useState<Stats | null>(null)
  const [gs, setGs] = useState<GameState | null>(null)

  const refreshGame = useCallback(() => {
    game.state().then(setGs).catch(() => {})
  }, [])

  const refresh = useCallback(() => {
    api.stats().then(setStats).catch(() => {})
    // 發音設定可能在別處改過（YouTube 面板與學習中心共用 prefs）
    api
      .getSetting('prefs')
      .then((raw) => setVoicePrefs(raw ? JSON.parse(raw) : null))
      .catch(() => {})
    refreshGame()
  }, [refreshGame])

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

  const gameOn = !!gs?.options.enabled
  const egg = gs?.eggs.find((e) => e.incubating) ?? gs?.eggs[0]

  return (
    <div className="app">
      <header className="top">
        <div className="brand">book-en 學習中心</div>
        <nav>
          {TABS.filter((t) => t.id !== 'pet' || gameOn).map((t) => (
            <a key={t.id} href={`#${t.id}`} className={tab === t.id ? 'tab on' : 'tab'}>
              {t.label}
              {t.id === 'review' && !!stats?.due && <span className="badge">{stats.due}</span>}
            </a>
          ))}
        </nav>
        {gameOn && gs && (
          <a className="pet-mini" href="#pet" title="寵物">
            {gs.pet ? (
              <PetPixel pet={gs.pet} mood={gs.mood} scale={1} centered />
            ) : (
              egg && <EggPixel egg={egg} scale={1} centered />
            )}
            <span>🪙 {gs.coins}</span>
          </a>
        )}
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
        {tab === 'review' && <Review onChanged={refresh} gs={gameOn ? gs : null} />}
        {tab === 'pet' && gameOn && gs && <Pet gs={gs} onChange={refreshGame} />}
        {tab === 'pet' && !gameOn && <p className="empty">遊戲模式沒有開啟（設定 → 一般 → 遊戲模式）。</p>}
        {tab === 'settings' && <Settings gs={gs} onGameChange={refreshGame} />}
        {tab === 'sprites' && <SpritePreview />}
        {tab === 'dict' && <DictSetup onDone={() => (location.hash = '#vocab')} />}
      </main>
    </div>
  )
}
