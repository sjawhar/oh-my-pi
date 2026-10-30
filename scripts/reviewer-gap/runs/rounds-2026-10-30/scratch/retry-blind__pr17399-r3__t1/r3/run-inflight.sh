#!/bin/bash
# Run from packages/agent of the snapshot.
S=/mnt/nvme/sami/tmp/cachefix/reviewer-evals/rounds/scratch/retry-blind__pr17399-r3__t1/r3
ROOT=$(mktemp -d)
PROBE_ROOT=$ROOT PROBE_ROLE=paused bun test "$S/inflight-proc.test.ts" &
A=$!
sleep 4
PROBE_ROOT=$ROOT PROBE_ROLE=free timeout 45 bun test "$S/inflight-proc.test.ts"
echo "free process exit=$? (124 = killed by 45s timeout)"
find "$ROOT" | head -20
kill $A
rm -rf "$ROOT"
