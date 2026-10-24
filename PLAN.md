# book-en — 用 YouTube 學英文的桌面 App（計畫）

> 目標：做出 Language Reactor 的核心體驗（雙語字幕、逐句精聽、點字查詢、收藏），
> 再補上它缺的：內建單字庫 + 間隔重複複習。
> 技術：沿用 yt-float 的做法 —— Tauri v2 + WebView2 直接載入真正的 youtube.com，注入學習介面。

---

## 1. 為什麼用這個架構

| 需求 | 做法 | 理由 |
|---|---|---|
| 每支影片都能播 | 視窗直接開 `https://www.youtube.com`（`WebviewUrl::External`） | 不是 iframe 內嵌，沒有「禁止嵌入」、Error 152/153 問題；可登入自己帳號 |
| 字幕穩定 | 在頁面內攔截 YouTube 播放器**自己的**字幕請求 | 請求帶有播放器產生的參數（含 PO token），比外部抓字幕不易被擋 |
| 字幕與影片精準同步 | 直接讀 `<video>.currentTime`、操作 `playbackRate` / `pause()` | 同一頁面，零延遲 |
| 輕量 | Tauri + 系統 WebView2 | exe 數 MB，殼層記憶體 ~50 MB |
| 跨網域 HTTP（翻譯、字典） | 全部走 Rust command（`reqwest`） | youtube.com 頁面內 fetch 外站會被 CORS 擋 |

已確認環境（2026-10-24）：Rust 1.96、WebView2 155、yt-float 可在本機編譯。

---

## 2. 整體架構

```
┌─────────────────────── 主視窗（WebView2，載入 youtube.com）───────────────────────┐
│  YouTube 原生頁面                                                                 │
│   ├ <video>  ← 注入腳本讀 currentTime / 控制播放                                   │
│   └ 播放器上方：雙語字幕層（取代原生 CC）                                          │
│                                                                                   │
│  注入的學習面板（React，掛在 Shadow DOM，CSS 與 YouTube 隔離）                    │
│   ├ 字幕清單：跟著影片捲動、點句跳轉、目前句高亮                                   │
│   ├ 逐句控制：自動暫停 / 重播 / 上下句 / 速度 / 遮字幕                              │
│   └ 單字卡彈窗：音標、發音、中英釋義、例句、⭐收藏                                  │
└───────────────────────────────┬───────────────────────────────────────────────────┘
                                │ window.__TAURI__.core.invoke()（只允許 youtube.com）
┌───────────────────────────────▼───────────────────────────────────────────────────┐
│ Rust 後端                                                                          │
│   translate_batch  字幕批次翻譯 + 快取                                              │
│   dict_lookup      ECDICT 離線英漢字典 + dictionaryapi.dev（音檔/例句）             │
│   vocab_*          單字/句子收藏 CRUD                                               │
│   review_*         間隔重複排程、出題、計分                                         │
│   SQLite（rusqlite, bundled）：app_data_dir/book-en.db                              │
└───────────────────────────────▲───────────────────────────────────────────────────┘
                                │ invoke()（本地頁面，預設權限）
┌───────────────────────────────┴───────────────────────────────────────────────────┐
│ 學習中心視窗（本地 React 頁面 tauri://localhost）                                  │
│   單字庫（搜尋、標籤、匯出 CSV/Anki）、每日複習、考試、學習統計                     │
│   點單字 → 主視窗跳回來源影片的那一秒                                               │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 關鍵設計決定

1. **學習面板注入在 YouTube 頁面內**（同 Language Reactor），而非另開 webview。
   - 用 Vite 把 React 面板打包成**單一 IIFE 檔**，Rust 以 `initialization_script` 注入。
   - 掛在 Shadow DOM，避免 YouTube CSS 互相污染。
   - 沿用 yt-float 陷阱 2：掛在 `<html>` 而非 `<body>`，並 keepalive 補回。
2. **單字庫 / 複習放在獨立的本地視窗**：需要大量畫面空間，且本地頁面權限單純、不受 YouTube 改版影響。
3. **所有資料存 SQLite**（不用 localStorage，yt-float 陷阱 8：各網域 storage 互相隔離）。
4. **IPC 權限只開給 youtube.com**：capability `remote.urls` 限定 `https://*.youtube.com/*`，
   不照抄 yt-float 的 `http://*`、`https://*`（那會讓任何網站都能呼叫指令）。
