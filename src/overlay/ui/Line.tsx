import { pauseVideo } from '../controller'
import { store, useStore } from '../store'
import { WordText } from './WordText'

// 一句字幕：點字 → 暫停影片、開這句的單字卡
export function Line({ text, cueIdx }: { text: string; cueIdx: number }) {
  const card = useStore((s) => s.card)
  return (
    <WordText
      text={text}
      picked={card?.cueIdx === cueIdx && !card.context ? card.word : null}
      onPick={(word) => {
        pauseVideo()
        store.set({ card: { word, cueIdx }, cardHistory: [] })
      }}
    />
  )
}
