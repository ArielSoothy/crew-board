export type CrewBoardEnvOwner = { sessionId?: string }
export type CrewBoardOwnership = 'mine' | 'not mine' | 'unknown'

export type CrewBoardRun = {
  label: 'claude' | 'codex' | 'gemini' | 'claude-cli'
  model?: string
  effort?: string
  folder?: string
  outputPaths: string[]
}

export type CrewBoardWorker = CrewBoardRun & {
  id: string
  toolUseId?: string
  taskId?: string
  scope?: 'own' | 'elsewhere'
  pid?: number
  processStartedAt?: number
  folderChecked?: boolean
  outputCache?: Record<string, { size: number; bytes: number; count: number; action: string }>
  livePaths?: string[]
  lastGrowthAt?: number
  observedBytes?: number
  stallNotified?: boolean
  stallReported?: boolean
  name?: string
  description?: string
  subagentType?: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'completed' | 'failed'
  progress: string
  count: number
  action: string
}

export type CrewBoardCompletion = {
  taskId?: string
  toolUseId?: string
  at: number
  status: 'completed' | 'failed'
  progress: string
}

export type CrewBoardState = {
  now: number
  polledAt: number
  workers: CrewBoardWorker[]
  completions: CrewBoardCompletion[]
  pendingSteps: Record<string, { count: number; action: string }>
}

declare module 'claude-code' {
  interface PluginState {
    'crew-board': { board: CrewBoardState }
  }
}
