import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'
import type { GlintTarget } from '../types'

import { parse } from './markdown'
import { boxArt, mermaidText } from './mermaid'
import type { Drawn, Fold } from './render'
import { remember, renderBlocks, renderExpandedShell, renderToolGroup, renderToolRow, renderTurnDuration, width } from './render'
import { helpText, rtlShowcaseText, showcaseText } from './help'
import { PRESET_NAMES } from './presets'
import type { Style } from './theme'
import { resolveStyle } from './theme'
import type { Terminal } from './rtl'
import { TERMINALS, hasRtl } from './rtl'
import { FILES, LINKS, gather, resolvePath } from './links'

const recent = atom({ plugin: 'glint', key: 'recent' } as const, [] as GlintTarget[])
const isHidden = atom({ plugin: 'glint', key: 'isHidden' } as const, false)
// Per drawn message: the blocks the person unfolded.
const expanded = atom({ plugin: 'glint', key: 'expanded' } as const, [] as number[])

async function foldFor($: EngineInterface, e: { requestId: string }): Promise<Fold> {
  const member = memberOf(expanded, e)
  const open = new Set(await read($, member))
  return {
    isOpen: b => open.has(b),
    toggle: b => { void update($, member, list => (list.includes(b) ? list.filter(x => x !== b) : [...list, b])) },
  }
}

// A file or URL from a reply: a web URL opens in the browser and a file is only revealed in Finder: the
// target comes from a reply's text, so it is never launched (a .command or .app would run) and no other URL scheme is handed to the system.
async function openTarget($: EngineInterface, t: GlintTarget) {
  if (t.kind === 'url' && /^https?:\/\/[^\s]+$/i.test(t.target)) {
    await $.process.run(['open', t.target]).catch(() => undefined)
  } else if (t.kind === 'file' && t.target.startsWith('/')) {
    await $.process.run(['open', '-R', '--', t.target]).catch(() => undefined)
  } else {
    $.ui.toast(`Not opened: ${t.target.slice(0, 60)}`)
  }
}

const HINT = [
  'Replies in this session are drawn by the glint mod, which runs inside Claude Code and is not a command or tool to call: when the user asks to show something with glint, write it as markdown in the reply.',
  'Markdown tables, GitHub alerts (> [!WARNING], > [!NOTE]), fenced code with a language tag, and ```mermaid blocks render as colored terminal graphics:',
  'flowcharts, sequence diagrams and xychart-beta bar or line charts.',
  'When a reply carries a numeric series or a flow that is easier to see than read, add one small diagram or chart with short labels.',
  'Skip diagrams for simple answers.',
  'Put any command or snippet the user may run or copy in a fenced block with a language tag, never inline code: fenced blocks get a copy button, inline code does not.',
].join(' ')

const detectTerminal = async ($: EngineInterface): Promise<Terminal | null> => {
  const program = await $.env.get('TERM_PROGRAM')
  const term = await $.env.get('TERM')
  if ((await $.env.get('KITTY_WINDOW_ID')) || term === 'xterm-kitty') return 'kitty'
  if (program === 'Apple_Terminal') return 'apple-terminal'
  if (program === 'WarpTerminal') return 'warp'
  if (program === 'ghostty') return 'ghostty'
  if (program === 'WezTerm') return 'wezterm'
  if (program === 'vscode') return 'vscode'
  if (program === 'iTerm.app') return 'iterm'
  if (term === 'alacritty' || (await $.env.get('ALACRITTY_WINDOW_ID'))) return 'alacritty'
  if (await $.env.get('WT_SESSION')) return 'windows-terminal'
  if (await $.env.get('VTE_VERSION')) return 'gnome'
  if (await $.env.get('KONSOLE_VERSION')) return 'konsole'
  return null
}

const applyRtl = async ($: EngineInterface, style: Style): Promise<void> => {
  if (style.rtl !== 'auto') return
  const terminal = await detectTerminal($)
  style.reorder = terminal !== null
  if (terminal) style.shape = TERMINALS[terminal]
}

const expandedCalls = new Set<string>()

// A link clicked in a reply: a file by its path, a URL as written.
async function openHref($: EngineInterface, href: string) {
  const isFile = href.startsWith('file://')
  const target = isFile ? decodeURI(href.slice(7)) : href
  await openTarget($, { kind: isFile ? 'file' : 'url', label: target, target })
}

