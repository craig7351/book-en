// 寵物分頁（遊戲模式開啟時才出現）：小屋、寵物與蛋、圖鑑、商店、金幣紀錄
import { useEffect, useState } from 'react'
import {
  coinKindText,
  game,
  gameErrorText,
  MAX_LEVEL,
  type CoinEntry,
  type GameState,
  type PetView,
  type ShopItem,
} from '../shared/game'
import { EggPixel, PetPixel, Pixel } from '../shared/PixelArt'
import {
  ACCESSORY_INFO,
  accessoryIcon,
  BRANCH_INFO,
  eggSprite,
  petSilhouette,
  petSprite,
  SCENE_INFO,
  sceneSprite,
  SPECIES,
  SPECIES_INFO,
  STAGE_NAME,
  type Branch,
} from '../shared/sprites'

type Sub = 'home' | 'pets' | 'dex' | 'shop' | 'log'
const SUBS: { id: Sub; label: string }[] = [
  { id: 'home', label: '小屋' },
  { id: 'pets', label: '寵物與蛋' },
  { id: 'dex', label: '圖鑑' },
  { id: 'shop', label: '商店' },
  { id: 'log', label: '金幣紀錄' },
]

const MOOD_TEXT = { happy: '今天很開心', normal: '有點想你', miss: '好久不見，很想你' }

export function formName(pet: PetView): string {
  if (pet.stage < 3) return STAGE_NAME[pet.stage]
  return `成年・${BRANCH_INFO[(pet.branch ?? 'balance') as Branch].name}`
}

// 彩蛋：在寵物頁輸入 ↑↑↓↓←→←→BA → 像素圖預覽頁（#sprites）
const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a']

function useKonami(onDone: () => void) {
  useEffect(() => {
    let recent: string[] = [] // 最近 10 個按鍵（多按一次 ↑ 也照樣算）
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      recent = [...recent, e.key.toLowerCase()].slice(-KONAMI.length)
      if (recent.join() === KONAMI.join()) {
        recent = []
        onDone()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDone])
}

const openSprites = () => (location.hash = '#sprites')

export function Pet({ gs, onChange }: { gs: GameState; onChange: () => void }) {
  const [sub, setSub] = useState<Sub>('home')
  const [msg, setMsg] = useState<string | null>(null)
  useKonami(openSprites)

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setMsg(null)
    try {
      await fn()
      if (ok) setMsg(ok)
      onChange()
    } catch (e) {
      setMsg(gameErrorText(e))
    }
  }

  return (
    <section className="pet-page">
      <nav className="subtabs">
        {SUBS.map((s) => (
          <button key={s.id} className={sub === s.id ? 'on' : ''} onClick={() => setSub(s.id)}>
            {s.label}
          </button>
        ))}
        <span className="pet-wallet">
          🪙 <b>{gs.coins}</b>　🔥 連續 <b>{gs.streak}</b> 天
        </span>
      </nav>
      {msg && <p className="msg">{msg}</p>}
      {sub === 'home' && <Home gs={gs} act={act} />}
      {sub === 'pets' && <Pets gs={gs} act={act} />}
      {sub === 'dex' && <Dex gs={gs} />}
      {sub === 'shop' && <Shop gs={gs} act={act} />}
      {sub === 'log' && <Log />}
    </section>
  )
}

type Act = (fn: () => Promise<unknown>, ok?: string) => Promise<void>

