# Does the review loop close the gap the prompt did not?

INFRA-724, following the prompt lane at `3429f759ceef`. Same branch
`infra-724-reviewer-gap-evals`, same 30 findings, same three heads, same mechanical grader, same
candidate prompt in every arm. Only the loop varies.

**Short answer: yes, the loop moves recall, and it is *restarting* that moves it, not what a round
carries.** Three rounds of the same same-family reviewer reach **40.0%** of the night's findings
against **23.3%** for one round — a paired **+16.7 pp, 95% [+2.8, +35.1]**, winning 5 of 6 pairs, the
first interval in either lane that excludes zero. But a three-round arm that is handed *nothing* —
only "an earlier attempt missed something, look again" — reaches **35.0%**, so **+11.7 pp, 95%
[+2.8, +25.0]** of that comes from another attempt alone, and carrying every earlier report plus its
probes adds only **+5.0 pp, 95% [−5.2, +14.5]**, which is not established. Three same-family rounds
land level with one cross-family round: **−1.7 pp, 95% [−18.8, +12.5]**.

The symlink class answer is the honest-null part: with rounds in play it is no longer
family-separated (same-family 3 of 12 against cross-family 3 of 6, p = 0.34), but 2 of those 3 hits
arrived at *round 1*, so rounds are not shown to be what reaches it. At single-round depth the class
still separates the families on the pooled data of both lanes: **2 of 30 against 3 of 6, Fisher
two-sided p = 0.0243**.

Cost: **$58.49** against a **$68** estimate and an **$85** cap. 36 runs, 0 provider errors, 0 runs
at the spend cap.

---

## 1. The arms, and why these

### What the first lane left open

Its own strongest hypothesis: every arm stopped after 4–6 minutes of a 20-minute budget in one cold
round, while the reviews that produced the corpus ran 3 to 11 rounds. A round is not a longer read —
a reviewer in round N holds round N−1's reproductions, knows which of its findings were closed, and
attacks the fix.

That phrasing hides two different mechanisms, and an experiment that cannot tell them apart is weak:

1. **Another attempt.** A fresh context with no memory of the last pass. Nothing is carried; the
   reviewer simply starts again and may land somewhere else.
2. **Information carried forward.** The earlier rounds' findings, their probes, their measured
   output, and the instruction not to re-report what they already found.

So the arms are chosen to separate exactly those two, holding everything else fixed:

| arm | model | rounds | what a later round is given | isolates |
|---|---|---:|---|---|
| `single` | opus-5-5 | 1 | — | the baseline |
| `retry-blind` | opus-5-5 | 3 | "This is attempt N of 3 … earlier attempts have already reviewed it and missed defects that a later reviewer found. You are not being shown what they reported, what they ran, or where they looked." Fresh scratch directory every round. | **another attempt** |
| `rounds-carry` | opus-5-5 | 3 | the same expectation, **plus** every earlier round's report verbatim, "do not report a defect one of them already reported", and the sequence's shared scratch directory with their probes and output still in it | **information carried forward** |
| `crossfamily-single` | gpt-6-astra | 1 | — | the family explanation |

Both multi-round templates state the *same expectation* — an earlier attempt missed something — so
the only thing that differs between them is whether that attempt's content is present. Without
`retry-blind`, a win for `rounds-carry` could not be told from "it got three tries".

`crossfamily-single` is the pair the brief asked for: it tests the family explanation against the
loop explanation on the same cases in the same table.

### What is held fixed

The same 30 findings, the same 3 heads, the same `detects` rule with its 1 200-character window, the
same `prompts/candidate.md` appended in **every** arm including cross-family, the same tools, the
same `--thinking high`, and the same **20-minute budget per round**.

**The one budget change, declared rather than silent.** A three-round arm gets three 20-minute
budgets, so its *total* budget is 3× a one-round arm's. That is the treatment, not a harness tweak,
and `retry-blind` is the control for it: it gets the same three attempts and the same total budget
as `rounds-carry` while carrying nothing. A fourth option — one 60-minute round — was dropped,
because the first lane measured every arm self-terminating at 4–6 minutes of 20 with none cut off;
more wall clock inside one session is not a treatment the model takes up. §4 shows the measurement
that vindicates this: each round here *also* used about 4 minutes of its 20.

