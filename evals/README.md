# Skill Evaluations — Operator Guide

Developer-only paired-evaluation harness for agent skills. This subsystem is not part of the published `arb` CLI, MCP server, or npm package. Nothing here ships, and no published command, export, or dependency exists to serve it.

## 1. Quick start

The fastest path to running an evaluation:

### Measured run
Requires Apple-silicon macOS with Apple Container running, live provider/MCP access, and an API key in `evals/.env` ([template](.env.example)):

```bash
# Check environment readiness (sends no completion requests)
pnpm eval:doctor

# Run paired evaluation with paid provider requests
pnpm eval -- --case network-config-01 \
  --skill skills/arbitrum-docs \
  --model gemini-3.8-flash
```

New measured runs default to Pi, Apple Container, isolated validation, and thinking `low`. Each arm receives 5 minutes by default starting from its prompt.

## 2. Methodology

### What is measured

Skill evaluations answer one question:

> Does adding one agent skill actually make an agent better at one concrete task?

The answer comes from running the same task twice in fresh, disposable environments:

| Arm | Environment |
| --- | --- |
| **baseline** | A fresh guest with the agent runtime and **no** evaluated skill. |
| **treatment** | A **different** fresh guest, built from the **same image digest**, with the agent runtime plus **exactly one** frozen copy of the evaluated skill. |

Skill presence is the *only* permitted difference between arms. Before anything runs, a field-by-field parity check verifies that all other variables are identical:
- Prompt and fixture bytes
- Requested output path
- Oracle and deterministic validator
- Allowed tools
- Provider, exact model, and thinking level
- Resource limits and execution policies
- Network policy

If any configuration diverges, the run aborts before any guest is launched.

### Why bother

A skill is an assertion: "this text makes an agent better at a task." Vibes do not distinguish a skill that imparts real domain knowledge from one that merely sounds authoritative. A single demo proves nothing about the counterfactual—how the agent would have performed without the skill.

Paired baseline/treatment runs make performance claims falsifiable. However, an ineffective skill need not produce an observed delta of zero: sampling variance, model stochasticity, and dynamic web data can introduce noise even under frozen configurations. A single pair is an operational smoke test, not a statistically rigorous effect estimate.

### Guest isolation and network boundary

With `--sandbox apple-container`, each arm executes in an independent, disposable guest VM on Apple-silicon macOS:
- **Egress enforcement**: The guest entrypoint applies an `iptables` egress filter under root privilege, then irreversibly drops privilege (`noNewPrivs true`, `uid 10001`, `gid 10001`, no groups, empty capability sets) before running agent code.
- **CIDR filtering**: Explicit deny rules block private networks (RFC 1918), the host gateway, loopback, link-local addresses, cloud metadata (`169.254.169.254`), and sibling guest networks. Bounded outbound TCP on public ports is permitted.
- **Attestation**: Before agent execution begins, the guest writes an immutable `attestation.json` proving actual UID/GID status, capabilities, mount flags, DNS resolvers, and network probe outcomes (confirming blocked private routes and active public routes). The host verifies this attestation before delivering credentials.
- **Credential delivery**: API keys flow directly to the guest over an in-memory control channel only after attestation succeeds. Credentials are never passed via command-line arguments (`argv`), environment variables (`--env`), or files (`--env-file`), preventing leakage via container inspection tooling.

### Agent capabilities and secret redaction

