/** Durable avatar IDs. Display order and translated names are not storage keys. */
export const AVATAR_SHAPES = [
  { id: 'round', name: '圆圆', en: 'Round' },
  { id: 'square', name: '方糖', en: 'Sugar cube' },
  { id: 'heart', name: '心心', en: 'Heart' },
  { id: 'wide-oval', name: '扁扁', en: 'Wide oval' },
  { id: 'drop', name: '水滴', en: 'Drop' },
  { id: 'triangle', name: '小山', en: 'Mountain' },
  { id: 'hexagon', name: '六角', en: 'Hexagon' },
  { id: 'diamond', name: '菱菱', en: 'Diamond' },
  { id: 'cloud', name: '云朵', en: 'Cloud' },
  { id: 'flower', name: '花花', en: 'Flower' },
  { id: 'star', name: '星星', en: 'Star' },
  { id: 'bean', name: '豆豆', en: 'Bean' },
  { id: 'pentagon', name: '五角', en: 'Pentagon' }
] as const

export const AVATAR_COLORS = [
  { id: 'cream', name: '奶油白', en: 'Cream', hex: '#F9F4F7' },
  { id: 'lavender', name: '薰衣草紫', en: 'Lavender', hex: '#DFD3F3' },
  { id: 'lilac', name: '浅丁香', en: 'Lilac', hex: '#E9DDF5' },
  { id: 'sky', name: '天空蓝', en: 'Sky', hex: '#CEE6F3' },
  { id: 'mint', name: '薄荷绿', en: 'Mint', hex: '#CFECDD' },
  { id: 'sage', name: '鼠尾草绿', en: 'Sage', hex: '#C6DECF' },
  { id: 'butter', name: '奶油黄', en: 'Butter', hex: '#F7E7BD' },
  { id: 'apricot', name: '浅杏色', en: 'Apricot', hex: '#F8DDC8' },
  { id: 'peach', name: '蜜桃粉', en: 'Peach', hex: '#F7D7D7' },
  { id: 'rose', name: '豆沙粉', en: 'Rose', hex: '#E9CAD2' },
  { id: 'mist', name: '暖雾灰', en: 'Mist', hex: '#DFD9DD' }
] as const

export type AvatarShapeId = typeof AVATAR_SHAPES[number]['id']
export type AvatarColorId = typeof AVATAR_COLORS[number]['id']
export const DEFAULT_AVATAR_SHAPE: AvatarShapeId = 'round'
export const DEFAULT_AVATAR_COLOR: AvatarColorId = 'cream'
export function avatarShape(value: unknown): AvatarShapeId {
  return AVATAR_SHAPES.find(shape => shape.id === value)?.id ?? DEFAULT_AVATAR_SHAPE
}
export function avatarColor(value: unknown): typeof AVATAR_COLORS[number] {
  return AVATAR_COLORS.find(color => color.id === value) ?? AVATAR_COLORS[0]
}

/** Missing or explicitly cleared shape preserves a user's legacy emoji. */
export function avatarFields(value: { avatarShape?: unknown; avatarColor?: unknown }): { avatarShape?: AvatarShapeId | ''; avatarColor?: AvatarColorId | '' } {
  if (typeof value.avatarShape !== 'string') return {}
  return value.avatarShape ? { avatarShape: avatarShape(value.avatarShape), avatarColor: avatarColor(value.avatarColor).id } : { avatarShape: '', avatarColor: '' }
}