### Arms dropped, and why they are not needed

| dropped | why |
|---|---|
| **`fix-carried`**: round N reviews the head that fixed round N−1's findings | Only `pr17394-r7 → pr17394-r8` is a consecutive-head pair among the three heads with working trees, and only 1 of #17394's 23 corpus findings was closed by a later head, so r8 is new feature code rather than a fix of r7. The arm would confound attacking a fix with reviewing new code, at n = 1 head. This is the one mechanism of a real round this eval cannot reach, and it needs more rebuilt heads, not more arms. |
| **a 2-round arm** between 1 and 3 | The per-round marginal inside the three-round arms gives the dose-response at rounds 1, 2 and 3 for no extra model calls (§3). |
| **cross-family, three rounds** | About $92 at the first lane's $5.09 per cross-family run — more than this entire run — and the question is whether the loop explains the *same-family* gap. |
| **one 60-minute round** | Covered above by the self-termination measurement. |
| **decomposing the carry bundle** into findings-only, scratch-only, closure-only | Three more arms at n = 60 could not resolve a three-way decomposition of an effect whose existence was not yet established. The first question is whether the bundle moves anything at all; §3 answers that it does not move much, which is why the decomposition is still not worth buying. |

### Reusing two arms, and the check that it is legitimate

`single` and `crossfamily-single` are the first lane's `candidate` and `crossfamily` arms, reused
unchanged: same cases, same grader, same prompt, same budget, 6 runs each, recorded
2026-10-30T06:30–07:20Z. That saved $40 of the $85 cap, and it is only sound if the provider has not
drifted.

Round 1 of every multi-round sequence is generated by the same `userPrompt` function with the same
head and the same 20 minutes, so those 12 fresh round-1 runs *are* a replication of the one-round
same-family arm:

| | sequences | n | detected | rate | 95% Wilson | 95% cluster bootstrap |
|---|---:|---:|---:|---:|---|---|
| reused `single` (2026-10-30 06:30–07:20Z) | 6 | 60 | 14 | **23.3%** | 14.4–35.4% | 10.0–34.3% |
| fresh round 1, both new arms pooled (2026-10-30 06:49–07:16Z) | 12 | 120 | 28 | **23.3%** | 16.7–31.7% | 16.0–29.6% |

23.3% against 23.3%. The reused baseline stands.

---

## 2. Frozen before any model call

`scripts/reviewer-gap/rounds-freeze.json`, declaring `frozen_at` **2026-10-30T06:40:00Z**, committed
as **`cc240883`** at **2026-10-30T06:44:09Z** (signed, `Omp-Session: 01a15237-…`). The first model
call of this lane started at 06:48Z. The freeze carries the arms, the two round-prompt templates
verbatim, the scoring scopes, the paired-comparison list, the symlink-class finding ids, the cost
estimate and cap, and the dropped arms with their reasons — all of it before any result existed.

**Grading is the first lane's, unchanged.** `rounds.ts` imports `detects`, `wilson` and
`clusterBootstrap` from `grade.ts` and only composes per-round detections into sequences. That claim
is tested rather than asserted: `rounds.test.ts` (27 tests) re-derives, from the first lane's
committed run records, its published per-arm rates and bootstraps, its `candidate − control` of
−3.3 pp, its `crossfamily − control` of +11.7 pp, and its symlink-class Fisher p of 0.0099. If the
grading had been redefined, those would not reproduce.

**One harness fix, made before the first model call and disclosed.** `loadRuns` now reads run files
in run-id order. The cluster bootstrap resamples cluster indices from a seeded PRNG, so the order
the clusters were built in — a `readdir` order — decided the published interval. The detection rule,
the window, the patterns, the pass rule and the exclusion of errored runs are untouched. Re-grading
the first lane's committed runs moves exactly one published number: the `crossfamily` cluster
bootstrap lower bound, **21.7% → 21.1%**. Every rate, count and other bound is identical.

### Scoring a sequence

The unit of analysis is the **(finding, sequence)** pair, a sequence being one (arm, head, trial);
6 sequences per arm, n = 60. Three scopes, all under the same frozen rule:

