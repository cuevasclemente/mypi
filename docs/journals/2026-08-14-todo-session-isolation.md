# TODO session isolation

**Date:** 2026-08-14

## Summary

Integrated the existing TODO isolation fix onto current `mypi` main. TODO state is now owned by each extension factory invocation and reconstructed from only the active session branch, preventing concurrent Wayang/Pi sessions from sharing live mutable state.

Forks and clones continue to inherit the source session branch intentionally. New and unrelated sessions remain independent, apart from TODO preseeds that hooks add separately to each session.

Wayang required no code change: its TODO panel already derives state from the selected session transcript.

## Validation

- Rebased `fix/todo-session-isolation` onto `main` without conflicts.
- Focused suite: 11/11 tests passed (`plugins/todo/index.test.ts`).
- `git diff --check` passed.
- Integrated source and `~/.pi/agent/extensions/todo/index.ts` had identical SHA-256 digests, so no runtime replacement was needed.

A standalone strict TypeScript invocation is not a repository gate and reported existing/dead legacy-block typing issues; executable TypeScript import and the focused behavioral suite passed.
