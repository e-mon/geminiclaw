// render.js — Unified bilingual HTML rendering
//
// Usage:
//   node render.js <blocks.json> <translated-blocks.json> > output.html
//
// Detects the domain from blocks.json internally:
//   - x.com → standalone HTML (no browser needed)
//   - Others → injection into live page via agent-browser
//
// Exit codes:
//   0 — success
//   1 — invalid arguments
//   3 — rendering failed

/* eslint-disable no-var */

var fs = require('fs');
var cp = require('child_process');
var tr = require('./twitter-render.js');
var bi = require('./build-injection.js');

var blocksFile = process.argv[2];
var translatedFile = process.argv[3];

if (!blocksFile || !translatedFile) {
  process.stderr.write('Usage: node render.js <blocks.json> <translated-blocks.json>\n');
  process.exit(1);
}

var blocksData = JSON.parse(fs.readFileSync(blocksFile, 'utf8'));
if (typeof blocksData === 'string') blocksData = JSON.parse(blocksData);
var translatedData = JSON.parse(fs.readFileSync(translatedFile, 'utf8'));
if (typeof translatedData === 'string') translatedData = JSON.parse(translatedData);

if (blocksData.domain === 'x.com') {
  // Twitter: standalone HTML generation (no browser needed)
  var html = tr.renderTwitterHtml(
    blocksData.blocks || blocksData,
    translatedData.blocks || translatedData,
    {
      sourceUrl: blocksData.url || '',
      title: blocksData.title || '',
      targetLang: translatedData.targetLang || '',
    }
  );
  process.stdout.write(html);
} else {
  // Non-Twitter: build injection payload, eval on the live page in agent-browser
  try {
    var injection = bi.buildInjectionPayload(blocksData, translatedData);
    var raw = cp.execFileSync('agent-browser', ['eval', '--stdin'], {
      input: injection,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    // agent-browser eval JSON-stringifies the return value, so the HTML string
    // comes back double-quoted: "\"<!DOCTYPE html>...\"". Unwrap it.
    var output = raw;
    try { var parsed = JSON.parse(raw); if (typeof parsed === 'string') output = parsed; } catch (_) {}
    process.stdout.write(output);
  } catch (err) {
    process.stderr.write('Error: ' + (err.message || err) + '\n');
    process.exit(3);
  }
}
