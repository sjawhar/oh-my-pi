# Claims lane: baseline for the shipped reviewer prompt, 2026-10-31

Design, counts and hashes: `claims-freeze.json` (revision 2). Runs:
`runs/claims-2026-10-31/current/`; scores: `runs/claims-2026-10-31/results.json`.
Reproduce with `bun scripts/reviewer-gap/claims.ts --runs scripts/reviewer-gap/runs/claims-2026-10-31/current`.

## What was measured

The shipped reviewer prompt (`prompts/current.md`, the body of omp's `reviewer`
agent) on Claude Opus 5.5, three fresh runs per head, against 23 real heads of
the batch's pull requests. Each head carries the real defects the batch's
reviews found there (123 in all, 97 of which one of the two original reviewers
missed) and the false claims the batch's reviewers made there (21 decoys). Each
run got the head, its patch and a read-only copy of the previous review round,
as every round of the batch did, and reported asserted defects under
`## DEFECT:` and cleared suspicions under `## NOT A DEFECT`. Only the asserted
sections are scored.

## Result

| | claimed / opportunities | rate | 95% Wilson | 95% bootstrap over runs |
|---|---|---|---|---|
| real defects claimed | 5 / 364 | 1.4% | 0.6–3.2% | 0.3–2.7% |
| — of those the original astra arm missed | 3 / 149 | 2.0% | 0.7–5.8% | 0.0–4.8% |
| — of those the original Claude arm missed | 2 / 150 | 1.3% | 0.4–4.7% | 0.0–3.4% |
| — not already stated in the earlier round given to the run | 4 / 325 | 1.2% | 0.5–3.1% | 0.3–2.6% |
| decoys asserted as defects | 0 / 63 | 0.0% | 0.0–5.7% | 0.0–0.0% |
| decoys mentioned anywhere in a report | 0 / 63 | 0.0% | 0.0–5.7% | — |

- 75 runs recorded, none errored. 68 scored; 1 unformatted (its whole report is
  "Waiting for the focused coding-agent test run (bg_1) to finish before I write
  the report."); 6 are on two heads revision 2 removed and are not scored.
- 22 of the 68 scored runs claimed no defect. The 46 others made 53 claims, of
  which 5 match a recorded defect and 48 match no case. An unmatched claim is
  neither a find nor a false claim: it may be a defect nobody recorded.
- The 5 found: D-17396-r5-1 (2 of 3 runs), D-17402-r51-1 (1 of 3, also stated
  in the earlier round's material), D-17457-r12-3 (1 of 3), D-17488-r25-2
  (1 of 3).
- 52 of the 75 runs left a probe file in their scratch directory. The median run
  used 6 of its 20 minutes.

## What it means

- **The real-defect side measures.** The shipped prompt claims 1.4% of the
  defects the batch's reviewers found at the same heads. The interval's top is
  3.2%, so a revision that finds one more defect in twenty would show.
- **The false-claim side measured nothing for this prompt.** No run asserted a
  decoy, and no run even mentioned one: 0 of 63. The decoys come from running
  things (a probe that is wrong, a replayed assertion the fix changed on purpose,
  a suite failing on the box); a reviewer that does little of that never meets
  them. A zero here is not evidence that the prompt avoids false claims. The
  decoy side becomes informative only for a prompt whose runs mention decoys,
  and `mentioned` is the check for that.
- **Most of the batch's false claims were caught by the reviewer that made
  them.** Of the 21 decoys, 18 were raised and withdrawn in the same report; 3
  were asserted. That bounds how many false claims a prompt revision can remove
  on this set.

## Limits

- One arm, so no comparison yet. `claims.ts --compare a:b` gives paired deltas
  for both rates from the same bootstrap draws once a second arm runs on the
  same cases.
- 48 of 53 claims match no case and are not scored either way.
- The native addon each snapshot links to is the one the batch's exports
  carried; whether it was built from each head's Rust is not recorded.
- Revision 2 of the case file was made after the runs started (seven decoy
  labels and one exclusion corrected after a cross-family review, scorer
  defects fixed); the reasons are in `claims-freeze.json` and
  `corpus/claims/adjudication.json`.
