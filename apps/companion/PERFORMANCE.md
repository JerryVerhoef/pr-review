# Performance data

The companion records where review time goes in `~/.cache/pr-review/performance.jsonl`, one JSON event per measured phase. `usage.jsonl` is unchanged. It still has one line per agent turn, and it only covers the turn itself: no slot wait, git, GitHub, context preparation or citation checks. The performance log covers all of those.

## Collecting

There is nothing to switch on. The host writes events while it runs reviews. To get useful numbers, review a spread of PRs (small, large, stacked) as you normally would, then summarize:

```sh
pr-review perf                      # everything in the log
pr-review perf --since 7d --top 20  # last week, 20 slowest operations
node apps/companion/src/main.ts perf --file /path/to/performance.jsonl   # from source, another log
```

How writing works:

- Events go on a bounded queue that a background fiber appends to the file in batches. Nothing in a review waits on the disk, and what is queued when the companion stops is still written.
- At most 2,000 lines wait to be written; anything more is dropped.
- When the file passes 20 MB it is moved to `performance.jsonl.1`, replacing the previous one. Disk use stays under about 40 MB.
- A failed write drops that batch. Logging can never fail or slow a review, and the tests cover this.

## What is in an event

```json
{"timestamp":"…","operationId":"71d4…","spanId":"6229…","parentId":"71d4…","offsetMs":8.9,"kind":"review","phase":"context.prepare",
 "owner":"o","repo":"r","prNumber":7,"headSha":"…","durationMs":1,"status":"success","metadata":{"files":1,"diffBytes":8,"promptBytes":6214}}
```