function Home({ gs, act }: { gs: GameState; act: Act }) {
  const pet = gs.pet
  const egg = gs.eggs.find((e) => e.incubating) ?? gs.eggs[0] ?? null
  const [hop, setHop] = useState(0)
  const [naming, setNaming] = useState<string | null>(null)
  const ownedAcc = gs.owned.filter((id) => ACCESSORY_INFO[id])
  const scenes = ['room', ...gs.owned.filter((id) => SCENE_INFO[id])]

  return (
    <div className="pet-home">
      <div className="scene">
        <Pixel sprite={sceneSprite(gs.options.scene)} scale={5} className="scene-bg" />
        <div className="scene-actor">
          {pet ? (
            <PetPixel
              key={hop}
              pet={pet}
              mood={hop ? 'happy' : gs.mood}
              scale={4}
              className={hop ? 'px-hop' : 'px-idle'}
              onClick={() => setHop((n) => n + 1)}
            />
          ) : (
            egg && <EggPixel egg={egg} scale={4} className="px-wobble" />
          )}
        </div>
        {pet && egg && (
          <div className="scene-egg" title={`孵化進度 ${egg.warmth}/${egg.need}`}>
            <EggPixel egg={egg} scale={2} className="px-wobble" />
          </div>
        )}
      </div>

      <div className="pet-info">
        {pet ? (
          <>
            <div className="pet-name">
              {naming === null ? (
                <>
                  <b>{pet.name}</b>
                  {pet.shiny && <span className="shiny-tag">✦ 閃亮</span>}
                  <button className="link" title="改名" onClick={() => setNaming(pet.name)}>
                    ✎
                  </button>
                </>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    void act(() => game.rename(pet.id, naming)).then(() => setNaming(null))
                  }}
                >
                  <input value={naming} maxLength={12} autoFocus onChange={(e) => setNaming(e.target.value)} />
                  <button type="submit">好</button>
                  <button type="button" onClick={() => setNaming(null)}>
                    取消
                  </button>
                </form>
              )}
            </div>
            <div className="muted">
              {SPECIES_INFO[pet.species].name}・{formName(pet)}・{MOOD_TEXT[gs.mood]}
            </div>
            <XpBar pet={pet} />
          </>
        ) : (
          egg && (
            <>
              <div className="pet-name">
                <b>{SPECIES_INFO[egg.species].name}的蛋</b>
              </div>
              <div className="muted">到期複習每答對一題，蛋就暖一點。</div>
              <Bar value={egg.warmth} max={egg.need} label={`孵化 ${egg.warmth} / ${egg.need}`} />
            </>
          )
        )}
        {pet && egg && (
          <div className="muted small">
            孵化中：{SPECIES_INFO[egg.species].name}的蛋 {egg.warmth} / {egg.need}
          </div>
        )}

        <div className="pet-stats">
          <span title="連續天數保護：某天沒複習會自動用掉一個，連續天數不中斷">❄ 保護 ×{gs.freezes}</span>
          <span>
            今天到期複習 <b>{gs.dueToday}</b> 題{gs.allDueDone && ' ・ ✓ 全部完成'}
          </span>
        </div>
        <div className="pet-snack">
          {gs.snackToday ? (
            <span>🍪 今天吃過點心了：到期複習答對的經驗 ×1.2</span>
          ) : (
            <button disabled={!gs.snacks || !pet} onClick={() => act(() => game.snack(), '吃了點心！今天到期複習的經驗 ×1.2')}>
              🍪 吃點心（剩 {gs.snacks}）
            </button>
          )}
        </div>

        {pet && ownedAcc.length > 0 && (
          <div className="pet-wear">
            <div className="label">配件</div>
            {ownedAcc.map((id) => {
              const on = pet.accessories.includes(id)
              return (
                <button key={id} className={on ? 'wear on' : 'wear'} onClick={() => act(() => game.equip(pet.id, id, !on))}>
                  <Pixel sprite={accessoryIcon(id)} scale={1.5} />
                  {ACCESSORY_INFO[id].name}
                </button>
              )
            })}
          </div>
        )}
        {scenes.length > 1 && (
          <div className="pet-wear">
            <div className="label">場景</div>
            {scenes.map((id) => (
              <button
                key={id}
                className={gs.options.scene === id ? 'wear on' : 'wear'}
                onClick={() => act(() => game.options({ scene: id }))}
              >
                {SCENE_INFO[id]}
              </button>
            ))}
          </div>
        )}
        <details className="pet-help">
          <summary>怎麼讓寵物長大？</summary>
          <ul>
            <li>
              <b>到期的字答對</b>：+10 經驗、+2 金幣，蛋也會暖一點（30 題孵化）。答錯也有 +2 經驗。
            </li>
            <li>今天到期的全部複習完：+30 經驗、+10 金幣。</li>
            <li>練習模式每天最多 +30 經驗；收藏新字每個 +1 金幣（每天最多 20）。</li>
            <li>Lv.10 長成少年；Lv.20 成年，樣子看少年期怎麼學決定（見圖鑑）。</li>
            <li>連續 7 / 30 / 100 天有金幣和蛋。某天沒來會自動用掉保護（每週送一個）。</li>
            <li>寵物不會生病、不會離開，只是久沒來會很想你。</li>
          </ul>
        </details>
      </div>
    </div>
  )
}

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <div className="xp">
      <div className="xp-bar">
        <span style={{ width: `${max ? Math.min(100, (value / max) * 100) : 100}%` }} />
      </div>
      <span className="xp-text">{label}</span>
    </div>
  )
}

