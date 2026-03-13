// twitter-render.js — Generate bilingual HTML from blocks + translations
//
// Usage (CLI):
//   node twitter-render.js <blocks.json> <translated-blocks.json> > output.html
//
// Usage (Node.js):
//   const { renderTwitterHtml } = require('./twitter-render.js');
//   const html = renderTwitterHtml(blocks, translatedBlocks, { sourceUrl, title, targetLang });
//
// Produces the same bilingual UI as inject-translations.js:
//   - tp-block wrappers with tp-original / tp-translated
//   - Fixed header with Translated/Both/Original toggle buttons
//   - Dark mode support
//   - Long-press and right-click individual block toggle

/* eslint-disable no-var */

function _tr_escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _tr_renderBlock(block, translatedText) {
  var id = block.id;
  var type = block.type;
  var tag = block.tag;
  var html = block.html || _tr_escapeHtml(block.text);
  var level = block.level;

  // Code blocks: render as-is, no translation wrapper
  if (type === 'code') {
    return '<pre data-tp-id="' + id + '"><code>' + html + '</code></pre>';
  }

  // Image blocks
  if (type === 'image') {
    // html already contains <img> tag
    return '<figure data-tp-id="' + id + '">' + html + '</figure>';
  }

  // Determine wrapper tag for original/translated
  var wrapTag = tag || 'p';
  if (wrapTag === 'li') wrapTag = 'p'; // use p inside tp-block for list items
  if (wrapTag === 'img') wrapTag = 'p';

  var cleanTranslated = (translatedText || '').replace(/[\s\n\r]+/g, ' ').trim();

  var result = '<div class="tp-block" data-state="translated">';
  // Translated version
  result += '<' + wrapTag + ' class="tp-translated">';
  result += _tr_escapeHtml(cleanTranslated);
  result += '</' + wrapTag + '>';
  // Original version
  result += '<' + wrapTag + ' class="tp-original" data-tp-id="' + id + '">';
  result += html;
  result += '</' + wrapTag + '>';
  result += '</div>';

  return result;
}

function renderTwitterHtml(blocks, translatedBlocks, options) {
  var opts = options || {};
  var sourceUrl = opts.sourceUrl || '';
  var title = opts.title || '';
  var targetLang = opts.targetLang || '';

  // Build translation lookup: id → translated text
  // Accept three formats:
  //   1. [{id, translatedText}] — structured (preferred)
  //   2. [{id, text}] — agent stores translation in text field
  //   3. ["translated string", ...] — plain string array (index = block id)
  var translationMap = {};
  if (translatedBlocks && translatedBlocks.length) {
    for (var i = 0; i < translatedBlocks.length; i++) {
      var tb = translatedBlocks[i];
      if (typeof tb === 'string') {
        translationMap[i] = tb;
      } else {
        translationMap[tb.id] = tb.translatedText != null ? tb.translatedText : tb.text;
      }
    }
  }

  // Render body content
  var bodyContent = '';
  for (var j = 0; j < blocks.length; j++) {
    var block = blocks[j];
    var translatedText = translationMap[block.id] !== undefined
      ? translationMap[block.id]
      : block.text;
    bodyContent += _tr_renderBlock(block, translatedText);
  }

  // Build full HTML
  var html = '<!DOCTYPE html>\n<html lang="' + _tr_escapeHtml(targetLang) + '">\n<head>\n';
  html += '<meta charset="utf-8">\n';
  html += '<meta name="viewport" content="width=device-width, initial-scale=1">\n';
  html += '<title>' + _tr_escapeHtml(title) + '</title>\n';
  html += '<style>\n' + _tr_getStyles() + '\n</style>\n';
  html += '</head>\n<body>\n';
  html += _tr_getHeaderHtml(sourceUrl);
  html += '<main class="tp-content">\n';
  html += bodyContent;
  html += '</main>\n';
  html += '<script data-tp="true">\n' + _tr_getInteractionScript() + '\n</script>\n';
  html += '</body>\n</html>';

  return html;
}

