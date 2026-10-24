// 像素圖元件：學習中心與 YouTube 面板共用。放大時保持像素清楚（image-rendering: pixelated）。
import type { CSSProperties } from 'react'
import type { EggView, PetView } from './game'
import { eggSprite, petSprite, type Mood } from './sprites'

interface Sprite {
  url: string
  w: number
  h: number
}

export function Pixel({
  sprite,
  scale,
  className,
  title,
  style,
  onClick,
}: {
  sprite: Sprite
  scale: number
  className?: string
  title?: string
  style?: CSSProperties
  onClick?: () => void
}) {
  return (
    <img
      src={sprite.url}
      width={sprite.w * scale}
      height={sprite.h * scale}
      className={className}
      title={title}
      alt={title ?? ''}
      draggable={false}
      onClick={onClick}
      style={{ imageRendering: 'pixelated', ...style }}
    />
  )
}

export function PetPixel({
  pet,
  mood,
  scale,
  className,
  onClick,
}: {
  pet: PetView
  mood?: Mood
  scale: number
  className?: string
  onClick?: () => void
}) {
  const sprite = petSprite({
    species: pet.species,
    stage: pet.stage,
    branch: pet.branch,
    shiny: pet.shiny,
    mood,
    accessories: pet.accessories,
  })
  return <Pixel sprite={sprite} scale={scale} className={className} title={pet.name} onClick={onClick} />
}

export function EggPixel({ egg, scale, className }: { egg: EggView; scale: number; className?: string }) {
  return <Pixel sprite={eggSprite(egg.species, egg.warmth / egg.need)} scale={scale} className={className} title="蛋" />
}
