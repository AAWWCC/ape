# Runtime limits

APE uses limits for resource containment, finite recovery, authenticated authority,
transport, and presentation. A useful mechanism does not establish that its exact
number is optimal. The September 2026 audit traced producers and consumers,
reproduced boundary failures, and exercised the revised contracts. It did not
measure model quality, certify live host capacity, or run paid evaluations.

The tables cover the runtime, persistence, diagnostics, admission, host adapters,
and repository tooling families. Repeated constants and schemas are one contract,
not separate independent restrictions. Test fixture sizes and enum cardinalities
are not product capacity limits.

## Artifact and capability decisions

| Family | Current behavior and reason |
| --- | --- |
| Planning complexity 48 and input 8 KiB | **Advisory.** These are heuristic decomposition signals. Neither proves that an authorized task is impossible. |
| Plan artifact | **Changed:** new runs use the existing 64 KiB artifact envelope. The separate 16 KiB plan cap and 500-character prose, 32-requirement, 16-workstream/path/list caps are retired for new contracts. Complete plans still require valid references, coverage, canonical in-scope paths and exact admitted commands. |
| Illustrative planning template | **Advisory when oversized.** Placeholder text and all-to-all references are not a lower bound on a complete plan. Scope is never shortened to force a template to fit. |
| Preflight artifact and answers | **Changed:** detail, the operator audit reason and collections use the 64 KiB artifact/control envelope and shared structural guards. The former 2,000-character detail and 32-question limits no longer independently reject new artifacts. Answers must match the complete exact question set and authoritative artifact hash before any writer starts. The complete sanitized reason remains in the run's audit; the override log and response echo retain 400-character projections. |
| Receipt ingress | **Changed:** 128 KiB for the complete receipt, including an artifact, observations and identity. Recovery accepts the same receipt plus a separate 64 KiB control envelope; durable task requests allow 192 KiB. Validation and recording use the same contract. |
| Receipt prose and collections | **Changed:** new-ticket tests, findings, paths, assurances, contradiction detail and roadmap followups use the shared receipt/structural allowance instead of separate small editorial caps; roadmap followups retain their 64 KiB aggregate registration allowance. Finding line numbers use positive safe integers. IDs, role membership, control-character restrictions, evidence provenance and command authority remain checked. |
| Shared JSON guards | **Retained resource policy:** ordinary input 64 KiB, nesting depth 32, 10,000 values, arrays and objects 2,048 entries. Byte, depth, node and collection checks apply together. Prototype keys, unsupported values and non-finite numbers are rejected. These values bound validation work; they are not measured model capacity. |
| Capability catalogs | **Changed:** source catalogs and expanded command/profile collections use the shared 2,048-item guard. The actual serialized manifest must fit 256 KiB. Alias expansion reports the resource bound it exceeds and stops further expansion. A valid source catalog does not guarantee its expanded manifest fits. |
| Additive test-path recovery | **Changed:** new growth contract v2 checks canonical unique paths, the shared item guard, actual derived commands (8,192 characters) and actual complete manifests (256 KiB) across reachable roles. The independent 64-path/4-KiB allowance is retired for new runs. No hypothetical worst-case command is charged as actual work. |
| Verification profiles | **Changed:** collection/detail bounds use shared resources. Positive integer timeouts use the common Node timer domain. Shell-free argv, canonical roots, unique profile identity and exact assignments remain mandatory. |
| Roadmap operations | **Changed:** batches, dependencies, replacements and prose use the existing 64 KiB input and structural guards. The former 64-entry, 32-edge, 200/4,000/2,000-character editorial caps are removed. IDs remain 128 characters; graph cycles, duplicate edges, missing dependencies and invalid provenance still reject atomically. |
| Historical contracts | **Preserved:** already-issued plan/receipt schemas and version-1 capability growth keep their original budgets and hashes. Readers accept the supported old and new representations; a new default does not rewrite an old ticket. |

UTF-8 bytes, UTF-16 string lengths and item counts are different units. The full
serialized allowance is shared by every field; individual maxima cannot all be
used at once. Schema acceptance is not proof of a good plan or correct product.

## Execution decisions

Execution settings are configurable operating policies, frozen at new-run START.
Ticket/dispatch receipt limits are also bound to immutable authority. Changing
project configuration affects subsequent runs. Legacy runs keep their supported
fallback semantics. See the generated [configuration reference](configuration.md).

