// 最先執行：在 YouTube 腳本之前包裝 XHR / fetch，記錄播放器「自己」發出的字幕請求。
// 播放器的請求帶有它產生的參數（含 PO token），比我們自己去抓字幕不容易被擋。

export interface CaptionHit {
  url: string
  body: string
  at: number
}

type Listener = (hit: CaptionHit) => void

const listeners = new Set<Listener>()
export const captionHits: CaptionHit[] = []
// 除錯用：用 CDP 檢查 window.__beCaptionHits
;(window as unknown as { __beCaptionHits: CaptionHit[] }).__beCaptionHits = captionHits

const isTimedText = (url: string) => url.includes('/api/timedtext')

function emit(url: string, body: string): void {
  if (!body) return
  const hit = { url, body, at: Date.now() }
  captionHits.push(hit)
  if (captionHits.length > 20) captionHits.shift()
  listeners.forEach((fn) => fn(hit))
}

export function onCaption(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function xhrBody(xhr: XMLHttpRequest): string {
  switch (xhr.responseType) {
    case '':
    case 'text':
      return xhr.responseText
    case 'json':
      return JSON.stringify(xhr.response)
    case 'arraybuffer':
      return new TextDecoder().decode(xhr.response as ArrayBuffer)
    default:
      return ''
  }
}

export function installCaptionHook(): void {
  type TaggedXhr = XMLHttpRequest & { __beUrl?: string }

  const open = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: TaggedXhr, ...args: unknown[]) {
    this.__beUrl = String(args[1])
    return (open as (...a: unknown[]) => void).apply(this, args)
  } as typeof open

  const send = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function (this: TaggedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = this.__beUrl
    if (url && isTimedText(url)) {
      this.addEventListener('load', () => {
        try {
          emit(url, xhrBody(this))
        } catch {
          /* 讀不到就略過，不影響 YouTube */
        }
      })
    }
    return send.call(this, body)
  }

  const origFetch = window.fetch
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const p = origFetch.call(this, input, init)
    if (isTimedText(url)) {
      p.then((res) => res.clone().text())
        .then((t) => emit(url, t))
        .catch(() => {})
    }
    return p
  }
}
