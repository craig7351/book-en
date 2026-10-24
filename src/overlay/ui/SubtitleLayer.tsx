import { cuesOf, useStore } from '../store'
import { Line } from './Line'
import { WordCard } from './WordCard'

// 影片上的雙語字幕（取代原生 CC）。掛在 #movie_player 內，全螢幕時也看得到。
export function SubtitleLayer() {
  const layer = useStore((s) => s.prefs.layer)
  const blur = useStore((s) => s.prefs.blur)
  const showZh = useStore((s) => s.prefs.showZh)
  const active = useStore((s) => s.active)
  const cues = useStore(cuesOf)
  const zh = useStore((s) => s.zh)
  const open = useStore((s) => s.open)
  const fullscreen = useStore((s) => s.fullscreen)
  const subSize = useStore((s) => s.prefs.subSize)
  const cue = active >= 0 ? cues[active] : undefined
  const zhText = active >= 0 ? zh[active] : undefined

  return (
    <>
      {layer && cue && (
        <div className={'subs' + (blur ? ' blur' : '')} style={{ '--scale': subSize / 100 } as React.CSSProperties}>
          <div className="subs-box">
            <Line text={cue.text} cueIdx={active} />
            {showZh && typeof zhText === 'string' && <div className="zh">{zhText}</div>}
          </div>
        </div>
      )}
      {/* 面板收起或全螢幕時，單字卡改顯示在影片上 */}
      {(!open || fullscreen) && <WordCard />}
    </>
  )
}
