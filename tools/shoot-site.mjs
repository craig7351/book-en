// 介紹網站（site/）的截圖：透過 CDP 操作正在執行的 book-en，截成 WebP 存到 site/img/。
// 先用展示用的資料夾、開除錯埠啟動 App（不要用自己的學習資料）：
//   $env:BOOKEN_DATA_DIR="<展示資料夾>"; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333"
//   src-tauri\target\debug\book-en.exe
// 然後：node tools/shoot-site.mjs [要拍的名稱…]（不給 = 全部）
// 會在學習中心答一題複習（展示資料會變動）。
import { mkdirSync, writeFileSync } from 'node:fs'

const port = process.env.CDP_PORT ?? '9333'
const OUT = new URL('../site/img/', import.meta.url)
const VIDEO = 'arj7oStGLkU' // TED：Inside the Mind of a Master Procrastinator
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect(match) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes(match))
  if (!page) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id)
  }
  const send = (method, params = {}) =>
    new Promise((r) => {
      const id = ++seq
      pending.set(id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const js = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'eval failed')
    return res.result?.result?.value
  }
  // clip：CSS px 的 {x, y, width, height}；不給 = 整個視窗
  const shot = async (name, clip) => {
    // 畫面上的本機路徑（含使用者名稱、展示資料夾）換成一般使用者會看到的位置
    await js(`(()=>{const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
      while((n=w.nextNode()))if(/[A-Z]:\\\\Users\\\\/.test(n.nodeValue))
        n.nodeValue=n.nodeValue.replace(/[A-Z]:\\\\Users\\\\[^\\s「」（）]*?(\\\\kokoro|\\\\subtitles|$)/g,'C:\\\\Users\\\\你\\\\AppData\\\\Roaming\\\\dev.booken.app$1');return 1})()`)
    const res = await send('Page.captureScreenshot', { format: 'webp', quality: 82, ...(clip && { clip: { ...clip, scale: 1 } }) })
    writeFileSync(new URL(`${name}.webp`, OUT), Buffer.from(res.result.data, 'base64'))
    console.log('✓', name)
  }
  return { send, js, shot, close: () => ws.close() }
}

// ---- YouTube 頁（主視窗）----

const panel = `document.querySelector('#book-en-host').shadowRoot`
const setSelect = (find, value) => `(()=>{const h=${panel};const s=[...h.querySelectorAll('select')].find(${find});
  const set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(s),'value').set;set.call(s,'${value}');
  s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`
const zhSource = (v) => setSelect(`x=>[...x.options].some(o=>o.value==='ai')`, v)
const panelRect = `(()=>{const r=${panel}.querySelector('aside.panel').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:Math.min(r.height,innerHeight-r.y)}})()`

async function youtube(only) {
  const yt = await connect('youtube.com')
  if (!yt) throw new Error('找不到 YouTube 頁面：App 有用除錯埠啟動嗎？')
  const want = (n) => !only.length || only.includes(n)
  if (!(await yt.js(`location.href`)).includes(VIDEO)) {
    await yt.send('Page.navigate', { url: `https://www.youtube.com/watch?v=${VIDEO}` })
    await sleep(4000)
  }
  // 等廣告結束、字幕載入
  for (let i = 0; i < 60; i++) {
    await yt.js(`document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern')?.click()`).catch(() => {})
    const ready = await yt.js(`!document.querySelector('.ad-showing') && !!${panel}?.querySelector('li.cue')`).catch(() => false)
    if (ready) break
    await sleep(3000)
  }
  await yt.js(zhSource('yt:zh-TW'))
  await yt.js(`(()=>{const v=document.querySelector('video');v.currentTime=262;v.play();
    return new Promise(r=>setTimeout(()=>{v.pause();r(1)},2500))})()`)
  await yt.js(`[...${panel}.querySelectorAll('button')].find(b=>b.innerText.trim()==='字幕')?.click()`)
  await sleep(1500)
  if (want('hero')) await yt.shot('hero')
  if (want('panel')) await yt.shot('panel', await yt.js(panelRect))

  if (want('wordcard')) {
    await yt.js(`[...${panel}.querySelectorAll('li.cue .w')].find(e=>e.textContent==='entire').click()`)
    await sleep(2500)
    await yt.shot('wordcard')
    await yt.js(`${panel}.querySelector('.card-backdrop')?.click()`)
    await sleep(500)
  }
  if (want('words')) {
    await yt.js(`[...${panel}.querySelectorAll('button')].find(b=>b.innerText.trim()==='詞語').click()`)
    await sleep(2000)
    await yt.shot('words', await yt.js(panelRect))
    await yt.js(`[...${panel}.querySelectorAll('button')].find(b=>b.innerText.trim()==='字幕').click()`)
  }
  if (want('webai')) {
    await yt.js(zhSource('web'))
    await sleep(1500)
    await yt.js(`(()=>{const w=${panel}.querySelector('.webai.folded .webai-head');w&&w.click();return 1})()`)
    await sleep(800)
    await yt.shot('webai', await yt.js(panelRect))
    await yt.js(zhSource('yt:zh-TW'))
    await sleep(1000)
  }
  return yt
}

