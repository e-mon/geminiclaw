// build-injection.js — Bundle __TP_DATA__ + inject-translations.js into one eval-ready JS
//
// Usage:
//   node build-injection.js <blocks.json> <translated-blocks.json> > injection.js
//
// The output is a single JS string that:
//   1. Sets window.__TP_DATA__ with merged block + translation data
//   2. Includes inject-translations.js (which auto-executes when __TP_DATA__ is present)
//
// The agent then does one eval call:
//   agent-browser eval <contents of injection.js>

/* eslint-disable no-var */

var fs = require('fs');
var path = require('path');

function buildInjectionPayload(blocksData, translatedData) {
  var blocks = blocksData.blocks || blocksData;
  var translated = translatedData.blocks || translatedData;

  var translationMap = {};
  for (var i = 0; i < translated.length; i++) {
    translationMap[translated[i].id] = translated[i].translatedText;
  }

  var mergedBlocks = [];
  for (var j = 0; j < blocks.length; j++) {
    var b = blocks[j];
    mergedBlocks.push({
      id: b.id,
      type: b.type,
      translatedText: translationMap[b.id] !== undefined ? translationMap[b.id] : b.text,
    });
  }

  var tpData = {
    blocks: mergedBlocks,
    sourceUrl: blocksData.url || '',
    title: blocksData.title || '',
    targetLang: translatedData.targetLang || '',
  };

  // Include extract-blocks.js so extractBlocks() is available for DOM re-marking
  // (inject-translations.js calls extractBlocks() if defined, to handle SPA re-renders)
  var extractPath = path.join(__dirname, 'extract-blocks.js');
  var extractSource = fs.readFileSync(extractPath, 'utf8');
  var injectPath = path.join(__dirname, 'inject-translations.js');
  var injectSource = fs.readFileSync(injectPath, 'utf8');

  return 'window.__TP_DATA__ = ' + JSON.stringify(tpData) + ';\n' + extractSource + '\n' + injectSource;
}

try {
  module.exports = { buildInjectionPayload: buildInjectionPayload };
} catch (_) { /* browser */ }

// CLI mode
if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
    process.argv[1].replace(/\\/g, '/').endsWith('build-injection.js')) {
  var blocksFile = process.argv[2];
  var translatedFile = process.argv[3];

  if (!blocksFile || !translatedFile) {
    process.stderr.write('Usage: node build-injection.js <blocks.json> <translated-blocks.json>\n');
    process.exit(1);
  }

  var blocksData = JSON.parse(fs.readFileSync(blocksFile, 'utf8'));
  var translatedData = JSON.parse(fs.readFileSync(translatedFile, 'utf8'));

  process.stdout.write(buildInjectionPayload(blocksData, translatedData));
}
