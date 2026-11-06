# Autonomous work

The sole active task queue is [GitHub Issues](GITHUB_ISSUES.md) in `Tarolrr/screeps`. Migration and readback are complete, and `queue-source.json` selects GitHub. `state/tasks.json` is a read-only archive, never a fallback. Queue access or data errors are errors, never an empty queue. Coordinators share a lease in the Git common directory.

1. Read HANDOFF, inspect Git, the Issues queue and lease, and distinguish new facts from an idle cycle.
2. Under a lease, the coordinator records actionable issues, acceptance criteria, dependencies and priorities. Assign workers bounded write scopes and record active worker references with heartbeat. Only the coordinator changes issues, labels and comments.
3. Collect evidence and arrange independent read-only review when authorized. Address findings, accept results, update the issue, and clear worker references only after workers have stopped. Record any review limitation.
4. Release the lease. Scheduled runs also follow AUTOMATION_PROMPT and PROCESS.

See PROCESS for roles and run outcomes; RECOVERY for the lease protocol; TASK, DELEGATION and REVIEW templates for prompts; AUTOMATION_BOOTSTRAP for the disabled scheduler integration. Run offline infrastructure tests with `python3 -m unittest discover -s autonomy -p 'test_*.py'`. Tests use temporary repositories and fake endpoints; never test against a real automation.