5. **Rust 只做 I/O 與資料**（HTTP、SQLite、排程計算）；畫面邏輯都在 TypeScript。

---

## 3. 字幕取得（最高風險，M1 先驗證）

**主方案：攔截播放器請求**
- 注入腳本比 YouTube 腳本先執行 → 包裝 `XMLHttpRequest` / `fetch`，
  看到 `/api/timedtext` 的回應就存下來（json3 格式：`events[].tStartMs / dDurationMs / segs[].utf8`）。
- 要讓播放器發出請求：透過播放器 API 開啟英文字幕
  （`movie_player.setOption('captions','track',{languageCode:'en'})`），再用 CSS 隱藏原生字幕
  （`.ytp-caption-window-container`），由我們的雙語字幕層顯示。

**備案：** 從 `movie_player.getPlayerResponse().captions…captionTracks` 取 `baseUrl`，
在頁面內同源 fetch `baseUrl&fmt=json3`（帶 cookie）。

**後備：** 手動匯入 SRT / VTT。

**字幕前處理：**
- 自動產生字幕（ASR）是逐字滾動、沒有標點 → 依時間間隔與字數合併成句；之後可選擇用 LLM 補標點。
- 人工字幕：直接使用，合併過短的片段。

**SPA 換影片：** 監聽 `yt-navigate-finish` 事件 + 檢查 videoId 變化，清空並重新抓字幕。

---

## 3.5 翻譯：本機 `claude -p`（不用 API key）

- 使用者已登入的 Claude Code CLI，以非互動模式呼叫：
  `claude -p --model <模型> --output-format json`，提示詞從 stdin 傳入（避免命令列長度與跳脫問題）。
- **模型可選**：設定頁提供 `haiku`（快、省）/ `sonnet`（品質較好）/ `opus`，預設 `haiku`；字串直接傳給 `--model`。
- **Windows 注意**：`claude` 是 npm 的 `claude.cmd` 包裝，Rust `Command::new("claude")` 找不到 →
  用 `cmd /C claude ...`，並設 `CREATE_NO_WINDOW` 避免跳出黑色主控台視窗。
- **批次與對齊**：每批約 40 句，要求模型只回 JSON 陣列 `[{"i":編號,"zh":"譯文"}]`；
  編號對不上的句子標記未翻譯、可重試。整支影片一次送出前後文，讓譯文語氣一致。
- **執行策略**：先翻「目前播放位置附近」的批次，再背景翻其餘；同時最多 2 個 `claude` 程序。
- **快取**：結果依 `(句子雜湊, 模型, 目標語言)` 存 SQLite，重看不再呼叫。
- **偵測**：啟動時檢查 `claude --version`；找不到或未登入時，面板顯示設定指引，英文字幕照常可用。
- 之後同一管道也可用於：ASR 字幕補標點、單字在句中的語意解釋、造句批改。

---

## 4. 功能清單與里程碑

每個里程碑都要能執行、能看到成果。

| M | 內容 | 驗收 |
|---|---|---|
| **M0 骨架** | Tauri 專案；主視窗開 youtube.com；注入 Shadow DOM 的 Hello 面板；從 youtube.com 呼叫 `ping` 指令成功；Vite 打包面板 → Rust 注入的建置流程 | 面板出現在 YouTube 上、invoke 有回應、換影片後面板不會消失 |
| **M1 字幕** | 攔截/取得字幕 → cue 陣列；側邊字幕清單跟著播放捲動、目前句高亮、點句跳轉；SPA 換影片重抓 | 隨機 10 支有字幕的影片（含 ASR、含音樂 MV）≥ 9 支成功 |
| **M2 逐句精聽** | 影片上方自訂字幕層（取代原生 CC）；快捷鍵：上一句 / 重播 / 下一句、每句自動暫停開關、速度 0.5–1.5x、遮字幕（盲聽，hover 才顯示） | 不碰滑鼠能完成「聽一句 → 重播 → 下一句」 |
| **M3 雙語字幕** | Rust `translate_batch`：呼叫本機 `claude -p`（見第 3.5 節）分批翻譯、編號對齊、失敗可重試；依 videoId 快取在 SQLite；模型可在設定選擇 | 同一支影片第二次開啟秒出中文、不重複翻譯 |
| **M4 單字卡** | 點字幕中的單字 → 彈窗：音標、發音（字典音檔 / TTS）、ECDICT 中文釋義、英英釋義與例句；字形還原（running → run） | 查詢 < 100 ms（離線字典）；斷網仍有中文釋義 |
| **M5 收藏** | ⭐ 收藏單字 / 整句，記錄來源影片 + 秒數 + 原句；字幕中已收藏的字上色（學習中 / 已熟悉） | 收藏後關掉重開還在；字幕中看得到上色 |
| **M6 學習中心** | 本地視窗：單字庫（搜尋、刪除、標籤、匯出 CSV / Anki）、學習統計；點來源 → 主視窗跳到該影片該秒 | 從單字跳回影片原句播放 |
| **M7 複習** | 間隔重複（先 SM-2，之後可換 FSRS）；題型：看中文選英文、聽音拼字、克漏字（用收藏的原句挖空）、原片段聽力（跳回影片播那一句） | 每日到期題目正確出現、答題後排程更新 |
| **M8 打磨與發佈** | 設定頁（翻譯引擎、快捷鍵、字幕樣式）；yt-float 功能選配（最上層迷你模式）；圖示；GitHub Actions 多平台 release | 產出 Windows 安裝檔 + 免安裝 exe |

