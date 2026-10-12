import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionRateLimit } from 'claude-code'

// Defaults; each can be overridden by a MODEL_ROUTER_* env var (README.md › Configure), read at session start and on every prompt.
let MAIN = 'claude-sonnet-5-5' // the main chat: one model for the whole session, so its prompt cache stays warm
let MAIN_EFFORT = 'high'
let WORKER = 'claude-haiku-5-5' // bulk, checkable work: reading, searching, summarising, test runs
let WORKER_EFFORT = 'medium'
let ADVISOR = 'claude-opus-5-5' // read-only second opinion on hard calls
let ADVISOR_EFFORT = 'high'
let KB_CHARS = 8000 // knowledge base characters sent to the main chat and to each agent
let RESUME_MS = 55 * 60_000 // a finished agent can be resumed this long: the prompt cache lives 1 hour
let ANALYTICS = 'off' // SQLite file every router event is appended to (README.md › Analytics); 'off' disables it
const WORKER_TYPE = 'model-router:haiku'
const ADVISOR_TYPE = 'model-router:opus'
const KB = '.claude/router-kb.md' // durable repo facts, shared by every model
const HANDOFF = ['## Goal', '## Context', '## Scope', '## Done when']
type Role = 'worker' | 'advisor'
const modelOfRole = (r: string) => (r === 'worker' ? WORKER : ADVISOR)
const effortOfRole = (r: string) => (r === 'worker' ? WORKER_EFFORT : ADVISOR_EFFORT)
const typeOfRole = (r: string) => (r === 'worker' ? WORKER_TYPE : ADVISOR_TYPE)
const roleOfType = (type: string): Role | undefined => (type === WORKER_TYPE ? 'worker' : type === ADVISOR_TYPE ? 'advisor' : undefined)

const KB_HEADER = /^<!-- model-router knowledge base · checked at (\w*) -->\n?/ // first line: the commit the facts were checked against
const ADHD_STYLE = [
  'How you write to the user (output style adapted from github.com/ayghri/i-have-adhd, MIT): the reader has ADHD, so every reply must be easy to act on.',
  '- First line: the next action or the answer itself (a command, path or result). No preamble.',
  '- More than one step: a numbered list, one bounded action per step, the fewest steps that work.',
  '- Restate where things stand ("step 2 of 4 done: ...") instead of relying on the reader to remember.',
  '- Show what now works in concrete terms; state errors plainly as cause and fix.',
  '- Time estimates in concrete units ("about 15 minutes"), never "a bit of work".',
  '- At most 5 items per list: group and rank, keep the rest for when they become relevant.',
  '- One topic at a time: finish it, then offer a side issue as a separate question.',
  '- No openers ("Great question", "Let me..."), no recaps of what you just did, no closing pleasantries.',
  '- When anything is left open, end with ONE concrete next action the reader can do in under two minutes.',
  '- When the user asks to explain or walk through something, explain fully, with headers to skim.',
  '- When relaying an agent report, reshape it this way; do not paste it whole.',
].join('\n')
const protocol = () =>
  [
    'Model router (enforced by the model-router plugin):',
    `- You are the main thread (${label(MAIN)}): you talk to the user, read the code and make the edits yourself. Your model never changes during a session, which keeps its prompt cache warm.`,
    `- Delegate down to ${WORKER_TYPE} (${label(WORKER)}) for bulk, checkable work: reading or searching many files, summarising long logs or command output, running tests or builds and reporting the failures. It cannot edit files. Spawn several in ONE message for independent pieces.`,
    `- Consult ${ADVISOR_TYPE} (${label(ADVISOR)}, read-only) when a change touches more than 5 files or modules, when a design, security or performance call is costly to get wrong, or when the same fix or test has failed twice. It returns a plan or review; you make the edits.`,
    `- A handoff document has these headings, in order: ${HANDOFF.join(', ')}. The agent starts with no context: put in everything it needs (absolute paths, what was said and decided earlier in this conversation, constraints, what to report back). Scope names the files or areas it may touch and what is out of scope.`,
    `- A finished agent can be resumed with SendMessage for a follow-up for about ${Math.round(RESUME_MS / 60_000)} minutes, while its context is still cached; after that spawn a fresh one with a new handoff.`,
    `- Knowledge base: the router appends the "## Facts" of every agent report to ${KB}; do not edit it. Bullets marked (stale?) may be outdated: check the file before relying on them.`,
    ...(kbSnapshot ? ['', `Knowledge base (${KB}, as of session start):`, kbSnapshot] : []),
    ...(STYLE === 'adhd' ? ['', ADHD_STYLE] : []),
  ].join('\n')

