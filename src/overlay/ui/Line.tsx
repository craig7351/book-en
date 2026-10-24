import { levelOf } from '../../shared/levels'
import { isSaved, tokenize } from '../../shared/tokenize'
import { infoOf, pauseVideo } from '../controller'
import { store, useStore } from '../store'

// 一句英文：每個單字可點（暫停影片、開單字卡）。
// 上色：學習中（已收藏）黃底；開啟「標示分級」時，建議學習加底線、罕見變淡。
export function Line({ text, cueIdx }: { text: string; cueIdx: number }) {
  const saved = useStore((s) => s.saved)
  const card = useStore((s) => s.card)
  useStore((s) => s.words) // 狀態改變時重繪
  const markLevels = useStore((s) => s.prefs.markLevels)
  const knownMax = useStore((s) => s.prefs.knownMax)
  const suggestMax = useStore((s) => s.prefs.suggestMax)

  function cls(word: string): string {
    const info = infoOf(word)
    const level = info ? levelOf(info, { knownMax, suggestMax }) : isSaved(word, saved) ? 'learning' : 'none'
    if (level === 'learning') return ' saved'
    if (!markLevels) return ''
    return level === 'suggest' ? ' suggest' : level === 'rare' ? ' rare' : ''
  }

  return (
    <span className="en">
      {tokenize(text).map((t, i) => (
        <span key={i}>
          {t.pre}
          {t.word && (
            <span
              className={'w' + cls(t.word) + (card?.cueIdx === cueIdx && card.word === t.word ? ' picked' : '')}
              onClick={(e) => {
                e.stopPropagation()
                pauseVideo()
                store.set({ card: { word: t.word, cueIdx } })
              }}
            >
              {t.word}
            </span>
          )}
          {t.post}
        </span>
      ))}
    </span>
  )
}
