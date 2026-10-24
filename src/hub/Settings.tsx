import { useEffect, useState } from 'react'
import { api, errorText } from '../shared/api'
import { DEFAULT_LEVELS, fmtRank, KNOWN_MAX_OPTIONS, SUGGEST_MAX_OPTIONS } from '../shared/levels'
import { game, gameErrorText, type GameState } from '../shared/game'
import { Pixel } from '../shared/PixelArt'
import { eggSprite, petSprite, SPECIES, SPECIES_INFO, type Species } from '../shared/sprites'
import {
  ACCENT_LABEL,
  DEFAULT_VOICE,
  englishVoices,
  onVoicesChanged,
  speakSentence,
  speakWord,
  setVoicePrefs,
  type Accent,
} from '../shared/speak'
import { MODELS, type DictStatus } from '../shared/types'

type SubTab = 'general' | 'credits'

// 設定：一般 / 貢獻（資料來源與授權）
export function Settings({ gs, onGameChange }: { gs: GameState | null; onGameChange: () => void }) {
  const [sub, setSub] = useState<SubTab>('general')
  return (
    <section className="settings">
      <nav className="subtabs">
        <button className={sub === 'general' ? 'on' : ''} onClick={() => setSub('general')}>
          一般
        </button>
        <button className={sub === 'credits' ? 'on' : ''} onClick={() => setSub('credits')}>
          貢獻
        </button>
      </nav>
      {sub === 'general' ? <General gs={gs} onGameChange={onGameChange} /> : <Credits />}
    </section>
  )
}

// 偏好設定與 YouTube 面板共用（存在 Rust 端 settings 表的 prefs）
function General({ gs, onGameChange }: { gs: GameState | null; onGameChange: () => void }) {
  const [prefs, setPrefs] = useState<Record<string, unknown>>({})
  const [claude, setClaude] = useState<string>('檢查中…')
  const [dict, setDict] = useState<DictStatus | null>(null)

  useEffect(() => {
    api.dictStatus().then(setDict).catch(() => {})
    api
      .getSetting('prefs')
      .then((raw) => setPrefs(raw ? JSON.parse(raw) : {}))
      .catch(() => {})
    checkClaude()
  }, [])

  function checkClaude() {
    setClaude('檢查中…')
    api
      .claudeStatus()
      .then((v) => setClaude(`✓ 已安裝：${v}`))
      .catch((e) => setClaude(errorText(e)))
  }

  async function update(patch: Record<string, unknown>) {
    // 讀最新的再合併，避免蓋掉 YouTube 面板剛改的設定
    const raw = await api.getSetting('prefs').catch(() => null)
    const next = { ...(raw ? JSON.parse(raw) : {}), ...patch }
    setPrefs(next)
    setVoicePrefs(next)
    await api.setSetting('prefs', JSON.stringify(next))
  }

  return (
    <>
      <h2>翻譯</h2>
      <label className="row">
        <span>Claude 模型</span>
        <select value={(prefs.model as string) ?? 'haiku'} onChange={(e) => update({ model: e.target.value })}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        AI 翻譯與 AI 解釋使用本機的 Claude Code CLI（<code>claude -p</code>），用你已登入的帳號，不需要 API key。
        翻譯結果會存在 <code>subtitles</code> 資料夾（Windows 在 exe 同目錄，其他平台在 App 資料夾），同一支影片不會重複翻譯。
      </p>
      <div className="row">
        <span>Claude Code</span>
        <span>{claude}</span>
        <button onClick={checkClaude}>重新檢查</button>
      </div>

      <h2>離線字典</h2>
      <div className="row">
        <span>狀態</span>
        <span>{dict ? (dict.installed ? `✓ 已安裝${dict.hasExamples ? '（含例句庫）' : ''}` : '✗ 未安裝') : '檢查中…'}</span>
        <a className="btn-link" href="#dict">
          {dict?.installed ? '管理' : '下載字典'}
        </a>
      </div>

      <h2>單字分級</h2>
      <label className="row">
        <span>我的程度</span>
        <select
          value={(prefs.knownMax as number) ?? DEFAULT_LEVELS.knownMax}
          onChange={(e) => update({ knownMax: Number(e.target.value) })}
        >
          {KNOWN_MAX_OPTIONS.map((n) => (
            <option key={n} value={n}>
              最常用前 {fmtRank(n)} 字當成已會
            </option>
          ))}
        </select>
      </label>
      <label className="row">
        <span>建議學習到</span>
        <select
          value={(prefs.suggestMax as number) ?? DEFAULT_LEVELS.suggestMax}
          onChange={(e) => update({ suggestMax: Number(e.target.value) })}
        >
          {SUGGEST_MAX_OPTIONS.map((n) => (
            <option key={n} value={n}>
              第 {fmtRank(n)} 名（更後面算罕見）
            </option>
          ))}
        </select>
      </label>

      <VoiceSection prefs={prefs} update={update} />

      <GameSection gs={gs} onChange={onGameChange} />

      <h2>快捷鍵（YouTube 影片頁）</h2>
      <table className="keys">
        <tbody>
          <tr><td><kbd>A</kbd></td><td>上一句</td></tr>
          <tr><td><kbd>S</kbd></td><td>重播這一句</td></tr>
          <tr><td><kbd>D</kbd></td><td>下一句</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>L</kbd></td><td>網址列</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>關閉單字卡</td></tr>
          <tr><td><kbd>空白鍵</kbd></td><td>播放 / 暫停（YouTube 原生）</td></tr>
        </tbody>
      </table>
    </>
  )
}

