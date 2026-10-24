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

**進度（2026-10-24）**：M0–M7 ✅、M9 詞頻分級 ✅（驗收紀錄與踩坑見 `README_AI.md`）。下一步 M8 打磨與發佈。

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