**進度（2026-10-24）**：M0–M7 ✅、M9 詞頻分級 ✅、M10 單字卡例句 ✅、字典遺失時可下載 ✅（驗收紀錄與踩坑見 `README_AI.md`）。
下一步 M8 打磨與發佈（含建立 GitHub repo 與 `dict-v1` Release 上傳 `ecdict.db.gz`）。

**MVP = M0–M5**（已具備 Language Reactor 免費版的核心體驗）。M6–M7 是勝過它的部分。

---

## 4.5 M9 詞頻分級（參考 Language Reactor）

> 目標：每個字一眼看出「常不常用」，決定要不要花時間背。
> 參考 Language Reactor：單字卡顯示「第 9387 常用」與進度條；詞彙頁分「已知 / 自動」「學習中 / 建議」「不要學習 / 罕見」三組，依排名每 100 字一區。

### 詞頻資料來源

| 來源 | 優點 | 缺點 | 決定 |
|---|---|---|---|
| ECDICT 內建 `frq`（COCA）/ `bnc` | 已在 `ecdict.db`，4.2 萬字有排名 | 書面語：yeah 429、okay 1642、gonna 沒排名，不符合影片口語 | 備援 |
| **wordfreq**（Python 套件，資料含 OpenSubtitles 影視字幕） | 口語排名準、涵蓋 5 萬字以上 | 需在建置時用 Python 匯出一次；資料授權 CC BY-SA 4.0 → 設定頁標註出處 | **主要** |

- 建置腳本 `tools/build-freq.py`：`wordfreq.top_n_list('en', 60000)` → 寫入 `ecdict.db` 新表 `freq(word, rank)`。
- **以「原形家族」計排名**：用 ECDICT 的 `exchange` 把 running / ran / runs 歸到 run，家族排名 = 家族內最常用的那個形式的排名。
  （LR 的 avengers 9387 是字面排名；以原形計較符合「要不要背這個字」的判斷。）
- 查不到排名：專有名詞（句中大寫、字典沒有）不分級；其餘視為「罕見」。

### 分級（門檻可在設定調整）

| 分級 | 預設排名 | 意義 | 字幕上的樣子 |
|---|---|---|---|
| 基礎（自動已知） | 1–1,500 | 預設當成已經會 | 一般 |
| **建議學習** | 1,501–8,000 | 常用、值得背 | **底線＋強調色**（一眼找出值得學的字） |
| 罕見 | 8,001 以上／無排名 | 少見，除非有興趣可略過 | 淡灰 |

- 「我的程度」設定：自動已知範圍 500 / 1,000 / 1,500 / 2,000 / 3,000 / 5,000（之後可加 3 分鐘程度測驗：抽各排名區段的字讓使用者勾「認識」，估出詞彙量）。

### 個人狀態（覆蓋分級）

| 狀態 | 來源 | 字幕上的樣子 |
|---|---|---|
| ✓ 已知 | 單字卡按 ✓、詞彙頁批次標記 | 一般（不再強調） |
| 📖 學習中 | 單字卡按 📖 ＝ 現有的 ⭐ 收藏（進 SRS 複習） | 黃底（現有） |
| ⊘ 不要學 | 單字卡按 ⊘（專有名詞、髒話、太冷門的字） | 一般 |

