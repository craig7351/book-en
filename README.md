# book-en

用 YouTube 學英文的桌面 App。直接在真正的 youtube.com 上加入雙語字幕、逐句精聽、點字查詢、單字分級，以及單字庫與間隔重複複習。

技術：Tauri v2 + 系統 WebView（Windows 上是 WebView2）。App 載入 youtube.com，再把學習介面（React）注入頁面。

## 功能

**看影片（YouTube 頁面）**
- **雙語字幕：** 英文字幕自動斷句，中文字幕可選以下來源：
  - YouTube 中文字幕
  - Google 自動翻譯
  - AI 翻譯（Claude）
  - 已存檔的翻譯
- **逐句精聽：**
  - 每句自動暫停、重播、循環，調整速度
  - 快捷鍵：<kbd>A</kbd> 上一句、<kbd>S</kbd> 重播、<kbd>D</kbd> 下一句
- **單字分級：** 依 wordfreq 詞頻排名，把字幕裡的字標成基礎、建議學習、罕見三級，你的程度可以自己設。
- **點字查詢：** 單字卡內容如下：
  - 中文釋義、音標、原形（running → run）、考試標籤
  - 英英釋義和發音
  - AI 句中解釋
- **例句：**
  - 本片其他含這個字的句子，可以只播那一句
  - 離線例句庫（Tatoeba）
  - AI 例句
- **其他：** 網址列、上一頁／下一頁、書籤、字幕大小調整

**學習中心（獨立視窗）**
- **單字庫：** 收藏的單字和句子，點一下就跳回影片中出現的那一秒。
- **複習：** 用 SM-2 間隔重複，共有 4 種題型。
- **詞彙：** 依常用度分區瀏覽，可以整區標成「已知」。
- **設定：** 包括資料來源與授權（「貢獻」分頁）。

**遊戲模式（選用，預設關閉）**
- 在「設定 → 一般 → 遊戲模式」開啟，關閉時所有遊戲畫面都會隱藏。
- **寵物養成：** 選一顆蛋，到期複習答對 30 題就孵化。寵物從寶寶、少年長到成年，成年的樣子看少年期怎麼學決定（聽力型、學者型、毅力型、均衡型）。
- **只有「到期的字」答對才會讓寵物長大**，所以養寵物就等於照間隔重複的排程複習。
- **金幣：** 用來買配件、小屋場景、點心（當天經驗 ×1.2）和連續天數保護。
- **其他：** 4 個物種、圖鑑、1/64 機率的閃亮版、YouTube 面板的迷你寵物、8-bit 音效（後兩者另有開關）。
- 像素圖全部由程式繪製，沒有外部圖檔。

## 安裝