- **`union`** (primary) — a finding counts when the rule fires on **at least one** round. The corpus
  it is graded against was itself harvested across all rounds of each night-time review, so the
  union is the quantity that corpus measures. Grading each round separately and OR-ing avoids any
  window artefact at a concatenation seam.
- **`final`** — the last round alone.
- **`first`** — round 1 alone, which is the drift check above.

A round recorded with an error or an empty report is dropped and counted as `failedRounds`, never
scored zero. There were none.

---

## 3. Results

36 new runs, 2026-10-30 06:48–07:16Z. Raw per-round records at
`scripts/reviewer-gap/runs/rounds-2026-10-30/`.

### Union over rounds — the primary score

| arm | model | rounds/seq | sequences | n | detected | rate | 95% Wilson | 95% cluster bootstrap | cost |
|---|---|---:|---:|---:|---:|---:|---|---|---:|
| `rounds-carry` | opus-5-5 | 3 | 6 | 60 | 24 | **40.0%** | 28.6–52.6% | 34.0–46.8% | $25.35 |
| `crossfamily-single` | gpt-6-astra | 1 | 6 | 60 | 23 | **38.3%** | 27.1–51.0% | 21.1–50.0% | $30.52 |
| `retry-blind` | opus-5-5 | 3 | 6 | 60 | 21 | **35.0%** | 24.2–47.6% | 27.4–43.3% | $31.06 |
| `single` | opus-5-5 | 1 | 6 | 60 | 14 | **23.3%** | 14.4–35.4% | 10.0–34.3% | $9.45 |

### The paired comparisons

Paired over the six (head, trial) pairs, cluster bootstrap on the pairs, 10 000 iterations, seed
20261030.

| comparison | pairs | delta | 95% interval | A wins | B wins | ties |
|---|---:|---:|---|---:|---:|---:|
| **loop**: `rounds-carry` − `single` | 6 | **+16.7 pp** | **[+2.8, +35.1]** | 5 | 1 | 0 |
| **another attempt**: `retry-blind` − `single` | 6 | **+11.7 pp** | **[+2.8, +25.0]** | 4 | 0 | 2 |
| **carried information**: `rounds-carry` − `retry-blind` | 6 | +5.0 pp | [−5.2, +14.5] | 3 | 2 | 1 |
| **family vs loop**: `crossfamily-single` − `rounds-carry` | 6 | −1.7 pp | [−18.8, +12.5] | 3 | 3 | 0 |

Two intervals exclude zero, and both of them are about *restarting*. The interval for what a round
*carries* does not. On six pairs the carry effect would have to be roughly three times larger to be
visible here, so this is "not established", not "shown to be zero" — but the ordering is clear:
whatever the loop is worth, most of it is already bought by the blind retry.

### Where the gain comes from: another draw, not a better one

| arm | round 1 | round 2 | round 3 | union |
|---|---:|---:|---:|---:|
| `retry-blind` | 12/60 — 20.0% | 13/60 — 21.7% | 11/60 — 18.3% | **21/60 — 35.0%** |
| `rounds-carry` | 16/60 — 26.7% | 11/60 — 18.3% | 13/60 — 21.7% | **24/60 — 40.0%** |

A later round is not better than round 1. Under `rounds-carry` it is *worse* — 26.7% at round 1 and
18.3% at round 2 — even though round 2 is handed round 1's report in full and told not to repeat it.
The union rises because each round finds a partly different subset, not because a later round digs
deeper.

The same thing from the other side, as first-detection:

| arm | first seen at round 1 | at round 2 | at round 3 |
|---|---:|---:|---:|
| `rounds-carry` | 16 | 3 | 5 |
| `retry-blind` | 12 | 8 | 1 |
| `crossfamily-single` | 23 | — | — |
| `single` | 14 | — | — |

And the instruction not to repeat did not reduce repetition. `rounds-carry`'s rounds 2 and 3
produced 24 detections of which 8 were new, so **16 were restatements**; `retry-blind`'s produced 24
of which 9 were new, so **15 were restatements** — 40% against 42% of later-round hits. Being handed
the earlier report verbatim, with an explicit instruction, changed that by two percentage points.