Both arms receive the standard toolset: `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. Ambient tools (such as `glob`) and the generic `mcp` client extension are provided identically to both arms. Baseline starts with no configured MCP servers; only treatment receives the selected skill's declared server configuration. Either arm may connect to endpoints it discovers using the shared client.

Because agents have access to `bash`, an agent may inspect its environment and output its API key. Every guest output is scanned across five encodings:
- Raw
- JSON-escaped
- Percent-encoded
- Base64
- Base64url

Redactions are applied before artifacts are written or sealed, and recorded under `--view redactions`. The run remains gradeable so an incidental environment listing does not invalidate an evaluation. If redaction verification fails, the run is quarantined and sealed without promoting secrets into evidence.

### Subsystem layout

```text
evals/
├── README.md                # Operator guide (this document)
├── ARCHITECTURE.md          # Frozen contract: invariants and security model
├── .env.example             # Direct-provider credential template
├── tsconfig.json            # Eval-only typecheck configuration
├── src/
│   ├── core/                # Pure logic: schemas, parity, limits, hashing, redaction
│   ├── runner/              # Preflight, case loading, snapshotting, candidate projection
│   ├── harnesses/           # Prompt execution (Pi SDK harness and test doubles)
│   └── sandboxes/           # Guest lifecycle (Apple Container and test doubles)
├── scripts/                 # CLI entrypoints
└── cases/
    └── network-config-01/   # Canonical case
        ├── case.json        # Prompt, output path, and allowed tools
        ├── fixture/         # Initial starting workspace
        ├── oracle.json      # Ground-truth expected answers and sources
        ├── validator.ts     # Deterministic validator executed in isolated guest
        ├── validator.test.ts
        └── runs/            # Local, git-ignored run evidence
```

Read in this sequence: **[evals/README.md](README.md) for operation → [evals/ARCHITECTURE.md](ARCHITECTURE.md) for fixed invariants → target case files → sealed receipts.**

`evals/ARCHITECTURE.md` is the authoritative specification for all invariants.

## 3. Prerequisites

### Environment requirements
- Invoke all commands from the **repository root**.
- Node `>=22` and pnpm `10.33.2` (pinned in `package.json`).
- Measured runs require **Apple-silicon macOS** with Apple Container installed and `container system status` reporting `running`.
- Fake runs (`--mode fake`) use deterministic in-process doubles and require neither Apple Container nor provider credentials.

### Provider credentials

Credentials reside in git-ignored `evals/.env`. Copy `evals/.env.example` and supply the required key:

| Provider | Variable |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `google` | `GEMINI_API_KEY` |

Strict credential invariants:
1. **Credential presence never selects models or providers.** The exact model flag is required. Provider is inferred from an exact match in the model catalog (or asserted via `--provider`). Contradictory or uncataloged targets fail at preflight before credentials are read.
2. **No fallback.** No silent retries or model substitutions occur. A run either executes with the specified configuration or terminates immediately.
3. **Isolation boundary.** Keys are held only in memory and transferred to attested guests over an authenticated control channel. Host and guest secret scanners strip credentials before logs or evidence are sealed.

Use a dedicated, low-limit, revocable API key.

### Admitted model catalog

| Model identifier | Provider | Reference |
| --- | --- | --- |
| `gemini-3.8-flash` | `google` | [Google Gemini documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| `claude-opus-4-8` | `anthropic` | [Anthropic Claude documentation](https://platform.claude.com/docs/de/models/opus-4-8/overview) |
| `claude-opus-5` | `anthropic` | [Anthropic Claude documentation](https://platform.claude.com/docs/en/models/opus-5/whats-new-opus-5) |

Thinking support defaults to `low` and is validated per model.

### Execution modes

| Mode | Harness | Sandbox | Validator runner | Network & credentials |
| --- | --- | --- | --- | --- |
| `--mode fake` | `fake` | `fake` | `in-process` | In-process doubles, zero network egress, no credentials read |
| `--mode measured` | `pi` | `apple-container` | `isolated-container` | Apple Container VMs, bounded public egress, verified credentials |

Measured mode requires all three production components; test doubles are rejected at preflight.

## 4. Grading

### Workspace grading

Cases declare no candidate mode: every fresh run grades the **final agent workspace**, including new and nested files, within existing bounds; a fresh case requesting `file` is rejected at preflight, while `--from` keeps each retained run's recorded mode.

### Deterministic validation

Grading is decoupled from agent execution:
1. When an agent condition finishes, its final workspace is sanitized and captured.
2. The validator runs inside an isolated, network-less container (`isolated-container`) separate from the agent runtime.
3. The validator evaluates workspace artifacts against `oracle.json` and produces a deterministic numerical score in the range `[0.0, 1.0]`.

### Task failure vs infrastructure failure

The harness strictly distinguishes task failures from infrastructure failures:

- **Task outcome — gradeable.** The agent produces an incorrect, malformed, or missing answer, or exhausts its allocated task-level budget. This is a legitimate evaluation result and may score `0.0`.
- **Infrastructure outcome — not gradeable (`score: null`).** Provider API outages, container creation failures, networking timeouts, guest crashes, validator failures, cleanup errors, or secret quarantine events. These indicate an invalid measurement condition.

**The Delta Rule**: A baseline/treatment delta is **never** computed, reported, or aggregated unless **both** arms of the pair are gradeable. An infrastructure failure is never treated as a task failure (never scored zero), and a task failure is never dismissed as infrastructure.

### Validation commands

```bash
# Decode and validate suites and cases, verifying hashes and limit resolution
pnpm eval:validate
pnpm eval:validate -- --case network-config-01 --skill skills/arbitrum-docs

