import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'
import type { Bot } from '../../../shared/types'
import { avatarColor, avatarShape } from '../../../shared/botAvatars'
import layers from '../assets/avatars/layers.json'
import { useAvatarActivity } from './avatarActivity'
import './BotAvatar.css'

interface BotAvatarProps {
  bot?: Pick<Bot, 'emoji' | 'color' | 'name' | 'avatarShape' | 'avatarColor'> & Partial<Pick<Bot, 'id'>>
  size?: 'sm' | 'md' | 'lg'
  /** Adds a faint halo — used where avatars sit on a busy surface. */
  ring?: boolean
  active?: boolean
  /** Thumbnail grids stay static; identity surfaces blink independently. */
  animate?: boolean
}

const sources = import.meta.glob<string>('../assets/avatars/source/*.png', { eager: true, query: '?url', import: 'default' })
const plates = import.meta.glob<string>('../assets/avatars/plates/*.png', { eager: true, query: '?url', import: 'default' })

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

/** One renderer for creation, editor, navigation, conversation and details. */
export function BotAvatar({ bot, size = 'md', ring = false, active = false, animate = true }: BotAvatarProps): ReactNode {
  const id = useId().replaceAll(':', '')
  const replying = useAvatarActivity(animate ? bot?.id : undefined)
  const reduced = useReducedMotion()
  const [blinking, setBlinking] = useState(false)
  const [failure, setFailure] = useState<'none' | 'selected' | 'all'>('none')
  useEffect(() => { setFailure('none') }, [bot?.avatarShape])
  useEffect(() => {
    if (!animate || reduced || !bot?.avatarShape || failure === 'all') { setBlinking(false); return }
    let blinkTimer: ReturnType<typeof setTimeout>, openTimer: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      blinkTimer = setTimeout(() => {
        if (!document.hidden) {
          setBlinking(true)
          openTimer = setTimeout(() => setBlinking(false), 135)
        }
        schedule()
      }, 2800 + Math.random() * 4800)
    }
    schedule()
    return () => { clearTimeout(blinkTimer); clearTimeout(openTimer) }
  }, [animate, reduced, bot?.avatarShape, failure])
  const style = { '--ob-bot-color': bot?.color ?? 'var(--ob-accent)' } as CSSProperties
  const selectedShape = avatarShape(bot?.avatarShape)
  const hasSelected = sources[`../assets/avatars/source/${selectedShape}.png`] && plates[`../assets/avatars/plates/${selectedShape}.png`]
  const shape = failure === 'selected' || !hasSelected ? 'round' : selectedShape
  const source = sources[`../assets/avatars/source/${shape}.png`]
  const plate = plates[`../assets/avatars/plates/${shape}.png`]
  const artwork = bot?.avatarShape && source && plate && failure !== 'all'
  const onImageError = (): void => setFailure(shape === 'round' ? 'all' : 'selected')
  const layer = layers[shape]
  const color = avatarColor(bot?.avatarColor)
  const channels = color.hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255 / layer.luminance)
  const matrix = channels.map(c => `${.2126 * c} ${.7152 * c} ${.0722 * c} 0 0`).join(' ') + ' 0 0 0 1 0'
  const eyes = layer.eyes
  return (
    <span
      className={`ob-avatar ob-avatar-${size}${artwork ? ' ob-avatar-artwork' : ''}${ring ? ' ob-avatar-ring' : ''}${active ? ' ob-avatar-active' : ''}${artwork && blinking && !reduced ? ' is-blinking' : ''}${artwork && replying && !reduced ? ' is-replying' : ''}`}
      style={style}
      aria-hidden="true"
      data-avatar-shape={artwork ? shape : 'legacy'}
      data-avatar-color={artwork ? color.id : undefined}
      data-avatar-motion={reduced || !animate ? 'static' : 'enabled'}
    >
      {artwork ? <svg className="ob-avatar-sprite" viewBox={layer.viewBox} focusable="false">
        <defs>
          <clipPath id={`${id}-silhouette`}><path d={layer.silhouette} /></clipPath>
          <filter id={`${id}-tint`} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values={matrix} /></filter>
          <filter id={`${id}-features`} colorInterpolationFilters="sRGB">
            {/* Preserve the actual pink pigment and dark features, with no pale skin cutouts. */}
            <feColorMatrix in="SourceGraphic" type="matrix" values={`0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 7 -7 0 0 ${-layer.redness * 7 - .18}`} result="blush" />
            <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -4 -4 -4 0 5" result="features" />
            <feMerge><feMergeNode in="blush" /><feMergeNode in="features" /></feMerge>
          </filter>
          <filter id={`${id}-patch-soft`}><feGaussianBlur stdDeviation="3" /></filter>
          <filter id={`${id}-face-edge`}><feGaussianBlur stdDeviation="2" /></filter>
          <mask id={`${id}-face`} maskUnits="userSpaceOnUse" x="0" y="0" width={layer.width} height={layer.height}>
            <path d={layer.face} fill="white" filter={`url(#${id}-face-edge)`} />
            <use href={`#${id}-base`} filter={`url(#${id}-features)`} />
          </mask>
          <mask id={`${id}-patch`} maskUnits="userSpaceOnUse" x="0" y="0" width={layer.width} height={layer.height}>
            <g fill="white" filter={`url(#${id}-patch-soft)`}>{eyes.map((eye, index) => <ellipse key={index} cx={eye.cx} cy={eye.cy} rx={eye.rx + 12} ry={eye.ry + 12} />)}</g>
          </mask>
          {eyes.map((eye, index) => <clipPath key={index} id={`${id}-eye-${index}`}><path d={eye.path} /></clipPath>)}
          <g id={`${id}-base`}>
            <image href={source} width={layer.width} height={layer.height} onError={onImageError} />
            {/* Only generated eye-removal patches are used; all other original pixels survive. */}
            <image href={plate} width={layer.width} height={layer.height} mask={`url(#${id}-patch)`} onError={onImageError} />
          </g>
        </defs>
        <g clipPath={`url(#${id}-silhouette)`}>
          <use href={`#${id}-base`} />
          <use href={`#${id}-base`} filter={`url(#${id}-tint)`} mask={`url(#${id}-face)`} />
          {eyes.map((eye, index) => <g key={index} className="ob-avatar-gaze" style={{ '--avatar-gaze-x': `${eye.rx * .29}px` } as CSSProperties}>
            <g className="ob-avatar-eyelid" style={{ transformOrigin: `${eye.cx}px ${eye.cy}px` }}>
              <image className="ob-avatar-eye" href={source} width={layer.width} height={layer.height} clipPath={`url(#${id}-eye-${index})`} />
            </g>
          </g>)}
        </g>
      </svg> : bot?.emoji || '◆'}
    </span>
  )
}