function _tr_getHeaderHtml(sourceUrl) {
  var urlHtml = sourceUrl
    ? '<a class="tp-header-url" href="' + _tr_escapeHtml(sourceUrl) + '" target="_blank" rel="noopener">' + _tr_escapeHtml(sourceUrl) + '</a>'
    : '';
  return '<div class="tp-header" data-tp="true">' +
    '<div class="tp-header-inner">' +
      '<div class="tp-header-title">' +
        '<span class="tp-header-label">Translate Preview</span>' +
        urlHtml +
      '</div>' +
      '<div class="tp-header-controls">' +
        '<button class="tp-btn tp-btn-active" data-tp-mode="translated">Translated</button>' +
        '<button class="tp-btn" data-tp-mode="both">Both</button>' +
        '<button class="tp-btn" data-tp-mode="original">Original</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function _tr_getStyles() {
  return (
    /* Reset & base */
    '*, *::before, *::after { box-sizing: border-box; }' +
    'body { margin: 0; padding: 56px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; ' +
      'line-height: 1.7; color: #1f2937; background: #fff; }' +
    '.tp-content { max-width: 720px; margin: 0 auto; padding: 24px 16px; }' +

    /* Typography */
    'h1, h2, h3 { margin: 1.5em 0 0.5em; line-height: 1.3; }' +
    'h1 { font-size: 1.75em; }' +
    'h2 { font-size: 1.4em; }' +
    'h3 { font-size: 1.15em; }' +
    'p { margin: 0.8em 0; }' +
    'blockquote { margin: 1em 0; padding: 0.5em 1em; border-left: 4px solid #d1d5db; color: #4b5563; }' +
    'pre { background: #f3f4f6; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.9em; line-height: 1.5; }' +
    'code { font-family: "SF Mono", Monaco, Consolas, monospace; }' +
    'figure { margin: 1em 0; }' +
    'figure img { max-width: 100%; height: auto; border-radius: 8px; }' +

    /* Header — same as inject-translations.js */
    '.tp-header { position: fixed; top: 0; left: 0; right: 0; z-index: 99999; ' +
      'background: rgba(255,255,255,0.85); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); ' +
      'border-bottom: 1px solid rgba(0,0,0,0.1); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }' +
    '.tp-header-inner { display: flex; align-items: center; justify-content: space-between; ' +
      'padding: 8px 16px; max-width: 100%; gap: 12px; }' +
    '.tp-header-title { display: flex; flex-direction: column; min-width: 0; flex: 1; }' +
    '.tp-header-label { font-size: 13px; font-weight: 600; color: #1f2937; }' +
    '.tp-header-url { font-size: 11px; color: #6b7280; text-decoration: none; ' +
      'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }' +
    '.tp-header-url:hover { color: #3b82f6; }' +
    '.tp-header-controls { display: flex; gap: 4px; flex-shrink: 0; }' +
    '.tp-btn { padding: 4px 12px; border: 1px solid #d1d5db; border-radius: 6px; ' +
      'background: transparent; color: #374151; font-size: 12px; cursor: pointer; ' +
      'transition: all 0.15s; }' +
    '.tp-btn:hover { background: #f3f4f6; }' +
    '.tp-btn-active { background: #3b82f6; color: #fff; border-color: #3b82f6; }' +
    '.tp-btn-active:hover { background: #2563eb; }' +

    /* Bilingual blocks — same as inject-translations.js */
    '.tp-block[data-state="translated"] .tp-original { display: none; }' +
    '.tp-block[data-state="original"] .tp-translated { display: none; }' +
    '.tp-block[data-state="both"] .tp-original { ' +
      'color: #6b7280; font-size: 0.85em; ' +
      'border-left: 3px solid rgba(59,130,246,0.3); ' +
      'padding-left: 8px; margin-top: 4px; }' +

    /* Dark mode */
    '@media (prefers-color-scheme: dark) {' +
      'body { background: #111827; color: #f3f4f6; }' +
      'pre { background: #1f2937; color: #e5e7eb; }' +
      'blockquote { border-left-color: #4b5563; color: #9ca3af; }' +
      '.tp-header { background: rgba(17,24,39,0.85); border-bottom-color: rgba(255,255,255,0.1); }' +
      '.tp-header-label { color: #f3f4f6; }' +
      '.tp-header-url { color: #9ca3af; }' +
      '.tp-header-url:hover { color: #60a5fa; }' +
      '.tp-btn { border-color: #4b5563; color: #d1d5db; }' +
      '.tp-btn:hover { background: #374151; }' +
      '.tp-btn-active { background: #3b82f6; color: #fff; border-color: #3b82f6; }' +
      '.tp-block[data-state="both"] .tp-original { color: #9ca3af; }' +
    '}'
  );
}

