// Tauri 的 invoke 包裝。withGlobalTauri 會在頁面放 window.__TAURI__（含 youtube.com 遠端頁面）。
declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> }
      event?: { listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void> }
    }
  }
}

export function hasTauri(): boolean {
  return !!window.__TAURI__?.core
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = window.__TAURI__
  if (!t?.core) return Promise.reject(new Error('no-tauri'))
  return t.core.invoke<T>(cmd, args)
}

// Rust 端 app.emit(...) 的事件（例如字典下載進度）
export function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const ev = window.__TAURI__?.event
  if (!ev) return Promise.resolve(() => {})
  return ev.listen<T>(event, (e) => handler(e.payload))
}