const TEMPLATE = HANDOFF.map(h => `${h}\n...`).join('\n\n')

type Row = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }
type Ledger = Record<string, Record<string, Row>> // UTC hour 'YYYY-MM-DDTHH' (older data: day) -> 'part:model' -> totals
type Part = 'chat' | 'classify' | 'kb' | 'handoff' | Role | 'medium' | 'complex' | 'coder' | 'review' | 'subagent'

const PARTS: [Part, string][] = [
  ['chat', 'Main thread'],
  ['classify', '↳ routing (old)'],
  ['kb', '↳ knowledge base (old)'],
  ['handoff', '↳ handoff docs (est.)'],
  ['worker', 'Worker agents'],
  ['advisor', 'Advisor agents'],
  ['medium', 'Medium agents (old)'],
  ['complex', 'Complex agents (old)'],
  ['coder', 'executors (old)'],
  ['review', 'reviews (old)'],
  ['subagent', 'other subagents'],
]
const HOUR = 3_600_000
const KEEP_DAYS = 35 // ponytail: older buckets are dropped at session start; export the store first if you need longer history

const runs = atom({ plugin: 'model-router', key: 'runs' } as const, [])
const today = atom({ plugin: 'model-router', key: 'today' } as const, {})
const PANE = 'model-router'
let isPaneShown = false // module state: a reload reopens the pane once
let userText = '' // the current user message, sent verbatim to agents
let kbSnapshot = '' // the knowledge base at session start, for the main chat's system prompt
let kbWrites: Promise<unknown> = Promise.resolve() // knowledge base appends, one after another
let STYLE = 'adhd' // the front desk's output style: 'adhd' (ADHD_STYLE in the protocol) or 'off' (MODEL_ROUTER_STYLE)
const agents = new Map<string, Role>() // worker/advisor agentId -> role, kept after the agent finishes so a resumed run keeps its model's effort
let inAgent = 0 // worker/advisor runs in flight: while > 0 the main chat is blocked, so a prompt.compose is for a subagent
const agentOf = new Map<string, string>() // Agent tool_use_id -> agentId
const idle = new Map<string, number>() // finished agent agentId and name -> when it finished: resumable for RESUME_MS

let ledger: Ledger = {}

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
const kbBody = (text: string) => text.replace(KB_HEADER, '')
const writeKb = ($: EngineInterface, body: string, sha: string) =>
  $.fs.write(KB, `<!-- model-router knowledge base · checked at ${sha} -->\n${body.trim()}\n`)