function _tr_getInteractionScript() {
  return (
    '(function(){' +
      // Global mode switch via header buttons
      'document.addEventListener("click",function(e){' +
        'var btn=e.target.closest("[data-tp-mode]");' +
        'if(!btn)return;' +
        'var mode=btn.getAttribute("data-tp-mode");' +
        'document.querySelectorAll(".tp-block").forEach(function(b){b.setAttribute("data-state",mode);});' +
        'document.querySelectorAll(".tp-btn").forEach(function(b){b.classList.remove("tp-btn-active");});' +
        'btn.classList.add("tp-btn-active");' +
      '});' +

      // Long-press toggle on individual blocks (500ms)
      'var _tpTimer=null;' +
      'function tpToggle(block){' +
        'var s=block.getAttribute("data-state");' +
        'block.setAttribute("data-state",s==="translated"?"both":s==="both"?"original":"translated");' +
      '}' +
      'document.addEventListener("touchstart",function(e){' +
        'var block=e.target.closest(".tp-block");' +
        'if(!block)return;' +
        '_tpTimer=setTimeout(function(){tpToggle(block);},500);' +
      '},{passive:true});' +
      'document.addEventListener("touchmove",function(){if(_tpTimer){clearTimeout(_tpTimer);_tpTimer=null;}},{passive:true});' +
      'document.addEventListener("touchend",function(){if(_tpTimer){clearTimeout(_tpTimer);_tpTimer=null;}},{passive:true});' +

      // Right-click toggle on desktop
      'document.addEventListener("contextmenu",function(e){' +
        'var block=e.target.closest(".tp-block");' +
        'if(!block)return;' +
        'e.preventDefault();' +
        'tpToggle(block);' +
      '});' +
    '})();'
  );
}

// Node.js export
try {
  module.exports = {
    renderTwitterHtml: renderTwitterHtml,
    _tr_renderBlock: _tr_renderBlock,
    _tr_escapeHtml: _tr_escapeHtml,
  };
} catch (_) { /* browser */ }

// CLI mode: node twitter-render.js <blocks.json> <translated-blocks.json>
if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
    process.argv[1].replace(/\\/g, '/').endsWith('twitter-render.js')) {
  var fs = require('fs');
  var blocksFile = process.argv[2];
  var translatedFile = process.argv[3];

  if (!blocksFile || !translatedFile) {
    process.stderr.write('Usage: node twitter-render.js <blocks.json> <translated-blocks.json>\n');
    process.exit(1);
  }

  var blocksData = JSON.parse(fs.readFileSync(blocksFile, 'utf8'));
  var translatedData = JSON.parse(fs.readFileSync(translatedFile, 'utf8'));

  var output = renderTwitterHtml(
    blocksData.blocks || blocksData,
    translatedData.blocks || translatedData,
    {
      sourceUrl: blocksData.url || '',
      title: blocksData.title || '',
      targetLang: translatedData.targetLang || '',
    }
  );

  process.stdout.write(output);
}
