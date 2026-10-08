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

test('router-usage reports plan usage', async ($, on) => {
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: '/home/test' }) as never)
  on('fs.read', () => ({ value: '{}' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: 'chat-1' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [{ kind: 'five_hour', percentUsed: 20 }] } }) as never)
  const r = await $.command.run({ command: 'router-usage', args: '' } as never)
  expect(JSON.stringify(r)).toContain('Account plan')
  expect(JSON.stringify(r)).toContain('20%')
})

test('finished coders cannot be resumed', async ($, on) => {
  on('agent.spawn', (_$, e) => ({ model: e.model ?? '', agentId: 'coder-9' }))
  on('tool.call', () => ({ result: 'sent' }) as never)
  await $.agent.spawn({ subagentType: 'model-router:coder', prompt: HANDOFF, description: 'x' } as never)
  const r = await $.tool.call({ tool: 'SendMessage', to: 'coder-9', message: 'one more thing' } as never)
  expect(JSON.stringify(r)).toContain('single-use')
})

test('only absolute paths in ## Files lock files', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  let calls = 0
  on('tool.call', async () => {
    if (calls++ === 0) await gate
    return { result: 'done' } as never
  })
  const handoff = (files: string, steps = files) =>
    `## Goal\ng\n\n## Context\nc\n\n## Files\n${files}\n\n## Steps\n${steps}\n\n## Done when\nd`
  const agent = (files: string, steps?: string) =>
    $.tool.call({ tool: 'Agent', subagent_type: 'model-router:coder', description: 'x', prompt: handoff(files, steps) } as never)
  const first = agent('/tmp/a.py, src/x.py, https://x.io and / here')
  const other = await agent('/tmp/b.py')
  const overlap = await agent('/tmp/a.py')
  const sameSteps = await agent('/tmp/c.py', '/tmp/a.py, src/x.py, https://x.io and / here')
  const noFiles = await agent('src/relative.py')
  release()
  await first
  expect(JSON.stringify(other)).not.toContain('already belong')
  expect(JSON.stringify(overlap)).toContain('already belong')
  expect(JSON.stringify(sameSteps)).toContain('different instructions')
  expect(JSON.stringify(noFiles)).toContain('absolute path')
})

test('router-usage reset clears the counters', async ($, on) => {
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: '/home/test' }) as never)
  on('fs.read', () => ({ value: '{}' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: 'chat-1' }) as never)
  const r = await $.command.run({ command: 'router-usage', args: 'reset' } as never)
  expect(JSON.stringify(r)).toContain('are reset')
})

test('router-usage learns plan % per API dollar', async ($, on) => {
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
  const store: Record<string, unknown> = {
    spent: 10,
    calibration: { five_hour: { at: { resetsAt, p: 30, c: 5 } } },
    usage: {
      [new Date().toISOString().slice(0, 13)]: {
        'chat:claude-opus-5-5|chat-1': { calls: 1, input: 0, output: 100_000, cacheRead: 0, cacheWrite: 0 },
      },
    },
  }
  let file = JSON.stringify(store)
  on('env.get', () => ({ value: '/home/test' }) as never)
  on('fs.read', () => ({ value: file }) as never)
  on('fs.write', (_$, e: { path: string; text: string }) => {
    file = e.text
    return { value: undefined } as never
  })
  on('session.id', () => ({ value: 'chat-1' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt }] } }) as never)
  const r = await $.command.run({ command: 'router-usage', args: '' } as never)
  expect((JSON.parse(file) as { calibration: Record<string, { rate?: number }> }).calibration.five_hour?.rate).toBe(2)
  expect(JSON.stringify(r)).toContain('This chat')
  expect(JSON.stringify(r)).not.toContain('No router usage yet')
  expect(JSON.stringify(r)).toContain('of session')
})

test('reviewer needs a finished batch of coder changes', async $ => {
  const r = await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:reviewer', description: 'review', prompt: 'brief' } as never)
  expect(JSON.stringify(r)).toContain('nothing to review')
})
