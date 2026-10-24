// 面板角落的迷你寵物（遊戲模式＋「YouTube 面板陪伴」開啟時）。收藏單字或句子時會跳一下。
import { api } from '../../shared/api'
import { EggPixel, PetPixel } from '../../shared/PixelArt'
import { useStore } from '../store'

export function PanelPet() {
  const p = useStore((s) => s.pet)
  const cheer = useStore((s) => s.petCheer)
  if (!p || (!p.pet && !p.egg)) return null
  return (
    <button className="panel-pet" title="打開寵物小屋" onClick={() => api.openHub('pet')}>
      {cheer > 0 && (
        <span key={cheer} className="pet-bubble">
          收藏了！
        </span>
      )}
      {p.pet ? (
        <PetPixel
          key={cheer}
          pet={p.pet}
          mood={cheer ? 'happy' : p.mood}
          scale={p.pet.stage === 1 ? 2 : 1.5}
          className={cheer ? 'px-hop' : 'px-idle'}
        />
      ) : (
        p.egg && <EggPixel key={cheer} egg={p.egg} scale={1.5} className={cheer ? 'px-hop' : 'px-wobble'} />
      )}
    </button>
  )
}
