import { useEffect, useRef, useState } from 'react'
import { api, errorText } from '../shared/api'
import { speak } from '../shared/speak'
import { lemmaCandidates, normWord, tokenize } from '../shared/tokenize'
import type { Item } from '../shared/types'
import { game, MAX_LEVEL, playSfx, type GameState, type Reward } from '../shared/game'
import { Celebrate, Companion } from './Companion'
import { SourceLink } from './Vocab'

// 題型：
//   choice 看中文選英文；spell 聽發音拼字；cloze 原句克漏字（可回影片聽原句）；
//   recall 句子：聽 → 想 → 看答案 → 自評
type Quiz =
  | { kind: 'choice'; item: Item; choices: string[] }
  | { kind: 'spell'; item: Item }
  | { kind: 'cloze'; item: Item; before: string; after: string; form: string }
  | { kind: 'recall'; item: Item }

const QUIZ_LABEL: Record<Quiz['kind'], string> = {
  choice: '看中文選英文',
  spell: '聽發音拼單字',
  cloze: '原句填空',
  recall: '句子聽力',
}

const shuffle = <T,>(a: T[]) => a.map((x) => [Math.random(), x] as const).sort((p, q) => p[0] - q[0]).map((p) => p[1])

// 在原句裡找到這個字實際出現的形式（例如收藏 run，原句是 running）
function findForm(context: string, word: string): { before: string; after: string; form: string } | null {
  const tokens = tokenize(context)
  const i = tokens.findIndex((t) => t.word && lemmaCandidates(t.word).includes(word))
  if (i < 0) return null
  const join = (ts: typeof tokens) => ts.map((t) => t.pre + t.word + t.post).join('')
  return { before: join(tokens.slice(0, i)) + tokens[i].pre, form: tokens[i].word, after: tokens[i].post + join(tokens.slice(i + 1)) }
}

type Kind = Quiz['kind']
const ALL_KINDS: Kind[] = ['choice', 'spell', 'cloze', 'recall']

// 依使用者勾選的題型出題；這個項目做不了任何勾選的題型就回 null（略過）
async function buildQuiz(item: Item, kinds: Kind[]): Promise<Quiz | null> {
  if (item.kind === 'sentence') return kinds.includes('recall') ? { kind: 'recall', item } : null
  const cloze = item.context ? findForm(item.context, item.text) : null
  const options = kinds.filter(
    (k) => k === 'spell' || (k === 'choice' && !!item.meaningZh) || (k === 'cloze' && !!cloze),
  )
  if (!options.length) return null
  const kind = options[Math.floor(Math.random() * options.length)]
  if (kind === 'cloze' && cloze) return { kind, item, ...cloze }
  if (kind === 'choice') {
    const distractors = await api.quizDistractors(item.text, 3)
    return { kind, item, choices: shuffle([item.text, ...distractors]) }
  }
  return { kind: 'spell', item }
}

// 從佇列前端找第一個能出題的項目，回傳剩下的佇列（以第一題開頭）與略過的項目
async function firstQuiz(queue: Item[], kinds: Kind[]) {
  for (let i = 0; i < queue.length; i++) {
    const quiz = await buildQuiz(queue[i], kinds)
    if (quiz) return { queue: queue.slice(i), quiz, skipped: queue.slice(0, i) }
  }
  return { queue: [] as Item[], quiz: null, skipped: queue }
}

async function loadKinds(): Promise<Kind[]> {
  const raw = await api.getSetting('prefs').catch(() => null)
  const saved = (raw ? JSON.parse(raw) : {}).quizKinds as Kind[] | undefined
  const kinds = (saved ?? ALL_KINDS).filter((k) => ALL_KINDS.includes(k))
  return kinds.length ? kinds : ALL_KINDS
}

async function saveKinds(kinds: Kind[]) {
  // 讀最新的再合併，避免蓋掉其他設定
  const raw = await api.getSetting('prefs').catch(() => null)
  await api.setSetting('prefs', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), quizKinds: kinds }))
}

