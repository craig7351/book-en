// 開發用：一次看所有 sprite（學習中心網址加 #sprites）
import { Pixel } from '../shared/PixelArt'
import {
  ACCESSORY_INFO,
  accessoryIcon,
  BRANCH_INFO,
  eggSprite,
  petSprite,
  SCENE_INFO,
  sceneSprite,
  SPECIES,
  type Branch,
  type Mood,
} from '../shared/sprites'

const BRANCHES = Object.keys(BRANCH_INFO) as Branch[]
const MOODS: Mood[] = ['happy', 'normal', 'miss']

export function SpritePreview() {
  return (
    <section className="sprite-preview">
      {SPECIES.map((s) => (
        <div key={s} className="sp-row">
          {[0, 0.6, 0.9].map((p) => (
            <Pixel key={p} sprite={eggSprite(s, p)} scale={3} />
          ))}
          <Pixel sprite={petSprite({ species: s, stage: 1 })} scale={4} />
          <Pixel sprite={petSprite({ species: s, stage: 2 })} scale={4} />
          {BRANCHES.map((b) => (
            <Pixel key={b} sprite={petSprite({ species: s, stage: 3, branch: b })} scale={4} title={b} />
          ))}
          <Pixel sprite={petSprite({ species: s, stage: 2, shiny: true })} scale={4} />
        </div>
      ))}
      <div className="sp-row">
        {MOODS.map((m) => (
          <Pixel key={m} sprite={petSprite({ species: 'pip', stage: 2, mood: m })} scale={4} />
        ))}
        {MOODS.map((m) => (
          <Pixel key={m} sprite={petSprite({ species: 'nori', stage: 1, mood: m })} scale={4} />
        ))}
      </div>
      <div className="sp-row">
        {Object.keys(ACCESSORY_INFO).map((a) => (
          <Pixel key={a} sprite={accessoryIcon(a)} scale={3} title={a} />
        ))}
      </div>
      <div className="sp-row">
        {Object.keys(ACCESSORY_INFO).map((a) => (
          <Pixel key={a} sprite={petSprite({ species: 'drako', stage: 3, branch: 'balance', accessories: [a] })} scale={3} title={a} />
        ))}
      </div>
      <div className="sp-row">
        {Object.keys(SCENE_INFO).map((id) => (
          <Pixel key={id} sprite={sceneSprite(id)} scale={2} />
        ))}
      </div>
    </section>
  )
}
