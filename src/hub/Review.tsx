import { useEffect, useRef, useState } from 'react'
import { api, errorText } from '../shared/api'
import { speak } from '../shared/speak'
import { lemmaCandidates, normWord, tokenize } from '../shared/tokenize'
import type { Item } from '../shared/types'
import { dueText, SourceLink } from './Vocab'

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

async function buildQuiz(item: Item): Promise<Quiz> {
  if (item.kind === 'sentence') return { kind: 'recall', item }
  const options: Quiz['kind'][] = ['spell']
  if (item.meaningZh) options.push('choice', 'choice')
  const cloze = item.context ? findForm(item.context, item.text) : null
  if (cloze) options.push('cloze', 'cloze')
  const kind = options[Math.floor(Math.random() * options.length)]
  if (kind === 'cloze' && cloze) return { kind, item, ...cloze }
  if (kind === 'choice') {
    const distractors = await api.quizDistractors(item.text, 3)
    return { kind, item, choices: shuffle([item.text, ...distractors]) }
  }
  return { kind: 'spell', item }
}

export function Review({ onChanged }: { onChanged: () => void }) {
  const [queue, setQueue] = useState<Item[] | null>(null)
  const [practice, setPractice] = useState(false)
  const [quiz, setQuiz] = useState<Quiz | null>(null)
  const [score, setScore] = useState({ right: 0, total: 0 })
  const [err, setErr] = useState<string | null>(null)

  async function start(mode: 'due' | 'practice') {
    setErr(null)
    try {
      const items =
        mode === 'due' ? await api.reviewDue(30) : shuffle(await api.itemList()).slice(0, 10)
      setPractice(mode === 'practice')
      setScore({ right: 0, total: 0 })
      setQueue(items)
      setQuiz(items.length ? await buildQuiz(items[0]) : null)
    } catch (e) {
      setErr(errorText(e))
    }
  }

  useEffect(() => {
    void start('due')
  }, [])

  async function finish(quality: number) {
    if (!quiz || !queue) return
    if (!practice) {
      await api.reviewGrade(quiz.item.id, quality, quiz.kind)
      onChanged()
    }
    setScore((s) => ({ right: s.right + (quality >= 3 ? 1 : 0), total: s.total + 1 }))
    const rest = queue.slice(1)
    // 忘記的字排到本輪最後再考一次（練習模式不重複）
    const next = quality < 3 && !practice ? [...rest, quiz.item] : rest
    setQueue(next)
    setQuiz(next.length ? await buildQuiz(next[0]) : null)
  }

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
        <p className="muted">間隔重複會在你快忘記的時候再安排複習。</p>
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
      <QuizView key={`${quiz.item.id}-${score.total}`} quiz={quiz} onDone={finish} />
    </section>
  )
}

function QuizView({ quiz, onDone }: { quiz: Quiz; onDone: (quality: number) => void }) {
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
          <p className="muted small">{result ? '答對：拉長複習間隔' : `答錯：10 分鐘後再考 · 原排程 ${dueText(item)}`}</p>
        </>
      )}
    </div>
  )
}
