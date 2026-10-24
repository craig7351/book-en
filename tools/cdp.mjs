// 除錯工具：透過 WebView2 的 CDP 在 book-en 主視窗內執行 JS 或截圖。
// 先用除錯埠啟動 App（只在開發時用，正式版不可內建 —— Netflix 等 DRM 會黑畫面，見 yt-float 陷阱 4）：
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333"; cargo run --manifest-path src-tauri/Cargo.toml
// 用法：
//   node tools/cdp.mjs eval "document.title"
//   node tools/cdp.mjs shot out.png
//   node tools/cdp.mjs nav "https://www.youtube.com/watch?v=..."
// 環境變數 CDP_PORT（預設 9333）、CDP_MATCH（挑網址含此字串的頁面，預設 youtube.com）

const port = process.env.CDP_PORT ?? '9333'
const match = process.env.CDP_MATCH ?? 'youtube.com'
const [cmd, arg] = process.argv.slice(2)

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes(match)) ?? targets.find((t) => t.type === 'page')
if (!page) throw new Error('找不到頁面 target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.onopen = r
  ws.onerror = j
})
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq
    pending.set(id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })

if (cmd === 'eval') {
  const res = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true })
  const r = res.result
  if (r?.exceptionDetails) console.error('例外:', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  else console.log(typeof r?.result?.value === 'string' ? r.result.value : JSON.stringify(r?.result?.value, null, 2))
} else if (cmd === 'shot') {
  const res = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(arg ?? 'shot.png', Buffer.from(res.result.data, 'base64'))
  console.log('saved', arg ?? 'shot.png')
} else if (cmd === 'nav') {
  await send('Page.navigate', { url: arg })
  console.log('navigated', arg)
} else {
  console.log('用法：node tools/cdp.mjs eval <js> | shot <file.png> | nav <url>')
}
ws.close()
