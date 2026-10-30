# Re-derivation class: labelling rubric (frozen 2026-10-30, before any record was labelled)

Each corpus finding gets exactly one label. Label from the mechanism the record states in
`title`, `files`, `trigger` and `measured`. Do not guess at code the record does not describe.

## The class

A finding is an **`instance`** when all three hold:

1. **Established (T1).** At some point the code holds or establishes a fact: an identity (this
   file, descriptor, inode, directory, object, session, kernel, run, lease, provider), a value
   (bytes read, a digest, a root, a selection, a configuration value), the kind of an outcome
   (this error means the run ended), an ownership or scope, or a decision derived from those.
2. **Re-derived (T2).** Later, the code obtains that fact again, or a proxy for it, through a
   handle that can resolve differently from what T1 established:
   - a pathname, name, id or key re-resolved after the code checked, opened or digested what it named;
   - metadata (size, mtime, a stat) used as a proxy for content, or for a record that work finished;
   - process-global, environment, module-level or "current" state read where the value that
     arrived with this request or call belongs;
   - message text matched as a proxy for an error's type;
   - a key or scope narrower than the lifetime of the thing it is used to own;
   - a choice (provider, model, root, target, holder) made before an `await` or callback and used after it;
   - a getter or field read a second time where one read was meant;
   - an acquire (lease, lock, registration, counter) placed outside the `try/finally` that releases it.
3. **The window matters.** The defect happens because the source changes, or can be made to
   change, between T1 and T2 (another process, session or request; the filesystem; a timer;
   caller or author code; the code's own later step), so T2 acts on something other than what
   T1 established.

A finding is **`adjacent`** when it is a check-then-act race in which a decision made at T1 is
false by T2 but T2 looks nothing up again: it acts on the same object with a stale decision
(for example, it decides a holder is dead and deletes it after the holder came back). These are
reachable by "attack the window between establishment and use", but they are not re-derivations.

Everything else is **`not`**. In particular:

- an incomplete enumeration or inventory (a call site, consumer, branch, variant or path missed);
- a wrong bound, budget, timeout or arithmetic;
- an error mishandled, or a fault that is not cleaned up, with no re-derivation in the mechanism;
- in-process state invisible to another process, unless the defect is a scope narrower than lifetime (shape 5);
- an identity computed from a string or path with no earlier established identity (two aliases
  produce two lock names at the same moment: aliasing, not re-derivation);
- performance, resource exhaustion, availability with no T1/T2;
- documentation, changelog, PR-body or diagnostic-text claims; tests that do not test what they claim.

## Decision rules

- When a record supports both readings, use the mechanism the record itself states.
- If the record does not let you name T1 and T2, the label is `not` unless the title itself
  names a re-lookup.
- A finding about a repair that re-checks through the same moving handle is an `instance`.
- One label per record. Do not split a record.

## Output: one JSON object per line

```json
{"id": "EXAMPLE-1", "label": "instance", "shape": "metadata-proxy", "t1": "descriptor read of the staged bytes", "t2": "second stat compared for equality", "window": "same-length in-place rewrite between the read and the second stat", "reason": "equal stats are taken as proof the bytes read are the bytes published"}
```

`shape` is one of `path-reresolved`, `metadata-proxy`, `global-for-request`, `message-for-type`,
`scope-narrower-than-lifetime`, `choice-across-await`, `double-read`, `acquire-outside-finally`,
`other` for an `instance`; `null` for `adjacent` and `not`. `t1`, `t2` and `window` are `null`
for `not`.
