import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionMessage, SessionRateLimit } from 'claude-code'

const MAIN = 'claude-opus-5-5'
const CODER = 'claude-haiku-5-5'
const REVIEWER = 'claude-sonnet-5-5'
const CODER_TYPE = 'model-router:coder'
const REVIEWER_TYPE = 'model-router:reviewer'
const MAX_CODERS = 8
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const HANDOFF = ['## Goal', '## Context', '## Files', '## Steps', '## Done when']
const MAX_CHARS = 100_000

const PROTOCOL = [
  'Model router (enforced by the model-router plugin):',
  `- You plan, explain and talk to the user. You cannot edit files: every change goes to ${CODER_TYPE} subagents (Haiku 5.5).`,
  `- Each coder prompt must be a handoff document with these headings, in order: ${HANDOFF.join(', ')}. Coders start with no context: put in it everything they need (absolute paths, snippets, conventions, the user's intent).`,
  `- Split every change by file: spawn one coder per independent file group, all in ONE message so they run in parallel. Usually that is 1 to 3 coders; ${MAX_CODERS} is a hard cap, not a target, so never split work just to use more coders. Each coder must get its own files (absolute paths under ## Files, locked to that coder) and its own ## Steps; overlapping files, repeated Steps or more than ${MAX_CODERS} running coders are refused, and a coder cannot edit outside its list.`,
  '- When every coder of a batch has finished, one Sonnet 5.5 reviewer agent reviews and tests the whole batch against your handoff documents, your notes and the user request; its report is appended to the last coder result. Fix what it finds (new coders) before reporting to the user.',
  '- Coders and reviewers are single-use and pruned when done: you are the only stateful session. Never SendMessage a finished agent; spawn a fresh one with a new handoff document.',
].join('\n')

const TEMPLATE = HANDOFF.map(h => `${h}\n...`).join('\n\n')

type Row = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }
type Ledger = Record<string, Record<string, Row>> // UTC hour 'YYYY-MM-DDTHH' (older data: day) -> 'part:model' -> totals
type Part = 'chat' | 'handoff' | 'coder' | 'review' | 'subagent'

const PARTS: [Part, string][] = [
  ['chat', 'Opus chat'],
  ['handoff', '↳ handoff docs (est.)'],
  ['coder', 'Haiku coders'],
  ['review', 'Sonnet reviews'],
  ['subagent', 'other subagents'],
]
const HOUR = 3_600_000
const KEEP_DAYS = 35 // ponytail: older buckets are dropped at session start; export the store first if you need longer history

const runs = atom({ plugin: 'model-router', key: 'runs' } as const, [])
const reviewing = atom({ plugin: 'model-router', key: 'reviewing' } as const, 0)
const today = atom({ plugin: 'model-router', key: 'today' } as const, {})
const lastReview = atom({ plugin: 'model-router', key: 'lastReview' } as const, '')
const PANE = 'model-router'
let isPaneShown = false // module state: a reload reopens the pane once

let ledger: Ledger = {}
const files = new Map<string, Set<string>>() // running coder agentId -> files it edits
const agentOf = new Map<string, string>() // Agent tool_use_id -> coder agentId
const declared = new Map<string, Set<string>>() // Agent tool_use_id -> absolute paths its handoff lists under ## Files
const spent = new Set<string>() // every coder/reviewer agentId and name: they are single-use
const stepsOf = new Map<string, string>() // Agent tool_use_id -> its handoff's ## Steps: no two running coders get the same instructions
const reviewers = new Set<string>() // reviewer agentIds, metered as 'review'
type Done = { task: string; handoff: string; report: string; paths: string[] }
let batch: Done[] = [] // finished coders waiting for the batch review
// ponytail: these maps reset on hot reload; a coder caught mid-run by one gets its edits denied, re-delegate

const hour = () => new Date().toISOString().slice(0, 13)
const bucketStart = (key: string) => Date.parse(key.length === 10 ? `${key}T00:00:00Z` : `${key}:00:00Z`)
const bucketEnd = (key: string) => bucketStart(key) + (key.length === 10 ? 24 : 1) * HOUR
const partOf = (id: string): Part =>
  id.includes(':') ? (id.split(':')[0] as Part) : id.includes('haiku') ? 'coder' : id.includes('sonnet') ? 'review' : 'chat'
