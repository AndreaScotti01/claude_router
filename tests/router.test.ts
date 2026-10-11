import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HANDOFF = '## Goal\ng\n\n## Context\nc\n\n## Scope\ns\n\n## Done when\nd'
const ANSWER = (text: string) =>
  ({ value: { isAnswered: true, text, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) as never
const NO_ANSWER = { value: { isAnswered: false, reason: 'empty-reply' } } as never

// Stubs every engine call a prompt makes; `classify` answers the classifier, the knowledge base reads as 'kb text'.
function stub(on: On, classify: () => unknown, env: Record<string, string> = {}) {
  on('env.get', (_$, e) => ({ value: env[e.name] ?? (e.name === 'HOME' ? '/home/test' : undefined) }) as never)
  on('session.id', () => ({ value: 'chat-t' }) as never)
  on('session.messages', () => ({ value: [] }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [] } }) as never)
  on('model.complete', () => classify() as never)
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('router-kb.md') ? 'kb text' : '{}' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
}

test('the main chat runs on Haiku', async ($, on) => {
  let model = ''
  on('turn.step', async function* (_$, e) {
    model = e.model
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  } as never)
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 0 } as never)) {
    // drain the stream
  }
  expect(model).toBe('claude-haiku-5-5')
})

test('a complex message: the main chat may only spawn model-router:opus with a handoff', async ($, on) => {
  stub(on, () => ANSWER('complex'))
  let sent: { prompt?: string } = {}
  on('tool.call', (_$, e) => {
    sent = e as never
    return { result: 'ok' } as never
  })
  await $.prompt.submit({ text: 'Refactor the auth module\n  keep  spacing' } as never)
  expect((await $.tool.call({ tool: 'Read', file_path: '/tmp/a' } as never)).deny).toContain('routed to complex')
  const ok = await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:opus', description: 'auth', prompt: HANDOFF } as never)
  expect(ok.deny).toBeUndefined()
  expect(sent.prompt).toContain("## User's message (verbatim)\nRefactor the auth module\n  keep  spacing")
  const bare = await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:opus', description: 'x', prompt: 'just do it' } as never)
  expect(bare.deny).toContain('## Done when')
})

test('!sonnet routes to medium without the classifier', async ($, on) => {
  let calls = 0
  let sent: { prompt?: string } = {}
  stub(on, () => {
    calls++
    return ANSWER('complex')
  })
  on('tool.call', (_$, e) => {
    sent = e as never
    return { result: 'ok' } as never
  })
  await $.prompt.submit({ text: '!sonnet fix the typo' } as never)
  expect(calls).toBe(0)
  expect((await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:opus', description: 'x', prompt: HANDOFF } as never)).deny).toContain('routed to medium')
  const ok = await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:sonnet', description: 'x', prompt: HANDOFF } as never)
  expect(ok.deny).toBeUndefined()
  expect(sent.prompt).toContain("## User's message (verbatim)\nfix the typo")
})

test('a failed classification routes to medium', async ($, on) => {
  stub(on, () => NO_ANSWER)
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.prompt.submit({ text: 'do it' } as never)
  expect((await $.tool.call({ tool: 'Read', file_path: '/tmp/a' } as never)).deny).toContain('routed to medium')
})

test('model-router:sonnet runs on Sonnet in the foreground', async ($, on) => {
  let seen: { model?: string; background?: boolean } = {}
  on('agent.spawn', (_$, e) => {
    seen = { model: e.model, background: e.background }
    return { model: e.model ?? '', agentId: 'sonnet-1' }
  })
  await $.agent.spawn({ subagentType: 'model-router:sonnet', prompt: HANDOFF, description: 'x', tool_use_id: 't-s' } as never)
  expect(seen).toEqual({ model: 'claude-sonnet-5-5', background: false })
})

test('a simple message lets the main chat edit', async ($, on) => {
  stub(on, () => ANSWER('simple'))
  on('tool.call', () => ({ result: 'edited' }) as never)
  await $.prompt.submit({ text: 'rename x' } as never)
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/r/a.py', old_string: 'a', new_string: 'b' } as never)
  expect(edit.deny).toBeUndefined()
})

test('pane shows the router state on terminal and VS Code', async ($, on) => {
  on('agent.spawn', (_$, e) => ({ model: e.model ?? '', agentId: 'sonnet-2' }))
  await $.agent.spawn({ subagentType: 'model-router:sonnet', prompt: HANDOFF, description: 'rename x' } as never)
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({
      plugin: 'model-router',
      surface,
      component: 'Pane',
      requestId: 'model-router',
      props: { title: 'Model router', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
    })
    expect(await ui.find({ type: 'Text', text: /model-router active/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /sonnet ▸ rename x/ })).toBeDefined()
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

test('finished agents cannot be resumed', async ($, on) => {
  on('agent.spawn', (_$, e) => ({ model: e.model ?? '', agentId: 'sonnet-9' }))
  on('tool.call', () => ({ result: 'sent' }) as never)
  await $.agent.spawn({ subagentType: 'model-router:sonnet', prompt: HANDOFF, description: 'x' } as never)
  const r = await $.tool.call({ tool: 'SendMessage', to: 'sonnet-9', message: 'one more thing' } as never)
  expect(JSON.stringify(r)).toContain('single-use')
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
  on('model.complete', () => NO_ANSWER)
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
  expect(out).toContain("'route'")
  expect(out).toContain("'tool'")
  expect(out).toContain('"tool":"Read"')
})

test('the front desk gets the protocol on any model, but not inside a tier agent', async ($, on) => {
  stub(on, () => ANSWER('medium'))
  on('prompt.compose', () => ({ sections: [] }) as never)
  let during = ''
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Agent') during = JSON.stringify(await compose('claude-sonnet-5-5'))
    return { result: 'ok' } as never
  })
  const compose = (model: string) => $.prompt.compose({ model, promptModel: model, surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) expect(JSON.stringify(await compose(model))).toContain('model-router:protocol')
  await $.prompt.submit({ text: '!sonnet fix the typo' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:sonnet', description: 'x', prompt: HANDOFF } as never)
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

test('the knowledge base is updated after each answer; NONE leaves it alone', async ($, on) => {
  let reply = '- (repo) uses bun'
  const written: string[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }) as never)
  on('session.id', () => ({ value: 'chat-kb' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [] } }) as never)
  on('model.complete', () => ANSWER(reply))
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('router-kb.md') ? 'kb text' : '{}' }) as never)
  on('fs.write', (_$, e: { path: string; text: string }) => {
    if (e.path.endsWith('router-kb.md')) written.push(e.text)
    return { value: undefined } as never
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false } }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  await $.prompt.submit({ text: '!haiku do it' } as never)
  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't', durationMs: 1, isAborted: false } as never)
  await new Promise(r => setTimeout(r, 20))
  expect(written).toHaveLength(1)
  expect(written[0]).toContain('<!-- model-router knowledge base · checked at')
  expect(written[0]).toContain('- (repo) uses bun')
  reply = 'NONE'
  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't', durationMs: 1, isAborted: false } as never)
  await new Promise(r => setTimeout(r, 20))
  expect(written).toHaveLength(1)
})

