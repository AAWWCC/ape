# Host compatibility

[`compatibility.json`](../compatibility.json) is APE's versioned, machine-readable compatibility
contract. Package metadata, documentation, pull-request CI, tagged-release validation,
marketplace smoke tests, and the public export are checked against it by
`npm run compatibility:check`.

The public Node.js minimum is 22.12.0. Blocking release validation uses Node.js 24.15.0,
Codex CLI 0.147.0, and Claude Code 2.1.228 exactly. Linux, macOS, and Windows are supported.

Pull-request and tagged-release jobs use the exact blocking pins. Registry-installed host CLIs run
only in unprivileged validation jobs, and the privileged publish job depends on successful host
validation. The separate edge workflow follows current versions on ephemeral runners. Edge results
are informational: they cannot satisfy or bypass a release gate and have no write, identity-token,
attestation, secret, publication, or release authority.

When compatibility changes, update the manifest and every consumer atomically. The deterministic
checker rejects partial migrations and stale literals before release work begins.