const RATES = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2]
const IS_MAC = /Mac/i.test(navigator.userAgent)

// 發音：單字用真人錄音或語音合成、口音、系統語音、語速。所有發音（YouTube 面板、學習中心、複習）都照這裡
function VoiceSection({
  prefs,
  update,
}: {
  prefs: Record<string, unknown>
  update: (patch: Record<string, unknown>) => Promise<void>
}) {
  const [voices, setVoices] = useState(englishVoices)
  useEffect(() => {
    setVoices(englishVoices())
    return onVoicesChanged(() => setVoices(englishVoices()))
  }, [])
  const wordSource = (prefs.wordSource as string) ?? DEFAULT_VOICE.wordSource
  const accent = (prefs.accent as Accent) ?? DEFAULT_VOICE.accent
  const voiceName = (prefs.voiceName as string) ?? ''
  const rate = (prefs.voiceRate as number) ?? DEFAULT_VOICE.voiceRate
  const known = !voiceName || voices.some((v) => v.name === voiceName)

  return (
    <>
      <h2>發音</h2>
      <label className="row">
        <span>單字發音</span>
        <select value={wordSource} onChange={(e) => update({ wordSource: e.target.value })}>
          <option value="recording">字典的真人錄音（沒有錄音時用語音合成）</option>
          <option value="tts">一律用語音合成</option>
        </select>
      </label>
      <label className="row">
        <span>口音</span>
        <select value={accent} onChange={(e) => update({ accent: e.target.value })}>
          {(Object.keys(ACCENT_LABEL) as Accent[]).map((a) => (
            <option key={a} value={a}>
              {ACCENT_LABEL[a]}
            </option>
          ))}
        </select>
        <span className="muted small">真人錄音優先挑這個口音；聲音選「自動」時也依口音挑</span>
      </label>
      <label className="row">
        <span>語音合成的聲音</span>
        <select value={known ? voiceName : ''} onChange={(e) => update({ voiceName: e.target.value })}>
          <option value="">自動（依口音挑）</option>
          {voices.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name.replace(/^Microsoft /, '')}（{v.lang}・{v.localService ? '離線' : '線上'}）
            </option>
          ))}
        </select>
      </label>
      <label className="row">
        <span>語速</span>
        <select value={rate} onChange={(e) => update({ voiceRate: Number(e.target.value) })}>
          {RATES.map((r) => (
            <option key={r} value={r}>
              {r}×{r === DEFAULT_VOICE.voiceRate ? '（預設）' : ''}
            </option>
          ))}
        </select>
        <span className="muted small">例句的「慢速」會再放慢一點</span>
      </label>
      <div className="row">
        <span>試聽</span>
        <button onClick={() => void speakWord('pronunciation')}>🔊 單字 pronunciation</button>
        <button onClick={() => speakSentence('Practice makes perfect, so keep listening every day.')}>🔊 句子</button>
      </div>
      {voices.length === 0 && (
        <div className="voice-warn">
          <b>這台電腦沒有英文語音</b>：句子（和沒有真人錄音的單字）會用其他語言的語音念，聽起來會不準。
          {IS_MAC ? (
            <>安裝方式：系統設定 → 輔助使用 → 朗讀內容 → 系統聲音 → 管理聲音 → 勾選英文聲音。</>
          ) : (
            <>
              安裝方式：Windows 設定 → 時間與語言 → 語音 → 「管理語音」的「新增語音」→ 選 English (United States)（或英國、澳洲），
              裝好後重新開啟 book-en。
            </>
          )}
        </div>
      )}
      <p className="muted small">
        語音合成用的是這台電腦安裝的語音（book-en 內嵌的瀏覽器元件沒有 Edge 瀏覽器的「線上自然語音」）。
        單字的真人錄音來自 dictionaryapi.dev 與維基詞典（Wikimedia Commons），需要網路；收藏時會記下錄音網址。
      </p>
    </>
  )
}

