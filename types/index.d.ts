export type CoderRun = { id: string; task: string; files: string[] }

declare module 'claude-code' {
  interface PluginState {
    'model-router': { runs: CoderRun[]; reviewing: number }
  }
}
