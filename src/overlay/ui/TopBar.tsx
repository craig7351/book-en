import { useEffect, useRef, useState } from 'react'
import { api } from '../../shared/api'
import { DEFAULT_LEVELS, fmtRank, KNOWN_MAX_OPTIONS, SUGGEST_MAX_OPTIONS } from '../../shared/levels'
import type { Bookmark } from '../../shared/types'
import { setPrefs } from '../controller'
import { useStore } from '../store'
import { navigate, pageTitle, resolveInput } from '../youtube'

export const BAR_H = 40

type Menu = 'bookmarks' | 'settings' | null

// 頂部列：上一頁 / 下一頁 / 重新整理 / 首頁、網址列（可直接打字搜尋 YouTube）、⭐ 書籤、📑 書籤清單、⚙ 設定
export function TopBar() {
  const [href, setHref] = useState(location.href)
  const [input, setInput] = useState(location.href)
  const [editing, setEditing] = useState(false)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [menu, setMenu] = useState<Menu>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // YouTube 是 SPA：輪詢網址變化
  useEffect(() => {
    const t = setInterval(() => setHref(location.href), 500)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!editing) setInput(href)
  }, [href, editing])

  const loadBookmarks = () => api.bookmarkList().then(setBookmarks).catch(() => {})
  useEffect(() => {
    void loadBookmarks()
  }, [])

  // Ctrl+L 聚焦網址列（同瀏覽器習慣）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const isBookmarked = bookmarks.some((b) => b.url === href)

  async function toggleBookmark() {
    await api.bookmarkToggle(location.href, pageTitle()).catch(() => {})
    await loadBookmarks()
  }

  function go(url: string) {
    setMenu(null)
    setEditing(false)
    inputRef.current?.blur()
    navigate(url)
  }

  return (
    <>
      <div className="topbar" style={{ height: BAR_H }}>
        <button className="tb" title="上一頁" onClick={() => history.back()}>
          ◀
        </button>
        <button className="tb" title="下一頁" onClick={() => history.forward()}>
          ▶
        </button>
        <button className="tb" title="重新整理" onClick={() => location.reload()}>
          ⟳
        </button>
        <button className="tb" title="YouTube 首頁" onClick={() => go('https://www.youtube.com/')}>
          ⌂
        </button>
        <form
          className="url-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (input.trim()) go(resolveInput(input))
          }}
        >
          <input
            ref={inputRef}
            className="url"
            value={input}
            spellCheck={false}
            placeholder="貼上 YouTube 網址，或輸入關鍵字搜尋（Ctrl+L）"
            onFocus={(e) => {
              setEditing(true)
              e.target.select()
            }}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              e.stopPropagation() // 不要觸發 YouTube 與 book-en 的快捷鍵
              if (e.key === 'Escape') {
                setInput(href)
                inputRef.current?.blur()
              }
            }}
            onChange={(e) => setInput(e.target.value)}
          />
        </form>
        <button className={isBookmarked ? 'tb star-on' : 'tb'} title={isBookmarked ? '移除書籤' : '加入書籤'} onClick={toggleBookmark}>
          {isBookmarked ? '★' : '☆'}
        </button>
        <button
          className={menu === 'bookmarks' ? 'tb wide on' : 'tb wide'}
          title="書籤清單"
          onClick={() => {
            void loadBookmarks()
            setMenu(menu === 'bookmarks' ? null : 'bookmarks')
          }}
        >
          書籤 ▾
        </button>
        <button className={menu === 'settings' ? 'tb on' : 'tb'} title="設定" onClick={() => setMenu(menu === 'settings' ? null : 'settings')}>
          ⚙
        </button>
      </div>

      {menu && <div className="menu-backdrop" onClick={() => setMenu(null)} />}
      {menu === 'bookmarks' && (
        <div className="menu" style={{ top: BAR_H + 4 }}>
          {bookmarks.length === 0 ? (
            <p className="menu-empty">還沒有書籤。按網址列旁的 ☆ 加入目前頁面。</p>
          ) : (
            bookmarks.map((b) => (
              <div key={b.url} className="bm" title={b.url} onClick={() => go(b.url)}>
                <span className="bm-title">{b.title}</span>
                <button
                  className="bm-del"
                  title="刪除書籤"
                  onClick={async (e) => {
                    e.stopPropagation()
                    await api.bookmarkDelete(b.url)
                    await loadBookmarks()
                  }}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}
      {menu === 'settings' && <SettingsMenu />}
    </>
  )
}

function SettingsMenu() {
  const subSize = useStore((s) => s.prefs.subSize)
  const knownMax = useStore((s) => s.prefs.knownMax)
  const suggestMax = useStore((s) => s.prefs.suggestMax)
  const markLevels = useStore((s) => s.prefs.markLevels)
  return (
    <div className="menu settings-menu" style={{ top: BAR_H + 4 }}>
      <div className="menu-title">設定</div>
      <label className="setting">
        <span>影片字幕大小</span>
        <input
          type="range"
          min={60}
          max={200}
          step={10}
          value={subSize}
          onChange={(e) => setPrefs({ subSize: Number(e.target.value) })}
        />
        <span className="setting-val">{subSize}%</span>
      </label>
      <div className="setting-preview" style={{ fontSize: `${(22 * subSize) / 100}px` }}>
        Sample 字幕預覽
      </div>

      <div className="menu-title section">單字分級</div>
      <label className="setting">
        <span>標示分級</span>
        <input type="checkbox" checked={markLevels} onChange={(e) => setPrefs({ markLevels: e.target.checked })} />
        <span className="muted">建議學習加底線、罕見變淡</span>
      </label>
      <label className="setting">
        <span>我的程度</span>
        <select value={knownMax} onChange={(e) => setPrefs({ knownMax: Number(e.target.value) })}>
          {KNOWN_MAX_OPTIONS.map((n) => (
            <option key={n} value={n}>
              最常用前 {fmtRank(n)} 字當成已會
            </option>
          ))}
        </select>
      </label>
      <label className="setting">
        <span>建議學習到</span>
        <select value={suggestMax} onChange={(e) => setPrefs({ suggestMax: Number(e.target.value) })}>
          {SUGGEST_MAX_OPTIONS.map((n) => (
            <option key={n} value={n}>
              第 {fmtRank(n)} 名（更後面算罕見）
            </option>
          ))}
        </select>
      </label>

      <div className="setting-foot">
        <button onClick={() => setPrefs({ subSize: 100, ...DEFAULT_LEVELS, markLevels: true })}>恢復預設</button>
        <button onClick={() => api.openHub('settings')}>更多設定（學習中心）</button>
      </div>
    </div>
  )
}
