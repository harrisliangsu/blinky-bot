import type { ReactNode, SVGProps } from 'react'

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number
}

function Icon({ size = 14, children, ...rest }: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconPlus = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Icon>
)

export const IconSearch = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <circle cx="7.2" cy="7.2" r="3.8" />
    <path d="M10.2 10.2 13 13" />
  </Icon>
)

export const IconSettings = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5" />
  </Icon>
)

export const IconBot = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="2.5" y="5" width="11" height="8" rx="2.5" />
    <path d="M8 2.2V5M5.6 8.6h.01M10.4 8.6h.01" />
  </Icon>
)

export const IconRoutine = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M3 4.5h10M3 8h6.5M3 11.5h4" />
    <circle cx="12" cy="11.2" r="2.3" />
  </Icon>
)

export const IconChevronRight = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Icon>
)

export const IconFolder = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5h5.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z" />
  </Icon>
)

export const IconChevronLeft = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M10 3.5 5.5 8 10 12.5" />
  </Icon>
)

export const IconChevronDown = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M3.5 6 8 10.5 12.5 6" />
  </Icon>
)

export const IconCheck = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M3 8.4 6.3 11.7 13 5" />
  </Icon>
)

export const IconClose = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
)

export const IconSpinner = (p: IconProps): ReactNode => (
  <Icon {...p} className={`ob-spin ${p.className ?? ''}`.trim()}>
    <path d="M8 1.8a6.2 6.2 0 1 1-4.4 1.8" />
  </Icon>
)

export const IconCopy = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
    <path d="M10.5 5.5v-1a1.6 1.6 0 0 0-1.6-1.6H4.1A1.6 1.6 0 0 0 2.5 4.5v4.8a1.6 1.6 0 0 0 1.6 1.6h1" />
  </Icon>
)

export const IconStop = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.6" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconSend = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M8 13V3.4M4 7.2 8 3.2l4 4" />
  </Icon>
)

export const IconPaperclip = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M11.8 7.3 7.4 11.7a2.6 2.6 0 0 1-3.7-3.7l4.8-4.8a1.8 1.8 0 0 1 2.5 2.5l-4.7 4.8a.9.9 0 0 1-1.3-1.3l4.3-4.3" />
  </Icon>
)

export const IconMic = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="5.2" y="2" width="5.6" height="8" rx="2.8" />
    <path d="M3.5 7.8a4.5 4.5 0 0 0 9 0M8 12.3V14M5.8 14h4.4" />
  </Icon>
)

export const IconRefresh = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13.2 2.6v2.6h-2.6" />
  </Icon>
)

export const IconTrash = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M3.2 4.4h9.6M6.4 4.4V3.2h3.2v1.2M4.5 4.4l.6 8.2h5.8l.6-8.2" />
  </Icon>
)

export const IconArchive = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="2.4" y="3" width="11.2" height="3" rx="1" />
    <path d="M3.4 6v6.2a.9.9 0 0 0 .9.9h7.4a.9.9 0 0 0 .9-.9V6M6.4 9h3.2" />
  </Icon>
)

export const IconPencil = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M11.2 2.9 13.1 4.8 5.6 12.3l-2.6.7.7-2.6z" />
  </Icon>
)

export const IconRecord = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="4.2" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconPlay = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M5.4 3.6 12 8l-6.6 4.4z" fill="currentColor" />
  </Icon>
)

export const IconDisplay = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="8" rx="1.4" />
    <path d="M6 13.4h4" />
  </Icon>
)

export const IconExpand = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" />
  </Icon>
)

export const IconTerminal = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="m4.5 6 2 2-2 2M8.5 10h3" />
  </Icon>
)

export const IconArrowDown = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M8 3v10M4 9l4 4 4-4" />
  </Icon>
)

export const IconGrid = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="2" y="2.5" width="5" height="5" rx="1" />
    <rect x="9" y="2.5" width="5" height="5" rx="1" />
    <rect x="2" y="8.5" width="5" height="5" rx="1" />
    <rect x="9" y="8.5" width="5" height="5" rx="1" />
  </Icon>
)

export const IconPanel = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.6" />
    <path d="M10 3v10" />
  </Icon>
)

export const IconList = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M3 4.5h10M3 8h10M3 11.5h6" />
  </Icon>
)

export const IconBoard = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <rect x="2" y="2.6" width="4" height="10.8" rx="1.2" />
    <rect x="10" y="2.6" width="4" height="6.6" rx="1.2" />
  </Icon>
)

export const IconNote = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M4 4.5h8M4 8h8M4 11.5h4.5" />
  </Icon>
)

export const IconChat = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M13.5 8.6a4.6 4.6 0 0 1-4.6 4.6H5.2L2.5 15v-3.1A4.6 4.6 0 0 1 4.9 3.4h4a4.6 4.6 0 0 1 4.6 4.6z" />
  </Icon>
)

export const IconMove = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M2.5 8h11M10.6 5 13.5 8l-2.9 3M5.4 5 2.5 8l2.9 3" />
  </Icon>
)

export const IconGrip = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M6 4.5h.01M10 4.5h.01M6 8h.01M10 8h.01M6 11.5h.01M10 11.5h.01" strokeWidth={2} />
  </Icon>
)

export const IconSun = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2.3" />
    <path d="M8 1.7v1.6M8 12.7v1.6M1.7 8h1.6M12.7 8h1.6M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2" />
  </Icon>
)

export const IconMoon = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M10 2.3a5.3 5.3 0 1 0 3.7 9.1A4.3 4.3 0 0 1 10 2.3z" />
  </Icon>
)

export const IconWarning = (p: IconProps): ReactNode => (
  <Icon {...p}>
    <path d="M8 2.6 14 12.4H2z" />
    <path d="M8 6.6v2.6M8 11h.01" />
  </Icon>
)