export function XpBar({ pet }: { pet: PetView }) {
  return pet.level >= MAX_LEVEL ? (
    <Bar value={1} max={1} label={`Lv.${pet.level}（滿級）`} />
  ) : (
    <Bar value={pet.xp} max={pet.need} label={`Lv.${pet.level}　${pet.xp} / ${pet.need}`} />
  )
}

function Pets({ gs, act }: { gs: GameState; act: Act }) {
  return (
    <div className="pet-list">
      <h3>寵物（只有陪伴中的會成長）</h3>
      {!gs.pets.length && <p className="muted">還沒有寵物，先把蛋孵出來吧。</p>}
      <div className="cards">
        {gs.pets.map((p) => (
          <div key={p.id} className={p.active ? 'pcard on' : 'pcard'}>
            <PetPixel pet={p} scale={2} />
            <div>
              <b>{p.name}</b>
              {p.shiny && <span className="shiny-tag">✦</span>}
            </div>
            <div className="muted small">
              {SPECIES_INFO[p.species].name}・{formName(p)}・Lv.{p.level}
            </div>
            {p.active ? (
              <span className="pill">陪伴中</span>
            ) : (
              <button onClick={() => act(() => game.setActive(p.id))}>讓牠陪伴</button>
            )}
          </div>
        ))}
      </div>
      <h3>蛋（一次孵一顆）</h3>
      {!gs.eggs.length && <p className="muted">沒有蛋。連續天數里程碑和商店每週會有新的蛋。</p>}
      <div className="cards">
        {gs.eggs.map((e) => (
          <div key={e.id} className={e.incubating ? 'pcard on' : 'pcard'}>
            <EggPixel egg={e} scale={2} />
            <div>
              <b>{SPECIES_INFO[e.species].name}的蛋</b>
            </div>
            <div className="muted small">
              {e.warmth} / {e.need}
            </div>
            {e.incubating ? (
              <span className="pill">孵化中</span>
            ) : (
              <button onClick={() => act(() => game.incubate(e.id))}>改孵這顆</button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

const FORMS: { key: string; label: string; stage: number; branch?: Branch }[] = [
  { key: 'baby', label: '寶寶', stage: 1 },
  { key: 'teen', label: '少年', stage: 2 },
  ...(Object.keys(BRANCH_INFO) as Branch[]).map((b) => ({ key: b, label: BRANCH_INFO[b].name, stage: 3, branch: b })),
]

function Dex({ gs }: { gs: GameState }) {
  const has = (k: string) => gs.discovered.includes(k)
  const total = SPECIES.length * (FORMS.length + 1)
  const found = SPECIES.reduce((n, s) => n + FORMS.filter((f) => has(`${s}:${f.key}`)).length + (has(`${s}:shiny`) ? 1 : 0), 0)
  return (
    <div className="dex">
      <p className="muted">
        已發現 {found} / {total}。成年的樣子看「少年期」怎麼學決定；閃亮版是孵化時 1/64 的機率，金幣買不到。
      </p>
      {SPECIES.map((s) => (
        <div key={s} className="dex-row">
          <div className="dex-species">
            <Pixel sprite={eggSprite(s)} scale={1.5} />
            <div>
              <b>{has(`${s}:egg`) ? SPECIES_INFO[s].name : '？？？'}</b>
              <div className="muted small">{has(`${s}:egg`) ? SPECIES_INFO[s].desc : '還沒遇過'}</div>
            </div>
          </div>
          <div className="dex-forms">
            {FORMS.map((f) => {
              const seen = has(`${s}:${f.key}`)
              return (
                <div key={f.key} className="dex-cell" title={f.branch ? `${BRANCH_INFO[f.branch].name}：${BRANCH_INFO[f.branch].hint}` : f.label}>
                  <Pixel
                    sprite={seen ? petSprite({ species: s, stage: f.stage, branch: f.branch }) : petSilhouette(s, f.stage, f.branch)}
                    scale={f.stage === 3 ? 1.5 : 2}
                  />
                  <span className="small">{seen ? f.label : '？'}</span>
                </div>
              )
            })}
            <div className="dex-cell" title="閃亮版：孵化時 1/64">
              <Pixel
                sprite={has(`${s}:shiny`) ? petSprite({ species: s, stage: 1, shiny: true }) : petSilhouette(s, 1)}
                scale={2}
              />
              <span className="small">{has(`${s}:shiny`) ? '✦ 閃亮' : '✦ ？'}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

const ITEM_TEXT: Record<string, [string, string, string]> = {
  snack: ['🍪', '點心', '吃了之後，當天到期複習答對的經驗 ×1.2'],
  freeze: ['❄️', '連續保護', '某天沒複習時自動用掉，連續天數不中斷（最多持有 2 個）'],
  egg: ['', '本週的蛋', '每週換一種，一週限買一顆'],
}

function Shop({ gs, act }: { gs: GameState; act: Act }) {
  const [items, setItems] = useState<ShopItem[]>([])
  const load = () => game.shop().then(setItems).catch(() => {})
  useEffect(() => {
    void load()
  }, [gs.coins])

  const card = (it: ShopItem, icon: React.ReactNode, name: string, desc: string) => (
    <div key={it.id} className="shop-card">
      <div className="shop-icon">{icon}</div>
      <b>{name}</b>
      <div className="muted small">{desc}</div>
      <button
        disabled={!it.available || gs.coins < it.price}
        onClick={() => act(() => game.buy(it.id), `買了「${name}」`)}
      >
        {it.available ? `🪙 ${it.price}` : it.kind === 'egg' ? '本週已買' : it.kind === 'freeze' ? '已達上限' : '已擁有'}
      </button>
    </div>
  )

  const by = (k: ShopItem['kind']) => items.filter((i) => i.kind === k)
  return (
    <div className="shop">
      <h3>道具</h3>
      <div className="cards">
        {items
          .filter((i) => i.kind === 'snack' || i.kind === 'freeze' || i.kind === 'egg')
          .map((it) => {
            const [emoji, name, desc] = ITEM_TEXT[it.kind]
            const icon =
              it.kind === 'egg' && it.species ? <Pixel sprite={eggSprite(it.species)} scale={2} /> : <span className="emoji">{emoji}</span>
            const label = it.kind === 'egg' && it.species ? `${SPECIES_INFO[it.species].name}的蛋` : name
            return card(it, icon, label, it.kind === 'snack' || it.kind === 'freeze' ? `${desc}（有 ${it.owned}）` : desc)
          })}
      </div>
      <h3>配件（每隻寵物都能戴）</h3>
      <div className="cards">
        {by('accessory').map((it) =>
          card(it, <Pixel sprite={accessoryIcon(it.id)} scale={2} />, ACCESSORY_INFO[it.id]?.name ?? it.id, ACCESSORY_INFO[it.id]?.slot === 'head' ? '頭' : ACCESSORY_INFO[it.id]?.slot === 'face' ? '臉' : '脖子'),
        )}
      </div>
      <h3>小屋場景</h3>
      <div className="cards">
        {by('scene').map((it) => card(it, <Pixel sprite={sceneSprite(it.id)} scale={1} />, SCENE_INFO[it.id] ?? it.id, '寵物小屋的背景'))}
      </div>
    </div>
  )
}

const ITEM_NAME: Record<string, string> = {
  snack: '點心',
  freeze: '連續保護',
  egg: '本週的蛋',
  ...Object.fromEntries(Object.entries(ACCESSORY_INFO).map(([k, v]) => [k, v.name])),
  ...SCENE_INFO,
}

const logText = (kind: string) => (kind.startsWith('buy:') ? `購買：${ITEM_NAME[kind.slice(4)] ?? kind.slice(4)}` : coinKindText(kind))

function Log() {
  const [rows, setRows] = useState<CoinEntry[] | null>(null)
  useEffect(() => {
    game.coinHistory(100).then(setRows).catch(() => setRows([]))
  }, [])
  if (!rows) return <p className="muted">載入中…</p>
  if (!rows.length) return <p className="muted">還沒有紀錄。</p>
  return (
    <table className="coin-log">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="muted">{new Date(r.at).toLocaleString()}</td>
            <td>{logText(r.kind)}</td>
            <td className={r.amount >= 0 ? 'plus' : 'minus'}>
              {r.amount >= 0 ? '+' : ''}
              {r.amount}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