const drawMarkdown = ($: EngineInterface, el: ReturnType<EngineInterface['ui']['resolve']>, style: Style, blocks: ReturnType<typeof parse>, columns: number, fold?: Fold): RenderElement[] => {
  const { Button } = el
  const copy = (text: string, key: string, label = '⧉ copy') =>
    style.copyButtons ? (
      <Button
        key={key}
        plain
        dimColor
        hover={{ dimColor: false, bold: true }}
        label={label}
        onPress={press => {
          $.ui.copy({ text, surface: press.surface })
            .then(r => $.ui.toast(r.isCopied ? 'Copied' : `Copy failed: ${r.reason}`))
            .catch(() => $.ui.toast('Copy failed'))
        }}
      />
    ) : null
  LINKS.press = href => { void openHref($, href) }
  const drawn: Drawn = new Map()
  if (style.mermaid) {
    for (const [i, block] of blocks.entries()) {
      if (block.kind !== 'code' || block.lang.toLowerCase() !== 'mermaid') continue
      const art = mermaidText(block.lines.join('\n'), style.mermaidAscii, columns)
      if (art !== null && art.split('\n').every(l => width(l) <= columns - 2)) drawn.set(i, { element: boxArt(el, style, art, `b${i}`), art })
    }
  }
  return renderBlocks(el, style, blocks, columns, drawn, copy, fold)
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return
  const style = resolveStyle(options)
  const parsed = new Map<string, ReturnType<typeof parse>>()
  const parseCached = (text: string) => remember(parsed, text, () => parse(text, { numbers: style.highlightNumbers, paths: style.highlightPaths }))

  if (options.toolRows !== false) {
    on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
      if (e.props.isExpanded) {
        for (const call of e.props.calls) if (call.tool_use_id) expandedCalls.add(call.tool_use_id)
        return next(e)
      }
      return renderToolGroup($.ui.resolve(e), style, e.props.calls, e.props.isActive, Math.max(40, (e.viewport?.columns ?? 100) - 4))
    })
    on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
      if (!expandedCalls.has(e.props.tool_use_id)) return renderToolRow($.ui.resolve(e), style, e.props, Math.max(40, (e.viewport?.columns ?? 100) - 4))
      return e.props.tool === 'Bash' || e.props.tool === 'PowerShell' ? renderExpandedShell($.ui.resolve(e), style, e.props) : next(e)
    })
  }

  on('session.start', async ($, e, next) => {
    await applyRtl($, style)
    FILES.cwd = e.cwd
    FILES.home = (await $.env.get('HOME')) ?? ''
    const started = await next(e)
    await $.command
      .register({ name: 'glint', description: 'Switch the glint theme, or list themes', argumentHint: '[theme <name>]' })
      .catch(() => undefined)
    return started
  })

  // Files Claude creates or edits are colored as such wherever a reply names them.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    if (ran.isError || ran.deny !== undefined || !(tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit')) return ran
    const input = e as unknown as Record<string, unknown>
    const raw = String(input.file_path ?? input.notebook_path ?? '')
    if (!raw) return ran
    const path = resolvePath(raw)
    const created = tool === 'Write' && (ran.result as { type?: unknown } | undefined)?.type === 'create'
    if (FILES.changed.get(path) !== 'new') FILES.changed.set(path, created ? 'new' : 'edit')
    return ran
  })

  // The link band above the prompt (off by default: links and files are clickable in the reply itself).
  if (options.linkBand === true) {
    on('turn.complete', async ($, e, next) => {
      const r = await next(e)
      if (e.agentId || e.isAborted) return r
      const found = gather(e.answer ?? '')
      await update($, recent, () => found)
      await update($, isHidden, () => false)
      return r
    })

    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      if (e.props.hasSurvey || e.props.view.agentId || e.props.isWorking) return next(e)
      const list = await read($, recent)
      if (!list.length || (await read($, isHidden))) return next(e)
      const { Box, Text, Button } = $.ui.resolve(e)
      const cols = e.props.bodyColumns
      const icon = (t: GlintTarget) => (t.kind === 'url' ? '↗' : t.state === 'new' ? '+' : t.state === 'edit' ? '✎' : '◇')
      let used = 4
      const shown = list.filter(t => (used += t.label.length + 7) <= cols)
      return (
        <Box flexDirection="row" gap={1} width={cols}>
          <Text dimColor>⌁</Text>
          {shown.map((t, i) => (
            <Button key={`go-${i}`} label={`${icon(t)} ${t.label}`} hotkey={String(i + 1)} plain onPress={() => { void openTarget($, t) }} />
          ))}
          <Button key="hide" label="×" plain dimColor onPress={() => { void update($, isHidden, () => true) }} />
        </Box>
      )
    })
  }

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      FILES.changed.clear()
      await update($, recent, () => [])
    }
    return next(e)
  })

  on('command.run', { command: 'glint' }, async ($, e) => {
    const [sub, name] = e.args.trim().split(/\s+/)
    if (sub === 'demo') return { text: showcaseText(PRESET_NAMES) }
    if (sub === 'demo-rtl') {
      await applyRtl($, style)
      return { text: rtlShowcaseText() }
    }
    if (sub !== 'theme' || !name) return { text: helpText(PRESET_NAMES) }
    if (!(PRESET_NAMES as readonly string[]).includes(name)) return { text: `Unknown theme "${name}". Themes: ${PRESET_NAMES.join(', ')}` }
    const result = await $.config.set({ key: `${$.plugin.name}.theme`, value: name })
    return { text: result.deny ? `Could not switch theme: ${result.deny}` : `Theme set to ${name}.` }
  })

  on('ui.render', { component: 'TurnDuration' }, ($, e) => renderTurnDuration($.ui.resolve(e), style, e.props.word, e.props.durationMs))

  on('prompt.submit', async ($, e, next) => {
    await applyRtl($, style)
    if (!style.diagramHints || (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge')) return next(e)
    return next({ ...e, context: [...(e.context ?? []), HINT] })
  })

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const blocks = parseCached(e.props.text)
    if (blocks.length === 0) return next(e)
    const el = $.ui.resolve(e)
    const { Box } = el
    const columns = Math.max(20, (e.viewport?.columns ?? 100) - 4)
    return <Box flexDirection="column" rowGap={1} {...(style.reorder && hasRtl(e.props.text) ? { width: '100%' } : {})}>{drawMarkdown($, el, style, blocks, columns, await foldFor($, e))}</Box>
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const blocks = parseCached(e.props.text)
    if (blocks.length === 0) return next(e)
    const el = $.ui.resolve(e)
    const { Box, Text } = el
    const columns = Math.max(20, (e.viewport?.columns ?? 100) - 4)
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={style.theme.accent}>{e.props.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexDirection="column" rowGap={1} flexGrow={1}>
          {drawMarkdown($, el, style, blocks, columns, await foldFor($, e))}
        </Box>
      </Box>
    )
  })
}