test('tier agents get the session-start knowledge base, and later changes only when it moved', async ($, on) => {
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
    if (e.name === 'sonnet') registered = String(e.prompt)
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
  await $.prompt.submit({ text: '!sonnet go' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:sonnet', description: 'x', prompt: HANDOFF } as never)
  expect(sent.prompt).not.toContain('Knowledge base updates')
  kb = 'kb text 2'
  await $.tool.call({ tool: 'Agent', subagent_type: 'model-router:sonnet', description: 'x', prompt: HANDOFF } as never)
  expect(sent.prompt).toContain("## User's message (verbatim)\ngo\n\n## Knowledge base updates (newer than your system prompt)\nkb text 2")
})

test('a knowledge-base reply that hit the token cap is not written', async ($, on) => {
  const written: string[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }) as never)
  on('session.id', () => ({ value: 'chat-cap' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [] } }) as never)
  on('model.complete', () =>
    ({ value: { isAnswered: true, text: '- (repo) fact', usage: { input_tokens: 10, output_tokens: 16000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) as never,
  )
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('router-kb.md') ? 'kb text' : '{}' }) as never)
  on('fs.write', (_$, e: { path: string; text: string }) => {
    if (e.path.endsWith('router-kb.md')) written.push(e.text)
    return { value: undefined } as never
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't', durationMs: 1, isAborted: false } as never)
  await new Promise(r => setTimeout(r, 20))
  expect(written).toHaveLength(0)
})

test('session end waits for a pending knowledge-base update', async ($, on) => {
  const written: string[] = []
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }) as never)
  on('session.id', () => ({ value: 'chat-end' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [] } }) as never)
  on('model.complete', async () => {
    await gate
    return ANSWER('- (repo) uses bun') as never
  })
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('router-kb.md') ? 'kb text' : '{}' }) as never)
  on('fs.write', (_$, e: { path: string; text: string }) => {
    if (e.path.endsWith('router-kb.md')) written.push(e.text)
    return { value: undefined } as never
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't', durationMs: 1, isAborted: false } as never)
  const ending = $.session.end({ reason: 'other', sessionId: 'chat-end', resume: {} } as never)
  expect(written).toHaveLength(0)
  release()
  await ending
  expect(written).toHaveLength(1)
})

// Last tests: the overrides they set stay in the module for the rest of this file.
test('MODEL_ROUTER_* env vars override the settings at session start', async ($, on) => {
  const env: Record<string, string> = { MODEL_ROUTER_MEDIUM_MODEL: 'claude-opus-5-5', MODEL_ROUTER_KB_CHARS: '4' }
  stub(on, () => ANSWER('medium'), env)
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
    return { model: e.model ?? '', agentId: 'sonnet-env' }
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await $.prompt.submit({ text: 'go' } as never)
  await $.agent.spawn({ subagentType: 'model-router:sonnet', prompt: HANDOFF, description: 'x', tool_use_id: 't-env' } as never)
  expect(spawned).toBe('claude-opus-5-5')
  expect(registered).toContain('as of session start):\nkb t')
  expect(registered).not.toContain('kb text')
})

test('MODEL_ROUTER_* env vars are re-read on every prompt', async ($, on) => {
  const env: Record<string, string> = {}
  stub(on, () => ANSWER('medium'), env)
  let spawned = ''
  on('session.start', (_$, e) => ({ cwd: e.cwd, value: undefined }) as never)
  on('agent.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: 'ran' }) as never)
  on('agent.spawn', (_$, e) => {
    spawned = e.model ?? ''
    return { model: e.model ?? '', agentId: 'sonnet-reload' }
  })
  await $.session.start({ cwd: '/tmp' } as never)
  env.MODEL_ROUTER_MEDIUM_MODEL = 'claude-opus-5-5'
  await $.prompt.submit({ text: 'go' } as never)
  await $.agent.spawn({ subagentType: 'model-router:sonnet', prompt: HANDOFF, description: 'x', tool_use_id: 't-reload' } as never)
  expect(spawned).toBe('claude-opus-5-5')
})

test('the front desk gets the ADHD output style unless MODEL_ROUTER_STYLE=off', async ($, on) => {
  const env: Record<string, string> = {}
  stub(on, () => ANSWER('simple'), env)
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
