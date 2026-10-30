# Does naming the re-derivation class close the gap?

INFRA-724, third lane. Harness, corpus and runs on branch `infra-724-reviewer-gap-evals` of
`~/src/oh-my-pi`, under `scripts/reviewer-gap/`. Design frozen in `rederive-freeze.json` before the
first recorded model call.

**Short answer: no. On the original cases the prompt is a null result, and on the rounds the class
was named from it does worse than no prompt.** A reviewer told to enumerate every place the code
looks up again something it already had, and to attack the window in between, found 20.0% of the
known findings on stratum A against the control's 23.3%: **−3.3 pp, 95% [−12.9, +5.2]**, null. On
stratum B, the latest round of the five batch pull requests, it found 7.8% against 12.5%:
**−4.7 pp, 95% [−9.2, −0.7]**. That interval excludes zero, on the wrong side. It found no more on
the findings that are instances of the class either: 0.0 pp on A's five, −3.6 pp on B's fourteen.

---

## 1. How common is the class?

Two labellers from different model families (Claude and GPT-6 Astra), each blind to the other and
to every run, labelled all 229 records under `rederive-rubric.md`: `instance` (a fact established at
T1 is obtained again at T2 through a handle that can resolve differently, and the change in between
is the defect), `adjacent` (a check-then-act whose decision goes stale, with no second lookup) or
`not`. They agreed on 88.3% of stratum A (Cohen's kappa 0.78) and 81.3% of stratum B (kappa 0.65).
The 29 disagreements are decided one by one, with a reason each, in
`corpus/rederive-labels/adjudication.json`.

| scope | n | instance | adjacent | not | instance share, 95% Wilson |
|---|---:|---:|---:|---:|---|
| the 197-finding corpus | 197 | 64 | 16 | 117 | **32.5%** (26.3–39.3%) |
| the 30 cases stratum A runs on | 30 | 5 | 5 | 20 | **16.7%** (7.3–33.6%) |
| stratum B, the batch's latest rounds | 32 | 14 | 2 | 16 | **43.8%** (28.2–60.7%) |

The class is a third of the corpus, not most of it, and a sixth of the thirty cases the first prompt
eval ran on. It is more common in the rounds it was named from, 14 of 32, but it is not a majority
there either. So the batch's recent findings are richer in the class than the corpus is, and the
observation that it "dominates" holds for the latest rounds only as the largest single class.

## 2. The two strata

- **A, original**: `cases.json` unchanged, 30 findings over `pr17394-r7`, `pr17394-r8` and
  `pr17399-r3`, the same detection rule and window.
- **B, batch extension**: every finding the latest completed cross-family round reported open on its
  head, for the five batch pull requests, at 12:00Z. Rounds still running were excluded.

| head | pull request, round | findings |
|---|---|---:|
| `pr17394-r16` | #17394 round 16, `5e70deb62c21` | 5 |
| `pr17398-r19` | #17398 round 19, `e43656228da5` | 8 |
| `pr17402-r17` | #17402 round 17, `9af7d8eb683d` | 9 |
| `pr17412-r6` | #17412 round 6, `f8cddb4da599` | 3 |
| `pr17421-r17` | #17421 round 17, `8b9cb46ff95c` | 7 |

32 findings, not the forty-odd expected. Records are in `corpus/findings-b/`, specs in
`cases-b.json`, both written by agents that never saw the candidate prompt or the hypothesis, and
each spec checked to fire on its own report section and not on its siblings' titles or generic
prose. **B is in-sample:** the class was named from these rounds, so B is the stratum where the
prompt had every advantage. Results are never pooled without saying so.

## 3. The arms

| arm | appended to the system prompt | model |
|---|---|---|
| `rederive` | `prompts/rederive.md`, 2851 characters | `anthropic/claude-opus-5-5` |
| `control` | nothing | `anthropic/claude-opus-5-5` |
| `candidate` | the first eval's probe-first prompt, `prompts/candidate.md` | `anthropic/claude-opus-5-5` |

The control appends 0 characters, so "no longer than the control" cannot be met literally; the
candidate is held to the shipped reviewer prompt's 3349 characters, and is also shorter than the
first candidate's 4797. It names the class, lists eight shapes generalised from the lane
assignment's ten examples, names no repository identifier, and was written before any record was
labelled or any stratum-B record existed. One version, run once; it was not tuned.

Everything else is the first eval's harness: the same user message, tools, 20-minute budget,
`detects` with a 1200-character window, per-arm Wilson and cluster-bootstrap intervals, and the
paired cluster bootstrap over (head, trial) pairs (`rounds.ts` `pairedCompare`, 10 000 draws, seed
20261030). Four trials per head instead of two: 12 pairs on A, 20 on B.

## 4. Results

96 runs, 32 per arm, 2026-10-30 12:14–13:49Z, 0 errored, 0 at a spend cap, longest 9.5 minutes of
20. Records and the reviewers' probe sources are in `runs/rederive-2026-10-30/{a,b}/<arm>/`;
`bun scripts/reviewer-gap/rederive.ts` reproduces every number below.

### Per arm

| stratum | arm | runs | n | detected | rate | 95% Wilson | 95% cluster bootstrap |
|---|---|---:|---:|---:|---:|---|---|
| A | `control` | 12 | 120 | 28 | 23.3% | 16.7–31.7% | 17.0–28.6% |
| A | `candidate` | 12 | 120 | 27 | 22.5% | 15.9–30.8% | 15.5–27.5% |
| A | `rederive` | 12 | 120 | 24 | 20.0% | 13.8–28.0% | 11.4–27.4% |
| B | `control` | 20 | 128 | 16 | 12.5% | 7.8–19.3% | 8.4–16.8% |
| B | `candidate` | 20 | 128 | 14 | 10.9% | 6.6–17.5% | 6.3–16.1% |
| B | `rederive` | 20 | 128 | 10 | 7.8% | 4.3–13.8% | 3.4–12.4% |

### Paired, over (head, trial)

| comparison | stratum | pairs | delta | 95% interval | wins / losses / ties | reading |
|---|---|---:|---:|---|---|---|
| **rederive − control** | **A** | 12 | **−3.3 pp** | **[−12.9, +5.2]** | 3 / 4 / 5 | **null** |
| **rederive − control** | **B** | 20 | **−4.7 pp** | **[−9.2, −0.7]** | 1 / 6 / 13 | **worse than control** |
| rederive − candidate | A | 12 | −2.5 pp | [−10.2, +6.1] | 3 / 5 / 4 | null |
| rederive − candidate | B | 20 | −3.1 pp | [−8.3, +1.4] | 2 / 5 / 13 | null |
| candidate − control | A | 12 | −0.8 pp | [−8.9, +6.4] | 5 / 5 / 2 | null |
| candidate − control | B | 20 | −1.6 pp | [−6.0, +2.6] | 2 / 3 / 15 | null |
| rederive − control, `instance` findings only | A (5) | 12 | 0.0 pp | [−15.8, +13.3] | 1 / 1 / 10 | null |
| rederive − control, `instance` findings only | B (14) | 20 | −3.6 pp | [−10.0, +3.4] | 1 / 3 / 16 | null |
| rederive − control, every other finding | A (25) | 12 | −4.0 pp | [−15.2, +6.0] | 3 / 4 / 5 | null |
| rederive − control, every other finding | B (18) | 20 | −5.6 pp | [−11.5, 0.0] | 1 / 5 / 14 | null |
| rederive − control, guard (6 prompt-satisfiable specs dropped) | A | 12 | −4.2 pp | [−17.2, +8.1] | 3 / 4 / 5 | null |
| rederive − control, **POOLED** A and B | A+B | 32 | −4.0 pp | [−9.2, +0.8] | 4 / 10 / 18 | null |

The frozen reading rule credits the lever only if A excludes zero and its guard agrees. A is null,
and the guard moves it further down. B, where the class was named, is the one comparison whose
interval excludes zero, and it excludes it below.

### What the prompt changed

| stratum | arm | runs that wrote a probe | probe files | runs quoting measured output | mean report chars | pairs where the mechanism was never named |
|---|---|---:|---:|---:|---:|---:|
| A | `rederive` | 12 / 12 | 15 | 12 / 12 | 5 795 | 80 / 120 |
| A | `control` | 10 / 12 | 13 | 6 / 12 | 6 539 | 60 / 120 |
| A | `candidate` | 12 / 12 | 24 | 11 / 12 | 5 953 | 70 / 120 |
| B | `rederive` | 17 / 20 | 21 | 20 / 20 | 5 495 | 100 / 128 |
| B | `control` | 15 / 20 | 19 | 14 / 20 | 6 131 | 98 / 128 |
| B | `candidate` | 17 / 20 | 29 | 16 / 20 | 5 710 | 96 / 128 |

As with the first candidate, the prompt changed behaviour and not recall: every rederive run quoted
measured output, against 6 of 12 and 14 of 20 control runs. It also narrowed what the reviewer wrote
about. On A the rederive reports never named the mechanism of 80 of 120 findings, against 60 for the
control. The same four minutes went into hunting one class, and the reports cover less of the rest.

## 5. What this evidence supports, and what it does not

**Supports**

- Naming the class does not make a same-family reviewer find more of the known defects. Null on the
  cases it was not named from, worse on the rounds it was named from, and no gain on the in-class
  findings in either stratum.
- A focusing prompt has a cost. On B every comparison against the control is negative, and the one
  with an interval that excludes zero is the class prompt against no prompt.
- The probe-first prompt of the first eval replicates as null on fresh runs and four trials:
  −0.8 pp [−8.9, +6.4] on A.
- The class is real and common but not dominant: 32.5% of the corpus, 43.8% of the latest rounds.

**Does not support**

- That the class is unimportant. It is a third of what cross-family review found. The result is that
  telling a reviewer about it in one round of about four minutes does not make it find more of it.
- Anything about cross-family reviewers or about rounds: every arm here is one same-family round.
  The rounds lane's +16.7 pp from restarting remains the only lever with an interval above zero.
- Stratum-B effects beyond these five heads, or #17412 in general: its Rust changes cannot be built
  on this box, so its three findings could be reached only by reading and by timing the shipped
  binary, in every arm alike.

**What it implies.** The gap is not in what a reviewer is told to look for. Two prompt levers, one
about how to work and one about what to attack, are both null or negative against no prompt, while
restarting the reviewer is positive. The next measurement is the one the rounds lane named: more
rounds, not more words.

## 6. Deviations, all recorded in `rederive-freeze.json`

- **Broken stratum-A snapshots.** At 12:13Z the `pr17394-r7` and `pr17394-r8` snapshots had all 252
  dependency links dangling: their donor tree, `/mnt/nvme/17394-astra-r6/head`, had been deleted to
  free disk. Their workspace links, and `pr17399-r3`'s, pointed into other trees. `snapshot.ts
  relink` re-pointed all three to a donor this lane owns (`/mnt/nvme/tmp-omp-batch/reviewer-gap-rederive/donor`,
  a hard-linked copy of the first eval's donor `/mnt/nvme/sami/tmp/astra17399-r2/source`; `bun.lock`
  is the same blob at every head) and their workspace links into the snapshot itself. No source
  file changed. Whether the first two lanes' pr17394 runs had working dependencies cannot be proved
  from their records; none of their reports quotes a missing-module error.
- **Six voided runs.** Rederive, control and candidate on `pr17394-r7`, trials 1 and 2, started on the
  broken snapshots and were killed by exact PID after about four minutes. None wrote a record. One
  of the later, valid runs (`rederive__pr17394-r7__t2`) found a read-only copy of the snapshot that
  a voided run had left in its scratch directory; it holds only snapshot source.
- **Repository gate unavailable.** Under the box's CPU cap every arm was told that `bun run check:ts`
  and repository-wide test runs were unavailable. Held for the whole lane, the same for every arm,
  and one difference from the first eval. No report mentions running it.
- **Width.** 3 runs at a time (one per arm) from 12:14Z, 6 from 12:38Z, back to one per arm at
  13:40Z. Each arm had the same number of runners throughout; only the last three runs (two control,
  one candidate, all `pr17421-r17`) ran after rederive had finished.
- **Bun 1.4.4** for every reviewer, through `MISE_BUN_VERSION`: the omp shim re-derives `PATH` from
  mise, so a `PATH` prefix alone would have given them 1.4.2.

## 7. Two findings about the earlier lanes

- **The first candidate prompt satisfies five of the first eval's thirty specs by itself**
  (`17394-R7-4`, `R7-5`, `R8-3`, `R8-8`, `R8-10`): a report that repeats its prompt's wording scores
  them. That eval did not check. Re-scored without these five and the new prompt's one, its −3.3 pp
  becomes −4.2 pp [−22.2, +9.8]; still null. The new prompt satisfies one (`17394-R8-4`); the guard
  rows above drop all six.
- **The first eval's published interval is not reproducible from committed code.** It reported
  −3.3 pp [−18.8, +9.5]; `rounds.ts` `pairedCompare` on its committed runs gives −3.3 pp
  [−19.2, +9.2]. The delta matches; the paired code it used was never committed.