有效狀態 = 個人狀態 ?? 分級。

### 功能

1. **單字卡**：排名徽章「第 9,387 常用」＋分級標籤＋進度條；三個按鈕 ✓ 已知 / 📖 學習中 / ⊘ 不要學。
2. **字幕上色**：依有效狀態（上表）；設定可開關「標示建議學習的字」。
3. **面板「詞語」分頁**（LR 的 本文 / 詞語）：本片出現的字依分級分組、依排名排序，顯示「本片建議學習 37 字」，可直接標 ✓ / 📖 / ⊘，點字跳到第一次出現的句子。
4. **學習中心「詞彙」頁**（LR 第二張圖）：
   - 頂部計數：已知 n｜自動 1,500　·　學習中 n｜建議 n　·　不要學 n｜罕見 n（點了篩選）
   - 依排名每 100 字一區（排名 1–100、101–200…），右側排名捲軸 1 / 100 / … / 1k / … / 8k 快速跳
   - 每區「整區標為已知」；搜尋；字的顏色＝狀態
5. **統計**：估計詞彙量 = 自動已知 + 手動已知，在學習中心頂部顯示。

### 實作拆解

| 步驟 | 內容 |
|---|---|
| 9.1 資料 | `tools/build-freq.py` 匯出 wordfreq 排名 → `ecdict.db` 加 `freq` 表；建置時計算原形家族排名（`lemma_rank` 表：lemma, rank） |
| 9.2 Rust | `word_status` 表（lemma PK, status, updated_at）；指令 `word_info(words[])` 一次回傳每個字的 原形 / 排名 / 有效狀態（一支影片約 1–2 千個不重複字，一次批次查詢）；`set_word_status`、`vocab_ranks(range, filter)`、`level_counts()` |
| 9.3 單字卡 | 排名徽章、進度條、✓ / 📖 / ⊘；📖 沿用現有收藏流程 |
| 9.4 字幕上色 | 載入字幕後批次查 `word_info`，`Line` 依狀態上 class；狀態改變即時更新 |
| 9.5 面板詞語頁 | 本片詞彙分組清單 |
| 9.6 學習中心詞彙頁 | 排名分區清單、計數、篩選、批次標記 |
| 9.7 設定 | 程度門檻、上色開關；出處標註（wordfreq CC BY-SA 4.0、ECDICT MIT） |

驗收：TED-Ed 影片中 the / people 為基礎、investment / giggle 為建議、circadian / suprachiasmatic 為罕見；
yeah / okay / gonna 依口語排名落在基礎；標 ✓ 後字幕立即取消強調；詞彙頁「整區標為已知」後計數正確。

---

## 4.6 M10 單字卡例句（可發音、依詞頻上色）

> 目標：單字卡多一個「例句」區，看這個字在不同句子裡怎麼用；每句可發音；例句裡的字跟字幕一樣依分級上色（建議學習底線、罕見變淡），也能點字查下一個字。

### 例句來源（依序顯示，各自可收合）

| 來源 | 內容 | 發音 | 備註 |
|---|---|---|---|
| **本片** | 同一支影片裡其他含這個字（原形家族）的句子，最多 5 句 | ▶ 播原影片片段（真人發音，播完自動停）＋ 🔊 TTS | 不需新資料；附時間戳，點了跳過去 |
| **例句庫**（Tatoeba，離線） | 中英對照例句，依難度挑最容易的 3 句 | 🔊 TTS | 新資料，見下 |
| **字典** | dictionaryapi.dev 的英英例句（現有） | 🔊 TTS | 常常沒有（例如 ham） |
| **AI 例句**（按鈕） | `claude -p` 依「我的程度」產生 3 句＋中文 | 🔊 TTS | 按了才呼叫；結果依原形快取在 SQLite |

### 例句庫資料：Tatoeba（CC BY 2.0 FR）

- 下載（2026-10-24 已確認可取得）：`eng_sentences.tsv.bz2`（25 MB）、`cmn_sentences.tsv.bz2`（1.3 MB）、`eng-cmn_links.tsv.bz2`（0.5 MB），
  來源 `downloads.tatoeba.org/exports/per_language/`。
