<!-- mode: shared -->
note: **Implementation handoff** — split independent work units from the Files of the plan. Start w-implementer with a single `Agent` tool spawn per unit.

```
Agent tool:
  name: w-implementer-1  (match the name in the plan)
  subagent_type: w-implementer
  model: (the model the plan gives the unit; sonnet when the plan gives none)
  prompt: (paste the task instructions, target files, and expected_output of the plan as they are)
```

Take the name and the model of each unit from the work unit table in the Files of the plan. The criteria for the model are in `skills/w-help/references/agent-models.md` of the pecot-w plugin.
In GitHub Copilot CLI, omit `model` or pass a Copilot model name. `sonnet` and `opus` are Claude Code aliases.

Start w-implementer-2, -3... in parallel, one per independent work unit.
Spawn them with multiple `Agent` calls in one message. Spawning them in separate messages runs them serially.

How it proceeds:

1. The implementation result reaches main by notification when the work finishes.
   A spawn with agent teams enabled and a `name` reports through the teammate's idle notification.
   Any other spawn reports through the completion notification.
   Follow-up requests and questions go from main with `SendMessage`, addressed by name.
2. The prompt to w-implementer does not include a commit instruction. Do not write "commit" or "commit before returning".
3. When w-implementer finishes, it returns the list of changed files and the results.
   Finishing means the implementation, plus green linters and green tests for the affected scope.
4. Committing is main's responsibility. Subagents running in parallel that commit to the same worktree collide.
   So main alone commits. When main receives the implementation results, main commits them itself.