| Field | Meaning |
| --- | --- |
| `operationId` | The outermost measured span this event ran under. Everything from one review (or one stack walk) shares it. |
| `spanId` / `parentId` | This event, and the nearest measured span it ran inside. Concurrent work has distinct `spanId`s under the same parent. |
| `offsetMs` | Start time in ms after the operation started, so overlapping (parallel) phases can be laid out. |
| `kind` | The nearest operation or agent turn kind: `review`, `sort`, `opinion`, `deeper`, `overview`, `stack-opinion`, `architecture`, `stack`, `ask`, `chat`, `ticket`, `rule`. `other` is work outside any of them, like a page load's `GetPr`. |
| `owner`, `repo`, `prNumber`, `headSha`, `agent`, `model` | Taken from the nearest enclosing span that has them. Left out when unknown. |
| `durationMs` | The span's own start and end from Effect's `Clock` (high-resolution, monotonic between re-anchors to the wall clock). |
| `status` | `success`, `error` (with `metadata.errorTag`, the error's type and never its message) or `cancelled` (interrupted). |

Only short tokens get logged: numbers, booleans, and strings of up to 80 characters with no whitespace or slashes. Prompts, diffs, file contents, agent answers, paths, URLs, command lines, environment variables and error messages are never written. The tests check this.

## Phases

| Phase | Where | Metadata |
| --- | --- | --- |
| `operation` | A whole review (`Reviewer`), sort run, opinion run, overview, stack opinion, architecture map, stack walk | `concurrentOperations` (operations running at its start, nested ones included). A review adds `sortCached`, `opinionCached`, `sortJoined`, `quick`, `reviewLines`, `files`, `decisions`, `highDecisions`, `streamed` (decisions queued for judging while the sort was still writing), `sideSessions` (judging sessions started on free slots), `slowTicket` (the ticket is checked in a turn of its own), `retried` (decisions retried after a failed turn), `specRetried`, `since` (sorted from the previous push's sort), `carried` (decisions that kept their opinion from it). |
| `git.clone` | First use of a repo | |
| `git.fetch` | `fetchPr`: ensuring the clone, refs, fetching when needed, merge base. In-memory hits aren't logged. | `network` (false = head already local) |
| `git.numstat`, `git.diff`, `git.show`, `git.lsTree` | Each git call | `files`, `additions`, `deletions` / `bytes`, `paths` / `entries` |
| `github.request` | Each GitHub API request (cache misses only) | `op` (`getPr`, `listOpenPrs`, `getChecks`, `getIssue`, `fileAt`…) |
| `ticket.lookup` | The ticket summary, including its agent turn if one runs | `refs`, `githubIssues`, `otherRefs`, `found` |
| `context.prepare` | Sort prompt (`Sorter.prepare`), opinion context (`Opiner.context`), stack opinion context | `files`, `additions`, `deletions`, `diffBytes`, `diffInlined`, `promptBytes`, `stackSize`, `guidanceFiles`, `ticket`… |
| `context.prompt` | One opinion prompt for a group of decisions | `decisions`, `continued`, `diffBytes`, `promptBytes` |
| `context.wait` | A review waiting on the ticket or opinion context it forked earlier | `on` |
| `sort.join` | Waiting on a sort of the same head that another caller started | |
| `sort.since` | Comparing a new head with the last reviewed one, change by change | `changedFiles`, `interdiffLines` |
| `agent.acquire` | Waiting for a free account slot | `account`, `waited`, `busySlots`, `slots`, `tickets` |
| `agent.turn` | One agent turn: what `usage.jsonl` times, plus `ask`/`chat` streams | `account`, `modelChoice` (`fast`/`main`), `schemaRetry`, `timedOut` |
| `agent.spawn` | Starting the agent process | |
| `acp.initialize` | ACP `initialize`: the process's first answer | `protocolVersion` |
| `acp.session` | `session/new`, `resume` or `load`, with a login retry | `method`, `authenticated` |
| `acp.setMode`, `acp.setModel`, `acp.setEffort` | Session configuration | |
| `agent.prompt` | One ACP prompt: request sent, answer received | See below |
| `agent.tool` | One tool call, from the agent announcing it to its final status | `tool`, `toolKind`, `command`/`subcommand` (git or gh only, e.g. `git` `show`), `permission`, `sincePreviousToolMs` |
| `agent.response` | `decode`: parsing and validating the JSON answer. `finish`: anchors and citation checks. | `responseBytes` / `findings`, `citations` |
| `cache.read` | Persisted cache reads and `PersistedCache` gets | `store`, `hit` |
| `cache.write` | Saving a result made elsewhere (`remember`) | `store` |

`agent.prompt` metadata: `promptBytes`, `toolCalls`, `toolMs` (wall time with at least one tool running), `toolCallMsSum` (sum over calls, higher when they overlap), `unclassifiedMs`, `maxToolGapMs`, `firstActivityMs`, `firstThoughtMs`, `firstToolMs`, `firstTextMs`, `updates`, `textChunks`, `thoughtChunks`, `rejectedTools`, `stopReason`, and when the agent reports them `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`, `thoughtTokens`, `totalTokens`, `contextTokens`, `contextWindow`, `cost`.

## Reading the summary

- **Operations / Agent turns.** Count, errors, cancellations, avg, p50, p95 and max per kind. The agent-turn table can be compared directly with your `usage.jsonl` numbers.
- **Phases, by own time.** Own time is a phase's duration minus the union of the measured phases directly inside it. Own times can be added up without double counting. Wall totals of nested phases overlap and can't. Parallel work counts once per fiber, so the own total can exceed elapsed time. A large own time on `operation` means time the instrumentation doesn't break down further (CPU work, cheap steps not measured).
- **Agent prompts.** Prompt time split into tool time and unclassified time, per kind. Unclassified is everything with no tool running: model inference, the agent's own processing, protocol overhead and waits on the provider. These can't be separated from here, so don't read it as "model time". `first activity` is how long the agent took to send anything. `first text` is when the answer started.
- **Tool calls.** Grouped by tool and git/gh subcommand, with total, avg, p95, max, failures and rejections. Rejected calls are commands the git-only gate refused, which costs the agent a round trip.
- **Cache reads.** Hit rate per store. For a `PersistedCache` get, `hit` means that get didn't run the work: it was stored, in memory, or joined a run already going.
- **Slowest operations.** Each one with its top phases by own time inside it.
- **Workload vs duration.** Pearson r between each operation's duration and its files, lines changed, diff bytes, prompt bytes, tool calls and tokens. Shown per kind once there are 5 or more operations. Treat it as a hint. With few runs, one outlier dominates.

For anything else, `jq` works on the log directly:

```sh
# Each review of PR 3238, phase by phase
jq -c 'select(.prNumber==3238) | [.offsetMs,.durationMs,.phase,.kind,.metadata]' ~/.cache/pr-review/performance.jsonl
# Slowest git subcommands the agent ran
jq -c 'select(.phase=="agent.tool" and .metadata.command=="git") | [.metadata.subcommand,.durationMs]' ~/.cache/pr-review/performance.jsonl | sort -t, -k2 -n | tail
```

## What is measured, inferred, or missing

Measured directly:
- Every phase in the table above.
- How long the account slot wait takes.
- The ACP handshake steps.
- Prompt round trips.
- Tool calls, from the agent's own notifications.
- Cache hits.
- Token counts and context size, when the agent reports them. Claude's ACP adapter does; it sends `usage` on the prompt answer and `usage_update` notifications.

Inferred:
- **Tool duration** runs from the agent announcing a call to it reporting a final status. It includes the permission round trip, and may include some of the agent's own bookkeeping.
- **Process startup** can't be separated from `acp.initialize`. `agent.spawn` only covers starting the process, so `npx` resolving the package and the agent booting show up in `acp.initialize`.
- **Unclassified time** in a prompt is the prompt duration minus tool time. It's whatever no tool covered. It isn't only model inference.

Not available:
- Model inference time on its own.
- Provider queueing or rate-limit waits inside a turn.
- Time to first token from the model, as distinct from the agent's first update.
- Per-tool time inside the agent before it announces a call.
- Token counts for agents that don't report them.
- `PersistedCache`'s own disk write after a miss. It's inside the `cache.read` span's own time.

Overhead: one span object per Effect span, with a few attribute writes and one JSON line per measured phase. Everything else the tracer sees (Effect.fn and RPC spans) is never written.