// 遊戲模式：預設關閉；第一次打開時選一顆蛋
function GameSection({ gs, onChange }: { gs: GameState | null; onChange: () => void }) {
  const [picking, setPicking] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const on = !!gs?.options.enabled

  async function run(fn: () => Promise<unknown>) {
    setMsg(null)
    try {
      await fn()
      onChange()
    } catch (e) {
      setMsg(gameErrorText(e))
    }
  }

  function toggle() {
    if (on) return void run(() => game.disable())
    // 第一次（沒有寵物也沒有蛋）要先選蛋
    if (gs && !gs.pets.length && !gs.eggs.length) return setPicking(true)
    void run(() => game.enable())
  }

  return (
    <>
      <h2>遊戲模式</h2>
      <label className="row switch-row">
        <span>寵物養成</span>
        <input type="checkbox" checked={on} onChange={toggle} />
        <span className="muted small">{on ? '開啟' : '關閉'}</span>
      </label>
      <p className="muted">
        開啟後，「到期的字」複習答對會讓寵物長大、賺金幣買配件。關閉時所有遊戲畫面都會隱藏，資料會保留。
      </p>
      {on && gs && (
        <>
          <label className="row switch-row">
            <span>YouTube 面板陪伴</span>
            <input
              type="checkbox"
              checked={gs.options.companion}
              onChange={(e) => run(() => game.options({ companion: e.target.checked }))}
            />
            <span className="muted small">在影片旁的面板角落顯示迷你寵物</span>
          </label>
          <label className="row switch-row">
            <span>8-bit 音效</span>
            <input
              type="checkbox"
              checked={gs.options.sound}
              onChange={(e) => run(() => game.options({ sound: e.target.checked }))}
            />
            <span className="muted small">答對、升級、孵化時的短音效</span>
          </label>
        </>
      )}
      {msg && <p className="msg error">{msg}</p>}
      {picking && (
        <EggPicker
          onCancel={() => setPicking(false)}
          onPick={(s) => {
            setPicking(false)
            void run(() => game.enable(s))
          }}
        />
      )}
    </>
  )
}

function EggPicker({ onPick, onCancel }: { onPick: (s: Species) => void; onCancel: () => void }) {
  const [hover, setHover] = useState<Species | null>(null)
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal egg-picker" onClick={(e) => e.stopPropagation()}>
        <h2>選一顆蛋</h2>
        <p className="muted">到期複習答對 30 題就會孵化。之後還能拿到其他的蛋。</p>
        <div className="eggs">
          {SPECIES.map((s) => (
            <button key={s} className="egg-choice" onMouseEnter={() => setHover(s)} onFocus={() => setHover(s)} onClick={() => onPick(s)}>
              <Pixel sprite={hover === s ? petSprite({ species: s, stage: 1, mood: 'happy' }) : eggSprite(s)} scale={3} />
              <b>{SPECIES_INFO[s].name}</b>
              <span className="muted small">{SPECIES_INFO[s].desc}</span>
            </button>
          ))}
        </div>
        <button onClick={onCancel}>先不要</button>
      </div>
    </div>
  )
}

interface Credit {
  name: string
  url: string
  license: string
  use: string
  note?: string
}

