import { expect, test } from 'claude-code/testing'

const HANDOFF = '## Goal\ng\n\n## Context\nc\n\n## Files\n/tmp/a.py\n\n## Steps\ns\n\n## Done when\nd'

test('main chat cannot edit files', async ($, on) => {
  on('tool.call', () => ({ result: 'edited' }) as never)
  const r = await $.tool.call({ tool: 'Edit', file_path: 'a.py', old_string: 'a', new_string: 'b' })
  expect(r.deny).toContain('model-router:executor')
})

test('shell writes are routed like edits', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  on('agent.spawn', (_$, e) => ({ model: e.model ?? '', agentId: `coder-${e.description}` }))
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Agent') await gate
    return { result: 'ran' } as never
  })
  const handoff = (files: string) => `## Goal\ng\n\n## Context\nc\n\n## Files\n${files}\n\n## Steps\ns\n\n## Done when\nd`
  const bash = (command: string, agentId?: string) => $.tool.call({ tool: 'Bash', command, agentId } as never)
  expect(JSON.stringify(await bash('sed -i s/a/b/ /tmp/x'))).toContain('model-router:executor')
  expect(JSON.stringify(await bash('cat > /tmp/x <<EOF'))).toContain('model-router:executor')
  expect((await bash('grep -rn foo . 2>/dev/null | head')).deny).toBeUndefined()
  expect((await bash('ls && echo a >&2')).deny).toBeUndefined()
  await $.agent.spawn({ subagentType: 'model-router:executor', prompt: handoff('none'), description: 'none', tool_use_id: 't-none' } as never)
  expect(JSON.stringify(await bash('rm /tmp/x', 'coder-none'))).toContain('lists none')
  await $.agent.spawn({ subagentType: 'model-router:executor', prompt: handoff('/tmp/x'), description: 'list', tool_use_id: 't-list' } as never)
  const running = $.tool.call({ tool: 'Agent', tool_use_id: 't-list', subagent_type: 'model-router:executor', description: 'list', prompt: handoff('/tmp/x') } as never)
  expect((await bash('rm /tmp/x', 'coder-list')).deny).toBeUndefined()
  release()
  await running
})

test('coder always spawns on Haiku in the foreground', async ($, on) => {
  let seen: { model?: string; background?: boolean } = {}
  on('agent.spawn', (_$, e) => {
    seen = { model: e.model, background: e.background }
    return { model: e.model ?? '', agentId: 'coder-1' }
  })
  await $.agent.spawn({ subagentType: 'model-router:executor', prompt: HANDOFF, model: 'opus' } as never)
  expect(seen).toEqual({ model: 'claude-haiku-5-5', background: false })
})

test('coder prompt must be a handoff document', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }) as never)
  const r = await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:executor', description: 'x', prompt: 'just do it' })
  expect(r.deny).toContain('## Done when')
})

test('pane shows the router state on terminal and VS Code', async ($, on) => {
  on('agent.spawn', (_$, e) => ({ model: e.model ?? '', agentId: 'coder-1' }))
  await $.agent.spawn({ subagentType: 'model-router:executor', prompt: HANDOFF, description: 'rename x' } as never)
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
  await $.agent.spawn({ subagentType: 'model-router:executor', prompt: HANDOFF, description: 'x' } as never)
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
    $.tool.call({ tool: 'Agent', subagent_type: 'model-router:executor', description: 'x', prompt: handoff(files, steps) } as never)
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
  expect(JSON.stringify(noFiles)).not.toContain('absolute path') // no absolute path: a read-only executor, allowed through
  expect(JSON.stringify(noFiles)).not.toContain('deny')
})

test('a heading named inside the Goal does not hide the real Files section', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  let calls = 0
  on('tool.call', async () => {
    if (calls++ === 0) await gate
    return { result: 'done' } as never
  })
  const agent = (goal: string, steps: string) =>
    $.tool.call({
      tool: 'Agent',
      subagent_type: 'model-router:executor',
      description: 'x',
      prompt: `## Goal\n${goal}\n\n## Context\nc\n\n## Files\n/tmp/z.py\n\n## Steps\n${steps}\n\n## Done when\nd`,
    } as never)
  const first = agent('edit z.py, see the `## Files` section', 'one')
  const second = await agent('g', 'two')
  release()
  await first
  expect(JSON.stringify(second)).toContain('already belong')
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

test('main chat may make a few direct calls, then must hand off', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }) as never)
  for (let i = 0; i < 6; i++) expect((await $.tool.call({ tool: 'mcp__GitLab__save_merge_request' } as never)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: '/tmp/a' } as never)).deny).toContain('model-router:executor')
})

// Last test: the overrides it sets stay in the module for the rest of this file.
test('MODEL_ROUTER_* env vars override the settings at session start', async ($, on) => {
  const env: Record<string, string> = { HOME: '/home/test', MODEL_ROUTER_EXECUTOR_MODEL: 'claude-sonnet-5-5', MODEL_ROUTER_MAX_DIRECT: '2' }
  let spawned = ''
  on('env.get', (_$, e) => ({ value: env[e.name] }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd, value: undefined }) as never)
  on('prompt.submit', () => ({ text: 'go' }) as never)
  on('agent.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('session.id', () => ({ value: 'chat-1' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [] } }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('fs.read', () => ({ value: '{}' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: 'ran' }) as never)
  on('agent.spawn', (_$, e) => {
    spawned = e.model ?? ''
    return { model: e.model ?? '', agentId: 'coder-env' }
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await $.prompt.submit({ text: 'go' } as never)
  await $.agent.spawn({ subagentType: 'model-router:executor', prompt: HANDOFF, description: 'x', tool_use_id: 't-env' } as never)
  expect(spawned).toBe('claude-sonnet-5-5')
  const call = () => $.tool.call({ tool: 'mcp__GitLab__save_merge_request' } as never)
  expect((await call()).deny).toBeUndefined()
  expect((await call()).deny).toBeUndefined()
  expect((await call()).deny).toContain('2 tool calls')
})

test('MODEL_ROUTER_* env vars are re-read on every prompt', async ($, on) => {
  const env: Record<string, string> = { HOME: '/home/test' }
  let spawned = ''
  on('env.get', (_$, e) => ({ value: env[e.name] }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd, value: undefined }) as never)
  on('prompt.submit', () => ({ text: 'go' }) as never)
  on('agent.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('session.id', () => ({ value: 'chat-2' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [] } }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('fs.read', () => ({ value: '{}' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: 'ran' }) as never)
  on('agent.spawn', (_$, e) => {
    spawned = e.model ?? ''
    return { model: e.model ?? '', agentId: 'coder-reload' }
  })
  await $.session.start({ cwd: '/tmp' } as never)
  env.MODEL_ROUTER_EXECUTOR_MODEL = 'claude-sonnet-5-5'
  await $.prompt.submit({ text: 'go' } as never)
  await $.agent.spawn({ subagentType: 'model-router:executor', prompt: HANDOFF, description: 'x', tool_use_id: 't-reload' } as never)
  expect(spawned).toBe('claude-sonnet-5-5')
})
