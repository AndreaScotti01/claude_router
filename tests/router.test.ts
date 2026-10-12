import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HANDOFF = '## Goal\ng\n\n## Context\nc\n\n## Scope\ns\n\n## Done when\nd'
const NO_ANSWER = { value: { isAnswered: false, reason: 'empty-reply' } } as never

// Stubs the engine calls metering and analytics make (not the files, so a test can supply its own knowledge base).
function engine(on: On, env: Record<string, string> = {}) {
  on('env.get', (_$, e) => ({ value: env[e.name] ?? (e.name === 'HOME' ? '/home/test' : undefined) }) as never)
  on('session.id', () => ({ value: 'chat-t' }) as never)
  on('session.messages', () => ({ value: [] }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [] } }) as never)
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false } }) as never)
}

// Stubs every engine call a prompt makes; the knowledge base reads as 'kb text'.
function stub(on: On, env: Record<string, string> = {}) {
  engine(on, env)
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('router-kb.md') ? 'kb text' : '{}' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
}

test('the main chat runs on Sonnet whatever model the session names', async ($, on) => {
  let model = ''
  on('turn.step', async function* (_$, e) {
    model = e.model
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  } as never)
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 0 } as never)) {
    // drain the stream
  }
  expect(model).toBe('claude-sonnet-5-5')
})

test('no message is classified: the main chat keeps all its tools', async ($, on) => {
  let calls = 0
  stub(on)
  on('model.complete', () => {
    calls++
    return NO_ANSWER
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.prompt.submit({ text: 'Refactor the auth module' } as never)
  expect(calls).toBe(0)
  for (const tool of ['Read', 'Edit', 'Bash']) expect((await $.tool.call({ tool, file_path: '/tmp/a' } as never)).deny).toBeUndefined()
})

test('worker and advisor agents need a handoff and get the user message verbatim', async ($, on) => {
  stub(on)
  let sent: { prompt?: string } = {}
  on('tool.call', (_$, e) => {
    sent = e as never
    return { result: 'ok' } as never
  })
  await $.prompt.submit({ text: 'Refactor the auth module\n  keep  spacing' } as never)
  for (const subagent_type of ['model-router:haiku', 'model-router:opus']) {
    const ok = await $.tool.call({ tool: 'Agent', subagent_type, description: 'auth', prompt: HANDOFF } as never)
    expect(ok.deny).toBeUndefined()
    expect(sent.prompt).toContain("## User's message (verbatim)\nRefactor the auth module\n  keep  spacing")
    const bare = await $.tool.call({ tool: 'Agent', subagent_type, description: 'x', prompt: 'just do it' } as never)
    expect(bare.deny).toContain('## Done when')
  }
})

test('model-router:haiku runs on Haiku and model-router:opus on Opus, in the foreground', async ($, on) => {
  const seen: { model?: string; background?: boolean }[] = []
  on('agent.spawn', (_$, e) => {
    seen.push({ model: e.model, background: e.background })
    return { model: e.model ?? '', agentId: `a-${seen.length}` }
  })
  await $.agent.spawn({ subagentType: 'model-router:haiku', prompt: HANDOFF, description: 'x', tool_use_id: 't-h' } as never)
  await $.agent.spawn({ subagentType: 'model-router:opus', prompt: HANDOFF, description: 'x', tool_use_id: 't-o' } as never)
  expect(seen).toEqual([
    { model: 'claude-haiku-5-5', background: false },
    { model: 'claude-opus-5-5', background: false },
  ])
})

test('the advisor and the worker are registered read-only', async ($, on) => {
  const registered: Record<string, { disallowedTools?: string[]; model?: string }> = {}
  stub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd, value: undefined }) as never)
  on('agent.register', (_$, e) => {
    registered[String(e.name)] = e as never
    return { value: undefined } as never
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  expect(Object.keys(registered).sort()).toEqual(['haiku', 'opus'])
  for (const a of Object.values(registered)) expect(a.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write', 'Agent']))
  expect(registered.haiku?.model).toBe('claude-haiku-5-5')
  expect(registered.opus?.model).toBe('claude-opus-5-5')
})

test('pane shows the router state on terminal and VS Code', async ($, on) => {
  on('agent.spawn', (_$, e) => ({ model: e.model ?? '', agentId: 'haiku-2' }))
  await $.agent.spawn({ subagentType: 'model-router:haiku', prompt: HANDOFF, description: 'rename x' } as never)
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
  const text = (r as unknown as { text: string }).text
  expect(text.startsWith('\n\n')).toBe(true)
  expect(text.trimStart().startsWith('**Account plan')).toBe(true)
})

test('a finished agent can be resumed while its cache is warm, not after', async ($, on) => {
  const env: Record<string, string> = {}
  stub(on, env)
  on('agent.spawn', (_$, e) => ({ model: e.model ?? '', agentId: 'haiku-9' }))
  on('tool.call', () => ({ result: 'sent' }) as never)
  await $.prompt.submit({ text: 'go' } as never)
  await $.agent.spawn({ subagentType: 'model-router:haiku', prompt: HANDOFF, description: 'x', tool_use_id: 't-9' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:haiku', description: 'x', prompt: HANDOFF, tool_use_id: 't-9' } as never)
  expect((await $.tool.call({ tool: 'SendMessage', to: 'haiku-9', message: 'one more thing' } as never)).deny).toBeUndefined()
  env.MODEL_ROUTER_RESUME_MINUTES = '0' // 0 minutes: every finished agent is past its window
  await $.prompt.submit({ text: 'go' } as never)
  expect(JSON.stringify(await $.tool.call({ tool: 'SendMessage', to: 'haiku-9', message: 'one more thing' } as never))).toContain('cache is cold')
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
  expect(JSON.stringify(r)).toContain('cache hit')
})

test('analytics appends prompt and tool events to a SQLite file', async ($, on) => {
  const sql: string[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }) as never)
  on('session.id', () => ({ value: 'chat-a' }) as never)
  on('session.messages', () => ({ value: [] }) as never)
  on('prompt.submit', () => ({ text: 'go' }) as never)
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: 'ran' }) as never)
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'sqlite3') sql.push(`${e.argv.join(' ')}\n${e.init?.stdin ?? ''}`)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false } } as never
  })
  await $.prompt.submit({ text: 'go' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/a' } as never)
  await new Promise(r => setTimeout(r, 20))
  const out = sql.join('\n')
  expect(out).toContain('/home/test/.claude/model-router-analytics.db')
  expect(out).toContain('CREATE TABLE IF NOT EXISTS events')
  expect(out).toContain("'prompt'")
  expect(out).toContain("'tool'")
  expect(out).toContain('"tool":"Read"')
})