| Policy | Default and disposition |
| --- | --- |
| Product stage attempts | **Configurable:** 2, including the initial attempt. |
| Directed replans | **Configurable:** 2 additional planner attempts. |
| Protocol redispatches | **Configurable:** 1 per ordinary stage. |
| Remediation cycles | **Configurable:** 3; the former upper bound of 10 is removed. |
| Re-gates | **Configurable:** 3. |
| Physical workers per ticket | **Configurable:** 2. Replacement N requires exact predecessor retirement and preserves lineage accounting; recovery cannot reset the budget. |
| Validation submissions per worker | **Configurable:** 3. Exact successful replay remains idempotent. Exhaustion accounting does not loop once per configured submission. |
| Reconciliation attempts / protocol redispatches | **Configurable:** 1 / 0. The single nonrecursive contradiction-reconciliation chain remains an architectural constraint. |
| Fast lane production files | **Configurable:** 6. Normalized exact files are counted cumulatively across validated receipts; known broad production directory claims select full for behavioral work. This is routing policy, not a universal task size. |
| Stage/suite deadlines | **Configurable:** mechanical/debug/spike 15 minutes, fast 30, full 60. Worker replacement uses the same mode-aware resolver. Zero or negative configured stage deadlines intentionally expire immediately. |
| Gate watch | **Configurable:** heartbeat 5 seconds, stale age 30 seconds, total spawns 2, inline grace 300 seconds, advisory poll delay 5 seconds. A verified live owner is stronger evidence than heartbeat age alone. |
| Remote check registration | **Configurable:** 120-second registration window and 10-second retry advice. A pending CI check has no new global elapsed-run cutoff. |