# Run case validator unit tests
pnpm test:eval-cases

# Run deterministic eval test suites
pnpm test:evals
pnpm test:eval-sdk

# Run container integration tests (requires Apple Container)
pnpm test:container
```

## 5. Metrics

### Runs and pairs

- A **run** is a single CLI invocation.
- A **pair** is one baseline/treatment repetition (`--repetitions N`).
- For each valid pair, score delta is treatment score minus baseline score.
- Aggregate delta is the arithmetic mean of deltas across all valid, gradeable pairs. Zero or negative deltas are valid measurements.

### Result table format

Upon run completion, the harness renders a standard nine-column summary:

```text
Case | Harness | Provider | Model | Baseline | Treatment | Delta | Tokens Δ | Time Δ
```

- **Delta**: Mean treatment score minus mean baseline score over valid pairs.
- **Tokens Δ & Time Δ**: Diagnostic measurements reflecting resource utilization differences (`n/a` if unavailable). These are diagnostic engineering metrics and do not represent monetary savings.
- `--details`: Adds individual per-pair scores to the output.
- `--format table|markdown|json`: Configures the output presentation (`pnpm --silent` produces raw parseable JSON).
- `--quiet`: Suppresses operational progress logs on stderr.

Official measured results are committed alongside evaluated skills once verified.

## 6. Inspection

### Sealed evidence structure

Runs seal an immutable cryptographic chain: **receipt → manifest → pair → condition → artifacts**. All evidence is stored locally under `evals/cases/<case-id>/runs/<run-id>/`:

```text
evals/cases/<case-id>/runs/<run-id>/
├── receipt.json                 # Chain root: references manifest SHA-256 hash
├── manifest.json                # SHA-256 digest map over all sorted evidence files
├── cleanup.json                 # Journaled container identities and destruction status
├── inputs/                      # Frozen invocation inputs: target, policy, case, skill snapshot
├── pairs/<pair-id>/
│   ├── pair.json                # Per-pair gradeability, arm scores, and computed delta
│   ├── baseline/                # Arm condition, attestation, session, redactions,
│   └── treatment/               #   workspace, candidate, validation, errors
├── views/                       # Derived visualizations (regenerable, outside sealed chain)
└── recovery/<id>/               # Sealed recovery audit records appended by eval:recover
```

Every inspection and reporting tool verifies the complete hash chain before outputting data. If any sealed file has been modified or corrupted, verification fails, identifies the mismatch, refuses to display scores, and exits with a non-zero status.

### Inspection commands

```bash
# Query latest run and pair identifiers for a case
pnpm eval:history -- --latest --case network-config-01

# Inspect the candidate output for the treatment arm
pnpm eval:inspect -- --latest --case network-config-01 \
  --condition treatment --view candidate

# Export native session JSONL and Pi HTML session transcripts
pnpm eval:inspect -- --latest --case network-config-01 \
  --condition treatment --view session --export both

# Re-render the verified report from a receipt file
pnpm eval:report -- --receipt evals/cases/network-config-01/runs/<run-id>/receipt.json --format table
```

Supported views for `--view`:
`condition`, `messages`, `tools`, `workspace`, `candidate`, `validation`, `errors`, `runtime`, `attestation`, `redactions`, `session`.

Use `--pair <pair-id>` to target a specific repetition.

### Resource recovery

If an evaluation is interrupted, residual guest containers or networks can be cleaned up without rerunning or regrading tasks:

```bash
pnpm eval:recover -- --run <run-id>
```

Recovery audits active resources, executes teardown, appends sealed recovery records into `recovery/`, and updates the cleanup ledger. If cancellation settlement cannot be confirmed in the bounded cleanup window, the run is recorded partial with `cleanup-failed` and `verified:false`; paid execution stops, and recovery later reconciles the exact identities without rerunning the task.

## 7. Reproduction

### Retained-input reproduction

Evaluations can be reproduced deterministically from retained run evidence using `--from`:

```bash
# Dry run: validates receipt, hashes, and inputs without launching guests
pnpm eval -- --from evals/cases/network-config-01/runs/<run-id>/receipt.json --dry-run

