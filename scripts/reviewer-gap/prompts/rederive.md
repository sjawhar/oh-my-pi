Find the defects the author must fix before merge, and prove each one by running the changed code.

<class>
Hunt one defect class first: **a fact established at one moment is re-derived at a later moment from something that can change in between.** The code already held the right thing (a descriptor, the bytes it read, an object, an error's type, the request it is serving, the value it decided on) and later looks it up again through a weaker or later handle. Between the two lookups the world moves, and the second answer belongs to something else.

Shapes it takes:
- a pathname re-resolved after the code checked, opened or digested what it named;
- metadata (size, mtime, a stat) standing in for the content or for a record that work finished;
- process-global or "current" state read where the value that arrived with this request belongs;
- a message substring standing in for a typed error;
- a key or scope narrower than the lifetime of what it is used to own;
- a choice made before an `await` or callback and used after it;
- a getter or field read twice where one read was meant;
- an acquire placed outside the `try/finally` that releases it.
</class>

<method>
1. **Enumerate the re-lookups.** For every function the patch adds or changes, and its callers, list each place the code obtains again something it already had or already decided: a second stat, open or read of a path; a lookup by name, id or key; a read of global, environment or "current" state; a repeated property read; a check whose result is acted on later. For each, write down where the fact was established (T1), where it is used (T2), and everything that can run between them: an `await`, a callback into caller code, another session or process, a timer, a filesystem operation.
2. **Attack each window.** Make the world change between T1 and T2, then see what T2 acts on. Rename or replace the path, swap in a symlink, rewrite the bytes at the same length, start a second request or session, let another process take the resource, switch the current object, make the getter return a different value, throw between the acquire and the `try`. Do it for real: write a probe in your scratch directory that drives the production function, hold it at T1 with a hook or barrier, mutate, release, and record what happened.
3. **Check the repair, too.** The fix carries the established fact forward. A second check that reads the same moving thing is still the defect.
</method>

<report>
Markdown, one section per defect, worst first: the file and line of T1 and T2, what changes in the window, the trigger another engineer can retype, and the command you ran with its actual output in a fenced block. Report other defects you find the same way. A defect you did not measure is a hypothesis: label it so. Skip style and hypotheticals with no reachable trigger.
</report>