const modelOf = (id: string) => id.slice(id.indexOf(':') + 1)
const midnight = () => new Date().setHours(0, 0, 0, 0)
const short = (model: string) => model.replace(/^claude-/, '').split('-')[0] ?? model
const k = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))
const base = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const empty = (): Row => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const tokens = (r: Row) => r.input + r.output + r.cacheRead + r.cacheWrite
const fromUsage = (u: ModelUsage): Row => ({
  calls: 1,
  input: u.input_tokens,
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens,
  cacheWrite: u.cache_creation_input_tokens,
})
const addTo = (s: Row, r: Row) => {
  s.calls += r.calls
  s.input += r.input
  s.output += r.output
  s.cacheRead += r.cacheRead
  s.cacheWrite += r.cacheWrite
}
const dur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : `${Math.floor(m / 60)}h ${m % 60}m`
}
const lastText = (msgs: SessionMessage[], role: SessionMessage['role']) =>
  [...msgs].reverse().find(m => m.role === role && m.text.trim())?.text.slice(-10_000) ?? ''
// Absolute paths listed in a handoff's ## Files section; a path ending in / covers everything under it.
const filesOf = (handoff: string) =>
  new Set(handoff.split('## Files')[1]?.split('\n## ')[0]?.match(/(?<![\w.~:/-])\/[\w.@~+-][^\s`'",)]*/g) ?? [])
const covers = (set: Set<string>, path: string) =>
  [...set].some(d => path === d || path.startsWith(d.endsWith('/') ? d : `${d}/`))
const stepsIn = (handoff: string) => handoff.split('## Steps')[1]?.split('\n## ')[0]?.trim() ?? ''

// Sums every bucket that overlaps [start, now), per 'part:model'; a bucket cut by `start` counts pro rata.
function since(start: number) {
  const sum: Record<string, Row> = {}
  for (const [key, rows] of Object.entries(ledger)) {
    const from = bucketStart(key)
    const to = bucketEnd(key)
    if (to <= start) continue
    const f = from >= start ? 1 : (to - start) / (to - from)
    for (const [id, r] of Object.entries(rows))
      addTo((sum[id] ??= empty()), {
        calls: r.calls * f,
        input: r.input * f,
        output: r.output * f,
        cacheRead: r.cacheRead * f,
        cacheWrite: r.cacheWrite * f,
      })
  }
  return sum
}

const totals = () => {
  const out: Record<string, number> = {}
  for (const [id, r] of Object.entries(since(midnight())))
    if (partOf(id) !== 'handoff') out[short(modelOf(id))] = (out[short(modelOf(id))] ?? 0) + tokens(r)
  return out
}
const usageLine = () =>
  `router · today ${Object.entries(totals()).map(([m, v]) => `${m} ${k(v)}`).join(' · ') || 'no usage yet'}`

type Plan = { at: number; rateLimits: SessionRateLimit[] }
let writes: Promise<unknown> = Promise.resolve()

// The plan % is account-wide (every device and session); the last reading is kept so a fresh session can show it.
async function planReading($: EngineInterface): Promise<Plan | undefined> {
  const { rateLimits } = await $.session.usage()
  if (rateLimits.length === 0) return (await $.store.get('plan')) as Plan | undefined
  const plan = { at: Date.now(), rateLimits: [...rateLimits] }
  await $.store.set('plan', plan)
  return plan
}
const when = (t: number) => {
  const d = new Date(t)
  return `${d.toDateString() === new Date().toDateString() ? 'today' : d.toDateString()} ${d.toTimeString().slice(0, 5)}`
}

// Every session on this computer shares the ledger: re-read it before each write, one write at a time.
function meter($: EngineInterface, part: Part, model: string, row: Row) {
  writes = writes
    .then(async () => {
      ledger = ((await $.store.get('usage')) ?? {}) as Ledger
      addTo(((ledger[hour()] ??= {})[`${part}:${model}`] ??= empty()), row)
      await $.store.set('usage', ledger)
      await planReading($)
    })
    .catch(() => undefined)
  return writes.then(async () => {
    $.ui.status(usageLine())
    await update($, today, () => totals())
  })
}

async function reset($: EngineInterface) {
  await writes
  await $.store.set('usageBeforeReset', (await $.store.get('usage')) ?? {}) // ponytail: one backup in the store file, no restore command
  ledger = {}
  await $.store.set('usage', ledger)
  await $.store.set('since', Date.now())
  $.ui.status(usageLine())
  await update($, today, () => totals())
  return "**model-router counters on this computer are reset.** The previous counters are kept once as `usageBeforeReset` in `~/.claude/plugins/store/model-router_*.json`. The account plan % is Anthropic's and is not affected."
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

async function report($: EngineInterface) {
  const plan = await planReading($)
  const now = Date.now()
  const win = (kind: string, ms: number) => {
    const r = plan?.rateLimits.find(l => l.kind === kind)
    const end = r?.resetsAt ? Date.parse(r.resetsAt) : 0
    if (!r) return { used: 'no reading yet', left: '—', start: now - ms }
    if (end && end <= now) return { used: 'reset since the last reading', left: '—', start: now - ms }
    return { used: `${r.percentUsed}%`, left: end ? dur(end - now) : '—', start: end ? end - ms : now - ms }
  }
  const session = win('five_hour', 5 * HOUR)
  const week = win('seven_day', 7 * 24 * HOUR)
  const from = ((await $.store.get('since')) as number | undefined) ?? Math.min(now, ...Object.keys(ledger).map(bucketStart))
  const lines = [
    `**Account plan: all your devices and sessions**${plan ? ` (Anthropic's reading from ${when(plan.at)})` : ''}`,
    '',
    '| window | used | resets in |',
    '|---|--:|--:|',
    `| session (5h) | ${session.used} | ${session.left} |`,
    `| week (7d) | ${week.used} | ${week.left} |`,
    '',
    `**model-router on this computer** (counting since ${when(from)}): only sessions on this computer with the router loaded. Other devices, and sessions without the router, count in the plan above but not here.`,
  ]
  const cols = [since(midnight()), since(session.start), since(week.start)]
  const byPart = cols.map(rows => {
    const out = Object.fromEntries(PARTS.map(([p]) => [p, empty()])) as Record<Part, Row>
    for (const [id, r] of Object.entries(rows)) addTo(out[partOf(id)], r)
    return out
  })
  const outs = byPart.map(p => PARTS.reduce((t, [part]) => (part === 'handoff' ? t : t + p[part].output), 0))
  if (outs.every(o => o === 0)) return [...lines, '', 'No usage recorded yet.'].join('\n')
  const models = (part: Part) =>
    [...new Set(Object.keys(cols[2] ?? {}).filter(id => partOf(id) === part).map(id => short(modelOf(id))))].join(', ') || '—'
  lines.push('', '| part | model | today | session (5h) | week (7d) |', '|---|---|--:|--:|--:|')
  for (const [part, label] of PARTS) {
    const cells = byPart.map((p, i) => {
      const out = p[part].output
      const sum = outs[i] ?? 0
      if (out === 0 || sum === 0) return '—'
      const share = (out / sum) * 100
      return `${share < 1 ? '<1' : Math.round(share)}% · ${k(out)} out`
    })
    lines.push(`| ${label} | ${models(part)} | ${cells.join(' | ')} |`)
  }
  lines.push(`| **total** | | ${outs.map(o => `**${k(o)} out**`).join(' | ')} |`)
  lines.push('', '**Last 7 days in detail**', '', '| part | calls | output | new input | cache write | cache read |', '|---|--:|--:|--:|--:|--:|')
  for (const [part, label] of PARTS) {
    const r = byPart[2]?.[part] ?? empty()
    if (r.calls > 0)
      lines.push(`| ${label} | ${Math.round(r.calls)} | ${k(r.output)} | ${k(r.input)} | ${k(r.cacheWrite)} | ${k(r.cacheRead)} |`)
  }
  lines.push(
    '',
    '_% = share of output tokens (what each model generated). Cache reads re-read earlier context: cheap, so they are listed apart and not used for shares. The plan % is not split by part because it includes usage the router never sees. Handoff docs are estimated (4 characters ≈ 1 token) and are part of Opus chat output. `/router-usage reset` clears these counters._',
  )
  return lines.join('\n')
}

async function card($: EngineInterface) {
  const list = await read($, runs)
  const n = await read($, reviewing)
  const last = await read($, lastReview)
  const usage = Object.entries(await read($, today)).map(([m, v]) => `${m} ${k(v)}`).join(' · ') || 'no usage yet'
  const reading = await planReading($)
  const plan =
    reading?.rateLimits
      .map(l => `${l.kind === 'five_hour' ? 'session' : l.kind === 'seven_day' ? 'week' : l.kind} ${l.percentUsed}%`)
      .join(' · ') || 'no reading yet'
  return [
    '**● model-router active**',
    '',
    '| role | model |',
    '|---|---|',
    '| main chat | Opus 5.5 · high |',
    `| edits | Haiku 5.5 · ${list.length} coder${list.length === 1 ? '' : 's'} running |`,
    `| review | Sonnet 5.5${n > 0 ? ` · reviewing ${n}` : ''} |`,
    '',
    `**Plan (all devices):** ${plan}`,
    '',
    `**Today:** ${usage}`,
    ...list.map(run => `- haiku ▸ ${run.task}${run.files.length > 0 ? ` (${run.files.map(base).join(', ')})` : ''}`),
    ...(last !== '' ? ['', `**Last review:** ${last}`] : []),
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    ledger = ((await $.store.get('usage')) ?? {}) as Ledger
    const cutoff = Date.now() - KEEP_DAYS * 24 * HOUR
    for (const key of Object.keys(ledger)) if (bucketEnd(key) < cutoff) delete ledger[key]
    $.ui.status(usageLine())
    await update($, today, () => totals())
    await $.agent.register({
      name: 'coder',
      description: `Haiku 5.5 coder: makes ALL file edits (the main chat cannot edit). The prompt must be a handoff document (${HANDOFF.join(', ')}). Spawn several in one message to work in parallel on disjoint files.`,
      prompt:
        'You are a coder. You get a handoff document (Goal, Context, Files, Steps, Done when). Do exactly the Steps and edit only the files listed under Files: other coders may be editing other files in parallel. Smallest diff that works, match the surrounding style. Finish with the files you changed and anything you could not do.',
      model: CODER,
      effort: 'medium',
      disallowedTools: ['Agent'],
    })
    await $.agent.register({
      name: 'reviewer',
      description: 'Sonnet 5.5 batch reviewer, started by the router after each batch of coders. Do not spawn it yourself.',
      prompt:
        'You review and test one batch of changes that Haiku coders made from handoff documents Opus wrote. Read the changed files and run the relevant tests or checks. Never edit files. Report real bugs per coder, most severe first, each with file:line and a fix. Say "No issues." if none.',
      model: REVIEWER,
      effort: 'high',
      disallowedTools: ['Agent', 'Edit', 'Write', 'NotebookEdit'],
    })
    await $.command.register({
      name: 'router-usage',
      description: "Account plan % and where this computer's router tokens went; 'reset' clears the counters (model-router)",
      argumentHint: 'reset',
    })
    await $.command.register({ name: 'router', description: 'Show model-router status and open its pane' })
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

  // Only Opus keeps state: subagents are single-use, so they are never compacted (one that overflows ends and Opus re-delegates).
  on('session.compact', ($, e, next) =>
    e.agentId ? { skip: 'model-router: subagents are single-use and are not compacted.' } : next(e),
  )

  // Router: main chat on Opus at high effort, coders at medium, reviewers at high (the session's effort setting stays Opus's); every request is metered by part.
  on('turn.step', async function* ($, e, next) {
    const effort = !e.agentId ? 'high' : files.has(e.agentId) ? 'medium' : reviewers.has(e.agentId) ? 'high' : e.effort
    const r = yield* next(!e.agentId ? { ...e, model: MAIN, effort: 'high' } : { ...e, effort })
    const part: Part = !e.agentId ? 'chat' : files.has(e.agentId) ? 'coder' : reviewers.has(e.agentId) ? 'review' : 'subagent'
    if (r.usage) await meter($, part, r.usage.model, fromUsage(r.usage))
    return r
  })

  // Coders run on Haiku and reviewers on Sonnet, both in the foreground and single-use.
  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType === REVIEWER_TYPE) {
      const r = await next({ ...e, model: REVIEWER, background: false })
      if (r.agentId) {
        reviewers.add(r.agentId)
        spent.add(r.agentId)
      }
      return r
    }
    if (e.subagentType !== CODER_TYPE) return next(e)
    const r = await next({ ...e, model: CODER, background: false })
    const id = r.agentId
    if (id) {
      files.set(id, new Set())
      agentOf.set(e.tool_use_id, id)
      spent.add(id)
      if (e.name) spent.add(e.name)
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
    const tool = [...agentOf].find(([, a]) => a === e.agentId)?.[0] ?? ''
    const own = declared.get(tool)
    if (own && own.size > 0 && !covers(own, path))
      return { deny: `model-router: ${path} is not under your ## Files. Edit only your files; report anything else as not done.` }
    const owner =
      [...files].some(([id, set]) => id !== e.agentId && set.has(path)) ||
      [...declared].some(([t, set]) => t !== tool && covers(set, path))
    if (owner) return { deny: `model-router: ${path} belongs to a parallel coder. Leave it and report it as not done.` }
    if (!mine.has(path)) {
      mine.add(path)
      await update($, runs, list => list.map(run => (run.id === e.agentId ? { ...run, files: [...run.files, path] } : run)))
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'model-router: edit guard failed.' }))

  // Coders are single-use: a finished coder is never resumed, so every Haiku session starts fresh.
  on('tool.call', { tool: 'SendMessage' }, ($, e, next) =>
    spent.has(String(e.to).split(' [')[0] ?? '')
      ? { deny: `model-router: coders are single-use. Spawn a fresh ${CODER_TYPE} with a new handoff document.` }
      : next(e),
  )

  // Coder prompts must be handoff documents; each finished change gets a Sonnet review with Opus's context.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.subagent_type !== CODER_TYPE) return next(e)
    if (!HANDOFF.every(h => e.prompt.includes(h)))
      return { deny: `model-router: a coder prompt must be a handoff document with these headings:\n\n${TEMPLATE}` }
    const mine = filesOf(e.prompt)
    const steps = stepsIn(e.prompt)
    if (mine.size === 0)
      return { deny: 'model-router: list the absolute path of every file this coder may edit under ## Files.' }
    const clash = [...mine].filter(p => [...declared.values()].some(set => covers(set, p) || [...set].some(d => covers(mine, d))))
    if (clash.length > 0)
      return { deny: `model-router: ${clash.join(', ')} already belong to a running coder. Give each coder its own files, or wait for it to finish.` }
    if ([...stepsOf.values()].includes(steps))
      return { deny: 'model-router: a running coder already has these ## Steps. Give each coder different instructions.' }
    if (declared.size >= MAX_CODERS)
      return { deny: `model-router: ${MAX_CODERS} coders are already running. Wait for one to finish.` }
    const call = e.tool_use_id ?? ''
    declared.set(call, mine)
    stepsOf.set(call, steps)
    await meter($, 'handoff', MAIN, { calls: 1, input: 0, output: Math.round(e.prompt.length / 4), cacheRead: 0, cacheWrite: 0 })
    const r = await next(e).finally(() => {
      declared.delete(call)
      stepsOf.delete(call)
    })
    const id = agentOf.get(call) ?? ''
    const paths = [...(files.get(id) ?? [])]
    files.delete(id)
    agentOf.delete(call)
    await update($, runs, list => list.filter(run => run.id !== id))
    if (r.deny === undefined && !r.isError && paths.length > 0)
      batch.push({ task: e.description, handoff: e.prompt, report: r.text ?? '', paths })
    // The last coder of a batch to finish starts one Sonnet reviewer for the whole batch.
    if (declared.size > 0 || batch.length === 0) return r
    const done = batch
    batch = []
    await update($, reviewing, n => n + 1)
    try {
      const msgs = await $.session.messages()
      const share = Math.floor(MAX_CHARS / done.length)
      const changes = await Promise.all(
        done.map(async (d, i) =>
          [
            `### Coder ${i + 1}: ${d.task}`,
            `Handoff document:\n${d.handoff}`,
            `Coder report:\n${d.report}`,
            `Change:\n${(await changeOf($, d.paths)).slice(0, share)}`,
          ].join('\n\n'),
        ),
      )
      const ran = await $.tool.call({
        tool: 'Agent',
        subagent_type: REVIEWER_TYPE,
        description: `Review ${done.length} coder change${done.length === 1 ? '' : 's'}`,
        prompt: [`User request:\n${lastText(msgs, 'user')}`, `Opus notes:\n${lastText(msgs, 'assistant')}`, ...changes].join('\n\n'),
        run_in_background: false,
      } as never)
      const text = ran.deny ?? ran.text ?? 'The reviewer returned nothing.'
      $.ui.toast(`Sonnet 5.5 review: ${text.split('\n')[0]?.slice(0, 120) ?? ''}`, { timeoutMs: 8000 })
      await update($, lastReview, () => text.split('\n')[0]?.slice(0, 200) ?? '')
      const note = `Sonnet 5.5 review of this batch (${done.length} coder${done.length === 1 ? '' : 's'}):\n${text}`
      return r.deny !== undefined ? r : { ...r, context: [...(r.context ?? []), note] }
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

  on('command.run', { command: 'router-usage' }, async ($, e) => ({
    text: e.args.trim() === 'reset' ? await reset($) : await report($),
  }))
}