- 建置腳本 `tools/build-examples.py`：
  1. 取有中文翻譯的英文句（4–20 個字），中文用 OpenCC 轉台灣繁體
  2. 每句斷詞 → 原形（沿用 `freq` / ECDICT 詞形）→ 倒排索引
  3. **難度** = 句中「目標字以外」最難字的排名 → 優先選其他字都是基礎字的句子（只學一個新字）
  4. 寫進 `ecdict.db`：`examples(id, en, zh)`、`example_index(lemma, id, difficulty)`
- 授權：CC BY 2.0 FR，在「設定 → 貢獻」標註 Tatoeba 與其貢獻者。

### 發音

- 🔊：系統 TTS（WebView2 有 Microsoft 自然語音），每句可選 1x / 0.75x；朗讀時依 `boundary` 事件把正在念的字標亮。
- ▶ 原片段（本片例句）：跳到該句開頭播放，播到句尾自動暫停（沿用每句暫停的守衛機制），單字卡保持開著。

### 上色與點字

- 把 `Line` 抽成共用的 `WordText`（字幕、面板、單字卡例句共用），同一套分級 class。
- 例句裡的字向 Rust 批次查 `word_info`；新增參數 `recordSeen: false`，例句的字**不**算進「看過的字」，以免灌水詞彙統計。
- 目標字（含變化形）加框標示；點例句中的其他字 → 單字卡換成那個字，左上角「← 返回」回上一個字（單字卡加瀏覽紀錄）。

### 順手修

- Google 自動翻譯的中文字之間有空白（「嚐 嚐 味道 怎麼樣」）→ 清理時移除中文字之間的空白。

### 實作拆解

| 步驟 | 內容 |
|---|---|
| 10.1 | 中文字間空白清理（`cues.ts`） |
| 10.2 | `WordText` 共用元件（從 `Line` 抽出），字幕行為不變 |
| 10.3 | 本片例句：依原形找其他句子、▶ 原片段播放、🔊 TTS |
| 10.4 | `tools/build-examples.py` + Rust `examples_for(lemma, limit)`；例句庫區塊 |
| 10.5 | 例句上色：`word_info` 加 `recordSeen`；點字換卡、← 返回 |
| 10.6 | AI 例句按鈕（`claude -p`，依程度、快取） |
| 10.7 | 貢獻分頁加 Tatoeba；學習中心單字小卡與複習的「原句填空」也可用例句庫（之後） |

驗收：ham 在 MrBeast／美食影片中能列出本片其他句子並播原片段；例句庫有 2–3 句中英對照且多為基礎字；
例句中罕見字變淡、建議學習字有底線；點例句裡的字可切換單字卡並返回；例句的字不影響「看過的字」計數。

---

## 4.7 M11 遊戲化：遊戲幣、角色經驗、給小孩的玩法（計畫）

> 目標：讓小孩願意每天回來複習。**獎勵對齊「真的學會」**，不是「點很多下」。
> 狀態：計畫中，尚未實作。

### 其他產品怎麼做（2026-10 查）

| 產品 | 做法 | 可以學 | 要避免 |
|---|---|---|---|
| **Duolingo** | 每課給 XP，XP 決定每週聯賽排名（約 30 人一組，前段升級）；寶石是貨幣，可買連續紀錄保護；有每日任務、與好友一起完成的每週任務 | XP 與貨幣分開；**連續天數＋保護**；每日任務 | 2025 年把「答錯扣愛心」改成「每題都扣能量」，被大量抱怨（有連署要求改回）→ **不要做限制學習次數的機制** |
| **Prodigy（數學 RPG）** | 答對題目才能施法打怪；題目依程度自動調整；寵物有能力、會影響戰鬥 | **答題＝戰鬥動作**，寵物有實際用途 | Common Sense Media 指出小孩會被戰鬥、寵物、升級推銷分心；重要功能鎖在付費方案 |
| **Blooket / Gimkit（課堂）** | 答對賺遊戲幣；Blooket 拿來收集角色（Blooks），Gimkit 拿來買升級和道具；同一組題目可套不同遊戲模式 | **同一份題庫、多種玩法**；收集角色 | 以多人同場競賽為主，單人 App 要改編 |
| **ABCmouse** | 完成活動拿票券，買頭像衣服、寵物、房間擺設；同一活動只有前 5 次給票；完成學習路徑一步給大獎勵 | **重複刷同一題有上限**；裝扮頭像和房間 | — |
| **Habitica（習慣 RPG）** | 完成任務得金幣、經驗、隨機掉落蛋和食物，寵物長大變坐騎；沒完成每日任務會扣血 | 蛋→寵物→坐騎的養成線；隨機掉落 | **扣血懲罰**不適合小孩 |

