import type { GlintTarget } from '../types'

// Links and file paths: telling them apart, resolving them, and gathering the ones a reply mentions.

export type FileState = 'new' | 'edit'

// Filled by register: where the session runs, and the files Claude created or edited in it.
export const FILES = {
  cwd: '',
  home: '',
  changed: new Map<string, FileState>(),
}

// Set by the render hook for the drawing in progress: what a click on a link in a reply does.
export const LINKS: { press?: (href: string) => void } = {}

const EXT = 'tsx?|jsx?|mjs|cjs|mts|cts|json|jsonc|md|mdx|html?|css|scss|less|svg|png|jpe?g|gif|webp|pdf|py|swift|kt|kts|java|go|rs|rb|php|c|cc|cpp|h|hpp|m|mm|ya?ml|toml|ini|env|sh|zsh|bash|txt|log|lock|plist|xml|sql|gradle|graphql|gql|vue|svelte|astro|csv|xcconfig|entitlements|pbxproj'

// A bare relative file name or path with a known extension: index.html, hooks/view.tsx, ./app.json
export const RELPATH = new RegExp(`(?<![\\w/.:@~-])((?:\\.{1,2}/)?(?:[\\w@+-][\\w.@+-]*/)*[\\w@+-][\\w.@+-]*\\.(?:${EXT}))(?::\\d+)?(?![\\w/])`, 'g')

const ABS = /^(?:~|\.{1,2})?\/[\w.@+-]/
const REL = new RegExp(`^(?:\\.{1,2}/)?(?:[\\w@+-][\\w.@+-]*/)*[\\w@+-][\\w.@+-]*\\.(?:${EXT})(?::\\d+)?$`)

export const isPathLike = (s: string): boolean => !/\s/.test(s) && !/^https?:/.test(s) && (ABS.test(s) || REL.test(s))

export function resolvePath(p: string): string {
  const clean = p.replace(/:\d+(?::\d+)?$/, '')
  if (clean.startsWith('~/')) return `${FILES.home}${clean.slice(1)}`
  if (clean.startsWith('/')) return clean
  const base = FILES.cwd.replace(/\/$/, '')
  const parts = `${base}/${clean}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return '/' + out.join('/')
}

export const fileHref = (p: string) => `file://${encodeURI(resolvePath(p))}`

// A changed file is matched by its absolute path, or by its tail when the reply names it relative to somewhere else.
export function stateOf(p: string): FileState | undefined {
  const abs = resolvePath(p)
  const hit = FILES.changed.get(abs)
  if (hit) return hit
  const tail = '/' + p.replace(/^\.\//, '').replace(/:\d+(?::\d+)?$/, '')
  if (tail.length < 4) return undefined
  for (const [path, state] of FILES.changed) if (path.endsWith(tail)) return state
  return undefined
}

export type Target = GlintTarget

const URL_RE = /https?:\/\/[^\s<>()`'"]+[^\s<>()`'".,;:!?]/g
const MD_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g
const CODE = /`([^`\n]+)`/g
const ABS_IN_TEXT = /(?<![\w/.:])((?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]*)*)/g

const short = (s: string, n = 32) => (s.length > n ? '…' + s.slice(-(n - 1)) : s)

// Every URL and file the text names, in order of first mention, files Claude changed first.
export function gather(text: string, limit = 6): Target[] {
  const body = text.replace(/```[\s\S]*?```/g, ' ')
  const seen = new Set<string>()
  const out: Target[] = []
  const add = (kind: Target['kind'], label: string, raw: string) => {
    const target = kind === 'file' ? resolvePath(raw) : raw
    if (seen.has(target)) return
    seen.add(target)
    out.push({ kind, label: short(label), target, ...(kind === 'file' ? { state: stateOf(raw) } : {}) })
  }
  for (const m of body.matchAll(MD_LINK)) {
    const href = m[2]!
    if (/^https?:/.test(href)) add('url', href.replace(/^https?:\/\//, ''), href)
    else if (href.startsWith('file://')) add('file', m[1]!, decodeURI(href.slice(7)))
    else if (isPathLike(href)) add('file', href.split('/').pop() ?? href, href)
  }
  for (const m of body.matchAll(URL_RE)) add('url', m[0].replace(/^https?:\/\//, ''), m[0])
  for (const m of body.matchAll(CODE)) if (isPathLike(m[1]!)) add('file', m[1]!.split('/').pop() ?? m[1]!, m[1]!)
  const plain = body.replace(CODE, ' ').replace(MD_LINK, ' ').replace(URL_RE, ' ')
  for (const m of plain.matchAll(ABS_IN_TEXT)) if (m[1]!.length > 2) add('file', m[1]!.split('/').pop() ?? m[1]!, m[1]!)
  for (const m of plain.matchAll(RELPATH)) add('file', m[1]!.split('/').pop() ?? m[1]!, m[1]!)
  const rank = (t: Target) => (t.state === 'new' ? 0 : t.state === 'edit' ? 1 : t.kind === 'url' ? 2 : 3)
  return out.map((t, i) => [t, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([t]) => t).slice(0, limit)
}
