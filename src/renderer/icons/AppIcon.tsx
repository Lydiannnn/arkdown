import {
  FileText,
  FolderOpen,
  ListBullets,
  Archive,
  ArrowClockwise,
  ArrowLeft,
  ArrowUp,
  Sparkle,
  ShieldCheck,
  ArrowLineDown,
  ArrowLineLeft,
  ArrowLineRight,
  ArrowLineUp,
  BracketsCurly,
  Check,
  CaretLeft,
  CaretRight,
  CaretUp,
  CaretDown,
  ClipboardText,
  ClockCounterClockwise,
  CodeBlock,
  Copy,
  CopySimple,
  CornersIn,
  Eraser,
  FloppyDisk,
  Function as FunctionIcon,
  Image,
  LinkSimple,
  MagnifyingGlass,
  Minus,
  NoteBlank,
  PushPin,
  Scissors,
  SidebarSimple,
  Square,
  Table,
  TextHFive,
  TextHFour,
  TextHOne,
  TextHSix,
  TextHThree,
  TextHTwo,
  TextT,
  Translate,
  Trash,
  X,
  type Icon,
  type IconProps,
  type IconWeight,
} from '@phosphor-icons/react'
import './app-icon.css'

const ICONS = {
  outline: ListBullets,
  document: FileText,
  workspace: FolderOpen,
  minimize: Minus,
  maximize: Square,
  restore: CopySimple,
  close: X,
  search: MagnifyingGlass,
  history: ClockCounterClockwise,
  reload: ArrowClockwise,
  'sticky-note': NoteBlank,
  archive: Archive,
  trash: Trash,
  check: Check,
  copy: Copy,
  paste: ClipboardText,
  cut: Scissors,
  delete: Trash,
  save: FloppyDisk,
  paragraph: TextT,
  'heading-1': TextHOne,
  'heading-2': TextHTwo,
  'heading-3': TextHThree,
  'heading-4': TextHFour,
  'heading-5': TextHFive,
  'heading-6': TextHSix,
  'clear-format': Eraser,
  image: Image,
  'link-reference': LinkSimple,
  'horizontal-rule': Minus,
  table: Table,
  'code-block': CodeBlock,
  formula: FunctionIcon,
  yaml: BracketsCurly,
  'paragraph-before': ArrowLineUp,
  'paragraph-after': ArrowLineDown,
  pin: PushPin,
  'restore-window': CornersIn,
  sidebar: SidebarSimple,
  translate: Translate,
  ai: Sparkle,
  'send-up': ArrowUp,
  permission: ShieldCheck,
  previous: CaretLeft,
  next: CaretRight,
  'find-previous': CaretUp,
  'find-next': CaretDown,
  return: ArrowLeft,
  'close-history': ArrowLineRight,
  'toolbar-collapse': ArrowLineRight,
  'toolbar-expand': ArrowLineLeft,
} satisfies Record<string, Icon>

export type AppIconName = keyof typeof ICONS | 'ai-document' | 'ai-workspace'

export interface AppIconProps extends Omit<IconProps, 'children' | 'size' | 'weight'> {
  name: AppIconName
  size?: number
  weight?: IconWeight
}

export function AppIcon({
  className = '',
  color = 'currentColor',
  name,
  size = 16,
  style,
  weight = 'regular',
  ...props
}: AppIconProps) {
  if (name === 'ai-document' || name === 'ai-workspace') {
    const Shape = name === 'ai-document' ? FileText : FolderOpen
    return <span aria-hidden="true" className={`app-icon app-icon-ai ${className}`} style={{ width: size, height: size, color, ...style }}>
      <Shape size={size} weight={weight} aria-hidden="true" focusable="false" />
      <span className="app-icon-ai-label">AI</span>
    </span>
  }
  const IconComponent = ICONS[name]
  return (
    <IconComponent
      {...props}
      aria-hidden="true"
      className={`app-icon${className ? ` ${className}` : ''}`}
      color={color}
      focusable="false"
      size={size}
      style={{ color, ...style }}
      weight={weight}
    />
  )
}