**研究面的提醒：** 外在獎勵可能降低原本的學習興趣（過度理由效應（overjustification effect），Lepper 等 1973 年對兒童的經典研究）。2023 年《International Journal of Serious Games》的回顧指出，遊戲化研究結果大多沒有定論，失敗常見原因是只靠點數、徽章、排行榜。

**對 book-en 的原則：**
1. **XP 只記錄學習成果，不能花**；遊戲幣用來買外觀，兩者分開（同 Duolingo）。
2. **獎勵綁在「間隔重複到期的字答對」，不是答題數量**。練習模式、重複刷同一題，獎勵有上限（同 ABCmouse 的前 5 次）。
3. **不懲罰。** 不扣血、不扣能量、不限次數；連續天數斷了不歸零到難看的數字，並且有免費的保護。
4. **獎勵大多是「看得到的成長」**：角色長大、圖鑑變滿、房間變漂亮，而不是只有數字。
5. **不做付費、不做真錢抽卡。** 寶箱的內容只是外觀，機率公開。

### 經濟系統

**經驗值（XP）→ 等級**
| 行為 | XP | 備註 |
|---|---|---|
| 複習到期的字答對 | 10 | 主要來源 |
| 複習到期的字答錯 | 2 | 鼓勵嘗試，不懲罰 |
| 練習模式答對 | 2 | 每天上限 50 XP |
| 收藏新字（📖 學習中） | 5 | 每天上限 20 個字 |
| 逐句精聽完整一句（S 重播後聽完） | 1 | 每天上限 50 |
| 完成今天全部到期複習 | 30 | 每日一次 |

- 等級曲線：升到下一級需要 `100 × 等級^1.5`，前期升得快，Lv.10 約要 2 週每天複習。

**遊戲幣（金幣）**
- 來源：答對到期的字 +2、完成每日任務、升級獎勵、連續天數里程碑（3／7／30 天）。
- 用途：角色裝扮、寵物食物、房間擺設、連續天數保護（也可以每週免費一次）。
- 全部記在 **流水帳**（每筆收支一列），餘額由流水帳加總，方便查錯和做家長報表。

### 角色與寵物

- **角色：** 小孩自己取名、選外型。Lv.5、10、20 解鎖新造型。
- **寵物（主打）：** 複習「孵蛋」→ 寵物 → 長大進化（Habitica 的養成線）。
  - 寵物的成長值來自 **到期複習答對**，所以養寵物就等於做間隔重複。
  - 寵物不會死、不會生病，只會「很想你」（久沒來時的表情）。
- **美術：** 先用 SVG 分層（身體、帽子、衣服、配件）組合，不用外部圖片；之後可換成 CC0 素材（例如 Kenney 的素材包）。

### 新玩法（考試模式）

同一份「到期的字」可以選不同玩法（同 Blooket 的做法），都還是寫進 SM-2 排程：

1. **怪物對戰（Prodigy 式）：** 每一題是一次攻擊，答對造成傷害，連續答對有加成（連擊）。到期的字越多，怪物血量越厚。打倒王掉落蛋或金幣。答錯怪物只會「閃開」，不扣小孩的血。
2. **單字卡圖鑑（book-en 獨有）：** 每個學會的字（間隔 ≥ 21 天）變成一張卡片收進圖鑑，**稀有度直接用詞頻排名**：基礎字＝普通卡、建議學習＝稀有、罕見字＝傳說。卡片背面是原句和影片出處，點了可以回影片聽。
3. **限時挑戰：** 60 秒內答越多越好，看自己的最佳紀錄，不跟別人比。
4. **每日任務：** 每天 3 個小任務，例如「複習 10 個字」、「看一支影片精聽 5 句」、「收藏 3 個新字」，完成開寶箱。

**刻意不做：** 跟陌生人比的排行榜、扣愛心或能量、付費道具。家裡多個小孩的「家庭排行」可以當之後的選項。

### 家長與多使用者

