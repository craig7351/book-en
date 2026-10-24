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

**進度（2026-10-24）**：M0–M7 ✅、M9 詞頻分級 ✅、M10 單字卡例句 ✅、字典遺失時可下載 ✅、M11 寵物養成 P1–P5 ✅（驗收紀錄與踩坑見 `README_AI.md`）。
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

## 4.7 M11 遊戲化：寵物養成（計畫）

> 目標：讓學習者（國中以上）願意每天回來複習。**獎勵對齊「真的學會」**，不是「點很多下」。
> 狀態：P1–P5 已實作（2026-10-24）。和計畫不同的地方：
> - sprite 改用「程式化繪製」（橢圓、多邊形＋自動描邊、陰影），不是逐格文字；同一套形狀依階段放大，越長越細緻（`src/shared/sprites.ts`）。
> - 慶祝視窗只在孵化、進化、滿級時跳出；一般升級在複習頁的陪伴列顯示一行。
> - 每次升級另外 +5 金幣。

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

### 定案（2026-10-24）

| 項目 | 決定 |
|---|---|
| 主玩法 | **寵物養成**（其他玩法之後再說） |
| 目標年齡 | 國中以上：文字可以多一點，語氣不要太幼稚，系統可以有點深度（進化分支、圖鑑） |
| 使用者 | 單人，一台電腦一位學習者，不做多使用者和家長頁 |
| 美術 | 像素可愛風 |
| 開關 | 「遊戲模式」**預設關閉**。關閉時所有遊戲介面都不出現，成人介面維持現在的樣子 |

### 遊戲模式開關

- 位置：學習中心「設定 → 一般 → 遊戲模式」，附一句說明和預覽圖。
- **關閉時（預設）：**
  - 不顯示任何寵物、金幣、動畫，也不新增分頁。
  - 背景也不累積獎勵，資料庫不寫入任何遊戲資料。
- **第一次打開時：**
  - 從三顆蛋選一顆。
  - 送一份「起始禮包」，依過去的複習紀錄（`review_log`）換算金幣，有上限，讓本來就有在學的人不會覺得從零開始。
- **之後關掉：** 遊戲資料保留但全部隱藏，再打開就接著玩。

### 核心循環

```
到期的字答對 ──► 寵物經驗 ＋ 金幣 ──► 寵物長大、進化
      ▲                                   │
      └──── 想看下一階段、收集新寵物 ◄────┘
```

**只有「到期的字」答對才會讓寵物長大。** 想讓寵物長大，就得照間隔重複的排程複習。

### 寵物

**蛋 → 孵化**
- 蛋需要「暖蛋」才會孵化：到期複習答對 30 題，大約 2～3 天的正常複習量。
- 取得蛋的方式：開啟遊戲時選一顆、連續天數里程碑（7／30／100 天）、商店每週換一顆（用金幣買）。

**成長：三個階段，等級 1～30**
| 階段 | 等級 | 外觀 |
|---|---|---|
| 寶寶 | 1–9 | 16×16 像素，圓滾滾 |
| 少年 | 10–19 | 24×24 |
| 成年 | 20–30 | 32×32，**依學習方式決定進化分支** |

**進化分支（國中以上會在意的深度）：** 從少年進化成成年時，看這段期間你**怎麼學**來決定型態。
| 分支 | 條件（佔比最高的） | 例如 |
|---|---|---|
| 聽力型 | 「聽發音拼單字」和「句子聽力」答對 | 長出大耳朵、音波花紋 |
| 學者型 | 答對的字裡罕見字比較多 | 戴眼鏡、拿書 |
| 毅力型 | 這段期間連續天數最長 | 盔甲、披風 |
| 均衡型 | 都差不多 | 原本型態的進階版 |

- 圖鑑會顯示「還沒發現的型態」的剪影，讓人想換一種學法再養一隻。

**心情（不會死、不會懲罰）**
- 寵物有三種表情：開心（今天有複習）、普通（1～2 天沒來）、想你（3 天以上沒來）。
- 心情只影響外觀，不會扣經驗、不會生病、不會逃走。

**多隻寵物**
- 可以有很多隻，但一次只有一隻「陪伴中」，**只有陪伴中的會成長**。
- 養滿一隻就會想孵下一顆蛋 → 持續複習。

**閃亮版（shiny）**
- 孵化時 1/64 機率出現換色版，純外觀。機率寫在圖鑑上，不能用金幣提高。

### 經驗與金幣

