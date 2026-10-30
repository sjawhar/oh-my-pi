# reviewer-gap

Measures whether a reviewer under a given prompt finds a defect that a review
on the night of 2026-10-29/30 already found, on the same head of the same pull
request.

- `corpus/` — one record per finding from those reviews, and one per lane belief
  a measurement falsified. `corpus/SCHEMA.md` is the schema; `corpus.test.ts`
  enforces it. `bun scripts/reviewer-gap/corpus.ts` prints the distributions.
- `cases.json` — the frozen subset the eval runs on: three heads whose working
  trees still exist on the box, with the mechanism and trigger patterns of each
  finding at that head. Frozen before any model call; a result must not change it.
- `prompts/` — the arms. `control.md` is empty on purpose: without it you cannot
  tell a rule from what the model does anyway.
- `run.ts` — one run per (head, arm, trial). Every arm gets the same snapshot,
  the same patch, the same tools and the same budget; only the text appended to
  the system prompt differs.
- `grade.ts` — mechanical grading, no model judge. A finding counts when every
  mechanism group and every trigger group matches inside one window of the
  report. Intervals are Wilson over findings and a cluster bootstrap over runs,
  because findings inside one run are not independent.

```bash
bun scripts/reviewer-gap/run.ts --out <dir> --arms control,current,candidate,crossfamily --trials 2 --dry-run
bun scripts/reviewer-gap/run.ts --out <dir> --arms control,current,candidate,crossfamily --trials 2 --max-time 20m --max-cost 3
bun scripts/reviewer-gap/grade.ts --runs <dir> --json <dir>/results.json
```

The snapshots `cases.json` names are read-only trees under `/mnt/nvme`. Runs
share them; each run writes only into its own scratch directory. A run that
errors is excluded from `n` and reported as `failedRuns`: a zero would penalise
the wrong arm.

## The rounds lane

The first lane answered "does the prompt close the gap" with no. This one asks
whether the review *loop* does: the night's reviews ran 3 to 11 rounds, and
every arm of the first lane was one cold round.

- `rounds-freeze.json` — arms, round prompt templates, scoring scopes, the
  symlink-class definition, the cost cap and the dropped arms with their
  reasons. Frozen and committed before the first model call of this lane.
- `run-rounds.ts` — one *sequence* per (arm, head, trial), its rounds run
  serially in fresh sessions. Round 1 is the one-round arm, so it doubles as a
  provider-drift check. It refuses to start another round once the cumulative
  spend reaches `--budget`.
- `rounds.ts` — sequence-level scoring. Detection is `detects` from `grade.ts`,
  unchanged; this file only composes it over rounds (`union`, `final`, `first`)
  and adds the paired bootstrap and Fisher's exact test. `rounds.test.ts`
  reproduces the first lane's published numbers from its committed runs, which
  is what proves the grading was not redefined.
- `rounds-audit.ts` — per-round diagnostics: report length, prompt growth,
  minutes used, whether a later round named an earlier one, probe files left.
  Never a score. It reads the probe files under `runs/<dir>/scratch/`.
- `results-rounds-2026-10-30.md` — the report. Runs at `runs/rounds-2026-10-30/`.

```bash
bun scripts/reviewer-gap/run-rounds.ts --out <dir> --arms retry-blind,rounds-carry --dry-run
bun scripts/reviewer-gap/run-rounds.ts --out <dir> --arms retry-blind,rounds-carry --concurrency 6 --budget 85
bun scripts/reviewer-gap/rounds.ts --runs scripts/reviewer-gap/runs/rounds-2026-10-30,scripts/reviewer-gap/runs/2026-10-30
bun scripts/reviewer-gap/rounds-audit.ts --runs scripts/reviewer-gap/runs/rounds-2026-10-30
```

## The re-derivation lane

A third lever: a prompt that names one defect class (a fact established at T1
is re-derived at T2 from something that can change in between) and tells a
running reviewer to enumerate every re-lookup and attack the window between.

- `prompts/rederive.md` — the candidate, 2851 characters.
- `rederive-freeze.json` — arms, strata, trials, comparisons, the guard and the
  deviations. Frozen and committed before the first recorded model call.
- `rederive-rubric.md` and `corpus/rederive-labels/` — the labelling rule, two
  independent labellers' labels of all 229 records, and the adjudication of
  every disagreement.
- `corpus/findings-b/` and `cases-b.json` — stratum B: the findings of the
  latest completed round of five pull requests, and their frozen specs.
- `snapshot.ts` — builds a read-only head snapshot whose dependencies link to a
  donor this lane owns, and `check`s that no link dangles or leaves the
  snapshot. The first two lanes' snapshots linked to reviewers' own trees, two
  of which were deleted later.
- `rederive.ts` — scoring. Per-arm rates are `gradeRuns`, paired deltas are
  `pairedCompare`, unchanged; this file selects strata, subsets and the guard
  (findings an arm's prompt satisfies by itself), and reports the class share.
- `results-rederive-2026-10-30.md` — the report. Runs at
  `runs/rederive-2026-10-30/{a,b}/<arm>/`.

```bash
bun scripts/reviewer-gap/snapshot.ts check <snapshot>...
MISE_BUN_VERSION=1.4.4 bun scripts/reviewer-gap/run.ts --out <dir>/a/rederive --arms rederive --trials 4 --concurrency 1 --max-time 20m --max-cost 6 --no-repo-gate
MISE_BUN_VERSION=1.4.4 bun scripts/reviewer-gap/run.ts --cases scripts/reviewer-gap/cases-b.json --out <dir>/b/rederive --arms rederive --trials 4 --concurrency 1 --max-time 20m --max-cost 6 --no-repo-gate
bun scripts/reviewer-gap/rederive.ts --a <a dirs> --b <b dirs> --stored scripts/reviewer-gap/runs/2026-10-30
```

One `run.ts` per arm, started together, keeps the arms in the same time window;
a second runner on the same directory takes the next unclaimed job.