- **多個學習檔案：** 兄弟姊妹共用一台電腦時，各自有收藏、複習排程、角色。這需要在 `items`、`review_log`、`word_status`、`seen_words` 等表加上 `profile_id`，是 M11 最大的資料庫改動。
- **家長頁（密碼保護）：** 看每個孩子的學習報表（每天複習數、學會的字、看了哪些影片）；可以關掉商店、設定每日上限。
- **影片內容：** App 直接開 youtube.com，小孩能看到任何影片。可以考慮預設開 YouTube 的「嚴格篩選模式」，或做「家長選好的影片清單」模式。

### 資料表（預計）

```
profiles(id, name, avatar_json, created_at)
xp_log(id, profile_id, at, kind, amount, ref)     -- 經驗流水帳
coin_log(id, profile_id, at, kind, amount, ref)   -- 金幣流水帳（花費為負數）
inventory(profile_id, item_id, qty, equipped)
pets(id, profile_id, species, stage, growth, name)
quests(profile_id, day, quest_id, progress, done)
collection(profile_id, lemma, rarity, unlocked_at) -- 單字卡圖鑑
```
- 獎勵一律在 Rust 端計算（例如 `review_grade` 回傳這題得到的 XP 和金幣），前端只負責顯示。

### 分階段

| 階段 | 內容 | 規模 |
|---|---|---|
| **G1 經驗與金幣** | 流水帳、等級、複習時跳出 +XP／+金幣的動畫、學習中心頂部顯示等級條 | 小 |
| **G2 每日任務＋連續天數** | 3 個任務、寶箱、連續天數保護 | 小 |
| **G3 角色與商店** | SVG 分層角色、商店、裝扮 | 中（美術最花時間） |
| **G4 寵物** | 蛋、孵化、進化，成長值綁到期複習 | 中 |
| **G5 怪物對戰＋圖鑑** | 新的考試玩法、單字卡收藏 | 中 |
| **G6 多使用者＋家長頁** | `profile_id` 遷移、報表、限制 | 大（資料庫遷移） |

如果主要使用者是小孩，可以把 G6 的「多使用者」提早到 G1 之前做。之後才加 `profile_id` 的話，要搬移所有已存在的資料。

### 要先決定的事

1. 目標年齡：國小低年級（多用圖示和語音）還是國小高年級到國中（可以有比較多文字）。
2. 家裡會不會有多個小孩共用一台電腦（決定 G6 要不要先做）。
3. 美術風格：可愛動物、像素風、或奇幻 RPG。
4. 遊戲化是否預設開啟，還是在設定裡另外開「兒童模式」，讓大人用的時候介面維持簡潔。

### 參考資料

- Duolingo 機制：<https://blog.duolingo.com/duolingo-101-how-to-learn-a-language-on-duolingo>、<https://nogood.io/2023/10/09/duolingo-case-study>
- Duolingo 能量取代愛心：<https://www.androidauthority.com/quitting-duolingo-energy-system-3599842/>、<https://www.change.org/p/duolingo-hearts-not-energy>
- Prodigy：<https://www.commonsensemedia.org/app-reviews/prodigy-kids-math-game>、<https://www.neilsquire.ca/prodigy-gamified-math/>
- Blooket／Gimkit：<https://www.differentiatedteaching.com/blooket>
- ABCmouse 票券：<https://support.abcmouse.com/hc/de/articles/360048194473-Replaying-Activities-and-Earning-Tickets-in-ABCmouse>
- Habitica：<https://gamedeveloper.com/design/gamified-productivity-habitica-rpg-overview>
- 過度理由效應與遊戲化研究：<https://journal.seriousgamessociety.org/index.php/IJSG/article/view/633>、<https://www.psychologyofgames.com/2016/10/the-overjustification-effect-and-game-achievements/>

---

## 5. 專案結構

```
book-en/
├─ package.json            # vite、react、typescript、@tauri-apps/cli
├─ vite.overlay.config.ts  # 面板 → 單一 IIFE：src-tauri/gen-overlay/overlay.js
├─ vite.hub.config.ts      # 學習中心 → dist/
├─ src/
│  ├─ overlay/             # 注入到 YouTube 的程式
│  │  ├─ boot.ts           #   最先執行：攔截 XHR/fetch、記錄字幕回應
│  │  ├─ youtube.ts        #   播放器操作：video、字幕軌、換影片偵測
│  │  ├─ cues.ts           #   json3 解析、ASR 合併成句
│  │  ├─ player-ctl.ts     #   逐句控制、快捷鍵
│  │  └─ ui/               #   React：Panel、SubtitleLayer、WordCard
│  ├─ hub/                 # 學習中心（本地視窗）：Vocab、Review、Stats
│  └─ shared/              # 型別、invoke 包裝、斷詞
└─ src-tauri/
   ├─ src/
   │  ├─ main.rs           # 視窗、注入、系統匣（參考 yt-float）
   │  ├─ db.rs             # SQLite schema 與 migration
   │  ├─ translate.rs
   │  ├─ dict.rs           # ECDICT + dictionaryapi.dev
   │  ├─ vocab.rs
   │  └─ review.rs         # SRS 排程
   ├─ resources/ecdict.db  # 離線英漢字典（首次啟動或建置時轉檔）
   └─ capabilities/        # main 視窗：只允許 youtube.com；hub 視窗：本地
```