| 行為 | 寵物經驗 | 金幣 | 上限 |
|---|---|---|---|
| 到期複習答對 | 10 | 2 | 無（到期數本來就有限） |
| 到期複習答錯 | 2 | 0 | 無 |
| 練習模式答對 | 1 | 0 | 每天 30 經驗 |
| 收藏新字 | 0 | 1 | 每天 20 枚 |
| 完成今天全部到期複習 | 30 | 10 | 每天一次 |
| 連續天數里程碑 | — | 50／200／500 | 7／30／100 天 |

- 升級所需經驗：`25 × 等級^1.2`。以每天 20 題到期複習、答對率 80%（約 200 經驗）估算：Lv.10 約 8 天，Lv.20 約 40 天，Lv.30 約 100 天。
- **連續天數：** 當天至少完成 10 題到期複習（或完成當天全部到期複習）就算一天。每週免費一次「連續保護」，可以再用金幣多買一次。

**金幣用途：**
- **點心：** 當天到期複習的經驗 ×1.2。只加成學習得到的經驗，不能直接買經驗。
- **配件：** 帽子、眼鏡、圍巾等，像素疊圖，每隻寵物都能戴。
- **小屋背景：** 寵物待的場景，例如書房、海邊、太空。
- **蛋：** 商店每週換一顆。
- **其他：** 改名免費，多買一次連續保護。

### 畫面（遊戲模式開啟時才有）

1. **學習中心：**
   - 多一個「寵物」分頁：小屋場景（寵物待機動畫和配件）、等級條、成長紀錄、圖鑑、商店、背包。
   - 頂部角落顯示一隻小寵物和金幣數。
2. **複習頁：**
   - 側邊顯示陪伴中的寵物：答對開心跳一下，答錯歪頭（不是難過）。
   - 每題飄出「+10 經驗 +2 金幣」。
   - 結束頁加一行「小球 獲得 180 經驗，再 40 經驗升級」。
3. **YouTube 面板（另有開關，預設關）：** 面板角落的迷你寵物，收藏單字時會反應。
4. **音效（另有開關，預設關）：** 8-bit 短音效（答對、升級、孵化），用 WebAudio 即時合成，不需要音檔。

### 像素美術怎麼做

- **sprite 用文字格子＋調色盤寫在程式碼裡**，例如 `"..11..", ".1221."`，每個字元對應一個顏色。
  - 自己畫的，沒有授權問題，檔案也很小。
  - 換調色盤就能做閃亮版和分支配色。
  - 可以用 git 追蹤每個像素的修改。
- **畫面輸出：** 用 canvas 畫成圖片並快取，CSS `image-rendering: pixelated` 放大 4 倍，保持像素清楚。
- **動畫：** 待機時 2 格上下彈跳；開心跳、歪頭、孵化各有幾格。
- **第一批素材：**
  - 4 個物種 × 寶寶、少年 2 階段 × 2 格待機。
  - 4 個物種 × 4 個成年分支。
  - 4 種蛋、10 個配件、4 個小屋背景。
- **預覽：** 開發時用 `tools/sprites.html` 一次看所有 sprite，方便調整。
- 之後如果想要更精緻，可以把同一套資料格式換成請人繪製的圖，程式不用改。

### 資料表（只在遊戲模式開啟後建立或寫入）

```
pets(id, species, nickname, stage, level, xp, branch, shiny, hatched_at, active)
eggs(id, species, warmth, obtained_at, source)
coin_log(id, at, amount, kind, ref)          -- 金幣流水帳，花費為負數；餘額 = 加總
pet_xp_log(id, pet_id, at, amount, kind, ref) -- 寵物經驗流水帳（也用來判斷進化分支）
inventory(item_id, qty, equipped_on)          -- 配件、點心、背景
game_daily(day, xp_practice, coins_collect, all_due_done, streak_saved)  -- 每日上限與連續天數
```
- 遊戲設定（開關、子開關）放在現有的 `settings` 表。
- **獎勵一律在 Rust 端算：** `review_grade` 在遊戲模式開啟時，多回傳這題得到的經驗、金幣、是否升級或孵化。前端只負責動畫。
- 進化分支用 `review_log` 的題型和 `pet_xp_log` 統計，不需要另外記錄。

### Rust 指令（新檔 `game.rs`）

`game_state`、`game_enable`（選蛋＋起始禮包）、`game_disable`、`pet_set_active`、`pet_rename`、`shop_list`、`shop_buy`、`item_use`（點心、配件）、`streak_info`。

### 分階段

