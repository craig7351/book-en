import { createRoot } from 'react-dom/client'
import { getPlayerElement } from '../youtube'
import cardCss from './card.css?inline'
import layerCss from './layer.css?inline'
import { Panel, PANEL_W } from './Panel'
import panelCss from './panel.css?inline'
import { SubtitleLayer } from './SubtitleLayer'
import { BAR_H, TopBar } from './TopBar'

function shadowHost(id: string, css: string): { host: HTMLElement; root: HTMLElement } {
  const host = document.createElement('div')
  host.id = id
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = css
  const root = document.createElement('div')
  shadow.append(style, root)
  return { host, root }
}

// 兩個 Shadow DOM：右側面板（掛 <html>）與影片字幕層（掛 #movie_player，全螢幕也看得到）。
// YouTube 的 CSS 進不來，我們的 CSS 也不影響 YouTube。被 SPA 清掉就每秒補回（yt-float 陷阱 2）。
export function mountUi(): void {
  const panel = shadowHost('book-en-host', panelCss + cardCss)
  const layer = shadowHost('book-en-layer', layerCss + cardCss)

  // Shadow DOM 外、作用在 YouTube 頁面的樣式。
  // YouTube 依「視窗」寬度算影片欄寬，不管 ytd-app 縮了多少 → 要直接限制 #primary，
  // 否則影片右半部會藏在面板底下。推薦欄讓位給面板。
  const pageStyle = document.createElement('style')
  pageStyle.id = 'book-en-page-style'
  // 頂部列佔 BAR_H：YouTube 固定定位的頂部元件（頂欄 0、側欄與分類列 56）全部往下推
  const top = BAR_H
  pageStyle.textContent = `
    #masthead-container, #frosted-glass { top: ${top}px !important; }
    tp-yt-app-drawer#guide, ytd-mini-guide-renderer { top: ${top + 56}px !important; }
    /* 首頁分類列：在頁頂時是 relative（有 not-sticky），往下捲才變 fixed，只有 fixed 時要下推 */
    ytd-feed-filter-chip-bar-renderer:not([not-sticky]) #chips-wrapper { top: ${top + 56}px !important; }
    ytd-page-manager { margin-top: ${top + 56}px !important; }
    html.be-open ytd-app { margin-right: ${PANEL_W}px !important; }
    html.be-open #masthead-container { right: ${PANEL_W}px !important; width: auto !important; }
    html.be-open ytd-watch-flexy #secondary { display: none !important; }
    html.be-open ytd-watch-flexy #columns { margin-left: 0 !important; margin-right: 0 !important; justify-content: flex-start !important; }
    html.be-open ytd-watch-flexy #primary { max-width: calc(100vw - ${PANEL_W + 40}px) !important; min-width: 0 !important; margin-left: 16px !important; }
    html.be-layer .ytp-caption-window-container { display: none !important; }
    #book-en-layer { position: absolute; inset: 0; z-index: 60; pointer-events: none; }
  `

  const keepalive = () => {
    const html = document.documentElement
    if (!html) return
    if (!pageStyle.isConnected) (document.head ?? html).appendChild(pageStyle)
    if (!panel.host.isConnected) html.appendChild(panel.host)
    const player = getPlayerElement()
    if (player && layer.host.parentElement !== player) player.appendChild(layer.host)
  }
  keepalive()
  setInterval(keepalive, 1000)

  createRoot(panel.root).render(
    <>
      <TopBar />
      <Panel />
    </>,
  )
  createRoot(layer.root).render(<SubtitleLayer />)
}
