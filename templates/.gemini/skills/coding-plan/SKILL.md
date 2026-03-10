---
name: coding-plan
description: Read before planning, declare scope before implementing. Prohibit out-of-scope changes and full rewrites.
enabled: true
---

# Coding Plan

A skill applied to all coding tasks that modify existing files.
Adapted from Claude Code's EnterPlanMode + TaskCreate approach for the Gemini agent.

## Trigger Patterns

Use **this skill** when the following apply:

- "Implement", "write code", "add a feature"
- "Fix a bug", "write tests", "refactor"
- Any task that modifies existing files

## Flow

### Phase 1: READ FIRST (Always read before writing)

> **Principle**: Never edit or propose changes without reading first.

1. Read all files related to the task
2. Look for existing patterns, reusable functions, and type definitions
3. Check the test setup (test file locations, framework)
4. Trace dependencies (import/require targets)

### Phase 2: Declare the Plan (EnterPlanMode equivalent)

Declare the following to the user before execution:

```
✅ What will be changed
- {file}: {change description} — Done when: {verifiable criteria}
- ...

❌ Out of scope (will not be changed)
- {file/feature}: Outside the scope of this request

⚠️ Irreversible operations (if any)
- {operation}: {impact scope} — Will confirm before executing
```

If the scope is ambiguous, **ask questions before declaring**:

- "Should I also change ~, or is that out of scope?"
- "This involves breaking changes (API changes / file deletion). Should I proceed?"

### Phase 3: Record Subtasks in todo-tracker

Use `skills/todo-tracker/SKILL.md` to record in `TODO.md`:

- Split into **independently verifiable units**
- Attach **completion criteria** to each entry (e.g., "tests pass", "file exists")
- If there are dependencies, specify the order explicitly

Example:
```markdown
- [ ] Add {function} to src/foo.ts <!-- Done when: no tsc errors, tests pass -->
- [ ] Add tests to tests/foo.test.ts <!-- Done when: npm test passes -->
```

### Phase 4: Step-by-Step Execution

**Prefer small, targeted edits to existing files** (full rewrites are prohibited).

Prohibited patterns:
- Improvements, optimizations, comment additions, or docstring additions outside the request
- "While I'm at it" fixes to files outside the scope
- Rewriting an entire file at once
- Fixing pre-existing bugs without being asked

Check off each step in `TODO.md` upon completion.

**Confirm with the user before executing** irreversible operations (file deletion, dependency removal, breaking API changes).

### Phase 5: Verification & Report

1. Run tests if they exist and check results
2. Verify against the success criteria declared in Phase 2
3. Return a summary of changes to the user:

```
## Done: {task name}

### What was changed
- `{file}`: {change description}

### Verification results
- {test results / build results}

### Out of scope (not changed)
- {reason}
```

## Prohibited Patterns (Summary)

| Prohibited | Reason |
|---|---|
| Editing without reading first | Breaks existing patterns / creates duplication |
| Adding improvements beyond the request scope | Introduces changes the user did not intend |
| Rewriting an entire file at once | Makes diffs hard to follow / risks deleting existing logic |
| Executing irreversible operations without confirmation | Causes unexpected loss for the user |
| Brute-forcing without stopping to analyze | Hides root causes and increases technical debt |
