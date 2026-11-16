import * as acp from '@agentclientprotocol/sdk'
import { AgentError, type AgentAccount } from '@pr-review/domain'
import { Context, Effect, Exit, Fiber, Layer, Queue, type Scope, Stream, type Tracer } from 'effect'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { safeGhCommand, safeGitCommand } from './gitOnly.ts'
import { loginPath } from './shellPath.ts'
import { annotate, measure, type Meta, startSpan } from './Perf.ts'
import { ticketPermission } from './permissions.ts'
import { describeTool } from './steps.ts'

export type AcpUpdate = { readonly _tag: 'Text'; readonly delta: string } | { readonly _tag: 'Step'; readonly step: string }

/** One agent session on one account. Each prompt streams until the agent ends its turn. */
export interface AcpSession {
  readonly sessionId: string
  /** The agent's own model before the account's was set, when the agent says. */
  readonly defaultModel: string | undefined
  setModel(model: string): Effect.Effect<void, AgentError>
  prompt(text: string): Stream.Stream<AcpUpdate, AgentError>
}

/** How to reach an account's agent: a spawned ACP server in the companion, an in-process fake in tests. */
export type Launch = (account: AgentAccount, cwd: string) => Effect.Effect<{ target: acp.Stream | acp.AgentApp; output: () => string }, AgentError, Scope.Scope>

// Claude Code's own settings could allow tools past the gate; its ACP adapter takes SDK options here.
const disallowedTools = ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']
const claudeOptions = { claudeCode: { options: { settingSources: [], disallowedTools } } }
// The ticket session loads the user's own config so their tracker MCP servers are there; it never sees PR code, and can't read files or fetch URLs.
// Residual risk: tools the user auto-allows in that config are approved by Claude Code itself and never reach ticketPermission.
const ticketOptions = { claudeCode: { options: { settingSources: ['user'], disallowedTools: [...disallowedTools, 'Read', 'Glob', 'Grep', 'Bash'] } } }
const READ_ONLY_MODES = [/read.?only/i, /^ask$/i, /^plan$/i, /^default$/i, /manual/i]

const agentError = (e: unknown, output = '') =>
  new AgentError({ message: [e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String(e.message) : String(e), output.trim().split('\n').slice(-3).join(' ')].filter(Boolean).join(': ') })

/** Answer text, and each shell command once as a step for the loading line. */
const toUpdate = (u: acp.SessionUpdate, seen: Set<string>): AcpUpdate | undefined => {
  if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') return { _tag: 'Text', delta: u.content.text }
  if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return undefined
  const command = (u.rawInput as { command?: unknown } | undefined)?.command
  if (typeof command !== 'string' || seen.has(u.toolCallId)) return undefined
  seen.add(u.toolCallId)
  return { _tag: 'Step', step: describeTool('Bash', { command }) }
}

const round = (ms: number) => Math.round(ms * 10) / 10
const SHELL = /^\s*(git|gh)\s+([a-z][a-z-]*)/

/** What a tool call is, without its arguments: the agent's tool name and kind, and for git or gh the subcommand. */
const toolMeta = (u: { kind?: acp.ToolKind | null; rawInput?: unknown; _meta?: { [k: string]: unknown } | null }): Meta => {
  const name = (u._meta?.claudeCode as { toolName?: unknown } | undefined)?.toolName
  const command = (u.rawInput as { command?: unknown } | undefined)?.command
  const shell = typeof command === 'string' ? SHELL.exec(command) : null
  return { tool: typeof name === 'string' ? name : undefined, toolKind: u.kind ?? undefined, command: shell?.[1], subcommand: shell?.[2] }
}

const tokens = (usage: unknown): Meta => {
  if (typeof usage !== 'object' || usage === null) return {}
  const u = usage as Record<string, unknown>
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : undefined)
  return { inputTokens: n('inputTokens'), outputTokens: n('outputTokens'), cachedReadTokens: n('cachedReadTokens'), cachedWriteTokens: n('cachedWriteTokens'), thoughtTokens: n('thoughtTokens'), totalTokens: n('totalTokens') }
}

/**
 * Times one prompt from the agent's updates: when it first did anything, first wrote, and each tool call from its
 * announcement to its last status, as an `agent.tool` span under `parent`. Time no tool covered is unclassified:
 * the model, the agent's own work and the protocol can't be told apart from here.
 */
