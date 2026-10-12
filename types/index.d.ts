export type AgentRun = { id: string; task: string; role: string }

declare module 'claude-code' {
  interface PluginState {
    'model-router': { runs: AgentRun[]; today: Record<string, number> }
  }
}
