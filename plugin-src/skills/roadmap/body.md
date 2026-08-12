# APE roadmap

Use only when the user explicitly requests roadmap work. The roadmap stores durable requirements;
its statuses are always derived by the runtime, never supplied by the caller.

- `status`: call `ape_history` with `action: "roadmap-status"`. Optional `status_filter` narrows
  returned entries without changing aggregate counts. `roadmap: null` means no roadmap exists.
- `register`: first draft cold-reader-complete entries and obtain explicit approval. Then call
  `roadmap-register` with a non-empty audit `reason` and at most 64 entries. Each entry needs `id`,
  `title`, `description`, and observable `acceptance`; `depends_on` and `discovered_by` are optional.
- `supersede`: only after explicit approval, call `roadmap-supersede` with selected IDs and a
  non-empty reason. Supersession marks entries stale; it does not rewrite history.

Never pass a `status` field. Registration is atomic. A proposed entry must describe a behavioral or
operator consequence if omitted; style notes and isolated documentation nits remain advisory rather
than becoming standalone requirements.

When a run discovers follow-up work, propose entries and ask for approval before registration. Use
the discovering run ID only as provenance returned by the runtime or supplied in current tool
state—never recover stale IDs from prose.
