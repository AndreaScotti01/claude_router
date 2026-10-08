import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionMessage } from 'claude-code'

import type { CoderRun } from '../types'

const MAIN = 'claude-opus-5-5'
const CODER = 'claude-haiku-5-5'
const REVIEWER = 'claude-sonnet-5-5'
const CODER_TYPE = 'model-router:coder'
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const HANDOFF = ['## Goal', '## Context', '## Files', '## Steps', '## Done when']
const MAX_CHARS = 100_000

const PROTOCOL = [
  'Model router (enforced by the model-router plugin):',
  `- You plan, explain and talk to the user. You cannot edit files: every change goes to ${CODER_TYPE} subagents (Haiku 5.5).`,
  `- Each coder prompt must be a handoff document with these headings, in order: ${HANDOFF.join(', ')}. Coders start with no context: put in it everything they need (absolute paths, snippets, conventions, the user's intent).`,
  '- Independent changes run in parallel: spawn several coders in ONE message, each with its own files. A file one running coder edits is locked for the others.',
  '- When a coder finishes, Sonnet 5.5 reviews its change against your handoff document, your notes and the user request; the review is appended to the coder result. Fix what it finds (a new coder) before reporting to the user.',
].join('\n')

const TEMPLATE = HANDOFF.map(h => `${h}\n...`).join('\n\n')

type Row = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }
type Ledger = Record<string, Record<string, Row>> // day -> model -> totals

const runs = atom({ plugin: 'model-router', key: 'runs' } as const, [])
const reviewing = atom({ plugin: 'model-router', key: 'reviewing' } as const, 0)
const today = atom({ plugin: 'model-router', key: 'today' } as const, {})
const lastReview = atom({ plugin: 'model-router', key: 'lastReview' } as const, '')
const PANE = 'model-router'
let isPaneShown = false // module state: a reload reopens the pane once

let ledger: Ledger = {}
const files = new Map<string, Set<string>>() // running coder agentId -> files it edits
const agentOf = new Map<string, string>() // Agent tool_use_id -> coder agentId
// ponytail: these maps reset on hot reload; a coder caught mid-run by one gets its edits denied, re-delegate

const day = () => new Date().toISOString().slice(0, 10)
const short = (model: string) => model.replace(/^claude-/, '').split('-')[0] ?? model
const k = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
const base = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const totals = () =>
  Object.fromEntries(Object.entries(ledger[day()] ?? {}).map(([m, r]) => [short(m), r.input + r.output]))
const usageLine = () =>
  `router · today ${Object.entries(totals()).map(([m, v]) => `${m} ${k(v)}`).join(' · ') || 'no usage yet'}`
const lastText = (msgs: SessionMessage[], role: SessionMessage['role']) =>
  [...msgs].reverse().find(m => m.role === role && m.text.trim())?.text.slice(-10_000) ?? ''

