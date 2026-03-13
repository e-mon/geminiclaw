---
name: translate-preview
description: Translate a web page while preserving its original DOM structure, CSS, and images. Generates a self-contained bilingual preview HTML with toggle controls. Use this skill whenever the user shares a URL and asks for translation, translated preview, bilingual view, or when the channel topic instructs to use translate-preview. Do NOT write your own translation scripts — always use this skill's reference files.
enabled: true
---

# Translate Preview

Translate a web page into a bilingual preview HTML with toggle controls (Translated/Both/Original).

## Flow

All domain-specific logic (Twitter vs general web) is handled internally by the scripts. Do NOT write your own extraction, injection, or rendering code.

### Step 1: Extract blocks

```
node .gemini/skills/translate-preview/references/extract.js <URL> > runs/{sessionId}/blocks.json
```

If `blockCount` < 3, the page may be behind a login wall. Inform the user.

### Step 2: Translate

Translate all blocks at once to preserve cross-paragraph context. Save to `runs/{sessionId}/translated-blocks.json`.

**Output format**: Array of objects matching blocks.json structure with `translatedText` added:
```json
[
  {"id": 0, "type": "paragraph", "translatedText": "Translated text"},
  {"id": 1, "type": "heading", "translatedText": "Translated heading"}
]
```

- Each object MUST have `id` (matching blocks.json) and `translatedText`
- `type: "code"` → copy original text as-is to `translatedText`
- `type: "image"` → copy text as-is (translate substantial captions)
- Preserve proper nouns and brand names in original form
- If the target language is not specified, ask the user

### Step 3: Generate preview HTML

```
node .gemini/skills/translate-preview/references/render.js \
  runs/{sessionId}/blocks.json runs/{sessionId}/translated-blocks.json \
  > runs/{sessionId}/translate-preview.html
```

### Step 4: Send

```
MEDIA:runs/{sessionId}/translate-preview.html
```

Copy to `preview/` with a descriptive filename and include the preview URL in the response.
