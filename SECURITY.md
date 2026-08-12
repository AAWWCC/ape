# Security policy

## Supported versions

Security fixes are made on the latest release line and `main`. Older releases may not receive
backports.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability
reporting for this repository (the **Security** tab, then **Report a vulnerability**). Include the
affected version, a minimal reproduction, the impact you observed, and any suggested mitigation.

If private vulnerability reporting is unavailable, open a public issue that contains no exploit,
secret, or sensitive detail and ask the maintainer to establish a private reporting channel.

## Scope

APE coordinates coding agents, invokes configured test commands, writes machine state under
`.ape/runtime/`, and can interact with GitHub when shipping is requested. Reports about authorization
bypasses, unapproved writes, command execution, evidence forgery, secret disclosure, or unsafe
shipping behavior are especially valuable.

APE defaults to holding green work for an explicit audited `ship` action. Enabling
`shipping.auto_merge` grants the runtime permission to push, open or reuse a pull request, and merge
after its configured gates pass.