const promptTimer = (tracer: Tracer.Tracer, parent: Tracer.AnySpan) => {
  const t0 = performance.now()
  const since = () => performance.now() - t0
  const tools = new Map<string, { span: Tracer.Span; start: number; end?: number }>()
  const m = { updates: 0, textChunks: 0, thoughtChunks: 0, rejectedTools: 0 } as Record<string, number>
  const first = (k: string) => void (m[k] ??= round(since()))
  let running = 0
  let lastEnd: number | undefined
  let maxGap = 0
  const end = (id: string, exit: Exit.Exit<unknown, unknown>) => {
    const t = tools.get(id)
    if (!t || t.end !== undefined) return
    t.end = lastEnd = since()
    running--
    t.span.end(process.hrtime.bigint(), exit)
  }
  const tool = (u: acp.ToolCall | acp.ToolCallUpdate) => {
    let t = tools.get(u.toolCallId)
    if (!t) {
      const at = since()
      if (running === 0 && lastEnd !== undefined) maxGap = Math.max(maxGap, at - lastEnd)
      first('firstToolMs')
      running++
      tools.set(u.toolCallId, (t = { span: startSpan(tracer, parent, 'agent.tool', { sincePreviousToolMs: lastEnd === undefined ? undefined : round(at - lastEnd) }), start: at }))
    }
    for (const [k, v] of Object.entries(toolMeta(u))) if (v !== undefined && !t.span.attributes.has(`perf.${k}`)) t.span.attribute(`perf.${k}`, v)
    if (u.status === 'completed') end(u.toolCallId, Exit.void)
    if (u.status === 'failed') end(u.toolCallId, Exit.fail({ _tag: 'ToolFailed' }))
  }
  return {
    update: (u: acp.SessionUpdate) => {
      m.updates!++
      first('firstActivityMs')
      if (u.sessionUpdate === 'agent_message_chunk') (m.textChunks!++, first('firstTextMs'))
      else if (u.sessionUpdate === 'agent_thought_chunk') (m.thoughtChunks!++, first('firstThoughtMs'))
      else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') tool(u)
      else if (u.sessionUpdate === 'usage_update') {
        m.contextTokens = u.used
        m.contextWindow = u.size
        if (u.cost) m.cost = u.cost.amount
      }
    },
    permission: (id: string, allowed: boolean) => {
      if (!allowed) m.rejectedTools!++
      tools.get(id)?.span.attribute('perf.permission', allowed ? 'allowed' : 'rejected')
    },
    /** Ends tool calls still open as cancelled; the prompt's numbers. */
    finish: (): Meta => {
      for (const id of tools.keys()) end(id, Exit.interrupt())
      const total = since()
      let covered = 0
      let reach = 0
      for (const t of [...tools.values()].sort((a, b) => a.start - b.start)) {
        const stop = t.end ?? total
        covered += Math.max(0, stop - Math.max(t.start, reach))
        reach = Math.max(reach, stop)
      }
      const summed = [...tools.values()].reduce((n, t) => n + ((t.end ?? total) - t.start), 0)
      return { ...m, toolCalls: tools.size, toolMs: round(covered), toolCallMsSum: round(summed), unclassifiedMs: round(total - covered), maxToolGapMs: round(maxGap) }
    },
  }
}

const expandHome = (v: string) => (v === '~' || v.startsWith('~/') ? homedir() + v.slice(1) : v)

/** Starts `account.command` through the shell, on the user's own PATH. Keys that would bill an API instead of the login are left out. */
export const spawnAgent: Launch = (account, cwd) =>
  Effect.gen(function* () {
    const PATH = (yield* Effect.promise(loginPath)) ?? process.env.PATH
    const env: NodeJS.ProcessEnv = { ...process.env, PATH, ...Object.fromEntries(Object.entries(account.env).map(([k, v]) => [k, expandHome(v)])) }
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) if (!(key in account.env)) delete env[key]
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => spawn(account.command, { shell: true, cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })),
      (c) => Effect.sync(() => void c.kill()),
    )
    let output = ''
    child.stderr.on('data', (d: Buffer) => (output = (output + d.toString()).slice(-4000)))
    child.on('error', (e) => (output += `\n${e.message}`))
    const target = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
    return { target, output: () => output }
  })

