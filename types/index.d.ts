export type QueuedPr = {
  number: number
  title: string
  subsystem: string
  fixes: number[]
  additions: number
  deletions: number
  files: string[]
  mergeable: string
  review: string
  isDraft: boolean
  overlaps: number[]
  alsoIn: number[]
}

export type Queue = {
  repo: string
  author: string
  fetchedAt: string
  prs: QueuedPr[]
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'temper-pr-queue': { queue: Queue | null }
  }
}
