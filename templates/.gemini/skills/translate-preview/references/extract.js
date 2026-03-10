// extract.js — Unified block extraction from any URL
//
// Usage:
//   node extract.js <URL> > blocks.json
//
// Detects the URL domain internally:
//   - X/Twitter URLs → fxtwitter API (no browser needed)
//   - All other URLs → agent-browser + extract-blocks.js
//
// Exit codes:
//   0 — success
//   1 — invalid arguments
//   2 — not an article tweet (Twitter only)
//   3 — extraction failed

/* eslint-disable no-var */

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var te = require('./twitter-extract.js');

var url = process.argv[2];
if (!url) {
  process.stderr.write('Usage: node extract.js <URL>\n');
  process.exit(1);
}

var parsed = te.parseTweetUrl(url);

if (parsed) {
  // Twitter path: fxtwitter API
  var apiUrl = 'https://api.fxtwitter.com/' + parsed.user + '/status/' + parsed.statusId;
  fetch(apiUrl)
    .then(function(res) {
      if (!res.ok) throw new Error('API returned ' + res.status);
      return res.json();
    })
    .then(function(json) {
      var result = te.convertFxtwitter(json);
      if (!result) {
        process.stderr.write('Error: Tweet does not contain an article\n');
        process.exit(2);
      }
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    })
    .catch(function(err) {
      process.stderr.write('Error: ' + err.message + '\n');
      process.exit(3);
    });
} else {
  // Non-Twitter: agent-browser
  try {
    cp.execFileSync('agent-browser', ['open', url], { stdio: ['ignore', 'ignore', 'inherit'] });
    // Wait for SPA hydration/rendering before extracting
    cp.execFileSync('agent-browser', ['wait', '2000'], { stdio: ['ignore', 'ignore', 'inherit'] });
    var extractScript = fs.readFileSync(path.join(__dirname, 'extract-blocks.js'), 'utf8');
    var raw = cp.execFileSync('agent-browser', ['eval', '--stdin'], {
      input: extractScript,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    // agent-browser eval returns the result JSON-stringified, so extract-blocks.js's
    // JSON.stringify() output gets double-encoded as "\"{ ... }\"". Unwrap it.
    var parsed = JSON.parse(raw);
    var output = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
    process.stdout.write(output + '\n');
  } catch (err) {
    process.stderr.write('Error: ' + (err.message || err) + '\n');
    process.exit(3);
  }
}