// 題型開關（至少留一個由 Review 檢查）
function KindPicker({ kinds, onToggle }: { kinds: Kind[]; onToggle: (k: Kind) => void }) {
  return (
    <div className="kind-picker">
      <span className="muted">題型</span>
      {ALL_KINDS.map((k) => (
        <button
          key={k}
          className={kinds.includes(k) ? 'kind on' : 'kind'}
          title={kinds.includes(k) && kinds.length === 1 ? '至少要選一種題型' : undefined}
          onClick={() => onToggle(k)}
        >
          {kinds.includes(k) ? '✓ ' : ''}
          {QUIZ_LABEL[k]}
        </button>
      ))}
    </div>
  )
}

export function Review({ onChanged, gs }: { onChanged: () => void; gs: GameState | null }) {
  const [queue, setQueue] = useState<Item[] | null>(null)
  const [practice, setPractice] = useState(false)
  const [quiz, setQuiz] = useState<Quiz | null>(null)
  const [score, setScore] = useState({ right: 0, total: 0 })
  // 不適用目前題型而略過的項目；改題型時放回佇列
  const [parked, setParked] = useState<Item[]>([])
  const [kinds, setKinds] = useState<Kind[]>(ALL_KINDS)
  // 連點時以最新的勾選計算，並丟掉過期的換題結果
  const kindsRef = useRef<Kind[]>(ALL_KINDS)
  const [err, setErr] = useState<string | null>(null)
  // 遊戲模式：寵物的反應、這題的獎勵、本輪累計、升級／孵化慶祝
  const [reaction, setReaction] = useState<{ ok: boolean; n: number } | null>(null)
  const [reward, setReward] = useState<{ r: Reward; n: number } | null>(null)
  const [session, setSession] = useState({ xp: 0, coins: 0 })
  const [party, setParty] = useState<Reward | null>(null)
  const sound = !!gs?.options.sound

  function onResult(ok: boolean) {
    setReaction((p) => ({ ok, n: (p?.n ?? 0) + 1 }))
    playSfx(ok ? 'correct' : 'wrong', sound)
  }

  function gotReward(r: Reward | null) {
    if (!r) return
    setReward((p) => ({ r, n: (p?.n ?? 0) + 1 }))
    setSession((s) => ({ xp: s.xp + r.xp, coins: s.coins + r.coins }))
    // 跳出慶祝只留給大事（孵化、進化、滿級）；一般升級在陪伴列顯示一行就好
    if (r.hatched || r.evolved || (r.levelUp ?? 0) >= MAX_LEVEL) {
      setParty(r)
      playSfx(r.hatched ? 'hatch' : 'level', sound)
    } else if (r.levelUp) playSfx('level', sound)
    else if (r.coins > 0) playSfx('coin', sound)
  }

  async function start(mode: 'due' | 'practice', useKinds = kinds) {
    setErr(null)
    try {
      const items =
        mode === 'due' ? await api.reviewDue(30) : shuffle(await api.itemList()).slice(0, 10)
      const first = await firstQuiz(items, useKinds)
      setPractice(mode === 'practice')
      setScore({ right: 0, total: 0 })
      setSession({ xp: 0, coins: 0 })
      setParked(first.skipped)
      setQueue(first.queue)
      setQuiz(first.quiz)
    } catch (e) {
      setErr(errorText(e))
    }
  }

  useEffect(() => {
    loadKinds().then((k) => {
      kindsRef.current = k
      setKinds(k)
      void start('due', k)
    })
  }, [])

  async function toggleKind(k: Kind) {
    const cur = kindsRef.current
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : ALL_KINDS.filter((x) => x === k || cur.includes(x))
    if (!next.length) return
    kindsRef.current = next
    setKinds(next)
    void saveKinds(next)
    // 本輪還沒考的（含先前略過的）依新題型重新挑；目前這題的題型還開著就不換
    const pool = [...(queue ?? []), ...parked]
    if (!pool.length) return void start(practice ? 'practice' : 'due', next)
    const keep = quiz && next.includes(quiz.kind)
    const first = keep ? null : await firstQuiz(pool, next)
    if (kindsRef.current !== next) return
    if (first) {
      setQueue(first.queue)
      setQuiz(first.quiz)
      setParked(first.skipped)
    } else {
      setQueue(pool)
      setParked([])
    }
  }

  async function finish(quality: number) {
    if (!quiz || !queue) return
    if (quiz.kind === 'recall') onResult(quality >= 3) // 句子題是自評，沒有 check 的時機
    if (!practice) {
      const res = await api.reviewGrade(quiz.item.id, quality, quiz.kind)
      gotReward(res.reward)
      onChanged()
    } else if (gs) {
      gotReward(await game.practice(quality >= 3).catch(() => null))
      onChanged()
    }
    setScore((s) => ({ right: s.right + (quality >= 3 ? 1 : 0), total: s.total + 1 }))
    const rest = queue.slice(1)
    // 忘記的字排到本輪最後再考一次（練習模式不重複）
    const next = quality < 3 && !practice ? [...rest, quiz.item] : rest
    const first = await firstQuiz(next, kindsRef.current)
    setParked((p) => [...p, ...first.skipped])
    setQueue(first.queue)
    setQuiz(first.quiz)
  }

  const skippedNote =
    parked.length > 0 ? (
      <p className="muted small">有 {parked.length} 個項目不適用目前選的題型，先略過（排程不變，改題型就會出現）。</p>
    ) : null

  const companion = gs && (
    <Companion gs={gs} reaction={reaction} reward={reward} />
  )
  const celebrate = party && gs && <Celebrate reward={party} gs={gs} onClose={() => setParty(null)} />

  if (err) return <p className="msg error">{err}</p>
  if (!queue) return <p className="empty">載入中…</p>

  if (!quiz) {
    return (
      <section className="review-done">
        {score.total > 0 ? (
          <>
            <h2>{practice ? '練習完成' : '今天的複習完成了 🎉'}</h2>
            <p className="big">
              {score.right} / {score.total}
            </p>
          </>
        ) : (
          <h2>目前沒有要複習的項目</h2>
        )}
        {skippedNote}
        {gs && score.total > 0 && (
          <p className="session-reward">
            {gs.pet ? `${gs.pet.name} ` : ''}這一輪獲得 <b>{session.xp}</b> 經驗、<b>{session.coins}</b> 金幣
            {gs.pet && gs.pet.need > 0 && `，再 ${gs.pet.need - gs.pet.xp} 經驗升級`}
          </p>
        )}
        {companion}
        {celebrate}
        <p className="muted">間隔重複會在你快忘記的時候再安排複習。</p>
        <KindPicker kinds={kinds} onToggle={toggleKind} />
        <div className="row-btns">
          <button onClick={() => start('due')}>重新檢查待複習</button>
          <button onClick={() => start('practice')}>隨機練習 10 題（不影響排程）</button>
        </div>
      </section>
    )
  }

  return (
    <section className="review">
      <div className="review-top">
        <span className="pill">{QUIZ_LABEL[quiz.kind]}</span>
        {practice && <span className="pill">練習模式</span>}
        <span className="muted">
          剩 {queue.length} 題 · 答對 {score.right}/{score.total}
        </span>
      </div>
      <KindPicker kinds={kinds} onToggle={toggleKind} />
      {skippedNote}
      {companion}
      {celebrate}
      <QuizView key={`${quiz.item.id}-${score.total}`} quiz={quiz} onDone={finish} onResult={onResult} />
    </section>
  )
}

