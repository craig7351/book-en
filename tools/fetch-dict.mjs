// 依 src-tauri/dict-manifest.json 下載離線字典、驗證 sha256，解壓到 src-tauri/resources/ecdict.db。
// 從原始碼建置與 GitHub Actions 打包都用這支（跨平台，不需要 curl / gunzip / shasum）。
// 用法：node tools/fetch-dict.mjs
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const manifest = JSON.parse(readFileSync('src-tauri/dict-manifest.json', 'utf8'))
const res = await fetch(manifest.url)
if (!res.ok) throw new Error(`下載失敗：HTTP ${res.status} ${manifest.url}`)
const gz = Buffer.from(await res.arrayBuffer())
const sha = createHash('sha256').update(gz).digest('hex')
if (sha !== manifest.sha256) throw new Error(`sha256 不符：${sha}（應為 ${manifest.sha256}）`)
mkdirSync('src-tauri/resources', { recursive: true })
writeFileSync('src-tauri/resources/ecdict.db', gunzipSync(gz))
console.log(`ecdict.db OK（${(gz.length / 1048576).toFixed(1)} MB 下載）`)
