// 打包離線字典給 GitHub Release：ecdict.db → .cache/dict-release/ecdict.db.gz，
// 並把 sha256 / 大小寫進 src-tauri/dict-manifest.json（編進 App，下載後用來檢查檔案完整）。
// 之後要重新 build App，再把 ecdict.db.gz 上傳到 manifest 裡的網址（Release 的 tag 與檔名要一致）。
// 用法：node tools/package-dict.mjs
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

const SRC = 'src-tauri/resources/ecdict.db'
const OUT_DIR = '.cache/dict-release'
const OUT = `${OUT_DIR}/ecdict.db.gz`
const MANIFEST = 'src-tauri/dict-manifest.json'

mkdirSync(OUT_DIR, { recursive: true })
await pipeline(createReadStream(SRC), createGzip({ level: 9 }), createWriteStream(OUT))

const sha256 = createHash('sha256').update(readFileSync(OUT)).digest('hex')
const size = statSync(OUT).size
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
writeFileSync(MANIFEST, JSON.stringify({ ...manifest, sha256, size }, null, 2) + '\n')

const mb = (n) => (n / 1024 / 1024).toFixed(1)
console.log(`${SRC} ${mb(statSync(SRC).size)} MB → ${OUT} ${mb(size)} MB`)
console.log(`sha256 ${sha256}`)
console.log(`已更新 ${MANIFEST}；上傳到：${manifest.url}`)