| 階段 | 內容 | 完成時可以 |
|---|---|---|
| **P1 開關＋第一隻寵物** | 遊戲模式開關、選蛋、暖蛋、孵化、成長到少年；複習時 +經驗動畫；寵物分頁（小屋＋等級條）；1 個物種的 sprite | 開啟遊戲 → 複習 → 看到蛋孵化、寵物長大 |
| **P2 金幣與連續天數** | 金幣流水帳、連續天數和保護、點心、完成每日到期的獎勵 | 每天回來有東西可以期待 |
| **P3 進化與圖鑑** | 4 個物種、成年 4 分支、圖鑑剪影、閃亮版、多隻寵物切換 | 養成有長期目標 |
| **P4 商店與裝扮** | 配件、小屋背景、每週蛋 | 金幣有地方花 |
| **P5 陪伴與音效** | YouTube 面板迷你寵物、8-bit 音效（兩個都是另外的開關） | 看影片時也有陪伴感 |

P1 先只做 1 個物種，確認整個流程好玩、數值合理，再補美術。

### 測試

- Rust 單元測試：獎勵規則、每日上限、跨日（以本機時區午夜切換）、連續天數與保護、進化分支判斷。
- 數值模擬：用腳本模擬「每天 20 題、答對率 80%」跑 90 天，檢查升級和孵化的節奏。
- 實際操作：遊戲模式關閉時，學習中心、複習頁、YouTube 面板跟現在完全一樣（截圖比對）。

### 參考資料

- Duolingo 機制：<https://blog.duolingo.com/duolingo-101-how-to-learn-a-language-on-duolingo>、<https://nogood.io/2023/10/09/duolingo-case-study>
- Duolingo 能量取代愛心：<https://www.androidauthority.com/quitting-duolingo-energy-system-3599842/>、<https://www.change.org/p/duolingo-hearts-not-energy>
- Prodigy：<https://www.commonsensemedia.org/app-reviews/prodigy-kids-math-game>、<https://www.neilsquire.ca/prodigy-gamified-math/>
- Blooket／Gimkit：<https://www.differentiatedteaching.com/blooket>
- ABCmouse 票券：<https://support.abcmouse.com/hc/de/articles/360048194473-Replaying-Activities-and-Earning-Tickets-in-ABCmouse>
- Habitica：<https://gamedeveloper.com/design/gamified-productivity-habitica-rpg-overview>
- 過度理由效應與遊戲化研究：<https://journal.seriousgamessociety.org/index.php/IJSG/article/view/633>、<https://www.psychologyofgames.com/2016/10/the-overjustification-effect-and-game-achievements/>

---

## 4.8 M12 Kokoro：離線的自然語音（計畫）

> 目標：句子也能用自然的英文語音念，**不用帳號、不用金鑰、離線可用**，取代電腦內建語音。
> 狀態：計畫中。可行性測試已做（2026-10-25，測試腳本與樣本在開發機的暫存資料夾，未進版控）。

### 為什麼是 Kokoro

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)：8,200 萬參數的開源語音模型，**Apache-2.0**，英文 28 個聲音（美式 20、英式 8）。
- 官方提供 ONNX 版（[onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)），可以用 ONNX Runtime 在 CPU 上跑。
- 比較：Azure／Google 要帳號和金鑰；系統語音在這台電腦根本沒有英文。

### ⚠️ 不能直接用 kokoro-js

