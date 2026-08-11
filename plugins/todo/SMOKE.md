# TODO extension live smoke check

This is intentionally a manual post-install smoke check, not a unit test. Do not run it from the unit-test suite or against an external Wayang/Pi service automatically.

1. Install or link `plugins/todo/` into a disposable interactive Pi profile and start a persisted session.
2. Add todos with different statuses and priorities. Confirm the widget and `todo list` use status/priority ordering before any explicit reorder.
3. Run `todo reorder` with a visibly different ID order. Confirm the tool result, expanded renderer, widget, `/todos`, and `/todos-full` show that explicit order.
4. End a turn, restart/resume the session, and confirm the reordered list is unchanged.
5. In `/todos-full`, toggle or delete a task and close the manager. Immediately restart/resume without another agent turn; confirm the manager mutation persisted.
6. Use `/tree` to select a branch before any TODO snapshot. Confirm the widget clears and `todo list` reports no todos rather than retaining state from the abandoned branch.
7. Resume a legacy session containing a valid `todo` tool-result or `todo-state` custom snapshot without `nextId`. Confirm the next added todo receives `max(existing id) + 1` and the session remains resumable.
