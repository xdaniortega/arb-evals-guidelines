# Review guide

This repo holds the Arbitrum evals guidelines and runner, extracted from `arbitrum-agent-skills` (branch `feat/evals`, source HEAD `65a761f`). It has no shared history with the source. The first four feature commits below replay the source stages (`evals/` tree and the skills under test only). The last commit syncs the repo to the final state and adds standalone scaffolding.

Run `git log --oneline` here. Each replay commit body names the original hash.

| # | Replay commit subject | Original hash | Stage |
|---|---|---|---|
| 1 | feat(evals): add isolated paired evaluation infrastructure | `089b45f` | Foundation |
| 2 | feat(evals): support unlimited budgets and harden measured runs | `2356ffe` | Hardening |
| 3 | feat(evals): simplified rubric v0.2, outcome (80) and constraints (20) | `6985abf` | Scoring |
| 4 | feat(evals): publish mean-of-pairs to EVALS.md and commit run evidence | `23bed3b` | Results and publication |

Replay commits are snapshots of each stage's tree, so they do not include the intermediate source commits (`878387b`, `6d28efd`, `ca40669`, `9d191fb` and others) or later fixes. Use the final sync commit for the authoritative state.

## Layout change (flat layout)

The history below describes the original tree. At HEAD the layout is flat and the skills moved out:

| Before | After |
|---|---|
| `evals/{container,scripts,src,tsconfig.json,.env.example,AGENTS.md}` | same names at the repository root |
| `evals/cases/<case-id>/` (including `runs/`) | `eval-cases/<skill>/<case-id>/` |
| `skills/arbitrum-docs`, `skills/arbitrum-network` | `arbitrum-skill-evals/skills/...` (git submodule) |
| `skills/arbitrum-onchain` (test path fixture) | `src/test-fixtures/skills/plain-skill/` (synthetic) |

Commits: pure `git mv` (renames show as `R100`; the tree is broken at that commit), path fixes, guest runtime relock, skills removal, docs. Sealed run evidence moved byte-for-byte. The relock changes the image digest, so new receipts carry a different image digest from the September runs.

## 1. Foundation (`089b45f`)
Paired-arm design (baseline vs treatment), core types and experiment definition, runner, artifact store and sealing, sandboxes (fake and Apple container), the Pi harness, and the secret scan.
What to check:
- `evals/src/core/`: types and experiment definition; are the two arms really symmetric?
- `evals/src/runner/`: run orchestration and preflight.
- `evals/src/artifacts/store.ts`: sealing and hash chain.
- `evals/container/`: isolation of the guest, image lock.
- `evals/src/core/secret-scan.ts`: coverage of key patterns.

## 2. Hardening (`2356ffe`)
Unlimited budgets, measured-run robustness, cancellation and cleanup, MCP/tool parity between arms.
What to check:
- Budget handling in `evals/src/runner/` and the harness adapter.
- Cancellation settles before cleanup is verified.
- Both arms see the same tools apart from the skill under test.

## 3. Scoring (`6985abf`)
Rubric v0.2: outcome (80) and constraints (20). It supersedes rubric v1.
What to check:
- Rubric engine and `evals/cases/network-config-01/rubric.json`.
- `validator.ts` and its tests: can a wrong answer score well?
- Rubric is frozen at seal time.

## 4. Results and publication (`23bed3b`)
Mean-of-pairs publication into `skills/*/EVALS.md` and committed evidence for two runs.
What to check:
- `evals/src/artifacts/publish.ts`: fail-closed destination checks, bounded marker block.
- `skills/arbitrum-docs/EVALS.md` and `skills/arbitrum-network/EVALS.md`.
- Evidence runs `20260924T151721Z-bfb34c20` and `20260924T170734Z-b115674e`: `pnpm eval:report --receipt eval-cases/arbitrum-docs/network-config-01/runs/<run>/receipt.json`.

## Final sync and scaffolding
- `package.json`, `vitest.config.ts`, CI, `.gitignore`.
- `skills/arbitrum-onchain/` is included only because a runner test uses it as a path fixture.
- `evals/docs/` (local-only contract) is intentionally not included.

## Not carried over (discarded by decision)
- `fix/generate-eval-guest-runtime` (`c7fc82d`): on-demand guest runtime build.
- `evals/docs/` (`ARCHITECTURE.md`, open items): stays local-only.
- `fee-estimation-01` case (`eval/fee-estimation`).
- `evals/README.md` moved to the root `README.md`; the logo and score SVGs under `evals/assets/` were removed.

## Verification run on the final state
`pnpm typecheck`, `pnpm test:evals`, `pnpm test:eval-cases`, `node scripts/build-guest-runtime.mjs --check`, `pnpm eval:validate`. `pnpm test:container` is opt-in and needs macOS Apple Container, so it was not run.