*Caveat on that one number.* The grader fires on the report's text, so a carrying round that writes
"round 1 already reported the symlink lock issue" counts as a restatement by the same rule. The
restatement comparison is therefore confounded in `rounds-carry`'s direction and should be read as
"no reduction", not as a measured equality. The **union** is not affected: a carry prompt contains
only the earlier rounds' own reports, so it can never introduce a finding those rounds did not have.

### Which findings each arm reaches at all

Union of distinct findings over an arm's six sequences, out of 30:

| arm | findings reached |
|---|---:|
| `crossfamily-single` | 17 |
| `rounds-carry` | 16 |
| `retry-blind` | 15 |
| `single` | 11 |

Eight findings were reached by a multi-round same-family arm and never by the single same-family
arm: `17394-R7-2`, `R7-4`, `R7-5`, `R7-6`, `R7-9`, `R8-7`, `R8-10`, `17399-R3-4`. Four remain
cross-family-only across both lanes: `17394-R7-3`, `R8-2`, `R8-9`, `R8-11`. Seven were found by
nobody in any arm of either lane: `17394-R7-1`, `R7-8`, `R8-12`, `R8-14`, `17399-R3-1`, `R3-3`,
`R3-6` — the two-process lease cases, the inventory-completeness cases and the intermittent ones.

---

## 4. Behaviour per round

`bun scripts/reviewer-gap/rounds-audit.ts --runs <dir>`. Diagnostics, not scores.

| arm | round | runs | mean report chars | mean prompt chars | mean minutes used | quoted measured output | named an earlier round | named an earlier round's probe file |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `retry-blind` | 1 | 6 | 5 345 | 1 773 | 5.4 | 6 | — | — |
| `retry-blind` | 2 | 6 | 5 883 | 2 059 | 4.6 | 6 | **0** | 2 |
| `retry-blind` | 3 | 6 | 5 588 | 2 059 | 5.1 | 6 | **0** | 1 |
| `rounds-carry` | 1 | 6 | 6 230 | 1 788 | 4.1 | 6 | — | — |
| `rounds-carry` | 2 | 6 | 5 436 | 8 596 | 3.9 | 6 | **6** | n/a (shared dir) |
| `rounds-carry` | 3 | 6 | 5 371 | 14 209 | 4.0 | 6 | **6** | n/a (shared dir) |

The carry arm worked as designed and the blind arm was genuinely blind: every `rounds-carry` later
round names an earlier round in its own report, no `retry-blind` later round does, and the prompt
grows from 1 788 to 14 209 characters as the earlier reports accumulate. `retry-blind`'s 2 and 1 in
the last column are filename collisions — two rounds both calling their probe `probe.test.ts` — not
reuse; a blind round writes into its own `r<N>` subdirectory and is never told the siblings exist.
For `rounds-carry` all rounds share one directory, so reuse cannot be attributed from the
filesystem; its 6-of-6 "named an earlier round" is the engagement evidence instead.

**Every round again stopped at about 4 minutes of its 20.** Three rounds of `rounds-carry` consume
12.0 minutes of model time in total, and `retry-blind` 15.1. A single round given the same 20
minutes stopped at 6.1. So the gain does not come from spending more wall clock inside a session —
it comes from ending the session and starting another one. The reviewer's own sense of being
finished, not the budget, is what bounds a round; a fresh context is the only thing measured here
that resets it.

Probe files left behind: `retry-blind` 38 over 6 sequences, `rounds-carry` 30. Against the first
lane's 15 for the one-round `candidate` arm. Every round of both arms quoted measured output.

---

## 5. The symlink / alias class

The first lane's sharpest post-hoc signal: same-family 0 of 18 (finding, run) pairs, cross-family 3
of 6, Fisher two-sided p = 0.0099, on the class `{17394-R7-5, 17394-R8-2, 17394-R8-7}` — a symlink
alias of the worktree root taking a second lock, `worktree clear` deleting a live sandbox after a
symlink swap, and a symlinked session cwd bypassing lease discovery. Those three ids were written
into the freeze before any model call of this lane.