async function meter($: EngineInterface, model: string, u: ModelUsage) {
  const row = ((ledger[day()] ??= {})[model] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  row.calls += 1
  row.input += u.input_tokens
  row.output += u.output_tokens
  row.cacheRead += u.cache_read_input_tokens
  row.cacheWrite += u.cache_creation_input_tokens
  $.ui.status(usageLine())
  await update($, today, () => totals())
  await $.store.set('usage', ledger)
}

async function changeOf($: EngineInterface, paths: string[]) {
  const parts: string[] = []
  for (const p of paths) {
    const d = await $.process.run(['git', '-C', p.slice(0, p.lastIndexOf('/')) || '/', 'diff', 'HEAD', '--', p])
    parts.push(
      d.exitCode === 0 && d.stdout
        ? d.stdout
        : `=== ${p} (new or outside git, full content)\n${await $.fs.read(p).catch(() => '(deleted)')}`,
    )
  }
  return parts.join('\n').slice(0, MAX_CHARS)
}

function report(days: Ledger) {
  const lines = ['| day | model | calls | input | output | cache read | cache write |', '|---|---|--:|--:|--:|--:|--:|']
  for (const [d, models] of Object.entries(days).sort().reverse())
    for (const [m, r] of Object.entries(models))
      lines.push(`| ${d} | ${short(m)} | ${r.calls} | ${k(r.input)} | ${k(r.output)} | ${k(r.cacheRead)} | ${k(r.cacheWrite)} |`)
  return lines.length > 2 ? `**Token usage per model**\n\n${lines.join('\n')}` : 'No usage recorded yet.'
}

async function card($: EngineInterface) {
  const list = await read($, runs)
  const n = await read($, reviewing)
  const last = await read($, lastReview)
  const usage = Object.entries(await read($, today)).map(([m, v]) => `${m} ${k(v)}`).join(' · ') || 'no usage yet'
  return [
    '**● model-router active**',
    '',
    '| role | model |',
    '|---|---|',
    '| main chat | Opus 5.5 · high |',
    `| edits | Haiku 5.5 · ${list.length} coder${list.length === 1 ? '' : 's'} running |`,
    `| review | Sonnet 5.5${n > 0 ? ` · reviewing ${n}` : ''} |`,
    '',
    `**Today:** ${usage}`,
    ...list.map(run => `- haiku ▸ ${run.task}${run.files.length > 0 ? ` (${run.files.map(base).join(', ')})` : ''}`),
    ...(last !== '' ? ['', `**Last review:** ${last}`] : []),
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    ledger = ((await $.store.get('usage')) ?? {}) as Ledger
    $.ui.status(usageLine())
    await update($, today, () => totals())
    await $.agent.register({
      name: 'coder',
      description: `Haiku 5.5 coder: makes ALL file edits (the main chat cannot edit). The prompt must be a handoff document (${HANDOFF.join(', ')}). Spawn several in one message to work in parallel on disjoint files.`,
      prompt:
        'You are a coder. You get a handoff document (Goal, Context, Files, Steps, Done when). Do exactly the Steps and edit only the files listed under Files: other coders may be editing other files in parallel. Smallest diff that works, match the surrounding style. Finish with the files you changed and anything you could not do.',
      model: CODER,
      disallowedTools: ['Agent'],
    })
    await $.command.register({ name: 'router-usage', description: 'Token usage per model and day (model-router)' })
    await $.command.register({ name: 'router', description: 'Open the model-router pane' })
    isPaneShown = (await $.ui.open({ id: PANE, title: 'Model router' })).isPlaced
    return next(e)
  })

  // A prompt counts as asked, so the pane is placed at any width (VS Code's narrow panel included).
  on('prompt.submit', async ($, e, next) => {
    if (!isPaneShown) isPaneShown = (await $.ui.open({ id: PANE, title: 'Model router' })).isPlaced
    return next(e)
  })

  // Opus learns the protocol from its system prompt.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.model.includes('haiku')) return r
    return { sections: [...r.sections, { id: 'model-router:protocol', text: PROTOCOL, scope: 'session' as const }] }
  })

  // Router: every main-loop request goes to Opus at high effort; every request is metered.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e.agentId ? e : { ...e, model: MAIN, effort: 'high' })
    if (r.usage) await meter($, r.usage.model, r.usage)
    return r
  })

  // Coders always run on Haiku, in the foreground, so their review follows.
  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== CODER_TYPE) return next(e)
    const r = await next({ ...e, model: CODER, background: false })
    const id = r.agentId
    if (id) {
      files.set(id, new Set())
      agentOf.set(e.tool_use_id, id)
      await update($, runs, list => [...list, { id, task: e.description, files: [] }])
    }
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'model-router: coder routing failed.' }))

  // Only running coders edit, and each file belongs to one coder at a time.
  on('tool.call', async ($, e, next) => {
    if (!EDIT_TOOLS.includes(String(e.tool))) return next(e)
    const mine = files.get(e.agentId ?? '')
    if (!mine) return { deny: `model-router: file edits are routed. Delegate this change to ${CODER_TYPE} with a handoff document.` }
    const args = e as unknown as { file_path?: string; notebook_path?: string }
    const path = args.file_path ?? args.notebook_path ?? ''
    const owner = [...files].find(([id, set]) => id !== e.agentId && set.has(path))
    if (owner) return { deny: `model-router: ${path} is being edited by a parallel coder. Leave it and report it as not done.` }
    if (!mine.has(path)) {
      mine.add(path)
      await update($, runs, list => list.map(run => (run.id === e.agentId ? { ...run, files: [...run.files, path] } : run)))
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'model-router: edit guard failed.' }))

  // Coder prompts must be handoff documents; each finished change gets a Sonnet review with Opus's context.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.subagent_type !== CODER_TYPE) return next(e)
    if (!HANDOFF.every(h => e.prompt.includes(h)))
      return { deny: `model-router: a coder prompt must be a handoff document with these headings:\n\n${TEMPLATE}` }
    const r = await next(e)
    const id = agentOf.get(e.tool_use_id ?? '') ?? ''
    const paths = [...(files.get(id) ?? [])]
    files.delete(id)
    agentOf.delete(e.tool_use_id ?? '')
    await update($, runs, list => list.filter(run => run.id !== id))
    if (r.deny !== undefined || r.isError || paths.length === 0) return r
    await update($, reviewing, n => n + 1)
    try {
      const msgs = await $.session.messages()
      const review = await $.model.complete({
        model: REVIEWER,
        system:
          'You review a change a Haiku coder made from a handoff document Opus wrote. Check it does what the handoff and the user asked, and look for real bugs. Most severe first, each with file:line and a fix. Say "No issues." if none.',
        prompt: [
          `User request:\n${lastText(msgs, 'user')}`,
          `Opus notes:\n${lastText(msgs, 'assistant')}`,
          `Handoff document:\n${e.prompt}`,
          `Coder report:\n${r.text ?? ''}`,
          `Change:\n${await changeOf($, paths)}`,
        ].join('\n\n'),
      })
      await meter($, REVIEWER, review.usage)
      const text = review.isAnswered ? review.text : `review failed: ${review.reason}`
      $.ui.toast(`Sonnet 5.5 review: ${text.split('\n')[0]?.slice(0, 120) ?? ''}`, { timeoutMs: 8000 })
      await update($, lastReview, () => text.split('\n')[0]?.slice(0, 200) ?? '')
      return { ...r, context: [...(r.context ?? []), `Sonnet 5.5 review of this change:\n${text}`] }
    } finally {
      await update($, reviewing, n => n - 1)
    }
  })

  // Every surface, VS Code included: a live pane with the router's state.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, runs)
    const n = await read($, reviewing)
    const usage = Object.entries(await read($, today))
    const last = await read($, lastReview)
    return (
      <Box flexDirection="column">
        <Text bold color="green">● model-router active</Text>
        <Text>main chat  Opus 5.5 · high</Text>
        <Text>edits      Haiku 5.5 · {list.length} coder{list.length === 1 ? '' : 's'} running</Text>
        <Text>review     Sonnet 5.5{n > 0 ? ` · reviewing ${n}` : ''}</Text>
        <Text dimColor>today      {usage.map(([m, v]) => `${m} ${k(v)}`).join(' · ') || 'no usage yet'}</Text>
        {list.map(run => (
          <Text color="cyan">
            haiku ▸ {run.task}
            {run.files.length > 0 ? ` (${run.files.map(base).join(', ')})` : ''}
          </Text>
        ))}
        {last !== '' && <Text dimColor>last review: {last}</Text>}
      </Box>
    )
  })

  // Every surface, VS Code included: coder rows in the transcript name their model.
  on('ui.render', { component: 'ToolUse', props: { tool: 'Agent' } }, ($, e, next) => {
    const input = e.props.input as { subagent_type?: string; description?: string }
    if (input.subagent_type !== CODER_TYPE) return next(e)
    return next({ ...e, props: { ...e.props, input: { ...input, description: `Haiku 5.5 · ${input.description ?? ''}` } } })
  })

  on('command.run', { command: 'router' }, async $ => {
    isPaneShown = (await $.ui.open({ id: PANE, title: 'Model router' })).isPlaced
    return { text: await card($) }
  })

  // VS Code prints command output as plain text: draw this plugin's commands as markdown on every surface.
  on('ui.render', { component: 'CommandOutput' }, ($, e, next) => {
    if (!['router', 'router-usage'].includes(e.props.command) || e.props.isErrored) return next(e)
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={e.props.text.replace(/^model-router: /, '')} />
  })

  on('command.run', { command: 'router-usage' }, async $ => ({
    text: report(((await $.store.get('usage')) ?? {}) as Ledger),
  }))
}
