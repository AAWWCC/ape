# Contributing to APE

APE is currently maintained and authored by AAWWCC. Bug reports, focused design discussions, and
feature proposals are welcome; unsolicited pull requests are not accepted unless the maintainer
has explicitly requested one in an issue.

## Before proposing a change

- Search existing issues and discussions to avoid duplicate work.
- Open an issue describing the problem, user-visible outcome, and evidence.
- Do not include secrets, private APE state, or licensed sound files.
- Wait for an explicit invitation before preparing a pull request.

## Local development

APE requires Node.js 22 or newer.

```bash
npm ci
npm run typecheck
npm test
npm run bundle
npm run validate
```

If a change affects the Claude schema integration, also run `npm run test:claude-schema`. If it
changes the committed MCP bundle, run `npm run bundle` and include the resulting `dist/` update.

## Invited pull requests

If the maintainer requests a pull request, keep it focused and describe the problem, chosen
approach, validation performed, and any remaining limitation. Behavioral changes need tests, and
all configured CI gates must pass. Repository write access, releases, and final project decisions
remain with AAWWCC.

## Security reports

Do not disclose vulnerabilities in an issue or pull request. Follow [SECURITY.md](SECURITY.md).
