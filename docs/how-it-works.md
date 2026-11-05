# How it works

This repository stores eval cases for agentic workflows together with the sandboxed environment they run in. This page describes how Evals Guidelines isolates, grades and records each comparison.

## Sandboxed environment

Each arm runs in its own fresh Apple Container guest, built from the same pinned image digest and attached to its own network. The two arms are:

- **Baseline:** without the skill.
- **Treatment:** with a frozen copy of the skill and the MCP servers it declares.

The only permitted difference between the arms is the skill.

- **Guest hardening:** PID 1 starts as root only to install the egress lock (with NET_ADMIN, SETUID and SETGID), then drops to a fixed non-root user (uid/gid 10001) with no_new_privs and no remaining capabilities. The root filesystem is read-only.
- **Egress:** only public IPv4 is allowed. Private (RFC1918), loopback, link-local and cloud-metadata, carrier-grade NAT, multicast and broadcast ranges are rejected, and all IPv6 is dropped (see `container/configure-egress.sh`). Outbound TCP is further limited to the ports in the declared network policy (unless that policy allows all ports), and the deny list covers specified ranges; it does not identify every possible host address or a public relay back to the host machine. Credentials reach the guest only in memory, never in files or arguments.
- **Grading:** deterministic code runs in a separate guest with no network and no credentials.
- **Evidence:** it is sealed and hash-chained. Each arm's containers and networks are destroyed, and that cleanup is verified before the next pair starts.

It is not a benchmark, a statistical authority, an offline sandbox, a plugin framework or an LLM judge.

## Scoring rubric

Evals Guidelines standardize how we score; each case defines what a correct outcome means.

| Pillar | Measured as |
|---|---|
| Accuracy | Points out of 100 from the case's checks. **Outcome** (80): did the agent correctly and fully deliver what was asked, including the expected response to any predefined failure or invalid input? **Constraints** (20): did it respect the task boundaries and preserve what must not change? |
| Cost | Recorded tokens, including cached input. |
| Latency | Milliseconds from the arm's prompt to completion or termination. |

Each pillar is reported as a baseline → treatment change; with several pairs, as the mean over the pairs.

Declare the checks in `rubric.json` and implement them in `validator.ts`:

- **One entry per check** in `rubric.json`: `id`, `group` (`outcome` or `constraints`), display `topic` and `points`. `outcome` checks sum to 80 and `constraints` checks to 20. Checks with the same `topic` are shown together in the **Accuracy Outcome Checks** table.
- **One deterministic predicate per check** in `validator.ts`. The same answer and the same oracle always give the same result. No language model judges the answer.
- **All or nothing.** Each check earns its full points or 0, and a full pass needs every check.
- **The runner decides the score.** Any score the validator computes is advisory; the runner recomputes it from the frozen rubric.
- **Task failures and infrastructure failures are kept apart.** If the agent fails the task, the arm is still graded and may score 0. If the infrastructure fails, the arm has no score, and no change is reported for that pair.
- **Test your validator.** `validator.test.ts` must show that wrong answers fail and that accepted variants pass.

## Evidence and cleanup

Evidence is sealed in `eval-cases/<case-id>/runs/<run-id>/` and committed. A receipt and manifest hash the retained files; `eval:report` and `eval:inspect` verify that chain, so editing a sealed file breaks verification. `views/` (git-ignored) and the two generated reports are outside the chain.

If an interrupted run leaves containers or networks behind: `pnpm eval:recover -- --run <run-id>`.