| arm | pairs | hits | first seen r1 | r2 | r3 |
|---|---:|---:|---:|---:|---:|
| `crossfamily-single` | 6 | 3 | 3 | 0 | 0 |
| `rounds-carry` | 6 | 2 | **2** | 0 | 0 |
| `retry-blind` | 6 | 1 | 0 | **1** | 0 |
| `single` | 6 | 0 | 0 | 0 | 0 |

| test | table | Fisher two-sided |
|---|---|---:|
| same-family **one round**, both lanes pooled, vs cross-family one round | 2/30 vs 3/6 | **p = 0.0243** |
| same-family **three rounds** vs cross-family one round | 3/12 vs 3/6 | p = 0.3441 |
| same-family three rounds vs same-family one round | 3/12 vs 2/30 | p = 0.1309 |

**The answer: the class stops being family-bound once rounds are in play, but a later round is not
shown to be what reaches it.** Three same-family rounds hit 3 of 12 class pairs against the
cross-family single round's 3 of 6, and that difference is no longer distinguishable (p = 0.34).
`17394-R7-5` and `17394-R8-7` were reached by a same-family arm for the first time in either lane.
But 2 of those 3 hits landed at **round 1**, where the single-round arm had scored 0 of 6 — so what
changed is partly just more same-family single rounds (12 fresh ones), not the loop. Only
`retry-blind`'s one hit arrived at a later round, and `17394-R8-2` stays cross-family-only.

The class still separates the families at single-round depth on the pooled data of both lanes: 2 of
30 against 3 of 6, p = 0.0243 — weaker than the first lane's 0 of 18 and p = 0.0099, because the 12
fresh round-1 runs found two. This remains a six-finding post-hoc subgroup tested four ways. The
first lane's recommendation stands and this lane did not discharge it: a dedicated case set of
aliases, bind mounts, hardlinks and cross-device renames, where n comes from cases rather than from
a subgroup.

---

## 6. Cost against the estimate

| what | estimate | actual |
|---|---:|---:|
| `retry-blind`, 18 runs | $28.80 | **$31.06** |
| `rounds-carry`, 18 runs | $39.60 | **$25.35** |
| one discarded duplicate round (see below) | — | **$2.09** |
| **new model spend** | **$68** | **$58.49** |
| reused `single` + `crossfamily-single`, 12 runs | $0 | $0 (spent in the first lane: $39.97) |
| hard cap, enforced by the runner | $85 | not reached |

Per run: $0.90–$2.62, median $1.46. Per sequence: `rounds-carry` $4.22, `retry-blind` $5.18, against
`crossfamily-single` $5.09 and `single` $1.58. **Three same-family rounds buy cross-family recall at
cross-family price.** Wall clock 27 minutes at sequence-concurrency 6, 2.8–6.3 minutes per run.

The estimate was wrong in one direction worth recording: `rounds-carry` was predicted to cost *more*
per later round because its prompt carries the earlier reports, and it cost **less** — $25.35 against
`retry-blind`'s $31.06 — because its later rounds also *ran* less, 3.9 and 4.0 minutes against 4.6
and 5.1. Carrying the earlier work shortened the round instead of deepening it, which is the same
fact §3 measures.

36 runs, **0 provider errors, 0 runs stopped by the per-round $6 cap**, so nothing was excluded and
nothing was scored zero for a harness reason.

**The $2.09 discarded run.** Before launching the full batch I front-ran one `rounds-carry` sequence
to verify the carry prompt rendered in a real session. The main runner later reached that same
sequence's round 3 before the front-run had written its record, so round 3 ran twice; the surviving
record is the main runner's $1.46 run and the front-run's $2.09 is money spent on a discarded
result. The runner skips a round whose record already exists, which is why only this one round
collided. It is in the total above.

---

## 7. What this evidence supports

**Supports**

- **The review loop moves recall and the prompt did not.** `rounds-carry` − `single` is +16.7 pp,
  95% [+2.8, +35.1], winning 5 of 6 pairs. Across both lanes this is the first interval excluding
  zero; the first lane's four prompt arms spanned 21.7–26.7% with heavily overlapping intervals.
- **Most of it is another attempt, not carried information.** `retry-blind` − `single` is +11.7 pp,
  95% [+2.8, +25.0] while carrying nothing at all. Adding every earlier report, its probes and an
  explicit do-not-repeat instruction adds +5.0 pp, 95% [−5.2, +14.5].
