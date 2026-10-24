# README_AI · 給 AI Agent 的開發筆記

> 接手前先讀 `PLAN.md`（目標、架構、里程碑）與本檔（實際踩過的坑）。
> 很多做法沿用 `D:\0_CODE\yt-float`，其 `README_AI.md` 的陷阱 1–10 同樣適用。

## 專案本質

- Tauri v2 + WebView2，主視窗直接載入 `https://www.youtube.com`（`WebviewUrl::External`）。
- `src/overlay/` 用 Vite 打包成單一 IIFE → `src-tauri/gen-overlay/overlay.js`，
  Rust 以 `initialization_script` 注入每個頁面（在 YouTube 腳本之前執行）。
- 面板是 React，掛在 Shadow DOM（`#book-en-host`），掛在 `<html>` 並每秒 keepalive。

## 開發流程

**剛 clone 下來**：離線字典 `src-tauri/resources/ecdict.db`（43 MB）不在 git 裡，要先產生：

```powershell
curl.exe -L -o .cache/ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
npm install
node tools/build-ecdict.mjs                         # ECDICT → ecdict.db（繁體）
python -m venv .cache/venv
.cache/venv/Scripts/python -m pip install wordfreq opencc-python-reimplemented
.cache/venv/Scripts/python tools/build-freq.py      # 加入詞頻排名
.cache/venv/Scripts/python tools/build-examples.py  # 加入 Tatoeba 例句庫（下載約 27 MB）
node tools/package-dict.mjs                         # 產生 Release 用的 ecdict.db.gz、更新 dict-manifest.json
```

```powershell
npm install
npm run build:web                       # overlay + hub
cargo build --manifest-path src-tauri/Cargo.toml

# 帶除錯埠啟動（只在開發用；正式版不可內建）
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333"
.\src-tauri\target\debug\book-en.exe

node tools/cdp.mjs eval "document.title"     # 在 YouTube 頁面內跑 JS
node tools/cdp.mjs shot out.png              # 截圖
node tools/cdp.mjs nav "https://www.youtube.com/watch?v=..."
```

- **改 overlay（TS/React）**：`npm run build:overlay` → 重開 exe 即可。debug 版執行時讀檔，**不用重編 Rust**。
- **改 Rust / capability / build.rs**：`cargo build`。release 版用 `include_str!` 把 overlay 編進 exe。
- 除錯：`window.__beCaptionHits` 是攔截到的字幕回應（URL + body）。

## ⚠️ 已驗證的關鍵事實（M1，2026-10-24）

### 1. 字幕只能用「攔截播放器請求」取得
播放器實際發出的 timedtext 請求帶有 `pot=`（PO token）、`potc=1`、`signature` 等參數，
`getPlayerResponse()` 裡的 `captionTracks[].baseUrl` **沒有** pot → 直接 fetch baseUrl 回空內容。
因此主方案是 `boot.ts` 包裝 `XMLHttpRequest`（播放器用 XHR，不是 fetch），再叫播放器載入英文字幕。
`youtube.ts` 裡的同源 fetch 備援目前幾乎不會成功，保留只為了萬一。

### 2. `setOption('captions','track',…)` 在影片剛載入時會被默默忽略
字幕模組還沒就緒時呼叫沒有效果、也不報錯。解法：每秒重試，直到攔截到相符的回應（同 videoId + lang）。

### 3. 片頭廣告期間字幕模組不可用
`#movie_player.ad-showing` 時不計入逾時，否則有廣告的影片會誤判「字幕載入失敗」。

### 4. 播放器會記住使用者上次選的字幕語言
我們切到英文會改變使用者的 CC 偏好（下次預設英文）。對學英文是可接受的副作用。
比對攔截結果時必須檢查 `lang` 參數，不能拿到任何 timedtext 就用（曾經拿到法文）。

### 5. 有些影片完全沒有字幕軌
官方 MV（Taylor Swift 等）、部分教學影片：`captionTracks` 不存在，連自動字幕都沒有。
面板顯示「這支影片沒有英文字幕」。後續可考慮本機語音辨識（Whisper）當最後備援。

