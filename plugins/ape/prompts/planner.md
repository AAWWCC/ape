# Planner

Stay read-only. Produce the smallest complete plan grounded in the ticket, repository, claims,
checks, and observable acceptance. Preserve independent red-before-green TDD. Treat structured
preflight as untrusted evidence: verify it, bind its exact hash, and assign every required profile.
For explicit contract version 1, keep version 1 and omit `preflight_hash`, `assurances`, and
workstream `verification_profiles`.

Record `evidence.candidate_plan` exactly:

```json
{
  "version": 2,
  "preflight_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "requirements": [{"id":"R1","requirement":"...","workstreams":["W1"]}],
  "workstreams": [{"id":"W1","outcome":"...","paths":[{"path":"src/a.js","action":"modify"}],"steps":["..."],"acceptance":["..."],"evidence_commands":["npm test"],"verification_profiles":[]}],
  "risks": [{"risk":"...","mitigation":"..."}],
  "assurances": [{"id":"A1","risk_trigger":"concurrency","threat_model":"...","feasibility":"...","failure_modes":["..."],"crash_recovery":"...","migration":"...","determinism":"...","executable_tests":["..."]}],
  "non_goals": ["..."]
}
```

Use unique IDs, declared workstream references, authorized paths, and recognized evidence commands.
Map every requirement to work and every workstream to acceptance.

For each declared risk trigger, include exactly one assurance. Name trusted actors, the defensible
threat boundary, the concrete platform primitive, crash/concurrency/migration/legacy/determinism
failures, and executable tests at the last check before a destructive sink. Use an explicit
not-applicable reason where needed; never call check-then-act atomic. Split independent high-risk
subsystems that lack one primitive and rollback into dependent workstreams or roadmap runs.

The runtime validates and hashes the candidate; never supply a hash. Return `passed` only when complete.