// ---- 學習中心（另一個視窗）----

async function hub(yt, only) {
  const want = (n) => !only.length || only.includes(n)
  await yt.js(`__TAURI_INTERNALS__.invoke('open_hub',{tab:'vocab'})`)
  await sleep(2500)
  const h = await connect('tauri.localhost')
  if (!h) throw new Error('找不到學習中心視窗')
  const go = async (tab, wait = 2500) => {
    await h.js(`(location.hash='${tab}',scrollTo(0,0),1)`)
    await sleep(wait)
  }
  const scrollToH2 = (text) =>
    h.js(`([...document.querySelectorAll('h2')].find(e=>e.textContent==='${text}').scrollIntoView(),scrollBy(0,-90),1)`)

  if (want('vocab')) await go('vocab'), await h.shot('vocab')
  if (want('levels')) await go('levels'), await h.shot('levels')
  if (want('pet')) await go('pet'), await h.shot('pet')
  if (want('dex')) {
    await go('pet')
    await h.js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='圖鑑').click()`)
    await sleep(1500)
    await h.shot('dex')
  }
  if (want('settings-ai')) await go('settings'), await scrollToH2('翻譯'), await sleep(800), await h.shot('settings-ai')
  if (want('settings-voice')) await go('settings'), await scrollToH2('發音'), await sleep(800), await h.shot('settings-voice')
  if (want('review')) {
    // 只出「原句填空」，答對後拍下回饋
    await h.js(`__TAURI_INTERNALS__.invoke('get_setting',{key:'prefs'}).then(v=>__TAURI_INTERNALS__.invoke('set_setting',
      {key:'prefs',value:JSON.stringify({...JSON.parse(v||'{}'),quizKinds:['cloze']})}))`)
    await go('vocab', 500)
    await go('review', 3000)
    await h.shot('review-quiz')
    if (await h.js(`!!document.querySelector('input[placeholder*=Enter]')`)) {
      // 答案：題目句子挖空前的那段，對回待複習單字的原句
      const answer = await h.js(`(async()=>{
        const q=document.querySelector('.quiz').textContent.replace(document.querySelector('.quiz .prompt').textContent,'');
        const before=q.split(/[＿_]+/)[0].trim();
        const due=await __TAURI_INTERNALS__.invoke('review_due',{limit:100,dayStart:new Date(new Date().setHours(0,0,0,0)).getTime()});
        return due.find(i=>i.context&&i.context.includes(before)&&i.context.toLowerCase().includes(i.text.toLowerCase()))?.text})()`)
      await h.js(`(()=>{const i=document.querySelector('input[placeholder*=Enter]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(answer ?? '')});
        i.dispatchEvent(new Event('input',{bubbles:true}));i.form.requestSubmit();return 1})()`)
      await sleep(2000)
      await h.shot('review-done')
    }
  }
  h.close()
}

mkdirSync(OUT, { recursive: true })
const only = process.argv.slice(2)
const yt = await youtube(only)
await hub(yt, only)
yt.close()