### 6. 自動字幕現在多半已有標點
json3 的 ASR 事件有逐字 `tOffsetMs`；`cues.ts` 依句末標點 / 停頓 > 1 秒 / 18 字斷句，效果良好。
URL 一律帶 `caps=asr`（那是能力宣告，不代表這條是自動字幕），判斷 ASR 要看 `kind=asr` 或 `tOffsetMs`。

### 7. 遠端頁面 invoke 權限
`capabilities/main.json` 的 `remote.urls` 限定 `https://*.youtube.com/*`，已驗證 youtube.com 可 invoke。
新增自訂指令：`generate_handler!`、`build.rs` commands、capability `allow-<name>` 三處都要加（yt-float 陷阱 7）。

## M1 驗收紀錄

| 影片 | 類型 | 結果 |
|---|---|---|
| xb0nLpdWttA TED | 人工 | 256 句 ✅ |
| dQw4w9WgXcQ Rick Astley | 人工 | 61 句 ✅ |
| jNQXAC9IVRw Me at the zoo | 人工 | 6 句 ✅ |
| nh36jE2M064 / kaPgGH5HC0w vlog | 自動 | 313 / 404 句 ✅ |
| FGvdNUgC5Kk / PrOrrItkYxk vlog | 人工 | 271 / 337 句 ✅（後者第一次因片頭廣告失敗，已修） |
| pjFlVc-EDzc BBC Learning English | 人工 | 117 句 ✅ |
| MMmOLN5zBLY / idrbwnWLJ7w TED-Ed | 人工 | 89 / 83 句 ✅ |
| ko70cExuzZM / 8xg3vE8Ie_E Taylor Swift MV | 無字幕軌 | 正確提示 ✅ |
| WXKilGiOQy8 英文教學 | 無字幕軌 | 正確提示 ✅ |

有英文字幕的影片 11/11 成功；SPA 內換影片可正確重抓。

## M2–M7 架構補充

- **兩個 Shadow DOM**：右側面板 `#book-en-host`（掛 `<html>`）、影片字幕層 `#book-en-layer`（掛 `#movie_player`，全螢幕也看得到）。
  兩者是不同 React root，共用 `src/overlay/store.ts`（`useSyncExternalStore`）。
- `controller.ts`：換影片載字幕、每幀追蹤目前句（自動暫停 / 單句循環）、A/S/D 快捷鍵、偏好設定存取。
- `translator.ts`：每批 40 句、先翻目前位置附近、同時 2 批 → Rust `translate_batch` → `claude -p`。
- 學習中心 `src/hub/`：本地頁面（`http://tauri.localhost`），capability `hub.json`。
- 離線字典：`tools/build-ecdict.mjs` 把 ECDICT 轉成 `src-tauri/resources/ecdict.db`（40 萬筆、41 MB、OpenCC 轉台灣繁體）。
  重建：先下載 `.cache/ecdict.csv`（見腳本開頭），再 `node tools/build-ecdict.mjs`。
- 使用者資料：`%APPDATA%\dev.booken.app\book-en.db`（設定、翻譯快取、收藏、複習紀錄）。
- 測試：`cargo test --manifest-path src-tauri/Cargo.toml`（SM-2、字典原形、JSON 擷取）。

## ⚠️ M2–M7 踩過的坑

### 8. YouTube 依「視窗」寬度算影片欄寬
`ytd-app` 加 `margin-right` 讓位給面板後，`#primary` 仍是依整個視窗算的寬度 → 影片右半部藏在面板下。
解法：面板打開時直接限制 `#primary { max-width: calc(100vw - 面板寬 - 40px) }`、`#columns` 靠左，並隱藏 `#secondary`（推薦欄）。

### 9. Windows 上在「同步」指令裡建立視窗會死結
`open_hub` 原本是同步指令 → 新視窗卡在 about:blank、invoke 永不返回。建立視窗 / navigate 的指令一律寫成 `async fn`。

### 10. `WebviewUrl::App("index.html#review")` 會被當成檔名
帶分頁要另外傳（目前用 `initialization_script` 設 `window.__bookEnTab`）。

### 11. YouTube 不一定理會網址的 `t=`
從學習中心 `play_source` 導到 `watch?v=…&t=67s`，影片仍從頭播 → `controller.ts` 的 `seekToUrlTime` 等影片就緒（且不在廣告中）後自己跳。

### 12. 學習中心的頁面在編譯期嵌入
`src/hub` 改完要 `npm run build:hub` **再 `cargo build`**（overlay 則是 debug 版執行時讀檔，不用重編）。