- **A round is bounded by the reviewer's sense of being finished, not by its budget.** Every round of
  both arms used about 4 minutes of 20, as every arm of the first lane did. Ending the session is
  what resets that; more wall clock inside one session is not.
- **Three same-family rounds reach one cross-family round.** −1.7 pp, 95% [−18.8, +12.5], 3 pairs
  each, at $4.22 against $5.09 per sequence. The cross-family advantage the first lane could not
  establish is matched by restarting the same-family reviewer three times.
- **The reused baseline is sound.** 12 fresh round-1 runs score 23.3%, the same as the 6 reused ones.

**Does not support**

- **That what a round carries matters.** +5.0 pp with 95% [−5.2, +14.5] on six pairs is consistent
  with nothing. It is also consistent with a real effect of up to +14 pp; six pairs cannot separate
  those. What *is* measured is that carrying the earlier report did not make the later round better
  (26.7% → 18.3% → 21.7%) and did not make it repeat less (40% of later hits restated, against 42%
  blind).
- **That rounds reach the symlink class.** 2 of the 3 same-family class hits landed at round 1. The
  class gap closes against cross-family (p = 0.34) but the loop is not shown to be the cause.
- **Anything about attacking a fix.** The one mechanism of a real round this eval could not build —
  round N reviewing the head that fixed round N−1 — is untested. The night's reviews had it; these
  arms do not.
- **That 3 rounds is where it saturates.** The night's reviews ran 3–11. Round 3 still contributed 5
  first-detections under `rounds-carry` and 1 under `retry-blind`; nothing here says round 4 would
  not.
- **Anything about the seven pull requests whose heads are not on this box**, or the 11 of 30
  findings no arm of either lane has ever found.

**Two honest nulls, and what they narrow to**

The prompt lane returned a null on wording. This lane returns a null on *carried information* — the
part of the loop everyone assumes is the valuable part — and a positive result on the part nobody
would design for: throwing the context away and starting again. Together they say the next lever is
neither a better reviewer prompt nor a richer round hand-off. It is **how many independent cold
attempts a review gets**, and after that the one thing still untested: a round that reviews the fix
rather than the original.

What I would do with this today, if you want it: a reviewer that runs three passes in **fresh
contexts** and unions their findings, rather than one pass with a longer prompt or one pass told to
try harder. Carry the earlier reports between passes if it is easy — `rounds-carry` scored highest
at 40.0% and, because carrying shortens the later rounds, it was also the **cheaper** of the two
multi-round arms, $4.22 a head against $5.18 — but do not expect the carrying to be what helps: the
blind arm got +11.7 pp [+2.8, +25.0] of the +16.7 pp [+2.8, +35.1] while being handed nothing. The
part worth building is the restart.

**What I would measure next, in this order**

1. **Does it saturate?** Five or seven blind rounds on the same cases, which is the cheapest arm in
   this lane ($1.46 a round) and the only one whose mechanism is established. If the union keeps
   climbing, the number of cold passes is the knob.
2. **The fix-carried round.** Rebuild four or five more heads so consecutive (head, fix) pairs exist,
   then run the arm this lane had to drop. It is the only part of a real round still untested, and
   it also roughly triples n for everything else at no model cost.
3. **The symlink class on purpose**, unchanged from the first lane's recommendation: a dedicated case
   set where n comes from cases rather than from a six-finding subgroup.

---

## 8. Reproducing it

```bash
cd ~/src/oh-my-pi-worktrees/infra-724-reviewer-gap-evals
bun test scripts/reviewer-gap/rounds.test.ts            # 27 tests, incl. the first lane's numbers
bun scripts/reviewer-gap/rounds.ts \
  --runs scripts/reviewer-gap/runs/rounds-2026-10-30,scripts/reviewer-gap/runs/2026-10-30
bun scripts/reviewer-gap/rounds-audit.ts --runs scripts/reviewer-gap/runs/rounds-2026-10-30
```

`packages/coding-agent/src/prompts/agents/reviewer.md` is unchanged on this branch, nothing was
installed into `~/.omp` or `~/.dotfiles`, and no pull request was opened.
