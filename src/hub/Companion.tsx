// 複習頁的陪伴寵物：答對跳一下、答錯歪頭，飄出這題的獎勵；升級、孵化、進化時跳出慶祝
import type { GameState, Reward } from '../shared/game'
import { EggPixel, PetPixel } from '../shared/PixelArt'
import { BRANCH_INFO, SPECIES_INFO, type Branch } from '../shared/sprites'
import { XpBar } from './Pet'

export function Companion({
  gs,
  reaction,
  reward,
}: {
  gs: GameState
  reaction: { ok: boolean; n: number } | null
  reward: { r: Reward; n: number } | null
}) {
  const pet = gs.pet
  const egg = gs.eggs.find((e) => e.incubating) ?? gs.eggs[0] ?? null
  const r = reward?.r
  const notes = r ? [...(r.levelUp && !r.evolved && !r.hatched ? [`${pet?.name ?? ''}升到 Lv.${r.levelUp}！+5 金幣`] : []), ...r.notes] : []
  return (
    <div className="companion">
      <div className="companion-sprite">
        {pet ? (
          <PetPixel
            key={reaction?.n ?? 0}
            pet={pet}
            mood={reaction ? (reaction.ok ? 'happy' : 'normal') : gs.mood}
            scale={pet.stage === 1 ? 3 : 2}
            className={reaction ? (reaction.ok ? 'px-hop' : 'px-tilt') : 'px-idle'}
          />
        ) : (
          egg && <EggPixel key={reaction?.n ?? 0} egg={egg} scale={2} className={reaction?.ok ? 'px-hop' : 'px-wobble'} />
        )}
      </div>
      <div className="companion-info">
        {pet ? (
          <>
            <b>{pet.name}</b>
            <XpBar pet={pet} />
          </>
        ) : (
          egg && (
            <>
              <b>{SPECIES_INFO[egg.species].name}的蛋</b>
              <span className="muted small">
                到期複習答對 {egg.warmth} / {egg.need}，滿了就孵化
              </span>
            </>
          )
        )}
      </div>
      {r && (r.xp > 0 || r.coins > 0) && (
        <div key={reward!.n} className="reward-pop">
          {r.xp > 0 && <span>+{r.xp} 經驗</span>}
          {r.coins > 0 && <span>+{r.coins} 🪙</span>}
        </div>
      )}
      {notes.length > 0 && (
        <div key={`n${reward!.n}`} className="reward-notes">
          {notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export function Celebrate({ reward, gs, onClose }: { reward: Reward; gs: GameState; onClose: () => void }) {
  const pet = reward.hatched ?? reward.pet ?? gs.pet
  let title = ''
  let text = ''
  if (reward.hatched) {
    title = '蛋孵化了！'
    text = `${reward.hatched.name}${reward.hatched.shiny ? '（✦ 閃亮版！只有 1/64 的機率）' : ''}來到你身邊了。`
  } else if (reward.evolved === 'teen') {
    title = '長成少年了！'
    text = '接下來怎麼學，會決定牠成年的樣子。'
  } else if (reward.evolved) {
    const b = BRANCH_INFO[reward.evolved as Branch]
    title = `成年了：${b?.name ?? reward.evolved}！`
    text = b ? `因為少年期${b.hint.replace(/^少年期/, '')}。` : ''
  } else if (reward.levelUp) {
    title = `升到 Lv.${reward.levelUp}！`
    text = '+5 金幣'
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal celebrate" onClick={(e) => e.stopPropagation()}>
        {pet && <PetPixel pet={pet} mood="happy" scale={5} className="px-hop" />}
        <h2>{title}</h2>
        <p>{text}</p>
        <button className="primary" autoFocus onClick={onClose}>
          太好了
        </button>
      </div>
    </div>
  )
}
