import { installCaptionHook } from './boot'
import { startController } from './controller'
import { mountUi } from './ui/mount'

declare global {
  interface Window {
    __bookEn?: boolean
  }
}

// 只在最上層 frame 跑一份（YouTube 頁面內還有廣告等 iframe）
if (window.top === window.self && !window.__bookEn) {
  window.__bookEn = true
  // 必須同步執行，搶在 YouTube 腳本之前
  installCaptionHook()

  const start = () => {
    mountUi()
    startController()
  }
  if (document.documentElement) start()
  else
    new MutationObserver((_, obs) => {
      if (document.documentElement) {
        obs.disconnect()
        start()
      }
    }).observe(document, { childList: true })
}
