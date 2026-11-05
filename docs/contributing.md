# Contributing

How to contribute code and documentation to Evals Guidelines.

Contributions to the Evals Guidelines code (runner, harnesses, sandboxes, scoring, reporting and documentation) are welcome. Open a PR against this repository with your proposed changes.

- Read [`AGENTS.md`](../AGENTS.md) first: it lists the guarantees that must not be weakened and which checks to run for each kind of change.
- Use Conventional Commits (for example `fix(evals): refuse export of ungraded pairs`).

To add a new eval case, see [How to submit your eval case](create-an-eval-case.md#how-to-submit-your-eval-case) instead.

## Project layout

```text
README.md  AGENTS.md                 # Human guide, agent guide
docs/                                # Human guides: how it works, running evals, create an eval case, contributing
package.json  pnpm-lock.yaml         # Scripts and dependencies
tsconfig.json  vitest.config.ts      # TypeScript and unit-test configuration
.env.example                         # Credential template; copy locally to .env
.github/workflows/ci.yml             # Lock check, typecheck, tests, offline case validation, export freshness
container/                           # Guest image, network setup, locked runtime and image lock
scripts/                             # Command-line entrypoints and the guest runtime build
src/
├── core/                            # Schemas, comparison rules, limits and redaction
├── runner/                          # Setup, case loading and paired-run orchestration
├── harnesses/                       # Agent execution through Pi or test doubles
├── sandboxes/                       # Container lifecycle and test doubles
├── artifacts/                       # Saved evidence, verification, reports and exports
└── test-fixtures/skills/            # Synthetic skills used only by tests
eval-cases/<case-id>/                # One folder per case (see docs/create-an-eval-case.md, Case layout)
```
