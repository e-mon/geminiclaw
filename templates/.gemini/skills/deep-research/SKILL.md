---
name: deep-research
description: Conduct thorough research using multi-angle queries, reading multiple sources, and cross-referencing.
enabled: true
---

# Deep Research

A skill for systematically investigating topics that cannot be answered with a single search or that require cross-referencing multiple sources.

## Trigger Patterns

Use **this skill** when the following apply:

- User asks to "research", "investigate", "compare", or "give a comprehensive overview"
- User asks for "reviews", "reputation", or "opinions"
- A single search cannot answer the question / cross-referencing multiple sources is needed
- User asks for "latest information" (date-stamped information is required)

## Research Flow

### Step 1: Confirm Scope

If the scope is ambiguous, **ask questions before proceeding**:

- What is the purpose of the research? (purchase decision / technology selection / knowledge acquisition)
- Are there preferred source types? (official documents / user reviews / numerical data)
- How deep should the research go? (overview sufficient / detailed comparison needed)

### Step 2: Declare Research Axes

Declare the angles to cover to the user before execution:

```
Research axes:
- Official information & specs
- User reviews & opinions
- Comparison with competitors & alternatives
- Latest developments (date-stamped)
- Community & expert discussions
```

### Step 3: Search with 5+ Queries

**Execute independent queries for each axis**. Do not repeat the same angle.

| Axis | Query Example |
|---|---|
| Official / authoritative sources | `{topic} official documentation specs` |
| Reviews & opinions | `{topic} review opinion site:reddit.com OR news.ycombinator.com` |
| Comparison & benchmarks | `{topic} vs {competitor} comparison 2026` |
| Latest information | `{topic} 2026 latest update` |
| Community | `{topic} issues drawbacks pitfalls` |

> **Prohibited**: Drawing conclusions from a single search. Answering based on snippets alone without reading actual pages.

### Step 4: Read Primary Pages

Search result snippets are only summaries. **Read the full text of the top 3-5 results using `web_fetch` or `agent-browser`**.

- Dynamic content / pages requiring login → `agent-browser`
- Static pages / official documentation → `web_fetch`

### Step 5: Cross-Reference

Cross-check important claims (prices, specs, ratings, figures) with **2 or more sources**.

- Claims with only one source should be explicitly labeled as "single-source information"
- Contradictory information should present both sides, weighting the more reliable source

### Step 6: Save Research Results

Save to `memory/research-YYYY-MM-DD-{topic}.md` (get the date from `geminiclaw_status`):

```markdown
# Research: {topic}
Date: YYYY-MM-DD

## Summary
(1-3 sentences)

## Findings
### {Axis 1}
...

### {Axis 2}
...

## Conclusion
(Judgment / recommendation / caveats)

## Sources
- [Title](URL) — Retrieved: YYYY-MM-DD
```

### Step 7: Return a Structured Summary

Report to the user in the following format:

```
## Research Results: {topic}

### Summary
(2-3 sentence overview)

### Key Findings
- **{Axis}**: ...
- **{Axis}**: ...

### Conclusion
(Recommendation / judgment / caveats)

### Sources
- [Title](URL)
```

## Prohibited Patterns

- Drawing conclusions from a single search
- Answering based on snippets alone without reading actual pages
- Asserting single-source information as fact
- Treating undated information as "latest"