async function readKb($: EngineInterface) {
  return kbBody(String(await $.fs.read(KB).catch(() => '')))
}
async function git($: EngineInterface, args: string[]) {
  const r = await $.process.run(['git', ...args])
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed`)
  return r.stdout.trim()
}

// Session start: bullets naming a file changed since the header's commit get '(stale?)', and the header moves to HEAD.
// ponytail: uncommitted changes re-mark their bullets every session until committed
async function checkKb($: EngineInterface) {
  const text = String(await $.fs.read(KB).catch(() => ''))
  if (!text) return ''
  const body = kbBody(text)
  try {
    const sha = await git($, ['rev-parse', 'HEAD'])
    const old = KB_HEADER.exec(text)?.[1] ?? ''
    const changed = old ? (await git($, ['diff', '--name-only', old])).split('\n') : []
    const next = body
      .split('\n')
      .map(l => (l.startsWith('- ') && !l.startsWith('- (stale?) ') && changed.some(p => p && l.includes(p)) ? l.replace('- ', '- (stale?) ') : l))
      .join('\n')
    if (next !== body || old !== sha) await writeKb($, next, sha)
    return next.slice(0, KB_CHARS)
  } catch {
    return body.slice(0, KB_CHARS)
  }
}

// After an agent reports: its "## Facts" bullets are appended as written (no model rewrites the file); one already there is confirmed (its stale mark goes).
// Over KB_CHARS the oldest bullets go first, never the new ones.
async function addFacts($: EngineInterface, report: string) {
  const parts = report.split(/^## Facts[ \t]*$/m)
  const facts = parts.length < 2 ? [] : (parts.pop() ?? '').split('\n').map(l => l.trim()).filter(l => l.startsWith('- ') && !/^- none\.?$/i.test(l))
  if (facts.length === 0) return
  const text = String(await $.fs.read(KB).catch(() => ''))
  const body = kbBody(text).trim()
  const lines = body ? body.split('\n') : []
  let added = 0
  for (const f of facts) {
    const i = lines.findIndex(l => l.replace('- (stale?) ', '- ') === f)
    if (i >= 0) lines[i] = f
    else {
      lines.push(f)
      added++
    }
  }
  const drop = () => {
    const i = lines.findIndex(l => l.startsWith('- '))
    return i >= 0 && i < lines.length - added && lines.splice(i, 1).length > 0
  }
  while (lines.join('\n').length > KB_CHARS && drop());
  const next = lines.join('\n')
  if (next === body) return
  await writeKb($, next, KB_HEADER.exec(text)?.[1] ?? '')
  record($, 'kb', { detail: { before: body.length, after: next.length } })
}

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

// Analytics: one row per event in a SQLite file, written with the sqlite3 CLI (the plugin API has no SQLite); query it to tune the router.
// ponytail: one sqlite3 process per event, failures dropped silently (no sqlite3 = no analytics)
const SCHEMA =
  'PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS events (ts TEXT, session TEXT, kind TEXT, part TEXT, model TEXT, effort TEXT, agent TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL, detail TEXT);'
const sqlValue = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))
    ? 'NULL'
    : typeof v === 'number'
      ? String(v)
      : `'${String(v).replaceAll("'", "''")}'`
type Event = { part?: string; model?: string; effort?: string; agent?: string; row?: Row; detail?: unknown }
let records: Promise<unknown> = Promise.resolve()
function record($: EngineInterface, kind: string, { part, model, effort, agent, row, detail }: Event = {}) {
  if (ANALYTICS === 'off') return
  records = records
    .then(async () => {
      const values = [new Date().toISOString(), await $.session.id(), kind, part, model, effort, agent, row?.input, row?.output, row?.cacheRead, row?.cacheWrite, row && model ? cost(model, row) : undefined, detail === undefined ? undefined : JSON.stringify(detail)]
      await $.process.run(['sqlite3', ANALYTICS], { stdin: `${SCHEMA}\nINSERT INTO events VALUES (${values.map(sqlValue).join(', ')});\n` })
    })
    .catch(() => undefined)
}

// MODEL_ROUTER_* overrides: an unset or invalid value keeps its default.
async function loadSettings($: EngineInterface) {
  const str = (v: string | undefined, fallback: string) => v || fallback
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v)
    return Number.isInteger(n) && n > 0 ? n : fallback
  }
  const effort = (v: string | undefined, fallback: string) => (v && /^(low|medium|high|xhigh|max)$/.test(v) ? v : fallback)
  MAIN = str(await $.env.get('MODEL_ROUTER_MAIN_MODEL'), 'claude-sonnet-5-5')
  MAIN_EFFORT = effort(await $.env.get('MODEL_ROUTER_MAIN_EFFORT'), 'high')
  WORKER = str(await $.env.get('MODEL_ROUTER_WORKER_MODEL'), 'claude-haiku-5-5')
  WORKER_EFFORT = effort(await $.env.get('MODEL_ROUTER_WORKER_EFFORT'), 'medium')
  ADVISOR = str(await $.env.get('MODEL_ROUTER_ADVISOR_MODEL'), 'claude-opus-5-5')
  ADVISOR_EFFORT = effort(await $.env.get('MODEL_ROUTER_ADVISOR_EFFORT'), 'high')
  KB_CHARS = num(await $.env.get('MODEL_ROUTER_KB_CHARS'), 8000)
  const minutes = await $.env.get('MODEL_ROUTER_RESUME_MINUTES')
  RESUME_MS = (minutes && Number.isInteger(Number(minutes)) && Number(minutes) >= 0 ? Number(minutes) : 55) * 60_000 // 0 turns resuming off
  STYLE = (await $.env.get('MODEL_ROUTER_STYLE')) === 'off' ? 'off' : 'adhd'
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  ANALYTICS = str(await $.env.get('MODEL_ROUTER_ANALYTICS_DB'), `${home}/.claude/model-router-analytics.db`)
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
    for (const [part] of PARTS) if (part !== 'handoff') addTo(sumTok, tok[part]) // handoff docs are part of the front desk's output
    const hit = (t: Row) => {
      const d = t.input + t.cacheRead + t.cacheWrite
      return d === 0 ? '—' : `${Math.round((t.cacheRead / d) * 100)}%`
    }
    const toks = (t: Row) => `${k(t.input)} | ${k(t.output)} | ${k(t.cacheRead)} | ${k(t.cacheWrite)} | ${hit(t)}`
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
      '| part | model | share | ≈ of session (5h) | ≈ of week (7d) | in | out | cache read | cache write | cache hit |',
      '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|',
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
    '_Router usage only: chats on this computer with the router loaded; other devices count in the plan table but not here. Share weighs each part by API list price over the last 7 days; the token columns cover the same 7 days (in = new input, out = output, cache read / cache write = context re-read from or written to the prompt cache). "≈ of session / week" = the plan points that usage cost, learned from moments the plan moved 5+ points while this computer worked ("calibrating" until then). Usage recorded before chats were tagged counts only under all chats. `/router-usage reset` clears the counters. cache hit = share of input read from the prompt cache._',
  )
  return lines.join('\n')
}