1. 從 [Releases](https://github.com/craig7351/book-en/releases) 下載對應平台的安裝檔：

   | 平台 | 檔案 |
   |---|---|
   | Windows | `book-en_x.y.z_x64-setup.exe` |
   | macOS（Apple 晶片／Intel） | `book-en_x.y.z_aarch64.dmg` ／ `book-en_x.y.z_x64.dmg` |
   | Linux | `.deb` 或 `.AppImage` |

   macOS 版沒有簽章：第一次開啟會被擋，請到「系統設定 → 隱私權與安全性」按「強制打開」。
2. 第一次開啟時，如果找不到離線字典，App 會詢問要不要從 [GitHub Release `dict-v1`](https://github.com/craig7351/book-en/releases/tag/dict-v1) 下載。下載檔約 22 MB，解壓後 50 MB，App 會自動驗證檢查碼。
   - 選擇不下載也能用：看影片、字幕、翻譯、英英釋義、AI 功能、收藏和複習都照常。
   - 沒有字典時不能用的功能：中文釋義、單字分級、詞彙頁、例句庫。

### AI 功能（選用）

AI 翻譯、AI 解釋、AI 例句會呼叫本機的 [Claude Code](https://www.anthropic.com/claude-code) CLI（`claude -p`），用你已登入的帳號，不需要 API key。

- 先安裝 Claude Code，並在終端機登入一次。
- 模型可以在設定裡選（預設 Haiku）。
- 翻譯結果會存檔，同一支影片不會重複翻譯。

## 從原始碼建置

需要 [Node.js](https://nodejs.org) 22.5 以上（建字典的腳本用到 `node:sqlite`）和 [Rust](https://rustup.rs)，Windows 另需 WebView2（Windows 11 內建）。

```bash
npm install

# 離線字典：打包時會一起放進安裝檔，請先準備好
node tools/fetch-dict.mjs   # 下載並驗證 → src-tauri/resources/ecdict.db

npm run dev      # 開發版
npm run build    # 正式版 → src-tauri/target/release/bundle/nsis/
```

- 改了注入頁面（`src/overlay`）：重跑 `npm run build:overlay`，再重開 App。開發版每次啟動都會重新讀取，不用重新編譯 Rust。
- 改了學習中心（`src/hub`）：要 `npm run build:hub`，再重新編譯 Rust。這部分是編譯時嵌進程式的。
- 測試：`cargo test --manifest-path src-tauri/Cargo.toml`

### 自己重建離線字典

```bash
# 1. ECDICT 英漢詞典
curl -L -o .cache/ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
node tools/build-ecdict.mjs

# 2. 詞頻排名與 3. Tatoeba 例句（Python）
python -m venv .cache/venv
.cache/venv/Scripts/python -m pip install wordfreq opencc-python-reimplemented
.cache/venv/Scripts/python tools/build-freq.py
.cache/venv/Scripts/python tools/build-examples.py    # Tatoeba 資料的下載方式見腳本開頭

# 4. 壓縮並更新 src-tauri/dict-manifest.json 的檢查碼
node tools/package-dict.mjs
```

順序不能換，因為 `build-ecdict.mjs` 會重建整個資料庫。

字典內容有變動時，要發新的 Release（例如 `dict-v2`），並更新 `dict-manifest.json` 的網址。不要覆蓋舊檔，否則舊版 App 比對檢查碼會失敗。

## 專案結構

```
src/overlay/     注入 youtube.com 的介面：字幕擷取、雙語字幕、面板、單字卡
src/hub/         學習中心：單字庫、複習、詞彙、設定、字典下載
src/shared/      共用：API、型別、分級、斷詞、朗讀
src-tauri/src/   Rust 後端：SQLite、字典、翻譯（claude -p）、複習排程、字典下載
tools/           建字典的腳本、CDP 測試工具
```

資料位置：
- 使用者資料庫：`%APPDATA%\dev.booken.app\book-en.db`，存設定、收藏、複習紀錄、翻譯快取。
- AI 字幕存檔：Windows 存在 exe 同目錄的 `subtitles\`，不能寫入時改存 `%APPDATA%\dev.booken.app\subtitles\`；其他平台存在 App 資料夾的 `subtitles/`。
- App 資料夾：macOS 是 `~/Library/Application Support/dev.booken.app/`，Linux 是 `~/.local/share/dev.booken.app/`。

開發筆記與踩過的坑在 [`PLAN.md`](PLAN.md)、[`README_AI.md`](README_AI.md)。

## 平台支援

| 平台 | 狀態 |
|---|---|
| Windows 10 / 11 | ✅ 主要開發與測試平台 |
| macOS 10.13+ | ⚠️ 由 GitHub Actions 打包，尚未實機測試 |
| Linux | ⚠️ 由 GitHub Actions 打包，尚未實機測試。YouTube 播放需要 GStreamer 解碼套件（deb 安裝時會一併安裝），系統朗讀不一定支援 |

### 發布新版

1. 修改 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的版本號。
2. 推送標籤：`git tag v0.2.0 && git push origin v0.2.0`。
3. GitHub Actions 會打包 Windows、macOS（Apple 晶片與 Intel）、Linux，並建立**草稿** Release。確認後到 GitHub 上按發布。

只想試打包、不發布：在 Actions 頁面手動執行 `build`，安裝檔會放在該次執行的 Artifacts。

## 授權

程式碼以 [MIT](LICENSE) 授權釋出。離線字典（`ecdict.db`）包含第三方資料，依各自的授權散布：

- [ECDICT](https://github.com/skywind3000/ECDICT)：MIT
- [wordfreq](https://github.com/rspeer/wordfreq)：資料採 CC BY-SA 4.0，其中包含 SUBTLEX、OpenSubtitles 等語料。由它衍生的排名資料同樣以 CC BY-SA 4.0 提供。
- [Tatoeba](https://tatoeba.org)：CC BY 2.0 FR
- [Free Dictionary API](https://dictionaryapi.dev)、[Datamuse](https://www.datamuse.com/api/)：線上英英釋義

完整清單見 App 的「設定 → 貢獻」。

YouTube 影片與字幕的權利屬於 YouTube／Google 和原作者。book-en 只在播放器內讀取字幕供個人學習，不下載影片，也不散布字幕。
