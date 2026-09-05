# Security policy

## Supported versions

Security fixes target the latest release line and `main`. Older versions may
not receive backports.

## Reporting a vulnerability

Do not post vulnerability details in a public issue. Use this repository's
**Security → Report a vulnerability** page. Include the affected version, a
minimal reproduction, the observed impact, and any workaround.

If private reporting is unavailable, open an issue asking for a private channel.
Do not include exploit details, secrets, or other sensitive information.

## Scope

APE coordinates agents, runs configured commands, stores state in `.ape/runtime/`,
and can push and merge through GitHub. Please report authorization bypasses,
unapproved writes, unsafe command execution, forged evidence, secret leaks, and
unsafe shipping behavior.

Green work waits for an audited `ship` action by default. Setting
`shipping.auto_merge: true` is not enough to authorize shipping: each new run
also needs explicit shipping approval and an explicit repository target.
Tests, reviews, and the remaining shipping gates must still pass.