test('the main chat gets the protocol on any model, but not inside a worker or advisor agent', async ($, on) => {
  stub(on)
  on('prompt.compose', () => ({ sections: [] }) as never)
  let during = ''
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Agent') during = JSON.stringify(await compose('claude-sonnet-5-5'))
    return { result: 'ok' } as never
  })
  const compose = (model: string) => $.prompt.compose({ model, promptModel: model, surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) expect(JSON.stringify(await compose(model))).toContain('model-router:protocol')
  await $.prompt.submit({ text: 'fix the typo' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:haiku', description: 'x', prompt: HANDOFF } as never)
  expect(during).not.toContain('model-router:protocol')
  expect(during).not.toContain('model-router:kb')
  expect(JSON.stringify(await compose('claude-sonnet-5-5'))).toContain('model-router:protocol')
})

test('session start marks the bullets of files changed since the knowledge base commit', async ($, on) => {
  let written = ''
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }) as never)
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('router-kb.md') ? '<!-- model-router knowledge base · checked at abc -->\n- (src/a.ts) x\n- (src/b.ts) y\n' : '{}' }) as never)
  on('fs.write', (_$, e: { path: string; text: string }) => {
    if (e.path.endsWith('router-kb.md')) written = e.text
    return { value: undefined } as never
  })
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const stdout = cmd === 'git rev-parse HEAD' ? 'def\n' : cmd === 'git diff --name-only abc' ? 'src/a.ts\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false } } as never
  })
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd, value: undefined }) as never)
  on('agent.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  expect(written).toContain('checked at def')
  expect(written).toContain('- (stale?) (src/a.ts) x')
  expect(written).toContain('- (src/b.ts) y')
  expect(written).not.toContain('(stale?) (src/b.ts)')
})

test('an agent report adds its Facts to the knowledge base, with no model call', async ($, on) => {
  let kb = '<!-- model-router knowledge base · checked at abc -->\n- (src/a.ts) old\n- (stale?) (src/b.ts) checked later\n'
  let calls = 0
  const written: string[] = []
  engine(on)
  on('model.complete', () => {
    calls++
    return NO_ANSWER
  })
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('router-kb.md') ? kb : '{}' }) as never)
  on('fs.write', (_$, e: { path: string; text: string }) => {
    if (e.path.endsWith('router-kb.md')) {
      kb = e.text
      written.push(e.text)
    }
    return { value: undefined } as never
  })
  let text = 'done\n\n## Facts\n- (repo) uses bun\n- (src/a.ts) old\n- (src/b.ts) checked later'
  on('tool.call', () => ({ result: 'done', text }) as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:haiku', description: 'x', prompt: HANDOFF } as never)
  expect(calls).toBe(0)
  expect(written).toHaveLength(1)
  expect(written[0]).toContain('checked at abc')
  expect(written[0]).toContain('- (repo) uses bun')
  expect(written[0]).toContain('- (src/b.ts) checked later') // a fact the agent confirms loses its stale mark
  expect(written[0]).not.toContain('(stale?)')
  expect(written[0]?.match(/\(src\/a\.ts\) old/g)).toHaveLength(1) // no duplicates
  text = 'done\n\n## Facts\nnone'
  await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:haiku', description: 'x', prompt: HANDOFF } as never)
  expect(written).toHaveLength(1)
})

