import * as acp from '@agentclientprotocol/sdk'
import { AgentError, type AgentAccount } from '@pr-review/domain'
import { Clock, Context, Effect, Exit, Fiber, Layer, Option, Queue, Schema, type Scope, Stream, type Tracer } from 'effect'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { safeGhCommand, safeGitCommand, words } from './gitOnly.ts'
import { directCommand, expandHome, loginPath } from './shellPath.ts'
import { annotate, elapsedMs, measure, type Meta, round, startSpan } from './Perf.ts'
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
// Only what a review uses: git through Bash, and skills with the files they name. claude.ai connectors stay off; the
// ticket session reads tickets, and an agent reading untrusted PR content gets no tools beyond read-only git.
const claudeOptions = (plugins: ReadonlyArray<string>) => ({
  claudeCode: {
    options: {
      settingSources: [],
      disallowedTools,
      tools: ['Bash', 'Skill', 'Read'],
      plugins: plugins.map((path) => ({ type: 'local', path, skipMcpDiscovery: true })),
      env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    },
  },
})
// The ticket session loads the user's own config so their tracker MCP servers are there; it never sees PR code, and can't read files or fetch URLs.
// Residual risk: tools the user auto-allows in that config are approved by Claude Code itself and never reach ticketPermission.
const ticketOptions = { claudeCode: { options: { settingSources: ['user'], disallowedTools: [...disallowedTools, 'Read', 'Glob', 'Grep', 'Bash'] } } }
const READ_ONLY_MODES = [/read.?only/i, /^ask$/i, /^plan$/i, /^default$/i, /manual/i]

const agentError = (e: unknown, output = '') =>
  new AgentError({ message: [e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String(e.message) : String(e), output.trim().split('\n').slice(-3).join(' ')].filter(Boolean).join(': ') })

const ShellInput = Schema.Struct({ command: Schema.String })
const SkillInput = Schema.Struct({ skill: Schema.String })
const ReadInput = Schema.Struct({ file_path: Schema.String })
/** The shell command a tool call runs, when it is one. */
const commandOf = (rawInput: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(ShellInput)(rawInput))?.command

const ClaudeCodeMeta = Schema.Struct({ claudeCode: Schema.Struct({ toolName: Schema.String }) })
const Count = Schema.optionalKey(Schema.NullOr(Schema.Number))
/** ACP's unstable `Usage`; agents that send it put it on the prompt's answer. */
const PromptUsage = Schema.Struct({
  usage: Schema.Struct({
    totalTokens: Schema.Number,
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    thoughtTokens: Count,
    cachedReadTokens: Count,
    cachedWriteTokens: Count,
  }),
})

/** Answer text, and each shell command once as a step for the loading line. */
const toUpdate = (u: acp.SessionUpdate, seen: Set<string>): AcpUpdate | undefined => {
  if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') return { _tag: 'Text', delta: u.content.text }
  if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return undefined
  const command = commandOf(u.rawInput)
  if (command === undefined || seen.has(u.toolCallId)) return undefined
  seen.add(u.toolCallId)
  return { _tag: 'Step', step: describeTool('Bash', { command }) }
}

/** What a tool call is, without its arguments: the agent's tool name and kind, and for git or gh the subcommand. */
const toolMeta = (u: acp.ToolCall | acp.ToolCallUpdate): Meta => {
  const command = commandOf(u.rawInput)
  const w = command === undefined ? undefined : words(command)
  const shell = w?.[0] === 'git' || w?.[0] === 'gh' ? w : undefined
  return {
    tool: Option.getOrUndefined(Schema.decodeUnknownOption(ClaudeCodeMeta)(u._meta))?.claudeCode.toolName,
    toolKind: u.kind ?? undefined,
    command: shell?.[0],
    subcommand: shell?.[1],
  }
}

const tokens = (response: unknown): Meta => {
  const usage = Option.getOrUndefined(Schema.decodeUnknownOption(PromptUsage)(response))?.usage
  if (!usage) return {}
  const { totalTokens, inputTokens, outputTokens, thoughtTokens, cachedReadTokens, cachedWriteTokens } = usage
  return { totalTokens, inputTokens, outputTokens, thoughtTokens: thoughtTokens ?? undefined, cachedReadTokens: cachedReadTokens ?? undefined, cachedWriteTokens: cachedWriteTokens ?? undefined }
}

/**
 * Times one prompt from the agent's updates: when it first did anything, first wrote, and each tool call from its
 * announcement to its last status, as an `agent.tool` span under `parent`. Time no tool covered is unclassified:
 * the model, the agent's own work and the protocol can't be told apart from here.
 */
