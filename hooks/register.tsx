import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionMessage, SessionRateLimit } from 'claude-code'

// Defaults; each can be overridden by a MODEL_ROUTER_* env var (README.md › Configure), read at session start.
let MAIN = 'claude-opus-5-5'
let MAIN_EFFORT = 'high'
let CODER = 'claude-haiku-5-5'
let CODER_EFFORT = 'high'
let REVIEWER = 'claude-sonnet-5-5'
let REVIEWER_EFFORT = 'high'
const CODER_TYPE = 'model-router:executor'
const REVIEWER_TYPE = 'model-router:reviewer'
let MAX_CODERS = 8
let MAX_FIXES = 5 // fix coders one reviewer may spawn before it must report what still fails
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const BASH_WRITE =
  /(?:^|[;&|(`]|\$\(|\bxargs|-exec(?:dir)?)\s*(?:sudo\s+)?(?:rm|rmdir|mv|cp|ln|tee|touch|truncate|dd|mkdir|chmod|chown|unlink|patch)\b|\s-delete\b|\b(?:sed|perl)\b[^|;&]*\s-[a-zA-Z]*i|(?<![=\-<>&])>>?(?![&=]|\s*\/dev\/null\b)|\bgit(?:\s+-C\s+\S+)?\s+(?:restore|reset|clean|apply|stash|mv|rm|checkout\s+--)\b/
const HANDOFF = ['## Goal', '## Context', '## Files', '## Steps', '## Done when']
let MAX_CHARS = 100_000
let MAX_DIRECT = 6 // tool calls the main chat may make in a row before it must hand off

const protocol = () => [
  'Model router (enforced by the model-router plugin):',
  `- You plan, explain and talk to the user. Do one-off operations yourself when a handoff would cost more: an API or MCP call (e.g. updating a merge request description, posting a note), a quick read or search. Hand runs of easy steps to ${CODER_TYPE} subagents (${label(CODER)}): reading or searching many files, mapping a folder, editing, moving or creating files, multi-step commands, scraping web pages. You cannot edit files yourself, and after ${MAX_DIRECT} tool calls in a row without a handoff your next calls are refused.`,
  `- Each executor prompt must be a handoff document with these headings, in order: ${HANDOFF.join(', ')}. Executors start with no context: put in it everything they need (absolute paths, URLs, snippets, conventions, the user's intent, what to report back). Under ## Files list the absolute path of every file it may change, or write "none" for read-only work (it then cannot edit).`,
  `- Split work into independent pieces and spawn one executor per piece, all in ONE message so they run in parallel. Usually that is 1 to 3; ${MAX_CODERS} is a hard cap, not a target. Executors that change files each get their own files (locked to that executor), and every executor gets its own ## Steps; overlapping files, repeated Steps or more than ${MAX_CODERS} running executors are refused.`,
  `- When all executors of a batch have returned and any of them changed files, spawn exactly one ${REVIEWER_TYPE} (${label(REVIEWER)}) with a brief: the user's request, what you intended, what each executor reported, and what to test. The router attaches every handoff and diff. Sonnet tests, sends failures to fresh Haiku executors until they pass (up to ${MAX_FIXES}), and reports back to you; relay its outcome to the user. New executors are refused until the batch is reviewed; read-only batches need no review.`,
  '- Executors and reviewers are single-use and pruned when done: you are the only stateful session. Never SendMessage a finished agent; spawn a fresh one with a new handoff document.',
].join('\n')

const reviewLoop = () => [
  'Your job, in order:',
  '1. Check every change above against its handoff and the brief. Run the relevant tests, or a one-off check when there are none.',
  `2. If something fails or is wrong, do not edit: spawn fresh ${CODER_TYPE} agents with handoff documents (${HANDOFF.join(', ')}; absolute paths under ## Files), one per independent file group, all in one message, then re-test. Repeat until everything passes, at most ${MAX_FIXES} fix executors in all.`,
  '3. Report to Opus: what you checked and ran, what you fixed, and anything still failing with file:line. Say "All checks pass." when nothing is left.',
].join('\n')

const TEMPLATE = HANDOFF.map(h => `${h}\n...`).join('\n\n')

type Row = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }
type Ledger = Record<string, Record<string, Row>> // UTC hour 'YYYY-MM-DDTHH' (older data: day) -> 'part:model' -> totals
type Part = 'chat' | 'handoff' | 'coder' | 'review' | 'subagent'

const PARTS: [Part, string][] = [
  ['chat', 'Opus chat'],
  ['handoff', '↳ handoff docs (est.)'],
  ['coder', 'Haiku executors'],
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
let streak = 0 // main-chat tool calls since the last user prompt or handoff

let ledger: Ledger = {}
const files = new Map<string, Set<string>>() // running coder agentId -> files it edits
const agentOf = new Map<string, string>() // Agent tool_use_id -> coder agentId
const declared = new Map<string, Set<string>>() // Agent tool_use_id -> absolute paths its handoff lists under ## Files
const spent = new Set<string>() // every coder/reviewer agentId and name: they are single-use
const stepsOf = new Map<string, string>() // Agent tool_use_id -> its handoff's ## Steps: no two running coders get the same instructions
const reviewers = new Set<string>() // reviewer agentIds, metered as 'review'
const fixesBy = new Map<string, number>() // reviewer agentId -> fix coders it has spawned
type Done = { task: string; handoff: string; report: string; paths: string[] }
let batch: Done[] = [] // finished coders waiting for the batch review
// ponytail: these maps reset on hot reload; a coder caught mid-run by one gets its edits denied, re-delegate

const hour = () => new Date().toISOString().slice(0, 13)
const bucketStart = (key: string) => Date.parse(key.length === 10 ? `${key}T00:00:00Z` : `${key}:00:00Z`)
const bucketEnd = (key: string) => bucketStart(key) + (key.length === 10 ? 24 : 1) * HOUR
const partOf = (id: string): Part =>
  id.includes(':') ? (id.split(':')[0] as Part) : id.includes('haiku') ? 'coder' : id.includes('sonnet') ? 'review' : 'chat'
const modelOf = (id: string) => id.slice(id.indexOf(':') + 1).split('|')[0] ?? '' // 'part:model|sessionId' (old rows: 'part:model')
const midnight = () => new Date().setHours(0, 0, 0, 0)
const short = (model: string) => model.replace(/^claude-/, '').split('-')[0] ?? model
// 'claude-<family>-<major>-<minor>' → '<Family> <major>.<minor>'; a trailing date ('-20251001') is dropped
const label = (model: string) => {
  const [family = '', ...ver] = model.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-')
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${ver.join('.')}`.trim()
}
const k = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))
const base = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const empty = (): Row => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const tokens = (r: Row) => r.input + r.output + r.cacheRead + r.cacheWrite
// API list prices, $ per million tokens: [input, output, cache read]; cache writes are billed at the 1-hour rate (2× input).
// The plan meter is not published: API cost is the closest public proxy for how much a call weighs on it.
const PRICE: Record<string, [number, number, number]> = { opus: [4, 20, 0.2], sonnet: [2, 10, 0.2], haiku: [0.1, 0.5, 0.01] }
const cost = (model: string, r: Row) => {
  const [i, o, cr] = PRICE[short(model)] ?? [4, 20, 0.2]
  return (r.input * i + r.cacheWrite * 2 * i + r.output * o + r.cacheRead * cr) / 1e6
}
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
  new Set(handoff.split(/^## Files[^\n]*\n/m)[1]?.split('\n## ')[0]?.match(/(?<![\w.~:/-])\/[\w.@~+-][^\s`'",)]*/g) ?? [])
const covers = (set: Set<string>, path: string) =>
  [...set].some(d => path === d || path.startsWith(d.endsWith('/') ? d : `${d}/`))
const stepsIn = (handoff: string) => handoff.split(/^## Steps[^\n]*\n/m)[1]?.split('\n## ')[0]?.trim() ?? ''

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

// One file per computer, shared by every chat and every copy of the plugin (dev folder or installed); $.store is per copy.
// ponytail: whole-file read-modify-write; two chats writing in the same instant can drop one update
const DB = '.claude/model-router-usage.json'
async function dbPath($: EngineInterface) {
  return `${(await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'}/${DB}`
}
async function dbAll($: EngineInterface): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(String(await $.fs.read(await dbPath($)))) as Record<string, unknown>
  } catch {
    return {}
  }
}
async function dbGet($: EngineInterface, key: string) {
  return (await dbAll($))[key]
}
async function dbSet($: EngineInterface, key: string, value: unknown) {
  return $.fs.write(await dbPath($), JSON.stringify({ ...(await dbAll($)), [key]: value }))
}

// MODEL_ROUTER_* overrides: an unset or invalid value keeps its default.
async function loadSettings($: EngineInterface) {
  const str = (v: string | undefined, fallback: string) => v || fallback
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v)
    return Number.isInteger(n) && n > 0 ? n : fallback
  }
  const effort = (v: string | undefined, fallback: string) => (v && /^(low|medium|high|xhigh|max)$/.test(v) ? v : fallback)
  MAIN = str(await $.env.get('MODEL_ROUTER_MAIN_MODEL'), 'claude-opus-5-5')
  MAIN_EFFORT = effort(await $.env.get('MODEL_ROUTER_MAIN_EFFORT'), 'high')
  CODER = str(await $.env.get('MODEL_ROUTER_EXECUTOR_MODEL'), 'claude-haiku-5-5')
  CODER_EFFORT = effort(await $.env.get('MODEL_ROUTER_EXECUTOR_EFFORT'), 'high')
  REVIEWER = str(await $.env.get('MODEL_ROUTER_REVIEWER_MODEL'), 'claude-sonnet-5-5')
  REVIEWER_EFFORT = effort(await $.env.get('MODEL_ROUTER_REVIEWER_EFFORT'), 'high')
  MAX_CODERS = num(await $.env.get('MODEL_ROUTER_MAX_EXECUTORS'), 8)
  MAX_FIXES = num(await $.env.get('MODEL_ROUTER_MAX_FIXES'), 5)
  MAX_DIRECT = num(await $.env.get('MODEL_ROUTER_MAX_DIRECT'), 6)
  MAX_CHARS = num(await $.env.get('MODEL_ROUTER_MAX_DIFF_CHARS'), 100_000)
}

type Plan = { at: number; rateLimits: SessionRateLimit[] }
let writes: Promise<unknown> = Promise.resolve()

// Learn % of plan per API $ from moments the plan moved while this computer spent (store key 'spent' = API $ metered here, never reset).
type Calibration = Record<string, { at: { resetsAt?: string; p: number; c: number }; rate?: number }>
const STEP = 5 // plan points per sample: smaller moves are dominated by the rounding of percentUsed
const sameWindow = (a?: string, b?: string) => a === b || Math.abs(Date.parse(a ?? '') - Date.parse(b ?? '')) < HOUR
async function calibrate($: EngineInterface, rateLimits: SessionRateLimit[]) {
  const spent = ((await dbGet($, 'spent')) as number | undefined) ?? 0
  const cal = ((await dbGet($, 'calibration')) ?? {}) as Calibration
  for (const l of rateLimits) {
    const entry = cal[l.kind]
    const now = { resetsAt: l.resetsAt, p: l.percentUsed, c: spent }
    if (!entry || !sameWindow(entry.at.resetsAt, l.resetsAt) || l.percentUsed < entry.at.p) cal[l.kind] = { ...entry, at: now }
    else if (l.percentUsed - entry.at.p >= STEP) {
      // ponytail: other devices only push a sample up, so the lowest rate is kept; rounding can make it up to 1/STEP low
      if (spent > entry.at.c) entry.rate = Math.min(entry.rate ?? Infinity, (l.percentUsed - entry.at.p) / (spent - entry.at.c))
      entry.at = now
    }
  }
  await dbSet($, 'calibration', cal)
}

// The plan % is account-wide (every device and session); the last reading is kept so a fresh session can show it.
async function planReading($: EngineInterface): Promise<Plan | undefined> {
  const { rateLimits } = await $.session.usage()
  if (rateLimits.length === 0) return (await dbGet($, 'plan')) as Plan | undefined
  const plan = { at: Date.now(), rateLimits: [...rateLimits] }
  await dbSet($, 'plan', plan)
  await calibrate($, rateLimits)
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
      ledger = ((await dbGet($, 'usage')) ?? {}) as Ledger
      addTo(((ledger[hour()] ??= {})[`${part}:${model}|${await $.session.id()}`] ??= empty()), row)
      await dbSet($, 'usage', ledger)
      if (part !== 'handoff') await dbSet($, 'spent', (((await dbGet($, 'spent')) as number | undefined) ?? 0) + cost(model, row))
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
  await dbSet($, 'usageBeforeReset', (await dbGet($, 'usage')) ?? {}) // ponytail: one backup in the store file, no restore command
  ledger = {}
  await dbSet($, 'usage', ledger)
  await dbSet($, 'since', Date.now())
  $.ui.status(usageLine())
  await update($, today, () => totals())
  return "**model-router counters on this computer are reset.** The previous counters are kept once as `usageBeforeReset` in `~/.claude/model-router-usage.json`. The account plan % is Anthropic's and is not affected."
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
  ledger = ((await dbGet($, 'usage')) ?? ledger) as Ledger // include other sessions on this computer
  const now = Date.now()
  const r = plan?.rateLimits.find(l => l.kind === 'five_hour')
  const end = r?.resetsAt ? Date.parse(r.resetsAt) : 0
  const live = r !== undefined && !(end && end <= now)
  const w = plan?.rateLimits.find(l => l.kind === 'seven_day')
  const wEnd = w?.resetsAt ? Date.parse(w.resetsAt) : 0
  const cell = (l: SessionRateLimit | undefined, e: number) =>
    !l ? 'no reading yet | —' : e && e <= now ? 'reset since the last reading | —' : `${l.percentUsed}% | ${e ? dur(e - now) : '—'}`
  const lines = [
    `**Account plan: all your devices**${plan ? ` (reading from ${when(plan.at)})` : ''}`,
    '',
    '| window | used | resets in |',
    '|---|--:|--:|',
    `| session (5h) | ${cell(r, end)} |`,
    `| week (7d) | ${cell(w, wEnd)} |`,
  ]
  const sid = await $.session.id()
  const windows = [since(live && end ? end - 5 * HOUR : now - 5 * HOUR), since(w && wEnd > now ? wEnd - 7 * 24 * HOUR : now - 7 * 24 * HOUR)]
  const cal = ((await dbGet($, 'calibration')) ?? {}) as Calibration
  const rates = [cal.five_hour?.rate, cal.seven_day?.rate]
  const from = ((await dbGet($, 'since')) as number | undefined) ?? Math.min(now, ...Object.keys(ledger).map(bucketStart))
  const table = (title: string, keep: (id: string) => boolean) => {
    const by = windows.map(rows => {
      const c = Object.fromEntries(PARTS.map(([p]) => [p, 0])) as Record<Part, number>
      for (const [id, row] of Object.entries(rows)) if (keep(id)) c[partOf(id)] += cost(modelOf(id), row)
      return c
    })
    const sums = by.map(c => PARTS.reduce((t, [part]) => (part === 'handoff' ? t : t + c[part]), 0))
    const tok = Object.fromEntries(PARTS.map(([p]) => [p, empty()])) as Record<Part, Row>
    for (const [id, row] of Object.entries(windows[1] ?? {})) if (keep(id)) addTo(tok[partOf(id)], row)
    const sumTok = empty()
    for (const [part] of PARTS) if (part !== 'handoff') addTo(sumTok, tok[part]) // handoff docs are part of Opus chat output
    const toks = (t: Row) => `${k(t.input)} | ${k(t.output)} | ${k(t.cacheRead)} | ${k(t.cacheWrite)}`
    const week = sums[1] ?? 0
    if (week === 0) return ['', title, '', 'No router usage yet.']
    const pts = (c: number, i: number) => {
      const rate = rates[i]
      return rate === undefined ? 'calibrating' : c === 0 ? '—' : `≈ ${c * rate < 0.1 ? '<0.1' : (c * rate).toFixed(1)}%`
    }
    const models = (part: Part) =>
      [...new Set(Object.keys(windows[1] ?? {}).filter(id => keep(id) && partOf(id) === part).map(id => short(modelOf(id))))].join(', ') || '—'
    const out = [
      '',
      title,
      '',
      '| part | model | share | ≈ of session (5h) | ≈ of week (7d) | in | out | cache read | cache write |',
      '|---|---|--:|--:|--:|--:|--:|--:|--:|',
    ]
    for (const [part, label] of PARTS) {
      const c = by[1]?.[part] ?? 0
      if (c === 0) continue
      const share = (c / week) * 100
      out.push(`| ${label} | ${models(part)} | ${share < 1 ? '<1' : Math.round(share)}% | ${pts(by[0]?.[part] ?? 0, 0)} | ${pts(c, 1)} | ${toks(tok[part])} |`)
    }
    out.push(`| **total** | | **100%** | **${pts(sums[0] ?? 0, 0)}** | **${pts(week, 1)}** | ${toks(sumTok)} |`)
    return out
  }
  lines.push(
    ...table('**This chat**', id => id.endsWith(`|${sid}`)),
    ...table(`**All chats on this computer** (since ${when(from)})`, () => true),
    '',
    '_Router usage only: chats on this computer with the router loaded; other devices count in the plan table but not here. Share weighs each part by API list price over the last 7 days; the token columns cover the same 7 days (in = new input, out = output, cache read / cache write = context re-read from or written to the prompt cache). "≈ of session / week" = the plan points that usage cost, learned from moments the plan moved 5+ points while this computer worked ("calibrating" until then). Usage recorded before chats were tagged counts only under all chats. `/router-usage reset` clears the counters._',
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
    `| main chat | ${label(MAIN)} · ${MAIN_EFFORT} |`,
    `| executors | ${label(CODER)} · ${CODER_EFFORT} · ${list.length} running |`,
    `| review | ${label(REVIEWER)} · ${REVIEWER_EFFORT}${n > 0 ? ` · reviewing ${n}` : ''} |`,
    '',
    `**Plan (all devices):** ${plan}`,
    '',
    `**Today:** ${usage}`,
    ...list.map(run => `- ${short(CODER)} ▸ ${run.task}${run.files.length > 0 ? ` (${run.files.map(base).join(', ')})` : ''}`),
    ...(last !== '' ? ['', `**Last review:** ${last}`] : []),
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadSettings($)
    // one-time move of this copy's old $.store data into the shared file
    for (const key of ['usage', 'since', 'plan', 'spent', 'calibration'])
      if ((await dbGet($, key)) === undefined) {
        const old = await $.store.get(key).catch(() => undefined)
        if (old !== undefined) await dbSet($, key, old)
      }
    ledger = ((await dbGet($, 'usage')) ?? {}) as Ledger
    const cutoff = Date.now() - KEEP_DAYS * 24 * HOUR
    for (const key of Object.keys(ledger)) if (bucketEnd(key) < cutoff) delete ledger[key]
    $.ui.status(usageLine())
    await update($, today, () => totals())
    await $.agent.register({
      name: 'executor',
      description: `${label(CODER)} executor: carries out any well-defined operation Opus hands off (search and read files, map folders, edit, move or create files, run commands, fetch or scrape web pages) and reports back. The prompt must be a handoff document (${HANDOFF.join(', ')}); its Files section lists the absolute paths it may change, or "none" for read-only work. Spawn several in one message to run in parallel.`,
      prompt:
        'You are an executor. You get a handoff document (Goal, Context, Files, Steps, Done when) and carry out the Steps, using your own judgment for small details the Steps leave open. Change only the files listed under Files (if it says none, change nothing): other executors may be working in parallel. For edits, make the smallest diff that works and match the surrounding style. Finish with a short report: what you did, what you found (the facts asked for, with paths or URLs), the files you changed, and anything you could not do.',
      model: CODER,
      effort: CODER_EFFORT as never,
      disallowedTools: ['Agent'],
    })
    await $.agent.register({
      name: 'reviewer',
      description: `${label(REVIEWER)} batch reviewer: spawn exactly one after all executors of a batch have returned, with a brief (request, intent, executor reports, what to test). It tests, sends failures to fresh Haiku executors until they pass, and reports back.`,
      prompt:
        'You review and test one batch of changes that Haiku executors made from handoff documents Opus wrote. You never edit files: every fix goes to a fresh model-router:executor with a handoff document. Follow the steps at the end of your prompt.',
      model: REVIEWER,
      effort: REVIEWER_EFFORT as never,
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    })
    await $.command.register({
      name: 'router-usage',
      description: "Plan session % and this computer's router share of it; 'reset' clears the counters (model-router)",
      argumentHint: 'reset',
    })
    await $.command.register({ name: 'router', description: 'Show model-router status and open its pane' })
    isPaneShown = (await $.ui.open({ id: PANE, title: 'Model router' })).isPlaced
    return next(e)
  })

  // A prompt counts as asked, so the pane is placed at any width (VS Code's narrow panel included).
  on('prompt.submit', async ($, e, next) => {
    streak = 0
    if (!isPaneShown) isPaneShown = (await $.ui.open({ id: PANE, title: 'Model router' })).isPlaced
    return next(e)
  })

  // Opus learns the protocol from its system prompt.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.model === CODER) return r
    return { sections: [...r.sections, { id: 'model-router:protocol', text: protocol(), scope: 'session' as const }] }
  })

  // Only Opus keeps state: subagents are single-use, so they are never compacted (one that overflows ends and Opus re-delegates).
  on('session.compact', ($, e, next) =>
    e.agentId ? { skip: 'model-router: subagents are single-use and are not compacted.' } : next(e),
  )

  // Router: main chat, coders and reviewers run at their configured effort (the session's effort setting does not apply to them); every request is metered by part.
  on('turn.step', async function* ($, e, next) {
    const effort = (!e.agentId ? MAIN_EFFORT : files.has(e.agentId) ? CODER_EFFORT : reviewers.has(e.agentId) ? REVIEWER_EFFORT : e.effort) as never
    const r = yield* next(!e.agentId ? { ...e, model: MAIN, effort } : { ...e, effort })
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
      await update($, runs, list => [...list.filter(run => files.has(run.id)), { id, task: e.description, files: [] }])
    }
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'model-router: executor routing failed.' }))

  // Only running coders edit, and each file belongs to one coder at a time.
  on('tool.call', async ($, e, next) => {
    // Opus may make one-off calls itself; a run of easy steps goes to an executor.
    if (!e.agentId) {
      if (e.tool === 'Agent') streak = 0
      else if (++streak > MAX_DIRECT)
        return { deny: `model-router: ${MAX_DIRECT} tool calls in a row. Hand the remaining steps to ${CODER_TYPE} in one handoff document.` }
    }
    if (!EDIT_TOOLS.includes(String(e.tool))) return next(e)
    const mine = files.get(e.agentId ?? '')
    if (!mine) return { deny: `model-router: file edits are routed. Delegate this change to ${CODER_TYPE} with a handoff document.` }
    const args = e as unknown as { file_path?: string; notebook_path?: string }
    const path = args.file_path ?? args.notebook_path ?? ''
    const tool = [...agentOf].find(([, a]) => a === e.agentId)?.[0] ?? ''
    const own = declared.get(tool)
    if (!own || !covers(own, path))
      return { deny: `model-router: ${path} is not in your handoff's Files (read-only executors list none). Change only your files; report anything else as not done.` }
    const owner =
      [...files].some(([id, set]) => id !== e.agentId && set.has(path)) ||
      [...declared].some(([t, set]) => t !== tool && covers(set, path))
    if (owner) return { deny: `model-router: ${path} belongs to a parallel executor. Leave it and report it as not done.` }
    if (!mine.has(path)) {
      mine.add(path)
      await update($, runs, list => list.map(run => (run.id === e.agentId ? { ...run, files: [...run.files, path] } : run)))
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'model-router: edit guard failed.' }))

  // Shell writes follow the same rule: only an executor whose handoff lists files may run them.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const tool = [...agentOf].find(([, a]) => a === e.agentId)?.[0] ?? ''
    const { command } = e as unknown as { command?: string }
    if ((declared.get(tool)?.size ?? 0) > 0 || !BASH_WRITE.test(command ?? '')) return next(e)
    return files.has(e.agentId ?? '')
      ? { deny: 'model-router: this command changes files and your handoff lists none. Report it as not done.' }
      : { deny: `model-router: this command changes files. Delegate it to ${CODER_TYPE} with a handoff document that lists them.` }
  })

  // Coders are single-use: a finished coder is never resumed, so every Haiku session starts fresh.
  on('tool.call', { tool: 'SendMessage' }, ($, e, next) =>
    spent.has(String(e.to).split(' [')[0] ?? '')
      ? { deny: `model-router: executors are single-use. Spawn a fresh ${CODER_TYPE} with a new handoff document.` }
      : next(e),
  )

  // Opus hands off to Haiku executors. Once they have all returned, Opus briefs one Sonnet reviewer, which gets every handoff
  // and diff, tests, and sends failures to fresh Haiku coders until they pass. (A plugin cannot start agents through
  // $.tool.call, so the review is a spawn Opus makes, not one the router makes.)
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const caller = e.agentId ?? ''
    const fromReviewer = reviewers.has(caller)
    if (fromReviewer && e.subagent_type !== CODER_TYPE)
      return { deny: `model-router: the reviewer can only spawn ${CODER_TYPE} agents to fix what fails.` }
    if (e.subagent_type === REVIEWER_TYPE) {
      if (caller) return { deny: 'model-router: only the main chat starts the reviewer.' }
      if (declared.size > 0) return { deny: 'model-router: executors are still running. Start the reviewer once they have all returned.' }
      if (batch.length === 0) return { deny: 'model-router: nothing to review: no executor changed a file since the last review.' }
      const done = batch
      batch = []
      const share = Math.floor(MAX_CHARS / done.length)
      const changes = await Promise.all(
        done.map(async (d, i) =>
          [
            `### Executor ${i + 1}: ${d.task}`,
            `Handoff document:\n${d.handoff}`,
            `Executor report:\n${d.report}`,
            `Change:\n${(await changeOf($, d.paths)).slice(0, share)}`,
          ].join('\n\n'),
        ),
      )
      await meter($, 'handoff', MAIN, { calls: 1, input: 0, output: Math.round(e.prompt.length / 4), cacheRead: 0, cacheWrite: 0 })
      await update($, lastReview, () => `started ${new Date().toTimeString().slice(0, 5)} for ${done.length} change${done.length === 1 ? '' : 's'}`)
      return next({ ...e, prompt: [`Brief from Opus:\n${e.prompt}`, ...changes, reviewLoop()].join('\n\n') })
    }
    if (e.subagent_type !== CODER_TYPE) return next(e)
    if (!caller && batch.length > 0 && declared.size === 0)
      return { deny: `model-router: the last batch has not been reviewed. Spawn one ${REVIEWER_TYPE} with a brief first.` }
    const fixes = fixesBy.get(caller) ?? 0
    if (fromReviewer && fixes >= MAX_FIXES)
      return { deny: `model-router: ${MAX_FIXES} fix executors used. Stop and report to Opus what still fails.` }
    if (!HANDOFF.every(h => e.prompt.includes(h)))
      return { deny: `model-router: an executor prompt must be a handoff document with these headings:\n\n${TEMPLATE}` }
    const mine = filesOf(e.prompt)
    const steps = stepsIn(e.prompt)
    const clash = [...mine].filter(p => [...declared.values()].some(set => covers(set, p) || [...set].some(d => covers(mine, d))))
    if (clash.length > 0)
      return { deny: `model-router: ${clash.join(', ')} already belong to a running executor. Give each executor its own files, or wait for it to finish.` }
    if ([...stepsOf.values()].includes(steps))
      return { deny: 'model-router: a running executor already has these ## Steps. Give each executor different instructions.' }
    if (declared.size >= MAX_CODERS)
      return { deny: `model-router: ${MAX_CODERS} executors are already running. Wait for one to finish.` }
    if (fromReviewer) fixesBy.set(caller, fixes + 1)
    const call = e.tool_use_id ?? ''
    declared.set(call, mine)
    stepsOf.set(call, steps)
    await meter($, 'handoff', fromReviewer ? REVIEWER : MAIN, { calls: 1, input: 0, output: Math.round(e.prompt.length / 4), cacheRead: 0, cacheWrite: 0 })
    const r = await next(e).finally(() => {
      declared.delete(call)
      stepsOf.delete(call)
    })
    const id = agentOf.get(call) ?? ''
    const paths = [...(files.get(id) ?? [])]
    files.delete(id)
    agentOf.delete(call)
    if (!fromReviewer && r.deny === undefined && !r.isError && paths.length > 0)
      batch.push({ task: e.description, handoff: e.prompt, report: r.text ?? '', paths })
    await update($, runs, list => list.filter(run => run.id !== id))
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'model-router: agent routing failed.' }))

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
        <Text>main chat  {label(MAIN)} · {MAIN_EFFORT}</Text>
        <Text>executors {label(CODER)} · {CODER_EFFORT} · {list.length} running</Text>
        <Text>review     {label(REVIEWER)} · {REVIEWER_EFFORT}{n > 0 ? ` · reviewing ${n}` : ''}</Text>
        <Text dimColor>today      {usage.map(([m, v]) => `${m} ${k(v)}`).join(' · ') || 'no usage yet'}</Text>
        {list.map(run => (
          <Text color="cyan">
            {short(CODER)} ▸ {run.task}
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
    return next({ ...e, props: { ...e.props, input: { ...input, description: `${label(CODER)} · ${input.description ?? ''}` } } })
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