async function card($: EngineInterface) {
  const list = await read($, runs)
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
    `| main thread | ${label(MAIN)} · ${MAIN_EFFORT} |`,
    `| worker | ${label(WORKER)} · ${WORKER_EFFORT} |`,
    `| advisor | ${label(ADVISOR)} · ${ADVISOR_EFFORT} |`,
    '',
    `**Plan (all devices):** ${plan}`,
    '',
    `**Today:** ${usage}`,
    ...list.map(run => `- ${short(modelOfRole(run.role))} ▸ ${run.task}`),
  ].join('\n')
}

export const register: Register = on => {
  // Analytics: registered first, so it is the outermost tool.call hook and sees every router denial.
  on('tool.call', { tool: /.*/ }, async ($, e, next) => {
    const r = await next(e)
    const { file_path, subagent_type } = e as unknown as { file_path?: string; subagent_type?: string }
    record($, 'tool', { agent: e.agentId, detail: { tool: e.tool, path: file_path, subagentType: subagent_type, deny: r.deny } })
    return r
  })

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
    kbSnapshot = await checkKb($)
    const TASK = {
      worker: 'Do the reading, searching or running the handoff asks for, inside the Scope, and report what you found with paths and line numbers; quote only what the main thread needs.',
      advisor: 'Read what you need, then give a plan or review: the recommendation first, then numbered steps with paths, then the risks.',
    }
    for (const role of ['worker', 'advisor'] as const) {
      const model = modelOfRole(role)
      await $.agent.register({
        name: typeOfRole(role).replace('model-router:', ''),
        description:
          role === 'worker'
            ? `${label(model)} worker for bulk, checkable work: reading or searching many files, summarising long logs or command output, running tests or builds. Read-only. The prompt must be a handoff document (${HANDOFF.join(', ')}). Spawn several in one message for independent pieces.`
            : `${label(model)} read-only advisor for hard calls: a change across more than 5 files or modules, a costly design, security or performance decision, a fix or test that failed twice. It returns a plan or review, not edits. The prompt must be a handoff document (${HANDOFF.join(', ')}).`,
        prompt: `You are a ${label(model)} ${role} agent. You get a handoff document from the main thread, the user's message verbatim and the repo's knowledge base. ${TASK[role]} You cannot edit files and must not change anything with a command. Bullets in the knowledge base marked (stale?) may be outdated: check before relying on them. Do not edit ${KB}; the router appends your "## Facts" to it. Finish with a short report the main thread can relay as is: first line the outcome; problems as cause and fix; anything you could not do. End it with a "## Facts" section: durable facts you learned about this repo, one per line as "- (relative/path) fact", or "none".${kbSnapshot ? `\n\nKnowledge base (${KB}, as of session start):\n${kbSnapshot}` : ''}`,
        model,
        effort: effortOfRole(role) as never,
        disallowedTools: ['Agent', 'Edit', 'Write', 'NotebookEdit'],
      })
    }
    await $.command.register({
      name: 'router-usage',
      description: "Plan session % and this computer's router share of it; 'reset' clears the counters (model-router)",
      argumentHint: 'reset',
    })
    await $.command.register({ name: 'router', description: 'Show model-router status and open its pane' })
    isPaneShown = (await $.ui.open({ id: PANE, title: 'Model router' })).isPlaced
    return next(e)
  })

  // A prompt counts as asked, so the pane is placed at any width (VS Code's narrow panel included); re-reads MODEL_ROUTER_* so /reload-plugins applies changes.
  on('prompt.submit', async ($, e, next) => {
    await loadSettings($)
    if (!isPaneShown) isPaneShown = (await $.ui.open({ id: PANE, title: 'Model router' })).isPlaced
    userText = e.text
    record($, 'prompt', { detail: { settings: { MAIN, MAIN_EFFORT, WORKER, WORKER_EFFORT, ADVISOR, ADVISOR_EFFORT, KB_CHARS, RESUME_MS, STYLE } } })
    return next(e)
  })

  // The main chat gets the protocol whatever model the session names; worker and advisor agents (composed while one is in flight) do not.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (inAgent > 0) return r
    return { sections: [...r.sections, { id: 'model-router:protocol', text: protocol(), scope: 'session' as const }] }
  })

  // Only the main chat is compacted: a compaction rewrites the agent's cached prefix, so an agent that overflows ends and the main chat re-delegates.
  on('session.compact', ($, e, next) =>
    e.agentId ? { skip: 'model-router: subagents are not compacted.' } : next(e),
  )

  // Router: the main chat runs on its one model, worker and advisor agents at their role's effort (the session's effort setting does not apply to them); every request is metered by part.
  on('turn.step', async function* ($, e, next) {
    const role = e.agentId ? agents.get(e.agentId) : undefined
    const effort = (!e.agentId ? MAIN_EFFORT : role ? effortOfRole(role) : e.effort) as never
    const r = yield* next(!e.agentId ? { ...e, model: MAIN, effort } : { ...e, effort })
    const part: Part = !e.agentId ? 'chat' : (role ?? 'subagent')
    if (r.usage) await meter($, part, r.usage.model, fromUsage(r.usage))
    if (r.usage) record($, 'request', { part, model: r.usage.model, effort, agent: e.agentId, row: fromUsage(r.usage) })
    return r
  })

  // Worker and advisor agents run on their role's model, in the foreground.
  on('agent.spawn', async ($, e, next) => {
    const role = roleOfType(e.subagentType)
    if (!role) return next(e)
    const r = await next({ ...e, model: modelOfRole(role), background: false })
    const id = r.agentId
    if (id) {
      agents.set(id, role)
      agentOf.set(e.tool_use_id, id)
      await update($, runs, list => [...list, { id, task: e.description, role }])
    }
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'model-router: agent routing failed.' }))

  // Worker and advisor agents get a handoff document with every heading, plus the user's message verbatim and the knowledge base, read fresh.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const role = roleOfType(e.subagent_type)
    if (role === undefined) return next(e)
    if (!HANDOFF.every(h => e.prompt.includes(h)))
      return { deny: `model-router: an agent prompt must be a handoff document with these headings:\n\n${TEMPLATE}` }
    await meter($, 'handoff', MAIN, { calls: 1, input: 0, output: Math.round(e.prompt.length / 4), cacheRead: 0, cacheWrite: 0 })
    const kb = (await readKb($)).trim().slice(0, KB_CHARS)
    const newer = kb !== '' && kb !== kbSnapshot.trim() // the system prompt has the session-start snapshot; send only a later change
    inAgent++
    const r = await next({ ...e, prompt: [e.prompt, `## User's message (verbatim)\n${userText}`, ...(newer ? [`## Knowledge base updates (newer than your system prompt)\n${kb}`] : [])].join('\n\n') }).finally(() => inAgent--)
    const call = e.tool_use_id ?? ''
    const id = agentOf.get(call) ?? ''
    agentOf.delete(call)
    idle.set(id, Date.now())
    if (e.name) idle.set(e.name, Date.now())
    await update($, runs, list => list.filter(run => run.id !== id))
    kbWrites = kbWrites.then(() => addFacts($, r.text ?? '')).catch(() => undefined)
    await kbWrites
    record($, 'agent', { model: modelOfRole(role), agent: id, detail: { role, task: e.description, handoffChars: e.prompt.length, isError: !!r.isError, deny: r.deny } })
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'model-router: agent routing failed.' }))

  // A finished agent can be resumed while its prompt cache is warm; later, a fresh agent is cheaper than re-writing its whole context.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const to = String(e.to).split(' [')[0] ?? ''
    const at = idle.get(to)
    if (at === undefined) return next(e)
    if (Date.now() - at >= RESUME_MS)
      return { deny: `model-router: this agent finished over ${Math.round(RESUME_MS / 60_000)} minutes ago, so its prompt cache is cold. Spawn a fresh agent with a new handoff document.` }
    inAgent++
    const r = await next(e).finally(() => inAgent--)
    idle.set(to, Date.now())
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'model-router: agent routing failed.' }))

  // Every surface, VS Code included: a live pane with the router's state.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, runs)
    const usage = Object.entries(await read($, today))
    return (
      <Box flexDirection="column">
        <Text bold color="green">● model-router active</Text>
        <Text>main    {label(MAIN)} · {MAIN_EFFORT}</Text>
        <Text>worker  {label(WORKER)} · {WORKER_EFFORT}</Text>
        <Text>advisor {label(ADVISOR)} · {ADVISOR_EFFORT}</Text>
        <Text dimColor>today   {usage.map(([m, v]) => `${m} ${k(v)}`).join(' · ') || 'no usage yet'}</Text>
        {list.map(run => (
          <Text color="cyan">
            {short(modelOfRole(run.role))} ▸ {run.task}
          </Text>
        ))}
      </Box>
    )
  })

  // Every surface, VS Code included: agent rows in the transcript name their model.
  on('ui.render', { component: 'ToolUse', props: { tool: 'Agent' } }, ($, e, next) => {
    const input = e.props.input as { subagent_type?: string; description?: string }
    const role = roleOfType(input.subagent_type ?? '')
    if (role === undefined) return next(e)
    return next({ ...e, props: { ...e.props, input: { ...input, description: `${label(modelOfRole(role))} · ${input.description ?? ''}` } } })
  })

  // the engine prefixes command output with "model-router: "; a leading blank line keeps the markdown's first line (a table or heading) intact on surfaces that render it as plain markdown
  on('command.run', { command: 'router' }, async $ => {
    isPaneShown = (await $.ui.open({ id: PANE, title: 'Model router' })).isPlaced
    return { text: `\n\n${await card($)}` }
  })

  // VS Code prints command output as plain text: draw this plugin's commands as markdown on every surface.
  on('ui.render', { component: 'CommandOutput' }, ($, e, next) => {
    if (!['router', 'router-usage'].includes(e.props.command) || e.props.isErrored) return next(e)
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={e.props.text.replace(/^model-router: \n*/, '')} />
  })

  on('command.run', { command: 'router-usage' }, async ($, e) => ({
    text: `\n\n${e.args.trim() === 'reset' ? await reset($) : await report($)}`,
  }))
}
