// 遊戲模式（寵物養成）的型別、指令與音效。規則都在 Rust 端（src-tauri/src/game.rs）。
import { invoke } from './tauri'
import type { Branch, Mood, Species } from './sprites'

export interface GameOptions {
  enabled: boolean
  companion: boolean
  sound: boolean
  scene: string
}

export interface PetView {
  id: number
  species: Species
  name: string
  level: number
  xp: number
  need: number // 升下一級要的經驗；滿級為 0
  stage: number
  branch: Branch | null
  shiny: boolean
  active: boolean
  accessories: string[]
  hatchedAt: number
}

export interface EggView {
  id: number
  species: Species
  warmth: number
  need: number
  incubating: boolean
  source: string
}

export interface GameState {
  options: GameOptions
  coins: number
  streak: number
  freezes: number
  snacks: number
  snackToday: boolean
  allDueDone: boolean
  dueToday: number
  mood: Mood
  pet: PetView | null
  pets: PetView[]
  eggs: EggView[]
  owned: string[]
  discovered: string[]
}

export interface Reward {
  xp: number
  coins: number
  levelUp: number | null
  evolved: string | null // teen 或成年分支
  hatched: PetView | null
  egg: EggView | null
  pet: PetView | null
  notes: string[]
}

export interface ShopItem {
  id: string
  kind: 'accessory' | 'scene' | 'snack' | 'freeze' | 'egg'
  slot: string
  price: number
  owned: number
  available: boolean
  species: Species | null
}

export interface CoinEntry {
  at: number
  amount: number
  kind: string
}

export const MAX_LEVEL = 30

export const dayStart = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export const game = {
  state: () => invoke<GameState>('game_state', { dayStart: dayStart() }),
  enable: (species?: Species) => invoke<GameState>('game_enable', { species, dayStart: dayStart() }),
  disable: () => invoke<void>('game_disable'),
  options: (o: { companion?: boolean; sound?: boolean; scene?: string }) => invoke<GameOptions>('game_options', o),
  setActive: (id: number) => invoke<void>('pet_set_active', { id }),
  rename: (id: number, name: string) => invoke<void>('pet_rename', { id, name }),
  incubate: (id: number) => invoke<void>('egg_incubate', { id }),
  equip: (petId: number, item: string, on: boolean) => invoke<void>('pet_equip', { petId, item, on }),
  shop: () => invoke<ShopItem[]>('shop_list', { dayStart: dayStart() }),
  buy: (id: string) => invoke<GameState>('shop_buy', { id, dayStart: dayStart() }),
  snack: () => invoke<GameState>('snack_use', { dayStart: dayStart() }),
  practice: (correct: boolean) => invoke<Reward | null>('game_practice', { correct, dayStart: dayStart() }),
  coinHistory: (limit = 50) => invoke<CoinEntry[]>('coin_history', { limit }),
}

export function gameErrorText(e: unknown): string {
  const s = String(e)
  if (s.includes('not-enough-coins')) return '金幣不夠'
  if (s.includes('sold-out')) return '這週已經買過了'
  if (s.includes('already-owned')) return '已經有了'
  if (s.includes('snack-used')) return '今天已經吃過點心了'
  if (s.includes('not-owned')) return '還沒有這個東西'
  if (s.includes('invalid-name')) return '名字要 1–12 個字'
  return s
}

export const COIN_KIND: Record<string, string> = {
  starter: '起始禮包',
  review: '到期複習答對',
  all_due: '今天到期全部完成',
  collect: '收藏新字',
  levelup: '寵物升級',
  streak7: '連續 7 天',
  streak30: '連續 30 天',
  streak100: '連續 100 天',
}

export function coinKindText(kind: string): string {
  if (kind.startsWith('buy:')) return `購買：${kind.slice(4)}`
  return COIN_KIND[kind] ?? kind
}

// ---- 8-bit 音效（WebAudio 即時合成，不需要音檔）----

type Sfx = 'correct' | 'wrong' | 'coin' | 'level' | 'hatch'

const NOTES: Record<Sfx, [number, number][]> = {
  // [頻率 Hz, 長度 ms]
  correct: [[784, 70], [1047, 110]],
  wrong: [[330, 90], [262, 140]],
  coin: [[988, 60], [1319, 140]],
  level: [[523, 90], [659, 90], [784, 90], [1047, 220]],
  hatch: [[392, 80], [523, 80], [659, 80], [784, 80], [1047, 260]],
}

let ctx: AudioContext | null = null

export function playSfx(name: Sfx, on: boolean) {
  if (!on) return
  try {
    ctx ??= new AudioContext()
    let t = ctx.currentTime
    for (const [freq, ms] of NOTES[name]) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.06, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + ms / 1000)
      t += ms / 1000
    }
  } catch {
    // 沒有音效裝置就算了
  }
}