**開發時的注入流程：** 正式版用 `include_str!` 嵌入打包好的 `overlay.js`；
開發版改為執行時讀檔 + `vite build --watch`，改 UI 不用重編 Rust。

---

## 6. 資料表（SQLite）

```sql
videos(id TEXT PK, title, channel, duration, last_pos REAL, opened_at)
cues(video_id, idx, start REAL, dur REAL, text, PRIMARY KEY(video_id, idx))
translations(text_hash TEXT, engine, target_lang, text, PRIMARY KEY(text_hash, engine, target_lang))
items(id INTEGER PK, kind TEXT CHECK(kind IN('word','phrase','sentence')),
      text, lemma, phonetic, audio_url, meaning_zh, meaning_en,
      context TEXT, video_id, t REAL, created_at, status TEXT)   -- status: learning/known
reviews(item_id PK, due_at, interval_days, ease, reps, lapses)
review_log(id PK, item_id, at, grade, quiz_kind)
```

---

## 7. 可直接沿用的資產

**從 yt-float**
- `main.rs` 的視窗建立、系統匣、`initialization_script` 注入模式
- `build.rs` 自訂指令 ACL 宣告（陷阱 7）、capability `remote` 設定（陷阱 1）
- keepalive 掛載（陷阱 2）、CDP 除錯流程與 `cdp_eval.py`
- GitHub Actions release workflow、圖示產生流程

**從 LingoTube PoC**
- 型別：`Cue`、`WordCard`、`VocabEntry`、`QuizQuestion`
- React 元件：WordPopup、VocabPage、QuizPage（改成走 Tauri invoke）
- 已修好的斷詞邏輯（標點位置、彎引號）、`speak()` 發音退回 TTS
- 翻譯與字典的錯誤處理、重試、備援邏輯（改寫成 Rust）

---

## 8. 風險與對策

| 風險 | 影響 | 對策 |
|---|---|---|
| YouTube 改版（DOM、播放器 API、字幕請求格式） | 字幕或面板失效 | 相關程式集中在 `youtube.ts` / `boot.ts`；保留三層字幕來源；CDP 除錯流程 |
| 攔截不到字幕（PO token、實驗性改版） | 核心功能失效 | **M1 優先驗證**；備案同源 fetch；後備 SRT |
| `claude -p` 速度與用量（每次呼叫有啟動成本、受 Claude 方案用量限制） | 長影片翻譯慢 | 先翻目前位置附近；大批次減少呼叫次數；SQLite 快取；預設 haiku |
| 使用者沒裝或沒登入 Claude Code | 無法翻譯 | 啟動偵測並提示；英文字幕、查字典、收藏不受影響 |
| 遠端頁面可呼叫 Rust 指令 | 安全 | capability 限定 youtube.com；指令參數驗證；不開檔案系統 / shell 權限 |
| Linux WebKitGTK 播 YouTube 不佳 | Linux 體驗差 | 以 Windows 為主、macOS 次之；Linux 列為不保證 |
| YouTube 服務條款 | 法律 | 個人學習用途；不下載影片、不散佈字幕 |

---

## 9. 第一步（M0）具體工作

1. `npm create tauri-app` 等效的最小骨架（不用框架模板，手動加 Vite + React）
2. 主視窗開 youtube.com，注入 `overlay.js`，畫一個 Shadow DOM 面板
3. capability：`remote.urls = ["https://*.youtube.com/*"]` + 自訂指令 `ping`
4. 面板按鈕 → `invoke('ping')` → 顯示回應
5. 換影片（SPA 導航）後確認面板仍在
6. 寫 `README_AI.md`，延續 yt-float 的踩坑紀錄習慣
