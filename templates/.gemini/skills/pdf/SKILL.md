---
name: pdf
description: Safe PDF reading via text extraction. Use this skill whenever you need to read, analyze, or extract content from PDF files. Gemini CLI's read_file sends PDFs as base64 inlineData which frequently causes API errors (400/500), garbled output, or empty responses. This skill avoids those failures by extracting text with pdftotext first. Triggers on any task involving PDF files — paper analysis, document review, data extraction from PDFs, or when a user shares a PDF URL.
enabled: true
---

# PDF — Safe Reading via Text Extraction

Gemini CLI's `read_file` sends PDFs as base64 to the API, which causes frequent failures:
- 400 "The document has no pages" (corrupted or misidentified files)
- 500 Internal Server Error (API crashes on certain PDFs)
- Garbled output (model produces control characters instead of text)
- Empty response (model returns nothing)

This skill bypasses all of these by extracting text locally before reading.

## Core Rule

**Never use `read_file` on PDF files.** Always extract text first with `pdftotext`.

## Workflow

### 1. Download (if needed)

Always use `-L` to follow redirects — many academic sites (arxiv, ACM, IEEE) redirect.

```bash
curl -sLO "https://example.com/paper.pdf"
```

### 2. Validate

Check the file is actually a PDF before processing.

```bash
file paper.pdf
# Expected: "PDF document, version 1.7, 12 pages"
# Bad sign: "HTML document" or "ASCII text" — download failed
```

If validation fails, the download likely got a redirect page or error HTML instead of the actual PDF. Retry with the correct URL or try a versioned URL (e.g., `arxiv.org/pdf/XXXX.XXXXXv1`).

### 3. Extract text

```bash
# Full document
pdftotext paper.pdf paper.txt

# Preserve layout (tables, columns)
pdftotext -layout paper.pdf paper.txt

# Specific page range (for large documents)
pdftotext -f 1 -l 10 paper.pdf paper.txt
```

Then read the extracted text with `read_file paper.txt`.

### 4. If pdftotext is not installed

```bash
# macOS
brew install poppler

# Debian/Ubuntu
sudo apt-get install -y poppler-utils
```

## Edge Cases

### Scanned PDFs (no extractable text)

If `pdftotext` produces empty or near-empty output, the PDF likely contains scanned images.

```bash
# Check if extraction yielded content
wc -c paper.txt
# If very small (< 100 bytes) for a multi-page doc → scanned PDF
```

Inform the user that OCR is needed. If `tesseract` is available:

```bash
# Convert pages to images, then OCR
pdftoppm -png -r 150 paper.pdf page
for img in page-*.png; do tesseract "$img" "${img%.png}" 2>/dev/null; done
cat page-*.txt > paper.txt
rm page-*.png page-*.txt
```

### Tables and structured data

Use `-layout` flag first. If table structure is still unclear, extract the specific page and explain the layout to the user rather than guessing.

```bash
pdftotext -layout -f 3 -l 3 paper.pdf table_page.txt
```

### Large documents (50+ pages)

Extract in chunks rather than all at once to keep context manageable.

```bash
# First 10 pages for overview
pdftotext -f 1 -l 10 paper.pdf overview.txt

# Then targeted sections as needed
pdftotext -f 25 -l 30 paper.pdf section.txt
```
