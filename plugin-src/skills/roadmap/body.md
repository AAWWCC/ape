# APE roadmap

Use only when the user explicitly requests roadmap work. The roadmap stores durable requirements;
its statuses are always derived by the runtime, never supplied by the caller.
On Google Antigravity / Gemini, pass the exact open project root as `project_dir`.

- `status`: call `ape_history` with `action: "roadmap-status"`. Optional `status_filter` narrows
  returned entries without changing aggregate counts. `roadmap: null` means no roadmap exists.
- `register`: first draft cold-reader-complete entries and obtain explicit approval. Then call
  `roadmap-register` with a non-empty audit `reason` and at most 64 entries. Each entry needs `id`,
  `title`, `description`, and observable `acceptance`; `depends_on` and `discovered_by` are optional.
  Same-batch forward references are allowed. Unknown or stale dependencies, duplicate edges,
  self-reference, cycles, or an otherwise-invalid live graph reject the entire batch.
- `supersede`: only after explicit approval, call `roadmap-supersede` with selected IDs and a
  non-empty reason. Targets and optional replacements must be unique, known, live, and disjoint.
  Supersession marks entries stale; it does not rewrite history.
- `attest`: close live requirements against an archived completed run or the exact verified
  produce-and-hold shape (`blocked` at `merge`, gates passed, canonical auto-merge-disabled reason).
  Call `roadmap-attest` with `requirement_ids`, `run_id`, and a non-empty audit `reason`;
  requirements must be known and live. No other blocked shape is eligible, and a hold does not
  satisfy from `completes` alone. Use when work was merged outside APE, a run completed before the
  roadmap existed, or fully gated work awaits shipping by policy.

Never pass a `status` field. Registration is atomic. A proposed entry must describe a behavioral or
operator consequence if omitted; style notes and isolated documentation nits remain advisory rather
than becoming standalone requirements.

When a run discovers follow-up work, declare normalized proposals in the accepted receipt's
`evidence.roadmap_followups` array, without `status` or `discovered_by`, then ask for approval before
registration. Receipt acceptance does not register anything. Use the discovering run ID only when
that active or archived run contains an accepted receipt with the exact declaration; the runtime
rejects nonexistent runs and payload mismatches.

Roadmap mutations are journaled and exact-once. A divergent journal/store state is a hard refusal,
not permission to retry with changed input. A run targeting a roadmap entry starts and completes
only while every dependency is `satisfied`; stale targets and all other dependency states block.
