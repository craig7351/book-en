import { levelOf } from '../../shared/levels'
import { isSaved, normWord, tokenize } from '../../shared/tokenize'
import { infoOf } from '../controller'
import { useStore } from '../store'

interface Props {
  text: string
  onPick: (word: string) => void
  picked?: string | null // 目前單字卡的字（加框）
  target?: string | null // 例句中要強調的原形（含變化形，加框）
  speakingAt?: number // TTS 正在念的字元位置（-1 = 沒在念）
}

// 一段英文：每個字可點，依詞頻分級上色（字幕、面板、單字卡例句共用）。
// 學習中（已收藏）黃底；開啟「標示分級」時，建議學習加底線、罕見變淡。
export function WordText({ text, onPick, picked, target, speakingAt = -1 }: Props) {
  const saved = useStore((s) => s.saved)
  useStore((s) => s.words) // 狀態改變時重繪
  const markLevels = useStore((s) => s.prefs.markLevels)
  const knownMax = useStore((s) => s.prefs.knownMax)
  const suggestMax = useStore((s) => s.prefs.suggestMax)

  function cls(word: string): string {
    const info = infoOf(word)
    const level = info ? levelOf(info, { knownMax, suggestMax }) : isSaved(word, saved) ? 'learning' : 'none'
    let c = level === 'learning' ? ' saved' : !markLevels ? '' : level === 'suggest' ? ' suggest' : level === 'rare' ? ' rare' : ''
    if (target && (info?.lemma === target || normWord(word) === target)) c += ' target'
    return c
  }

  let pos = 0 // 每個 token 在原文中的字元位置（對應 TTS 的 charIndex）
  return (
    <span className="en">
      {tokenize(text).map((t, i) => {
        const start = pos + t.pre.length
        pos += t.pre.length + t.word.length + t.post.length
        const speaking = speakingAt >= start && speakingAt < start + t.word.length
        return (
          <span key={i}>
            {t.pre}
            {t.word && (
              <span
                className={'w' + cls(t.word) + (picked === t.word ? ' picked' : '') + (speaking ? ' speaking' : '')}
                onClick={(e) => {
                  e.stopPropagation()
                  onPick(t.word)
                }}
              >
                {t.word}
              </span>
            )}
            {t.post}
          </span>
        )
      })}
    </span>
  )
}
