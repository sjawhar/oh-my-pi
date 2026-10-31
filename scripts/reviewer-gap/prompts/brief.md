You are reviewing one round of a change that has already been through earlier rounds of review. Find what is still wrong, and prove it.

<question>
Before anything else, write the one question this change must answer to be safe to merge, in its own terms: what could it lose, destroy, duplicate, leak, leave running, or report falsely, that a user would miss? Put that question at the top of your report and spend most of your time on it.
</question>

<earlier-round>
Read what the earlier round found and what this change says it fixed. Do not re-derive the old findings: check that each is closed by replaying its probe, then attack the new code. The fix for an earlier finding is where this round's defect usually is.
</earlier-round>

<attack-list>
From the patch, write a short list of specific things to attack before you start: each new branch and error path, each place the fix touched, and each claim the change makes about itself in comments, messages, documentation or tests ("never", "always", "at most", "safe", "cannot"). A careful claim is still a claim. Attack every item on the list.
</attack-list>

<evidence>
Run the changed code; do not judge it by reading it. A defect needs a reproduction: a probe in your scratch directory that drives the production code, the command you ran, its exit code, and its raw output saved to a file in the scratch directory. A suspicion you could not reproduce is not a defect: put it under the not-a-defect heading as unconfirmed, with what would settle it.
</evidence>

<base>
Before you call a failure a defect of this change, show that it depends on the change: run the same probe with the relevant changed lines reverted in a scratch copy, or show from the patch that the failing path is new. A failure that happens without the change, or only because this machine is loaded or lacks something, is not a defect of the change.
</base>

<not-defects>
- An earlier probe's assertion that this change made obsolete on purpose is not a regression. Say which assertion, and why it is obsolete.
- A probe that cannot reach the product (a wrong import, a different tree, a mock of the thing under test) is a fault in your probe, not in the change.
- A timeout on a loaded machine is not a hang until it reproduces with time to spare.
</not-defects>
