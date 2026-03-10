// translate-preview: DOM text block extractor
// Run via agent-browser execute_js on target page.
// Returns JSON string of translatable text blocks.
//
// Node.js (tests):
//   const { extractBlocks } = require('./extract-blocks.js');
//   extractBlocks(document);
//
// Browser (agent-browser execute_js):
//   Paste this file's content — the IIFE at the bottom returns JSON.

/* eslint-disable no-var */
var SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO',
  'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'HEAD',
]);

var NAV_ROLES = new Set([
  'navigation', 'banner', 'contentinfo', 'complementary',
  'search', 'form', 'menubar', 'toolbar',
]);

var NAV_TAGS = new Set(['NAV', 'FOOTER', 'HEADER']);

var BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'TD', 'TH', 'DT', 'DD', 'CAPTION', 'FIGCAPTION',
  'BLOCKQUOTE', 'PRE', 'SUMMARY', 'LABEL',
]);

var LIST_PARENTS = new Set(['UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR']);

function _eb_isHidden(el) {
  // Check inline style
  if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return true;
  // Check hidden / aria-hidden attributes
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
  // Browser-only: check computed style
  if (typeof getComputedStyle === 'function' && el.offsetParent === null &&
      el.tagName !== 'BODY' && el.tagName !== 'HTML') {
    try {
      var style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
    } catch (_) { /* jsdom may throw */ }
  }
  return false;
}

function _eb_isNavArea(el) {
  if (NAV_TAGS.has(el.tagName)) return true;
  var role = el.getAttribute('role');
  if (role && NAV_ROLES.has(role)) return true;
  var cls = (el.className || '').toString().toLowerCase();
  if (/\b(nav|menu|sidebar|footer|header|breadcrumb|cookie|banner|ad[s]?)\b/.test(cls)) return true;
  var id = (el.id || '').toLowerCase();
  if (/\b(nav|menu|sidebar|footer|header|breadcrumb|cookie|banner|ad[s]?)\b/.test(id)) return true;
  return false;
}

function _eb_getText(el) {
  var t = (typeof el.innerText === 'string') ? el.innerText : el.textContent;
  return t ? t.trim() : '';
}

function _eb_classifyTag(tag) {
  if (/^H[1-6]$/.test(tag)) return 'heading';
  if (tag === 'LI') return 'list-item';
  if (tag === 'TD' || tag === 'TH') return 'table-cell';
  if (tag === 'DT') return 'def-term';
  if (tag === 'DD') return 'def-desc';
  if (tag === 'BLOCKQUOTE') return 'quote';
  if (tag === 'PRE') return 'code';
  if (tag === 'FIGCAPTION' || tag === 'CAPTION') return 'caption';
  if (tag === 'SUMMARY') return 'summary';
  if (tag === 'LABEL') return 'label';
  return 'paragraph';
}

var _EB_INLINE_TAGS = new Set([
  'SPAN', 'A', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'SMALL',
  'SUB', 'SUP', 'ABBR', 'CITE', 'CODE', 'TIME', 'MARK', 'LABEL',
]);

function _eb_findBlockAncestor(node) {
  // Walk up to find the nearest non-inline ancestor that could serve as a merge group.
  // Skip pure inline wrappers (e.g., <span> wrapping a single <span>).
  var cur = node.parentNode;
  for (var d = 0; d < 5 && cur && cur.getAttribute; d++) {
    if (!_EB_INLINE_TAGS.has(cur.tagName)) return cur;
    cur = cur.parentNode;
  }
  return node.parentNode;
}

function _eb_mergeInlineSiblings(doc, blocks) {
  // Build a map from data-tp-id to DOM node in one pass
  var nodeMap = {};
  var marked = doc.querySelectorAll('[data-tp-id]');
  for (var m = 0; m < marked.length; m++) {
    nodeMap[marked[m].getAttribute('data-tp-id')] = marked[m];
  }

  // Group inline blocks by nearest block-level ancestor
  var groups = {};
  var parentCounter = 0;
  for (var i = 0; i < blocks.length; i++) {
    var node = nodeMap[blocks[i].id];
    if (!node || !_EB_INLINE_TAGS.has(node.tagName)) continue;
    var ancestor = _eb_findBlockAncestor(node);
    if (!ancestor || !ancestor.getAttribute) continue;
    var parentKey = ancestor.getAttribute('data-tp-parent');
    if (!parentKey) {
      parentKey = 'tp-p-' + (parentCounter++);
      ancestor.setAttribute('data-tp-parent', parentKey);
    }
    if (!groups[parentKey]) groups[parentKey] = [];
    groups[parentKey].push(i);
  }

  // Merge groups with 2+ siblings
  var removeSet = new Set();
  for (var key in groups) {
    var indices = groups[key];
    if (indices.length < 2) continue;

    var firstNode = nodeMap[blocks[indices[0]].id];
    var parentEl = _eb_findBlockAncestor(firstNode);
    var fullText = _eb_getText(parentEl);
    if (fullText.length < 2) continue;

    // Merge into first block
    blocks[indices[0]].text = fullText;
    blocks[indices[0]].html = parentEl.innerHTML ? parentEl.innerHTML.trim() : '';

    // Move marker to parent
    firstNode.removeAttribute('data-tp-id');
    parentEl.setAttribute('data-tp-id', String(blocks[indices[0]].id));

    for (var j = 1; j < indices.length; j++) {
      var otherNode = nodeMap[blocks[indices[j]].id];
      if (otherNode) otherNode.removeAttribute('data-tp-id');
      removeSet.add(indices[j]);
    }
  }

  if (removeSet.size === 0) return blocks;

  // Re-index
  var result = [];
  for (var k = 0; k < blocks.length; k++) {
    if (removeSet.has(k)) continue;
    var bl = blocks[k];
    var oldId = bl.id;
    bl.id = result.length;
    if (oldId !== bl.id) {
      var mn = nodeMap[oldId] || doc.querySelector('[data-tp-id="' + oldId + '"]');
      if (mn) mn.setAttribute('data-tp-id', String(bl.id));
    }
    result.push(bl);
  }
  return result;
}