const DATA: Credit[] = [
  {
    name: 'wordfreq',
    url: 'https://github.com/rspeer/wordfreq',
    license: '程式 Apache-2.0；資料 CC BY-SA 4.0（creativecommons.org/licenses/by-sa/4.0）',
    use: '單字詞頻排名與分級（基礎 / 建議學習 / 罕見）',
    note:
      'Robyn Speer. (2022). rspeer/wordfreq: v3.0 (v3.0.2). Zenodo. https://doi.org/10.5281/zenodo.7199437 。' +
      'book-en 由 wordfreq 匯出前 6 萬字的排名並以原形歸併，衍生的排名資料同樣以 CC BY-SA 4.0 提供。',
  },
  {
    name: 'SUBTLEX（SUBTLEX-US、SUBTLEX-UK 等）',
    url: 'http://crr.ugent.be/programs-data/subtitle-frequencies',
    license: '可自由取得的資料（經作者同意隨 wordfreq 散布，須標註作者）',
    use: 'wordfreq 的影視字幕詞頻來源之一',
    note: 'Marc Brysbaert 等人建立。SUBTLEX 為免費提供的資料。',
  },
  {
    name: 'OPUS OpenSubtitles 2018',
    url: 'http://opus.nlpl.eu/OpenSubtitles.php',
    license: '標註出處即可使用；原始資料來自 OpenSubtitles 專案（opensubtitles.org）',
    use: 'wordfreq 的影視字幕詞頻來源之一',
  },
  {
    name: 'wordfreq 的其他語料',
    url: 'https://github.com/rspeer/wordfreq#license',
    license: 'Google Books Ngram（books.google.com/ngrams）、Wikipedia、Leeds Internet Corpus、ParaCrawl 等，依各自條款',
    use: 'wordfreq 詞頻的書面語、網路語料來源',
  },
  {
    name: 'ECDICT 英漢詞典',
    url: 'https://github.com/skywind3000/ECDICT',
    license: 'MIT',
    use: '離線中文釋義、音標、詞形（running → run）、考試標籤',
  },
  {
    name: 'Tatoeba',
    url: 'https://tatoeba.org',
    license: 'CC BY 2.0 FR（creativecommons.org/licenses/by/2.0/fr）',
    use: '單字卡的離線例句庫（中英對照）',
    note: '例句由 Tatoeba 社群的貢獻者撰寫與翻譯。book-en 選取有中文翻譯的英文句，中文轉為台灣繁體。',
  },
  {
    name: 'OpenCC（opencc-js、opencc-python-reimplemented）',
    url: 'https://github.com/nk2028/opencc-js',
    license: 'MIT / Apache-2.0',
    use: '建置時把 ECDICT 釋義與 Tatoeba 中文例句轉為台灣繁體',
  },
  {
    name: 'Free Dictionary API（dictionaryapi.dev）',
    url: 'https://dictionaryapi.dev',
    license: '依其服務條款；內容主要來自 Wiktionary',
    use: '英英釋義、例句、發音音檔（線上補充）',
  },
  {
    name: '維基詞典發音錄音（Wiktionary / Wikimedia Commons）',
    url: 'https://commons.wikimedia.org',
    license: '各檔案依其授權（多為 CC BY-SA 或 CC0），作者見各檔案頁面',
    use: '單字的真人發音錄音（dictionaryapi.dev 的錄音也來自這裡）',
  },
  {
    name: 'Datamuse API',
    url: 'https://www.datamuse.com/api/',
    license: '依其服務條款（免費、免金鑰）',
    use: 'dictionaryapi.dev 無法連線時的英英釋義備援',
  },
]

const SERVICES: Credit[] = [
  {
    name: 'YouTube',
    url: 'https://www.youtube.com',
    license: '影片、字幕與自動翻譯的權利屬 YouTube / Google 及原作者',
    use: '影片播放、英文字幕、YouTube 中文字幕與 Google 自動翻譯',
    note: 'book-en 只在播放器內讀取字幕供個人學習，不下載影片、不散布字幕。',
  },
  {
    name: 'Claude Code（Anthropic）',
    url: 'https://www.anthropic.com/claude-code',
    license: '依 Anthropic 服務條款，使用者自己的帳號',
    use: 'AI 字幕翻譯、單字句中解釋',
  },
]

const CODE: Credit[] = [
  { name: 'Tauri', url: 'https://tauri.app', license: 'Apache-2.0 / MIT', use: '桌面 App 外殼' },
  { name: 'React', url: 'https://react.dev', license: 'MIT', use: '介面' },
  { name: 'Vite', url: 'https://vitejs.dev', license: 'MIT', use: '前端建置' },
  { name: 'rusqlite / SQLite', url: 'https://github.com/rusqlite/rusqlite', license: 'MIT / Public Domain', use: '本機資料庫' },
  { name: 'reqwest', url: 'https://github.com/seanmonstar/reqwest', license: 'MIT / Apache-2.0', use: '線上字典連線' },
  { name: 'serde', url: 'https://serde.rs', license: 'MIT / Apache-2.0', use: '資料序列化' },
]

function CreditList({ title, items }: { title: string; items: Credit[] }) {
  return (
    <>
      <h2>{title}</h2>
      <div className="credits">
        {items.map((c) => (
          <div key={c.name} className="credit">
            <div className="credit-name">{c.name}</div>
            <div className="credit-url">{c.url}</div>
            <div>
              <span className="muted">用途：</span>
              {c.use}
            </div>
            <div>
              <span className="muted">授權：</span>
              {c.license}
            </div>
            {c.note && <div className="muted small">{c.note}</div>}
          </div>
        ))}
      </div>
    </>
  )
}

function Credits() {
  return (
    <>
      <p className="muted">book-en 使用了以下資料、服務與開放原始碼專案，感謝這些作者與社群。</p>
      <CreditList title="資料" items={DATA} />
      <CreditList title="服務" items={SERVICES} />
      <CreditList title="程式庫" items={CODE} />
    </>
  )
}