Attempt/worker/submission counts require positive safe integers. Optional recovery
counts accept zero. Combined counters must fit safe-integer arithmetic before
forecasts or allocation. Timer settings reject fractions and values outside their
supported domains; the maximum is 2,147,483,647 ms. These checks prevent silent
numeric fallback and overflow into nearly immediate timers.
The representable delay boundary follows [Node's timer behavior](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args),
not measurements of how long useful work should take.

Strictly shrinking normalized blockers, serialized writers, the pipeline's two
independent review roles, lane escalation, one authoritative receipt, exact claims,
and immutable provenance remain structural protections. Raising a retry policy
cannot bypass them. Local archived runs show budget hits, but stopped runs cannot
reveal what another attempt would have achieved; that history does not establish
an optimal retry count.

Raising an execution setting does not enlarge state, artifact or journal budgets.
A run must satisfy all applicable contracts; a larger attempt allowance is not a
promise that every possible accumulated transcript fits in persistent state.

## Transport, inspection and process safeguards

| Family | Retained protection or correction |
| --- | --- |
| Wire and injected context | MCP responses: 48,000 framed bytes; receipt construction: 96 KiB; Codex injected context: 160 KiB; native prompt: 256 KiB; packaged common/role prompt files: 64 KiB each; session guidance: 4 KiB. Large schemas/plans use exact durable references with hashes. These are project transport policies, not model context-window claims. |
| Correction and review forwarding | All 20 bounded correction entries are rendered completely. Review forwarding retains 40 entries / 10,000 serialized JSON characters, with reserved omission notices; structured identity previews retain 16 with omission counts. Full source receipts remain authoritative. |
| Native binding | Fresh launch claim: 60 seconds within the ticket horizon; probe horizon: 5 minutes. Intent/probe files: 1 MiB; bootstrap candidate: 8 KiB; start diagnostics: 64 KiB and last 8 observations. Old independent 64-launch/million-generation cuts are removed; exact intent bytes and safe counters remain bounded. |
| Native identity | Claude model 256, Codex model 512, effort 64 characters; probes and production agree. Identity/path fields retain bounded grammar. Bearer entropy and digest/key widths describe cryptographic formats, not work allowances. Live host support still requires certification. |
| In-call waiting | NEXT waits at most 300 seconds per call with a 250 ms poll floor; inline polling uses the smaller of 200 ms and remaining grace. These prevent busy loops or indefinite synchronous calls, not continued work across calls. |
| Process output and shutdown | Suite collection retains 200,000 UTF-16 units plus at most one pipe chunk. SIGTERM grace 10 seconds and drain 5 seconds bound shutdown; owned-process freshness 30 seconds and lifetime slack 60 seconds protect identity. Per-GitHub command timeout is 120 seconds. Exact margins are operational choices. |
| Command rendering and hashing | Impacted command above 6,000 characters falls back to a full suite. Executables above the 8 MiB content-hash threshold use verified file metadata. These are fallbacks, not bans on large tasks or executables. |
| Repository admission | 2,048 changed paths and 64 MiB changed content with 64 KiB read chunks bound fingerprinting. These can reject legitimate larger changes; they are explicit local inspection budgets, not complexity estimates. |
| Prerequisite inspection | 2,048 commands, 256 actual inspections, 256 KiB per manifest / 4 MiB aggregate, 8 KiB headers, nesting depth 8, 2,048 directory entries, 64 returned blockers. Cached executable/manifest aliases no longer spend inspection budget repeatedly. Exhaustion refuses incomplete proof. |
| Baseline/workspace inspection | Retain bounded traversal: 64 ancestor/pattern levels, 2,048 work/entry queues, 256 workspace variants/directories, depth-8 script expansion; manifest budgets apply separately. Tree reads batch 64 paths with 128 KiB subprocess output. These bound static proof, not project nesting supported by every execution path. |
| Runner discovery | Depth 3 and 64 candidates limit automatic proposals. Explicit configuration supports the shared catalog allowance. Discovery is a bounded convenience scan and does not certify that no deeper runner exists. |
| Locks and ownership | Keep PID/file identity, leases, heartbeats, bounded acquisition and race recovery. Receipt/config defaults: 60/15/15 seconds stale/heartbeat/busy; native locks: 10/2.5/2; task locks: 30/5/5. Windows latency scaling has floor 6 and ceiling 8; acquisition churn 8 attempts and handback windows 1/1.5 seconds protect liveness. These margins are not universal filesystem guarantees. |
| Temporary cleanup | Age 300 seconds and at most 1,000 removals per sweep protect recent artifacts and bound deletion work. Directory enumeration and metadata inspection are not bounded by that removal count. |

The exact-command length is a representation policy, not a guarantee that every
shell and operating system can launch every accepted string. Quoting, expanded
environment and launcher choice matter; Windows documents different limits for
[CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
and [Cmd.exe](https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation).
Tooling timeouts that only send a termination signal are also not hard guarantees
of child exit; [Node documents this for synchronous child processes](https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options).

## Storage and observations

| Family | Current behavior and reason |
| --- | --- |
| State and diagnostic archive | **Aligned:** 8 MiB serialized JSON envelope and depth 34, derived from the ingress depth of 32 plus the two enclosing state levels. Wrapping a valid receipt or preflight artifact no longer makes it unreadable. The former nested 256-entry/4,096-object archive decoder no longer rejects supported larger records. Admission's complete 2,048-path evidence participates in the archived hash. Public diagnostic samples remain smaller. |
| History query and metrics | **Paged:** 1–256 records per page, default 256, with stable opaque cursors. Older records remain reachable. Wire shortening advances only over returned records. Filters bind the cursor; coverage describes the processed page, not all history. |
| Lineage explanation | Includes the readable requested immutable record even outside the newest 256 contextual runs (at most 257 selected primaries); truncation makes lineage coverage explicitly incomplete rather than falsely reporting the requested old record missing. |
| Metric counts and durations | **Corrected:** counts use safe integers; finite nonnegative durations preserve fractional milliseconds. No silent 1-billion clamp or 11.57-day duration ceiling. Missing or invalid observations remain unknown. Display cohorts retain the largest 16 and disclose omissions. |
| Retention | Keep newest 32 / compact 16 by default; caller-selected nonnegative safe-integer keep counts have no separate 10,000 ceiling. Public compaction allows at most 256 successful run compactions per action (manual default 64). Status is bounded at 32 KiB before reading; the first 16 failure details have total and omitted counts. Inventory scan bytes are reported honestly. |
| Retention I/O | Read batches 32, gzip level 6, extra candidate allowance 16. These are operational defaults. A mutation cap does not bound the complete inventory, every read, or lifetime disk use. |
| Durable task journals | Ordinary updates through generation 1,024; generation 1,025 permits cancellation/terminal and 1,026 terminal only. The reserved transitions prevent exhaustion from stranding work. Each generation is at most 8 MiB and the store has at most 4,096 task directories. |
| Task retention and payloads | TTL default 24 hours, accepted 60 seconds–7 days; suggested poll default 1 second, range 100 ms–60 seconds. Result 2 MiB, ordinary retained update/error data 128 KiB, individual input requests 64 KiB (up to 16), status text 2,048 and error message 8,192 characters. These bound protocol storage, not productive reasoning time. |
| Task GC | Default 100 / maximum 1,000 removals; audit files 64 KiB, retained 7 days or 4,096 records. Full inventory and chain verification can cost more than selected deletion work. No whole-store memory bound is implied by one file's maximum. |
| Tree attribution and status display | Attribution file 1 MiB, 128 recent tool observations and 2,048 unresolved paths retain a conservative fallback. Status timing samples newest 20 files; state, history and cache reads use the shared 8 MiB ceiling, dispatch observations 64 KiB, and final output 1,024 characters. Summary text and identity fields are presentation/decoder bounds, not authority or lifetime work limits. |
| Generic storage and imports | No universal byte/count cap exists on every filesystem operation or planning-document import. Caller contracts own those budgets. Windows atomic rename retries (10 with 10–100 ms backoff) address transient sharing failures; exact waits remain tuning choices. |

## Repository tooling and release evidence

| Family | Disposition |
| --- | --- |
| Prompt word targets | **Advisory:** `npm run prompts:budget`. Semantic contracts, scope safety, generated parity and behavioral regression checks remain gates. Word count is not token count. |
| Prompt evaluations | Classify and retain complete observed commands and error diagnostics under the existing 16 MiB provider-output envelope. The former 500-character action cut could hide an unsafe suffix before classification. Validate concurrency 1–6 and timeout 1,000–2,147,483,647 ms before provider work. Defaults remain concurrency 2 / 30 minutes. The fixed 52-case corpus is an integrity check, not a workload limit. |
| Benchmark acceptance | At least 20 observations and at least 90% passing, rounded up: 18/20, 19/21, 36/40. Cohort growth no longer weakens the criterion. This threshold is a declared acceptance policy, not a universal reliability standard. |
| Public files and archives | Keep the 5 MiB public-file policy; already oversized files fail before full reading/hashing. Ustar's 100-byte leaf, 155-byte prefix, octal widths and 512-byte blocks are encoding constraints. Supporting larger archive paths requires a different representation. |
| Live certification | Preserve exact candidate/host/provenance and first-attempt cohort identity. One first-pass observation per cohort is smoke evidence, not a statistically established reliability rate. Bounded ledgers (256 KiB), fixture snapshots (depth 32 / 10,000 entries / 64 MiB per file / 256 MiB total), probe budgets and host timeouts contain certification cost. |
| Test and CI operation | Developer workers 6, agent workers 3; test/hook timeouts 15/20 seconds; CI jobs typically 20–30 minutes. Documented contention and startup measurements support bounded concurrency, but values remain environment-specific. Shard timing estimates are advisory scheduling heuristics. |
| Tooling files and subprocesses | Benchmark/timing reports and locks have local size/lease bounds; Git identity checks allow 64 MiB output. Smoke commands usually allow 60 seconds, package installation 5 minutes, MCP startup 10 seconds. These trigger termination of slow verification; callers using only SIGTERM do not guarantee a hard return deadline when a child ignores that signal. |
| Hooks and metadata | Hook body 8 MiB and identity tokens 4,096 characters protect ingress. Lifecycle/canary/audio hook deadlines 30/10/5 seconds, discovery TTL 1 hour and progress heartbeat 10 seconds govern host integration and responsiveness. A host configuration value is not proof of current live host capacity. |
| Versions, identifiers and signatures | Preserve supported runtime/host versions, canonical names, digest widths, nonce entropy, exact enum semantics and immutable lineage. Version-number guards and bounded labels are format/decoder policies. They do not justify limits on plan quality or task scope. |

Boundary regressions prove consistency at the tested boundary. Retuning retained
operating defaults needs observations of limit hits, useful work refused, recovery
outcomes, latency and cost, while retaining failed attempts in the sample. No
claim here treats a round number as empirically optimal.
