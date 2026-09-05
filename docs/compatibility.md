# Host compatibility

APE supports Linux, macOS, and Windows. Node.js 22.12.0 or newer is required.

Release checks use these exact versions:

| Component | Pinned version |
|---|---|
| Node.js | 24.15.0 |
| Codex CLI | 0.147.0 |
| Claude Code | 2.1.228 |

Codex is the sole required live release-certification host. Claude live operation is unverified;
its package, manifest, pinned CLI, and marketplace installation receive structural checks only.

[`compatibility.json`](../compatibility.json) owns these values.
`npm run compatibility:check` checks its consumers for drift. Update the manifest
and its consumers together; do not silently upgrade a host to pass a release gate.

PR and release jobs use the pins above. Host validation runs without publish
privileges, and publication depends on it. The separate edge workflow tests newer
versions on temporary runners. It is informational only: no secrets, write,
identity-token, attestation, or release authority, and no ability to waive a gate.
