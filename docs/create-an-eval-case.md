# Create an eval case

How to create your own eval case and submit it.

A case is a folder under `eval-cases/`; adding one needs no change to `src/`.

## What is an eval case?

An eval case is **one task with a deterministic way to grade it**. It lives in its own folder, `eval-cases/<case-id>/`, and the folder name equals the case id. Adding a case needs no change to `src/`.

A case is not tied to a skill. You choose the skill at run time with `--skill`, so the same case can measure different skills, or different versions of one skill.

For each pair, the runner uses the case like this:

1. **Both arms get the same task.** The prompt from `case.json` and a fresh copy of `fixture/` go to the baseline and the treatment. The only difference is that the treatment also has the frozen skill.
2. **The agent works in its workspace** and leaves its answer at the `outputPath` declared in `case.json`.
3. **The final workspace is graded.** `validator.ts` runs in a separate offline container with no credentials and compares the answer to `oracle.json`. The agent never sees the oracle, the validator or the rubric.
4. **The runner scores centrally** from the frozen `rubric.json` and the result of each check, and seals everything into the run folder. See the [Scoring rubric](how-it-works.md#scoring-rubric).

A good case has an answer that can be checked by code, has a known correct result with sources, and is one where a skill could plausibly make a difference.

## Case layout

Use `network-config-01` as a template:

```text
eval-cases/
└── network-config-01/
    ├── README.md            # Optional case documentation (see below)
    ├── case.json            # Task prompt, output path and allowed tools
    ├── fixture/             # Agent workspace: the starting files both arms receive
    ├── oracle.json          # Hidden golden answers and their sources; never shown to the agent
    ├── rubric.json          # Checks and weights (rubric v0.2)
    ├── validator.ts         # Scores the final workspace against the oracle, in a separate container
    ├── validator.test.ts    # Wrong-answer and accepted-variant tests
    └── runs/                # Sealed evidence and generated reports (views/ is git-ignored)
```

**Case `README.md` (optional).** Documentation only, not evidence; no tool reads it. Use the same sections in every case: Why this case exists · The task · How to run it · Scoring rubric (one row per check) · Provenance · Additional context (optional) · Results. See the [network-config-01 README](../eval-cases/network-config-01/README.md).

## Run your eval with your skill

There is no import step: `--skill` takes any directory containing `SKILL.md` (no symlinks, no URLs). The runner freezes and hashes a copy into `runs/<run-id>/inputs/frozen/skill/`; never edit it.

```bash
pnpm test:eval-cases                                                # validator tests
pnpm eval:validate -- --case <case-id> --skill <path_to_skill>      # offline input check
pnpm eval:doctor -- --model <model-id>                              # readiness; no completion requests
pnpm eval -- --case <case-id> --skill <path_to_skill> --model <model-id> [--repetitions N]
```

A verified run writes `EVALS.md` and `EVALS-FULL-REPORT.md` into its run folder (see [Export](running-evals.md#export-evalsmd-and-evals-full-reportmd)). For every `pnpm eval` option see [Options for `pnpm eval`](running-evals.md#options-for-pnpm-eval), and for inspecting a run see [Inspect a run](running-evals.md#inspect-a-run).

## How to submit your eval case

Open a PR against this repository that adds your case under `eval-cases/<case-id>/`. Use [`network-config-01`](../eval-cases/network-config-01/) as the reference: your PR must contain the same content.

1. **The case files:** `case.json`, `fixture/`, `oracle.json`, `rubric.json`, `validator.ts` and `validator.test.ts`, plus a case `README.md` with the standard sections (see [Case layout](#case-layout)).
2. **At least one sealed run** under `eval-cases/<case-id>/runs/<run-id>/`, produced by `pnpm eval` with the skill you evaluated, including its generated `EVALS.md` and `EVALS-FULL-REPORT.md`. Do not edit anything in the run folder by hand.
3. **Passing checks** before you open the PR:

   ```bash
   pnpm test:eval-cases
   pnpm eval:validate -- --case <case-id> --skill <path_to_skill>
   pnpm eval:export -- --check --all
   ```
4. **No secrets and no local files.** Keep `.env`, `.state/` and `views/` out of the PR.

If your skill lives in another repository, merge this PR first so the full-report link in its `EVALS.md` resolves (see [Export](running-evals.md#export-evalsmd-and-evals-full-reportmd)).