export class Acp extends Context.Service<Acp, { open(account: AgentAccount, cwd: string, resume?: string, o?: { related?: ReadonlyArray<string>; tickets?: boolean }): Effect.Effect<AcpSession, AgentError, Scope.Scope> }>()(
  'pr-review/Acp',
) {
  static readonly layerWith = (launch: Launch) =>
    Layer.succeed(
      Acp,
      Acp.of({
        open: (account, cwd, resume, o) =>
          Effect.gen(function* () {
            const { target, output } = yield* launch(account, cwd).pipe(measure('agent.spawn', { agent: account.agent }))
            const updates = yield* Queue.unbounded<acp.SessionNotification | 'stop'>()
            // The prompt running now; prompts in a session never overlap.
            let timer: ReturnType<typeof promptTimer> | undefined
            const fail = (e: unknown) => agentError(e, output())
            const call = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: fail })

            const app = acp
              .client({ name: 'pr-review' })
              .onNotification(acp.methods.client.session.update, (ctx) => {
                Queue.offerUnsafe(updates, ctx.params)
                timer?.update(ctx.params.update)
              })
              .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
                const raw = ctx.params.toolCall.rawInput as { command?: unknown } | undefined
                const allowed = o?.tickets
                  ? ticketPermission(ctx.params.toolCall)
                  : ctx.params.toolCall.kind === 'execute' && typeof raw?.command === 'string' && (safeGitCommand(raw.command) || safeGhCommand(raw.command, o?.related ?? []))
                timer?.permission(ctx.params.toolCall.toolCallId, Boolean(allowed))
                const option = ctx.params.options.find((o) => o.kind === (allowed ? 'allow_once' : 'reject_once')) ?? ctx.params.options.find((o) => o.kind.startsWith(allowed ? 'allow' : 'reject'))
                return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
              })
            const connection = yield* Effect.acquireRelease(
              Effect.sync(() => (typeof (target as acp.AgentApp).onRequest === 'function' ? app.connect(target as acp.AgentApp) : app.connect(target as acp.Stream))),
              (c) => Effect.sync(() => c.close()),
            )
            const agent = connection.agent

            // The first answer from the process, so it includes the agent starting up (for npx, resolving the package too).
            const init = yield* call(() => agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })).pipe(
              measure('acp.initialize'),
            )
            const caps = init.agentCapabilities
            const _meta = o?.tickets ? ticketOptions : claudeOptions
            const start = () =>
              resume
                ? caps?.sessionCapabilities?.resume
                  ? agent.request(acp.methods.agent.session.resume, { sessionId: resume, cwd, mcpServers: [], _meta })
                  : agent.request(acp.methods.agent.session.load, { sessionId: resume, cwd, mcpServers: [], _meta })
                : agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [], _meta })
            // Agents that keep their own login (Cursor, Gemini) want it named first; an API key is never offered.
            const login = init.authMethods?.find((m) => m.id !== 'api-key' && !('type' in m && m.type === 'terminal'))
            const session = yield* call(start).pipe(
              Effect.catch((e) =>
                login && /auth/i.test(e.message)
                  ? Effect.andThen(
                      Effect.andThen(annotate({ authenticated: true }), call(() => agent.request(acp.methods.agent.authenticate, { methodId: login.id }))),
                      call(start),
                    )
                  : Effect.fail(e),
              ),
              Effect.mapError((e) => (/auth/i.test(e.message) ? new AgentError({ message: `${account.name} is not logged in: ${e.message}` }) : e)),
              measure('acp.session', { method: resume ? (caps?.sessionCapabilities?.resume ? 'resume' : 'load') : 'new' }),
            )
            const sessionId = resume ?? (session as acp.NewSessionResponse).sessionId
            // Replayed history from a load is not part of the next answer.
            yield* Queue.clear(updates)

            const modes = 'modes' in session ? session.modes?.availableModes : undefined
            const mode = account.mode ?? READ_ONLY_MODES.map((r) => modes?.find((m) => r.test(m.id))?.id).find(Boolean)
            if (mode && mode !== ('modes' in session ? session.modes?.currentModeId : undefined))
              yield* call(() => agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: mode })).pipe(measure('acp.setMode'))
            const options = (session as { configOptions?: ReadonlyArray<acp.SessionConfigOption> | null }).configOptions
            const current = options?.find((c) => c.id === 'model')?.currentValue
            const defaultModel = typeof current === 'string' ? current : undefined
            let model = defaultModel
            const setModel = (value: string): Effect.Effect<void, AgentError> =>
              Effect.suspend(() =>
                value === model
                  ? Effect.void
                  : call(() => agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'model', value })).pipe(
                      Effect.map(() => void (model = value)),
                      measure('acp.setModel'),
                    ),
              )
            if (account.model) yield* setModel(account.model)

            const steps = new Set<string>()
            return {
              sessionId,
              defaultModel,
              setModel,
              prompt: (text) =>
                Stream.unwrap(
                  Effect.gen(function* () {
                    const turn = yield* Effect.forkScoped(
                      Effect.gen(function* () {
                        timer = promptTimer(yield* Effect.tracer, yield* Effect.orDie(Effect.currentSpan))
                        const r = yield* call(() => agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] })).pipe(
                          Effect.onExit(() => Effect.suspend(() => (timer ? annotate(timer.finish()) : Effect.void))),
                          Effect.ensuring(Effect.sync(() => void (timer = undefined))),
                        )
                        // Token counts are an unstable ACP field; agents that send them put them on the prompt's answer.
                        yield* annotate({ stopReason: r.stopReason, ...tokens((r as { usage?: unknown }).usage) })
                        if (r.stopReason !== 'end_turn') return yield* new AgentError({ message: `${account.name} stopped: ${r.stopReason}` })
                      }).pipe(measure('agent.prompt', { promptBytes: Buffer.byteLength(text) }), Effect.ensuring(Queue.offer(updates, 'stop'))),
                    )
                    return Stream.fromQueue(updates).pipe(
                      Stream.takeWhile((u): u is acp.SessionNotification => u !== 'stop'),
                      Stream.map((u) => toUpdate(u.update, steps)),
                      Stream.filter((u): u is AcpUpdate => u !== undefined),
                      Stream.concat(Stream.fromEffect(Fiber.join(turn)).pipe(Stream.drain)),
                    )
                  }),
                ),
            } satisfies AcpSession
          }),
      }),
    )

  static readonly layer = Acp.layerWith(spawnAgent)
}

