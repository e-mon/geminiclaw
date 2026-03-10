# Site-Specific Patterns

Patterns for sites with known characteristics. **This file is auto-updated** by the agent-browser skill after each task — see SKILL.md for update rules.

## Index
- [Amazon](#amazon-amazoncojp--amazoncoma)
- [General Patterns by Site Type](#general-patterns-by-site-type)

> 5〜6サイトを超えたら site-patterns/ ディレクトリに分割を検討する。

---

## How to Add a New Site

Copy this template and fill in what you know. Mark uncertain entries with `[unverified]`.

```markdown
## SiteName (domain.com)

### Wait Strategy
- Use `wait N` — reason

### Anti-patterns
- ✗ Don't do X because Y

### Navigation / Filtering
- pattern description

### Data Extraction
- selector or pattern
```

---

## Amazon (amazon.co.jp / amazon.com)

### Wait Strategy
- Use `wait 2000` — `networkidle` never resolves (continuous ad/tracking requests)

### Anti-patterns
- ✗ `wait --load networkidle` — causes timeout every time
- ✗ Checking individual product pages for dates when sidebar date filters exist
- ✗ URL parameter manipulation for filters that are available in the sidebar UI

### Critical: Timeouts

```bash
# Amazon continuously fires network requests — networkidle never resolves
# ✗ agent-browser wait --load networkidle
# ✓
agent-browser wait 2000
agent-browser wait 3000   # for slower connections or heavy pages
```

### Search & Filtering

Prefer clicking **sidebar filters** over constructing URLs manually:

```bash
agent-browser open "https://www.amazon.co.jp/s?k=<query>&i=<category>"
agent-browser wait 2000
# Find and click filters from the snapshot instead of URL hacking
agent-browser snapshot -i | grep -E "過去7日|過去30日|カテゴリー|絞り込み"
agent-browser click @eN   # click the filter
```

Useful URL parameters when building search URLs:
- `i=digital-text` — Kindleストア
- `i=stripbooks` — 本・紙書籍
- `s=date-desc-rank` — 発売日の新しい順
- `s=review-rank` — レビュー評価順
- `page=N` — ページ番号

### Extracting Search Results

```bash
# Efficient: grep snapshot for titles and status
agent-browser snapshot -i | grep -E "link.*コミック|link.*文庫|heading.*件"

# For structured data (title + price + status across many cards):
agent-browser eval --stdin <<'EOF'
var items = [];
document.querySelectorAll('[data-component-type="s-search-result"]').forEach(function(el) {
  var title = el.querySelector('h2') ? el.querySelector('h2').textContent.trim() : '';
  var price = el.querySelector('.a-price .a-offscreen') ? el.querySelector('.a-price .a-offscreen').textContent.trim() : '';
  var asin  = el.getAttribute('data-asin') || '';
  var text  = el.innerText;
  var dateMatch = text.match(/202\d年\d+月\d+日/);
  var available = text.indexOf('今すぐ買う') !== -1 || text.indexOf('すぐに購読可能') !== -1;
  var preorder  = text.indexOf('発売予定日') !== -1;
  items.push(title.substring(0,60) + '|||' + price + '|||' + (dateMatch ? dateMatch[0] : '既発売') + '|||' + (preorder ? '予約' : available ? '購入可' : '?') + '|||' + asin);
});
items.join('\n');
EOF
```

### Product Detail Page — Common Selectors

```bash
# Publication date (Kindle)
agent-browser eval 'document.querySelector("#rpi-attribute-book_details-publication_date .rpi-attribute-value")?.textContent?.trim()'

# Product title
agent-browser eval 'document.querySelector("#productTitle")?.textContent?.trim()'

# Price
agent-browser eval 'document.querySelector(".a-price .a-offscreen")?.textContent?.trim()'
```

### Pagination

```bash
# Find and click "Next page" from snapshot
agent-browser snapshot -i | grep -E "次のページ|次へ|button.*ページ"
agent-browser click @eN
agent-browser wait 2000
```

---

## General Patterns by Site Type

### E-Commerce / Catalogue Sites (Rakuten, Yahoo Shopping, etc.)

- Avoid `networkidle` — they load ads/tracking continuously
- Look for sidebar date/category filters before constructing filter URLs
- Product cards usually share a common CSS class — use `eval` to batch-extract
- Pagination: look for `次へ` / `next` button in snapshot

### News / Blog Sites

- Usually `networkidle` works (less dynamic after initial load)
- Article lists often have `article` or `[class*="post"]` selectors
- Date filters may not exist in UI — URL parameters or search may be needed

### SPAs (Single Page Apps — React, Vue, etc.)

- Use `wait --fn "document.readyState === 'complete'"` or wait for a specific element
- Snapshot after route changes, not just after `open`
- Content may be in shadow DOM — `snapshot -i -C` to expose more elements

### Login-Required Sites

- Save state after login: `agent-browser state save auth.json`
- Reuse: `agent-browser state load auth.json` before `open`
- See `references/authentication.md` for OAuth and 2FA flows