test('the knowledge base drops its oldest facts, not the new ones, past the character cap', async ($, on) => {
  let kb = '<!-- model-router knowledge base · checked at abc -->\n- (a) first fact\n- (b) second fact\n'
  engine(on, { MODEL_ROUTER_KB_CHARS: '40' })
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('router-kb.md') ? kb : '{}' }) as never)
  on('fs.write', (_$, e: { path: string; text: string }) => {
    if (e.path.endsWith('router-kb.md')) kb = e.text
    return { value: undefined } as never
  })
  on('tool.call', () => ({ result: 'done', text: 'done\n\n## Facts\n- (c) third fact' }) as never)
  await $.prompt.submit({ text: 'go' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:haiku', description: 'x', prompt: HANDOFF } as never)
  expect(kb).toContain('- (c) third fact')
  expect(kb).not.toContain('first fact')
})

test('agents get the session-start knowledge base, and later changes only when it moved', async ($, on) => {
  let kb = 'kb text'
  let registered = ''
  let sent: { prompt?: string } = {}
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }) as never)
  on('session.id', () => ({ value: 'chat-kb2' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [] } }) as never)
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('router-kb.md') ? kb : '{}' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false } }) as never)
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd, value: undefined }) as never)
  on('agent.register', (_$, e) => {
    if (e.name === 'haiku') registered = String(e.prompt)
    return { value: undefined } as never
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('tool.call', (_$, e) => {
    sent = e as never
    return { result: 'ran' } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  expect(registered).toContain('Knowledge base (.claude/router-kb.md, as of session start):\nkb text')
  await $.prompt.submit({ text: 'go' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:haiku', description: 'x', prompt: HANDOFF } as never)
  expect(sent.prompt).not.toContain('Knowledge base updates')
  kb = 'kb text 2'
  await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:haiku', description: 'x', prompt: HANDOFF } as never)
  expect(sent.prompt).toContain("## User's message (verbatim)\ngo\n\n## Knowledge base updates (newer than your system prompt)\nkb text 2")
})

// Last tests: the overrides they set stay in the module for the rest of this file.
test('MODEL_ROUTER_* env vars override the settings at session start', async ($, on) => {
  const env: Record<string, string> = { MODEL_ROUTER_WORKER_MODEL: 'claude-opus-5-5', MODEL_ROUTER_KB_CHARS: '4' }
  stub(on, env)
  let spawned = ''
  let registered = ''
  on('session.start', (_$, e) => ({ cwd: e.cwd, value: undefined }) as never)
  on('agent.register', (_$, e) => {
    registered = String(e.prompt)
    return { value: undefined } as never
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: 'ran' }) as never)
  on('agent.spawn', (_$, e) => {
    spawned = e.model ?? ''
    return { model: e.model ?? '', agentId: 'haiku-env' }
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await $.prompt.submit({ text: 'go' } as never)
  await $.agent.spawn({ subagentType: 'model-router:haiku', prompt: HANDOFF, description: 'x', tool_use_id: 't-env' } as never)
  expect(spawned).toBe('claude-opus-5-5')
  expect(registered).toContain('as of session start):\nkb t')
  expect(registered).not.toContain('kb text')
})

test('MODEL_ROUTER_* env vars are re-read on every prompt', async ($, on) => {
  const env: Record<string, string> = {}
  stub(on, env)
  let spawned = ''
  on('session.start', (_$, e) => ({ cwd: e.cwd, value: undefined }) as never)
  on('agent.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: 'ran' }) as never)
  on('agent.spawn', (_$, e) => {
    spawned = e.model ?? ''
    return { model: e.model ?? '', agentId: 'haiku-reload' }
  })
  await $.session.start({ cwd: '/tmp' } as never)
  env.MODEL_ROUTER_WORKER_MODEL = 'claude-opus-5-5'
  await $.prompt.submit({ text: 'go' } as never)
  await $.agent.spawn({ subagentType: 'model-router:haiku', prompt: HANDOFF, description: 'x', tool_use_id: 't-reload' } as never)
  expect(spawned).toBe('claude-opus-5-5')
})

test('the front desk gets the ADHD output style unless MODEL_ROUTER_STYLE=off', async ($, on) => {
  const env: Record<string, string> = {}
  stub(on, env)
  on('prompt.compose', () => ({ sections: [] }) as never)
  const compose = () => $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  await $.prompt.submit({ text: 'go' } as never)
  expect(JSON.stringify(await compose())).toContain('i-have-adhd')
  env.MODEL_ROUTER_STYLE = 'off'
  await $.prompt.submit({ text: 'go' } as never)
  const off = JSON.stringify(await compose())
  expect(off).not.toContain('i-have-adhd')
  expect(off).toContain('model-router:protocol')
})