const promptTimer = (clock: Clock.Clock, tracer: Tracer.Tracer, parent: Tracer.AnySpan) => {
  const now = () => clock.currentTimeNanosUnsafe()
  const t0 = now()
  const since = () => elapsedMs(t0, now())
  const tools = new Map<string, { span: Tracer.Span; start: number; end?: number }>()
  const m: Record<'updates' | 'textChunks' | 'thoughtChunks' | 'rejectedTools', number> &
    Partial<Record<'firstActivityMs' | 'firstTextMs' | 'firstThoughtMs' | 'firstToolMs' | 'contextTokens' | 'contextWindow' | 'cost', number>> = {
    updates: 0,
    textChunks: 0,
    thoughtChunks: 0,
    rejectedTools: 0,
  }
  const first = (k: 'firstActivityMs' | 'firstTextMs' | 'firstThoughtMs' | 'firstToolMs') => void (m[k] ??= since())
  let running = 0
  let lastEnd: number | undefined
  let maxGap = 0
  const end = (id: string, exit: Exit.Exit<unknown, unknown>) => {
    const t = tools.get(id)
    if (!t || t.end !== undefined) return
    t.end = lastEnd = since()
    running--
    t.span.end(now(), exit)
  }
  const tool = (u: acp.ToolCall | acp.ToolCallUpdate) => {
    let t = tools.get(u.toolCallId)
    if (!t) {
      const at = since()
      if (running === 0 && lastEnd !== undefined) maxGap = Math.max(maxGap, at - lastEnd)
      first('firstToolMs')
      running++
      const span = startSpan(tracer, parent, now(), 'agent.tool', { sincePreviousToolMs: lastEnd === undefined ? undefined : round(at - lastEnd) })
      tools.set(u.toolCallId, (t = { span, start: at }))
    }
    for (const [k, v] of Object.entries(toolMeta(u))) if (v !== undefined && !t.span.attributes.has(`perf.${k}`)) t.span.attribute(`perf.${k}`, v)
    if (u.status === 'completed') end(u.toolCallId, Exit.void)
    if (u.status === 'failed') end(u.toolCallId, Exit.fail({ _tag: 'ToolFailed' }))
  }
  return {
    update: (u: acp.SessionUpdate) => {
      m.updates++
      first('firstActivityMs')
      if (u.sessionUpdate === 'agent_message_chunk') (m.textChunks++, first('firstTextMs'))
      else if (u.sessionUpdate === 'agent_thought_chunk') (m.thoughtChunks++, first('firstThoughtMs'))
      else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') tool(u)
      else if (u.sessionUpdate === 'usage_update') {
        m.contextTokens = u.used
        m.contextWindow = u.size
        if (u.cost) m.cost = u.cost.amount
      }
    },
    permission: (id: string, allowed: boolean) => {
      if (!allowed) m.rejectedTools++
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

const direct = new Map<string, Promise<string>>()

/** Starts `account.command` through the shell, on the user's own PATH. Keys that would bill an API instead of the login are left out. */
export const spawnAgent: Launch = (account, cwd) =>
  Effect.gen(function* () {
    const PATH = (yield* Effect.promise(loginPath)) ?? process.env.PATH
    const env: NodeJS.ProcessEnv = { ...process.env, PATH, ...Object.fromEntries(Object.entries(account.env).map(([k, v]) => [k, expandHome(v)])) }
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) if (!(key in account.env)) delete env[key]
    const key = `${PATH}\n${account.command}`
    if (!direct.has(key)) direct.set(key, directCommand(account.command, env))
    const command = yield* Effect.promise(() => direct.get(key)!)
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => spawn(command, { shell: true, cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })),
      (c) => Effect.sync(() => void c.kill()),
    )
    let output = ''
    child.stderr.on('data', (d: Buffer) => (output = (output + d.toString()).slice(-4000)))
    child.on('error', (e) => (output += `\n${e.message}`))
    const target = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
    return { target, output: () => output }
  })

export class Acp extends Context.Service<Acp, { open(account: AgentAccount, cwd: string, resume?: string, o?: { related?: ReadonlyArray<string>; tickets?: boolean; /** A `thought_level` value, set when the agent offers it. */ effort?: string | undefined; /** Skill-only plugin folders, and the files a Read may open. */ plugins?: ReadonlyArray<string>; readable?: (path: string) => boolean }): Effect.Effect<AcpSession, AgentError, Scope.Scope> }>()(
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
                const tool = ctx.params.toolCall
                const command = commandOf(tool.rawInput)
                const raw = tool.rawInput
                // Non-MCP requests carry no tool name; the adapter's kind and title for each tool stand in for it.
                const allowed = o?.tickets
                  ? ticketPermission(tool)
                  : (tool.kind === 'execute' && command !== undefined && (safeGitCommand(command) || safeGhCommand(command, o?.related ?? []))) ||
                    (tool.kind === 'other' && tool.title?.startsWith('Load skill') === true && Schema.is(SkillInput)(raw)) ||
                    (tool.kind === 'read' && tool.title?.startsWith('Read ') === true && Schema.is(ReadInput)(raw) && o?.readable?.(raw.file_path) === true)
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
            const _meta = o?.tickets ? ticketOptions : claudeOptions(o?.plugins ?? [])
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
            // Pinned for the session: a later model switch keeps it.
            const thought = options?.find((c): c is acp.SessionConfigOption & { type: 'select' } => c.category === 'thought_level' && c.type === 'select')
            const levels = thought?.options.flatMap((x) => ('options' in x ? x.options : [x])).map((x) => x.value) ?? []
            if (thought && o?.effort && o.effort !== thought.currentValue && levels.includes(o.effort))
              yield* call(() => agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: thought.id, value: o.effort! })).pipe(measure('acp.setEffort'))

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
                        timer = promptTimer(yield* Clock.Clock, yield* Effect.tracer, yield* Effect.orDie(Effect.currentSpan))
                        const r = yield* call(() => agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] })).pipe(
                          Effect.onExit(() => Effect.suspend(() => (timer ? annotate(timer.finish()) : Effect.void))),
                          Effect.ensuring(Effect.sync(() => void (timer = undefined))),
                        )
                        yield* annotate({ stopReason: r.stopReason, ...tokens(r) })
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

