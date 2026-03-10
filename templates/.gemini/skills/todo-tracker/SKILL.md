---
name: todo-tracker
description: Persistent task management via TODO.md. Supports add, complete, list, delete, and heartbeat integration.
enabled: true
---

# Todo Tracker

Treat `TODO.md` as the single source of truth for task management in the workspace.
Track tasks across sessions and alert on high-priority or overdue tasks during heartbeats.

## Trigger Patterns

Use this skill **autonomously** when the following apply:

**When explicitly requested by the user:**
- "Add ~ to TODO", "add a task", "remember to..."
- "Show TODOs", "list tasks", "what's on my list"
- "Mark ~ as done", "~ done", "check off ~"
- "Delete TODO", "remove task"

**When the agent autonomously determines it's needed:**
- A task has 3 or more independent sub-steps (e.g., research → aggregate → write report)
- User requests a broad investigation ("comprehensively", "check everything", "in detail")
- Answering requires covering multiple topics

**During heartbeats:**
- Check TODO.md before returning `HEARTBEAT_OK`

## TODO.md Format

Manage `TODO.md` in the following format:

```markdown
# TODO

## High Priority 🔴
- [ ] Task name <!-- added: 2026-02-23 -->
- [x] Completed task <!-- added: 2026-02-20, done: 2026-02-21 -->

## Medium Priority 🟡
- [ ] Task name <!-- added: 2026-02-23 -->

## Low Priority 🟢
- [ ] Task name <!-- added: 2026-02-23 -->
```

## Procedures

### Add a Task

1. Call `geminiclaw_status` to get today's date
2. Read `TODO.md` (if it doesn't exist, create a new one using the format above)
3. Append to the specified priority section (default: Medium Priority)
4. Add a `<!-- added: YYYY-MM-DD -->` comment and save
5. Report: "Added: [task name]"

### Complete a Task

1. Read `TODO.md`
2. Change `[ ]` to `[x]` for the relevant task and append `<!-- added: ..., done: YYYY-MM-DD -->`
3. Save and report: "Completed: [task name]"

### List Tasks

1. Read `TODO.md` (if it doesn't exist, respond "No TODOs found")
2. Display incomplete tasks organized by priority
3. Show completed tasks in a separate section (if too many, show count only)

### Delete a Task

1. Read `TODO.md`
2. Remove the relevant line and save
3. Report: "Deleted: [task name]"

## Heartbeat Integration

During heartbeat execution, perform the following before returning `HEARTBEAT_OK`:

1. Read `TODO.md` (if it doesn't exist, skip and return `HEARTBEAT_OK` as normal)
2. Check for the following conditions:
   - 🔴 There is 1 or more incomplete high-priority task
   - There is an incomplete task whose `added` date is more than 7 days ago
3. If conditions are met → Do not return `HEARTBEAT_OK`; instead output an alert in the following format:
   ```
   📋 TODO: N high-priority, M stale (>7 days)
   - [task name] (added: YYYY-MM-DD)
   - ...
   ```
4. If no conditions are met → Return `HEARTBEAT_OK` as normal (TODO check is silent)