### 13. `claude -p` 呼叫細節
`cmd /C claude -p --model <m> --output-format json --tools "" --no-session-persistence`，提示詞走 stdin，
工作目錄設成 temp（避免讀到專案 CLAUDE.md），`CREATE_NO_WINDOW`。模型名會經過 cmd.exe → 只允許英數與 `-._`。
Haiku 翻 3 句約 3.6 秒；回覆在 JSON 的 `result` 欄位。

## M2–M7 驗收紀錄（2026-10-24，TED-Ed idrbwnWLJ7w）

| 項目 | 結果 |
|---|---|
| 影片字幕層取代原生 CC、雙語 | ✅ |
| 每句暫停（15.76 → 停在 17.56，下一句 17.6 開始） | ✅ |
| A / D 上下句、速度 0.75x | ✅ |
| 翻譯 83 句（Haiku）、重開後從快取秒出 | ✅ |
| 單字卡：fighting → 原形 fight；circadian、melatonin 等罕見字 | ✅ |
| AI 句中解釋 | ✅ |
| 收藏存原形（rhythms → rhythm），字幕中各種變化形上色 | ✅ |
| 學習中心：單字庫、匯出 CSV（含 BOM）/ Anki、回影片該秒 | ✅ |
| 複習：四種題型、答錯本輪重考、SM-2 排程、連續天數 | ✅ |
| 面板收起時單字卡改顯示在影片上 | ✅ |

## 2026-10-24 下午追加

- **字幕重複**：有樣式的字幕（MrBeast）每行是兩個同起點同長度的 event，且夾零寬空白 U+200B。
  `cues.ts`：先拿掉零寬字元；同時段多數成對時（> 50%）只取每組第一個（Google 自動翻譯的成對內容常不一致）；中文重複片段去重。
- **中文來源**（面板下拉）：已存的 AI 字幕 / YouTube 中文字幕 / Google 自動翻譯（`tlang=zh-Hant`，同樣攔截播放器請求）/ AI 翻譯。
  AI 只在按「開始 AI 翻譯」才呼叫 claude；其餘選了就載入。上次選的種類存在 prefs.zhKind。
  ⚠️ 有影片把英文字幕標成 zh-Hant → `looksChinese` 檢查中文字比例，不是中文就移除該選項並改用下一個。
  中文字幕與英文句子依時間重疊對齊（`alignTo`）。
- **AI 字幕存檔**：每翻完一批寫 `exe 同目錄\subtitles\<影片ID>.json`（寫不進去退回 `%APPDATA%\dev.booken.app\subtitles`），
  下次開同一支影片預設選「已存的 AI 字幕」。依英文原句對應，斷句規則改過也對得上。
- **頂部列**：上一頁 / 下一頁 / 重新整理 / 首頁、網址列（貼網址、youtu.be、影片 ID 或關鍵字搜尋，Ctrl+L）、☆ 書籤、書籤清單、⚙ 設定（影片字幕大小 60–200%）。
  書籤存 SQLite `bookmarks` 表。YouTube 固定定位的頂部元件都要往下推 40px（見 `mount.tsx`）；
  ⚠️ 首頁分類列在頁頂是 relative（有 `not-sticky` 屬性），捲動後才變 fixed，只能推 fixed 狀態。
  ⚠️ 塞 `<a>` 去點不會變成 YouTube 的 SPA 導覽（一樣整頁重載），網址列一律 `location.assign`。

## M9 詞頻分級（2026-10-24）

- 資料：`tools/build-freq.py`（Python venv：`.cache/venv`，`pip install wordfreq`）把 wordfreq 前 6 萬字寫進 `ecdict.db`：
  `freq(word, rank, lemma)`、`lemma_rank(lemma, rank)`（原形家族 = 家族內最常用形式的排名）。
  **重建字典時順序**：`node tools/build-ecdict.mjs` → `python tools/build-freq.py`（前者會重建整個 db）。
