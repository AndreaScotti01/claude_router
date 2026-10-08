import { expect, test } from 'claude-code/testing'

const HANDOFF = '## Goal\ng\n\n## Context\nc\n\n## Files\n/tmp/a.py\n\n## Steps\ns\n\n## Done when\nd'

test('main chat cannot edit files', async ($, on) => {
  on('tool.call', () => ({ result: 'edited' }) as never)
  const r = await $.tool.call({ tool: 'Edit', file_path: 'a.py', old_string: 'a', new_string: 'b' })
  expect(r.deny).toContain('model-router:coder')
})

test('coder always spawns on Haiku in the foreground', async ($, on) => {
  let seen: { model?: string; background?: boolean } = {}
  on('agent.spawn', (_$, e) => {
    seen = { model: e.model, background: e.background }
    return { model: e.model ?? '', agentId: 'coder-1' }
  })
  await $.agent.spawn({ subagentType: 'model-router:coder', prompt: HANDOFF, model: 'opus' } as never)
  expect(seen).toEqual({ model: 'claude-haiku-5-5', background: false })
})

test('coder prompt must be a handoff document', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }) as never)
  const r = await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:coder', description: 'x', prompt: 'just do it' })
  expect(r.deny).toContain('## Done when')
})

test('pane shows the router state on terminal and VS Code', async ($, on) => {
  on('agent.spawn', (_$, e) => ({ model: e.model ?? '', agentId: 'coder-1' }))
  await $.agent.spawn({ subagentType: 'model-router:coder', prompt: HANDOFF, description: 'rename x' } as never)
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({
      plugin: 'model-router',
      surface,
      component: 'Pane',
      requestId: 'model-router',
      props: { title: 'Model router', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
    })
    expect(await ui.find({ type: 'Text', text: /model-router active/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /haiku ▸ rename x/ })).toBeDefined()
    await ui.unmount()
  }
})

test('command output is drawn as markdown on terminal and VS Code', async $ => {
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({
      plugin: 'model-router',
      surface,
      component: 'CommandOutput',
      props: { command: 'router-usage', args: '', text: '| a | b |\n|---|---|\n| 1 | 2 |', isErrored: false },
    })
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    await ui.unmount()
  }
})
