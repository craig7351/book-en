// 把 ECDICT（https://github.com/skywind3000/ECDICT，MIT）轉成 App 用的離線字典 SQLite。
// - 只留常用 / 有收錄等級的字，以及屈折變化形（running → run），控制檔案大小
// - 中文釋義由簡體轉成台灣繁體（OpenCC）
// 用法：
//   curl -L -o .cache/ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
//   node tools/build-ecdict.mjs
import { readFileSync, rmSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as OpenCC from 'opencc-js'

const SRC = '.cache/ecdict.csv'
const OUT = 'src-tauri/resources/ecdict.db'

// RFC 4180 CSV：欄位可含逗號、換行、"" 跳脫
function* parseCsv(text) {
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      yield row
      row = []
      field = ''
    } else field += c
  }
  if (field || row.length) {
    row.push(field)
    yield row
  }
}

const toTw = OpenCC.Converter({ from: 'cn', to: 'twp' })
const text = readFileSync(SRC, 'utf8')
const rows = parseCsv(text)
const header = rows.next().value
const col = Object.fromEntries(header.map((h, i) => [h, i]))

mkdirSync('src-tauri/resources', { recursive: true })
rmSync(OUT, { force: true })
const db = new DatabaseSync(OUT)
db.exec(`
  CREATE TABLE dict(
    word TEXT PRIMARY KEY COLLATE NOCASE,
    phonetic TEXT, translation TEXT, definition TEXT,
    exchange TEXT, tag TEXT, collins INTEGER, oxford INTEGER, bnc INTEGER, frq INTEGER
  ) WITHOUT ROWID;
`)
const insert = db.prepare('INSERT OR IGNORE INTO dict VALUES (?,?,?,?,?,?,?,?,?,?)')

let total = 0
let kept = 0
db.exec('BEGIN')
for (const r of rows) {
  total++
  const word = r[col.word]
  const translation = r[col.translation]
  if (!word || !translation || word.length > 40 || !/^[A-Za-z][A-Za-z' .-]*$/.test(word)) continue
  const collins = Number(r[col.collins]) || 0
  const oxford = Number(r[col.oxford]) || 0
  const bnc = Number(r[col.bnc]) || 0
  const frq = Number(r[col.frq]) || 0
  const tag = r[col.tag] || ''
  const exchange = r[col.exchange] || ''
  const common = collins > 0 || oxford > 0 || bnc > 0 || frq > 0 || tag !== ''
  const inflected = exchange.includes('0:') // 屈折變化形，需要它才能還原原形
  const singleWord = !word.includes(' ') // 罕見單字正是學習者會點的字；片語只留常用的
  if (!common && !inflected && !singleWord) continue
  insert.run(
    word,
    r[col.phonetic] || null,
    toTw(translation.replace(/\\n/g, '\n')),
    (r[col.definition] || '').replace(/\\n/g, '\n').slice(0, 600) || null,
    exchange || null,
    tag || null,
    collins,
    oxford,
    bnc,
    frq,
  )
  kept++
}
db.exec('COMMIT')
db.exec('VACUUM')
db.close()
console.log(`ECDICT: ${total} 筆 → 保留 ${kept} 筆 → ${OUT}`)