- 人名（ECDICT 唯一義項是「（男子名）（女子名）（人名）（姓氏）」）不分級，共排除 2,486 個；mark / bill / frank 等多義字照常。
- 使用者資料庫：`word_status(lemma, known|ignore)`、`seen_words`（看過的字，給「建議 / 罕見」計數）。學習中 = 已收藏的單字。
- 指令：`word_info`（一支影片的字一次查）、`set_word_status`、`vocab_ranks`、`level_counts`。
- 分級門檻（prefs.knownMax / suggestMax，預設 1,500 / 10,000）在 YouTube 頁 ⚙ 與學習中心設定都能改。
- wordfreq 頻率是分段的（同段並列）→ 詞彙頁每 100 名一區、區內依字母排。
- 授權：wordfreq 資料 CC BY-SA 4.0，須標註 SUBTLEX 作者 → 學習中心「設定 → 貢獻」分頁。
- 驗收：TED-Ed 影片 people / night / study 基礎、rhythms 建議（#6,583）、circadian / melatonin / hypothalamus 罕見；
  標 ✓ 後 rhythms 與 rhythm’s 立即取消強調；詞語分頁「建議學習 76 · 罕見 32 · 基礎 217」。

## M10 單字卡例句 + 字典遺失處理（2026-10-24）

- 例句來源：本片（同原形的其他句子，▶ `playCueOnce` 只播一句）、例句庫（Tatoeba，`examples` / `example_index`）、
  字典英英例句、AI 例句（`ai_examples`，依原形快取在使用者資料庫）。
- `WordText`：字幕、單字卡原句、例句共用的上色元件；目標字加框，TTS `boundary` 事件標亮正在念的字。
  例句的字用 `word_info(..., recordSeen=false)` 查，**不算進「看過的字」**。點例句的字 → 單字卡換字，`cardHistory` 支援 ← 返回。
- `tools/build-examples.py`（需 `pip install opencc-python-reimplemented`）：Tatoeba eng / cmn / eng-cmn links →
  52,841 句、9,770 個原形；難度 = 句中其他字最難的排名，例句由易到難。Tatoeba 中文翻譯品質參差（社群貢獻）。
- **字典遺失**：`Dict(Mutex<Option<Connection>>)`，找不到也照樣開。尋找順序：安裝版 resources → exe 旁 resources → `%APPDATA%\dev.booken.app\ecdict.db`。
  沒有字典時自動開學習中心 `#dict` 畫面（使用者選「不下載」後 settings `dictPrompt=skip` 不再自動跳）。
  下載：`dict_download` 從 `dict-manifest.json` 的網址抓 `ecdict.db.gz`（進度事件 `dict-progress`）→ 比對 sha256 → 解壓 → 驗證 → 換上，YouTube 頁自動重新載入。
  `BOOKEN_DICT_URL` 可改下載位置測試（仍檢查 sha256）。
- **重建字典完整順序**：`build-ecdict.mjs` → `build-freq.py` → `build-examples.py` → `node tools/package-dict.mjs`
  （產生 `.cache/dict-release/ecdict.db.gz` 並更新 `dict-manifest.json`）→ 重新 build App → 把 gz 上傳到 manifest 的 Release 網址。
- dictionaryapi.dev 會整個掛掉（HTTP 530）→ `dict_online` 自動改用 Datamuse（只有英英釋義）。沒有字典時依 `lemmaCandidates` 猜原形查線上。

### ⚠️ 測試時別動到使用者自己開的 App
- 使用者可能同時開著 release 版。debug 版與 release 版 identifier 相同 → **共用 WebView2 資料夾**，新開的 debug 版會併進既有瀏覽器程序、
  `--remote-debugging-port` 不生效。解法：測試時另設 `WEBVIEW2_USER_DATA_FOLDER` 到暫存資料夾。
- **不要用 `Stop-Process -Name book-en`**：只停自己啟動的 PID（`Get-CimInstance Win32_Process` 看 ExecutablePath 分辨）。
- 使用者資料庫（%APPDATA%）也是共用的：測試後別清資料，使用者可能已經有自己的收藏。

## 已知限制 / 後續

- 全螢幕時面板不顯示（單字卡會改顯示在影片上，可用）。
- 克漏字若原句同時含兩個已收藏的字，只挖其中一個；提示用的中文是整句翻譯。
- 沒有字幕軌的影片（部分官方 MV）無法使用；可考慮本機 Whisper 語音辨識。
- 句子收藏的 ★ 狀態只在本次瀏覽中標示（`saved_words` 只回傳單字）。