function extractBlocks(doc) {
  var blocks = [];
  var seen = new Set();

  function walk(node) {
    if (node.nodeType !== 1) return;
    if (SKIP_TAGS.has(node.tagName)) return;
    if (_eb_isHidden(node)) return;
    if (_eb_isNavArea(node)) return;

    if (BLOCK_TAGS.has(node.tagName)) {
      var text = _eb_getText(node);
      if (text.length < 2) return;

      var key = text.substring(0, 100);
      if (seen.has(key)) return;
      seen.add(key);

      var blockId = blocks.length;
      blocks.push({
        id: blockId,
        tag: node.tagName.toLowerCase(),
        type: _eb_classifyTag(node.tagName),
        text: text,
        html: node.innerHTML ? node.innerHTML.trim() : '',
        level: (function() { var m = node.tagName.match(/^H([1-6])$/); return m ? parseInt(m[1]) : null; })(),
      });
      node.setAttribute('data-tp-id', String(blockId));
      return;
    }

    var children = node.children;
    for (var i = 0; i < children.length; i++) {
      walk(children[i]);
    }

    // Capture significant direct text in non-block containers
    if (!LIST_PARENTS.has(node.tagName) && !BLOCK_TAGS.has(node.tagName)) {
      var directText = '';
      var childNodes = node.childNodes;
      for (var j = 0; j < childNodes.length; j++) {
        if (childNodes[j].nodeType === 3) {
          directText += childNodes[j].textContent;
        }
      }
      directText = directText.trim();
      if (directText.length >= 20) {
        var key2 = directText.substring(0, 100);
        if (!seen.has(key2)) {
          seen.add(key2);
          var blockId2 = blocks.length;
          blocks.push({
            id: blockId2,
            tag: node.tagName.toLowerCase(),
            type: 'paragraph',
            text: directText,
            html: directText,
            level: null,
          });
          node.setAttribute('data-tp-id', String(blockId2));
        }
      }
    }
  }

  // Find the narrowest content root (prefer specific selectors over generic ones)
  var ROOT_SELECTORS = [
    // Site-specific content containers (narrowest)
    '.mw-parser-output',     // Wikipedia
    '.post-content',         // Common blog
    '.entry-content',        // WordPress
    '.article-body',         // News sites
    // Semantic elements
    'article',
    '[role="main"]',
    'main',
    '#content',
  ];
  var root = null;
  for (var si = 0; si < ROOT_SELECTORS.length; si++) {
    root = doc.querySelector(ROOT_SELECTORS[si]);
    if (root) break;
  }
  if (!root) root = doc.body;

  walk(root);

  // Post-process: merge inline sibling fragments that share the same parent.
  // Sites like X/Twitter split one sentence across multiple <span> nodes
  // separated by link/mention elements. Merge them into a single block keyed
  // on the parent node so the entire sentence becomes one translation unit.
  blocks = _eb_mergeInlineSiblings(doc, blocks);

  return {
    title: doc.title || '',
    url: (typeof location !== 'undefined') ? location.href : '',
    domain: (typeof location !== 'undefined') ? location.hostname : '',
    lang: doc.documentElement ? (doc.documentElement.lang || '') : '',
    blockCount: blocks.length,
    blocks: blocks,
  };
}

// Node.js export
try { module.exports = { extractBlocks: extractBlocks }; } catch (_) { /* browser */ }

// Browser auto-execute: returns JSON string when run via agent-browser execute_js
// Node.js: module is defined → skips. Browser: module is undefined → executes.
if (typeof module === 'undefined') {
  JSON.stringify(extractBlocks(document));
}
