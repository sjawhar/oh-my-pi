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