# Re-execute evaluation using retained inputs, limits, and image digest
pnpm eval -- --from evals/cases/network-config-01/runs/<run-id>/receipt.json --authorize-paid
```

Reproduction invariants:
- Retained inputs, limits, repetitions, image digests, and candidate modes are locked from the original receipt; configuration overrides are rejected.
- Retained fake runs execute in fake mode; paid execution requires the explicit `--authorize-paid` flag.

## 8. Recorded results

Per-skill measured results live next to the skill they describe, so a skill's evidence
travels with it and stays out of the agent-visible snapshot:

| Skill | Case | Result |
|---|---|---|
| [`skills/arbitrum-docs`](../skills/arbitrum-docs/EVALS.md) | `network-config-01` | baseline 0.111, treatment 0.778, delta +0.667 (one pair, `NOT PASS`) |

`NOT PASS` records operational acceptance, not skill quality: the treatment arm completed
and both arms were graded, but the baseline arm exhausted its output token budget instead
of finishing, and acceptance requires both arms to finish cleanly. One pair does not
establish statistical effectiveness. A skill-root `EVALS.md` is excluded from the
agent-visible snapshot; `SKILL.md`, which carries the label, is not.

## 9. Limitations

Read and understand these limitations before interpreting evaluation scores:

- **Models are stochastic**: Identical prompts and configurations produce different model completions across iterations.
- **A single pair is an operational smoke test**: One repetition validates that harness plumbing, sandboxing, and grading executed cleanly. It does not establish statistical significance.
- **Dynamic public web dependencies**: Both arms have access to bounded public internet egress; external network resources and documentation endpoints can change between runs.
- **Historical chain state retention varies**: Nitro node providers configure state history and pruning independently. The availability of archive state depends on node operator policy. A state verifiable at capture may not persist indefinitely.
- **Single runs are exploratory**: Substantial score deltas on small sample sizes should be treated as prompts for further testing rather than definitive conclusions.
- **Private model reasoning traces are not retained**: Internal model thinking and intermediate provider traces are not preserved or exported.
- **Skill bundles and tool provisioning**: Both arms have the same generic MCP client extension and ambient tools. Only treatment receives the selected skill and its declared MCP server configuration. Baseline receives no seeded servers but can connect to discovered endpoints. A skill naming an external tool does not by itself guarantee that the endpoint is reachable. Model-selected connections and calls are agent behavior, not additional evaluator-provided server configuration.
- **Test-double results are non-evaluative**: Evidence generated with `--mode fake` is marked with `TEST-DOUBLE EVIDENCE` and reflects harness execution mechanics, not skill quality.
- **Non-atomic sealing**: While sealing is guarded and tampering is detected loudly, an abrupt system termination during manifest generation leaves an unsealed run tree that verification will reject.
- **Execution budgets**: The **300,000 ms (5 minute) default** and **600,000 ms (10 minute) maximum** apply **per arm**, from prompt submission, and are resolved identically for both arms. The overall invocation watchdog is separate and reserves infrastructure time for startup, cleanup, and sealing; it is not a single combined arm ceiling. Setup, waiting, capture, and validation have distinct bounded allowances enforced by watchdogs.
- **Disk quotas are memory-bounded**: Apple Container provides no hypervisor-level disk quota primitive. Guest writable storage is backed by tmpfs and constrained by guest memory limits.
- **In-guest egress enforcement**: Egress filtering is applied via guest `iptables` and privilege drops rather than an external hypervisor firewall. Attestation probes verify network blocks on each run, but isolation relies on container kernel privilege isolation.
- **Shared immutable image cache**: In accordance with architecture Amendment 4, container images (`eval-cached-*`) are immutable build artifacts shared across runs. Both arms run against the identical verified image digest.
