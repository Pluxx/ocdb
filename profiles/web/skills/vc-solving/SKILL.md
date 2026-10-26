---
name: vc-solving
description: Prepare a compact evidence packet before asking the user to approve one VC-Solver analysis
---

# Preparing a solver call

The solver is expensive and has only a few steps, so it works from the evidence
you give it. Use it only for a real blocker that normal triage couldn't resolve,
and only after the user approves that specific call.

## Evidence packet

Gather this with normal agents first; don't pay the solver to discover it:

- The objective and one precise question.
- Installed versions, relevant dependencies, and the runner/environment.
- A minimal reproduction, with expected vs. observed behavior and the exact error.
- Relevant `path:line` excerpts and caller context, not a repository dump.
- Fixes already tried, and what they ruled out.
- Constraints: compatibility, data/security risks, and files that must not change.

Redact secrets, tokens, cookies, and personal data.

## After the call

Treat the report as a proposal, not proof. Assign one agent to implement it and
another to validate it, then run the narrow reproduction followed by the suite.
Don't call the solver again on the same problem unless there's new evidence and
the user approves again.
