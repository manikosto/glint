export type GlintTarget = {
  kind: 'url' | 'file'
  label: string
  target: string
  state?: 'new' | 'edit'
}

declare module 'claude-code' {
  interface PluginState {
    glint: {
      recent: GlintTarget[]
      isHidden: boolean
      expanded: StateFamily<number[]>
    }
  }
}