官方的 JavaScript 套件 kokoro-js 用 `phonemizer` 套件把文字轉成音標，它裡面是 **eSpeak NG（GPL-3.0）**。
包進 App 會讓 book-en 的散布要遵守 GPL，和 MIT 授權衝突。→ **改用 Kokoro 作者自己的 G2P 詞典 [misaki](https://github.com/hexgrad/misaki)（Apache-2.0）**，不用 eSpeak。

### 可行性測試結果（Node + onnxruntime-node，16 核 CPU）

**1. 不用 eSpeak 可以運作**：misaki 詞典查音標 → 對照 `config.json` 的 vocab 轉成 token → 模型 → 24 kHz 音訊。

**2. 速度（念一句 3.7 秒的句子要算多久）：**
| 模型檔 | 大小 | 時間 | 倍速 |
|---|---|---|---|
| `model_quantized.onnx`（8-bit） | 92 MB | 2,270 ms | 0.6× 即時（比念的還慢） |
| `model_q8f16.onnx` | 86 MB | 2,340 ms | 0.6× |
| **`model_fp16.onnx`** | **163 MB** | **750 ms** | **5× 即時** |

8-bit 量化版在 CPU 上反而慢 3 倍（量化對這個模型的卷積層沒幫助）。調 CPU 執行緒數沒有差別。

**3. 詞典涵蓋率**：用 App 的 52,841 句 Tatoeba 例句測，查不到的字只有 **0.72%**（4.5% 的句子有至少一個）。
查不到的主要是：縮寫（TV、PC、USA）、`-ies` 複數（countries、cities）、`'ve` `'re` 縮寫、人名地名、序數（5th）。前幾類補規則就能解決，剩下的人名用拼讀規則備援。

**4. 要另外處理**：冠詞 a（ɐ）、the 在母音前（ði）、多音字（read、live：詞典有依詞性的版本，先用預設值）、數字轉英文。英式聲音要用英式詞典（`gb_gold` / `gb_silver`）。

### 架構

```
畫面（speak.ts）── invoke('tts_kokoro', 文字, 聲音, 速度) ──► Rust
                                                            ├ G2P：misaki 詞典（記憶體裡）＋規則
                                                            ├ ONNX Runtime（ort crate）跑 Kokoro
                                                            ├ 編成 WAV（或 Ogg）
                                                            └ 磁碟快取：同一句不重算
畫面拿到音訊 → <audio> 播放；念到哪個字用「時間比例」估計
```

- **在 Rust 跑，不在網頁裡跑**：YouTube 面板和學習中心都能用同一個指令；原生 ONNX Runtime 比網頁版 WASM 快很多；YouTube 頁面不用載入大型 WASM。
- **字詞亮起來**：模型不輸出每個字的時間 → 依各字音標長度占整句的比例，對照播放時間估算。
- **快取**：`app_data/tts-cache/`，鍵 = 文字＋聲音＋速度的雜湊，上限 200 MB，舊的先刪。
- **長句**：模型一次最多 510 個 token → 依標點切段，分段算、接起來。

### 下載（和離線字典同一套做法）

App 本體不變大，在「設定 → 發音」按「下載 Kokoro 語音」才下載：
| 檔案 | 大小 | 來源 |
|---|---|---|
| 模型（fp16） | 163 MB | Hugging Face（固定版本＋sha256） |
| misaki 詞典（美式＋英式） | 約 13 MB（壓縮後約 3 MB） | GitHub（固定版本＋sha256） |
| 聲音檔 | 每個 0.5 MB，先放 8 個約 4 MB | Hugging Face |
| ONNX Runtime 函式庫 | 約 10–15 MB | 見下方「要決定的事」2 |

### 設定畫面

「發音」區多一個「語音合成引擎」：
- 系統語音（現在的做法）
- **Kokoro（離線自然語音）**：沒下載時顯示下載按鈕和進度；下載後可以選聲音（美式女 Heart、Bella，美式男 Michael、Fenrir，英式女 Emma，英式男 George…），每個都能試聽。
- 「口音」設定一起套用：美式口音預設 Heart，英式預設 Emma。
- 單字的「真人錄音優先」照舊；沒有錄音時用 Kokoro 念。

### 分階段

| 階段 | 內容 |
|---|---|
| **K1 Rust 引擎** | `ort` 載入模型（第一次用到時才載入）、G2P（詞典＋規則＋數字）、`tts_kokoro` 指令、WAV 輸出；單元測試（音標、token、長句切段） |
| **K2 下載** | manifest（網址、sha256、大小）、進度、放到 App 資料夾；下載完不用重開 |
| **K3 畫面** | 設定的引擎和聲音選單、試聽；`speak.ts` 改走 Kokoro；🔊 按下到出聲之間顯示轉圈；字詞亮起來 |
| **K4 收尾** | 磁碟快取、CI 三平台（ONNX Runtime 各平台的函式庫）、貢獻頁標註（Kokoro、misaki、ONNX Runtime 授權） |

### 風險

- **較慢的電腦**：測試機 16 核，一句約 0.4–1.2 秒；4 核筆電可能 2–3 秒。對策：快取、先念短句、顯示轉圈。
- **G2P 品質**：沒有 eSpeak，詞典查不到的字（多半是人名）靠規則，可能念錯；多音字依詞性可能選錯。
- **ONNX Runtime 跨平台**：Windows 已驗證（Node 版），macOS／Linux 要在 CI 驗證。
- **記憶體**：模型載入後約 300–400 MB，閒置一段時間後釋放。

### 要決定的事

1. **模型用哪個**：fp16（163 MB、快，**建議**）或 q8f16（86 MB、念一句要等 2 秒以上）。
2. **ONNX Runtime 放哪裡**：跟模型一起下載（安裝檔維持約 18 MB，**建議**）或直接包進安裝檔（安裝檔變約 35 MB，但比較單純）。
3. **預設聲音**：先聽樣本再決定。

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
