// 網頁 AI 翻譯的解析測試（Node 22.6+ 可直接跑 .ts）：node tools/test-webai.mts
import { parseReply, buildPrompt, chunks, parseSrt, usable } from '../src/shared/webai.ts'
import assert from 'node:assert/strict'
const reply = `好的，以下是翻譯結果：
\`\`\`
1| 我滿喜歡這些抱枕的。
**2.** 像這種沉船風
3) 第三句
【4】第四句
５｜第五句
6: These like shipwreck → 像沉船
7| >> 所以，嗯，我昨天去了那裡。
8 | Hello there my friend
10| >> So, um, I went there yesterday.
11| Tim Urban
9、第九句**
\`\`\`
1. 每行格式是「編號| 英文」，請輸出「編號| 中文」，一行一句，編號照原樣保留。
希望有幫助！`
const m = parseReply(reply)
assert.equal(m.get(1), '我滿喜歡這些抱枕的。')
assert.equal(m.get(2), '像這種沉船風')
assert.equal(m.get(3), '第三句')
assert.equal(m.get(4), '第四句')
assert.equal(m.get(5), '第五句')
assert.equal(m.get(6), '像沉船')
assert.equal(m.has(7), false)
assert.equal(m.get(9), '第九句')
assert.equal(m.has(8), false); assert.equal(m.has(10), false); assert.equal(m.get(11), 'Tim Urban'); assert.equal(usable('Tim Urban', 'tim urban'), false)
assert.deepEqual(chunks(250, 120), [[0,120],[120,240],[240,250]])
const srt = parseSrt('1\n00:00:01,000 --> 00:00:02,500\n<i>你好</i>\n世界\n\n2\n00:01:02.000 --> 00:01:03.000 align:start\n再見\n')
assert.deepEqual(srt, [{start:1,end:2.5,text:'你好 世界'},{start:62,end:63,text:'再見'}])
assert.equal(parseSrt('1| x'), null)
console.log('ALL OK')