function QuizView({
  quiz,
  onDone,
  onResult,
}: {
  quiz: Quiz
  onDone: (quality: number) => void
  onResult: (ok: boolean) => void
}) {
  const [answer, setAnswer] = useState('')
  const [result, setResult] = useState<null | boolean>(null)
  const [revealed, setRevealed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { item } = quiz

  useEffect(() => {
    if (quiz.kind === 'spell' || quiz.kind === 'recall') speak(item.text)
    inputRef.current?.focus()
  }, [])

  function check(given: string) {
    if (result !== null) return
    const g = normWord(given.trim())
    const ok = quiz.kind === 'cloze' ? g === normWord(quiz.form) || g === item.text : g === item.text
    setAnswer(given)
    setResult(ok)
    onResult(ok)
  }

  // 作答後：Enter 下一題
  useEffect(() => {
    if (result === null) return
    const onKey = (e: KeyboardEvent) => e.key === 'Enter' && onDone(result ? 4 : 1)
    const t = setTimeout(() => window.addEventListener('keydown', onKey), 300)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [result])

  const reveal = (
    <div className="reveal">
      <div className="reveal-word">
        <span onClick={() => speak(item.text)} title="發音">
          🔊 {item.text}
        </span>
        {item.phonetic && <span className="phonetic">/{item.phonetic}/</span>}
      </div>
      {item.kind === 'word' && item.meaningZh && <div className="meaning">{item.meaningZh}</div>}
      {item.context && item.kind === 'word' && <div className="ctx">{item.context}</div>}
      {item.contextZh && <div className="muted">{item.contextZh}</div>}
      <SourceLink item={item} />
    </div>
  )

  if (quiz.kind === 'recall') {
    return (
      <div className="quiz">
        <p className="prompt">聽這句，試著聽懂或跟讀，再看答案。</p>
        <div className="row-btns">
          <button onClick={() => speak(item.text, null, 0.85)}>🔊 再聽一次</button>
          <SourceLink item={item} />
        </div>
        {!revealed ? (
          <button className="primary" onClick={() => setRevealed(true)}>
            看答案
          </button>
        ) : (
          <>
            <p className="sentence">{item.text}</p>
            {item.contextZh && <p className="muted">{item.contextZh}</p>}
            <div className="grade">
              <button onClick={() => onDone(1)}>忘了</button>
              <button onClick={() => onDone(3)}>有點模糊</button>
              <button onClick={() => onDone(4)}>聽懂了</button>
              <button onClick={() => onDone(5)}>很簡單</button>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="quiz">
      {quiz.kind === 'choice' && (
        <>
          <p className="prompt">哪個英文單字是這個意思？</p>
          <p className="target">{item.meaningZh}</p>
          <div className="choices">
            {quiz.choices.map((c) => (
              <button
                key={c}
                className={
                  'choice' + (result === null ? '' : c === item.text ? ' right' : c === answer ? ' wrong' : '')
                }
                disabled={result !== null}
                onClick={() => check(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </>
      )}

      {quiz.kind === 'spell' && (
        <>
          <p className="prompt">聽發音，拼出單字</p>
          <button className="big-btn" onClick={() => speak(item.text)}>
            🔊 播放
          </button>
          {item.meaningZh && <p className="muted">提示：{item.meaningZh}</p>}
        </>
      )}

      {quiz.kind === 'cloze' && (
        <>
          <p className="prompt">填入原句中缺少的字</p>
          <p className="sentence">
            {quiz.before}
            <span className="blank">{result === null ? '＿＿＿' : quiz.form}</span>
            {quiz.after}
          </p>
          {item.contextZh && <p className="muted">{item.contextZh}</p>}
          <SourceLink item={item} />
        </>
      )}

      {(quiz.kind === 'spell' || quiz.kind === 'cloze') && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (answer.trim()) check(answer)
          }}
        >
          <input
            ref={inputRef}
            className={'answer' + (result === null ? '' : result ? ' right' : ' wrong')}
            value={answer}
            disabled={result !== null}
            placeholder="輸入單字後按 Enter"
            onChange={(e) => setAnswer(e.target.value)}
          />
        </form>
      )}

      {result !== null && (
        <>
          <p className={result ? 'verdict right' : 'verdict wrong'}>{result ? '✓ 答對了' : `✗ 答案是 ${quiz.kind === 'cloze' ? quiz.form : item.text}`}</p>
          {reveal}
          <button className="primary" onClick={() => onDone(result ? 4 : 1)}>
            下一題（Enter）
          </button>
          <p className="muted small">{result ? '答對：拉長複習間隔' : '答錯：10 分鐘後再考，這一輪最後也會再出一次'}</p>
        </>
      )}
    </div>
  )
}
