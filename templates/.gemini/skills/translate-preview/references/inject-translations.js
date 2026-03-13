// translate-preview: DOM in-place translation injector + HTML capture
// Run via agent-browser eval after extract-blocks.js + setting window.__TP_DATA__.
//
// Browser auto-execute:
//   1. Reads window.__TP_DATA__ (set beforehand via separate eval)
//   2. Re-runs extractBlocks() if available (re-marks DOM after SPA re-render)
//   3. Injects translations into marked nodes
//   4. Captures page as self-contained HTML (inlines CSS, absolutizes URLs)
//   Returns Promise<string> with the final HTML.
//
// Node.js (tests):
//   const { injectTranslations } = require('./inject-translations.js');
//   injectTranslations(document, data);

/* eslint-disable no-var */

var _TP_INLINE_TAGS = new Set([
  'SPAN', 'A', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'SMALL',
  'SUB', 'SUP', 'ABBR', 'CITE', 'CODE', 'TIME', 'MARK', 'LABEL',
]);

function injectTranslations(doc, data) {
  var blocks = data.blocks || [];

  // 1. Inject translations into marked nodes
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    var node = doc.querySelector('[data-tp-id="' + block.id + '"]');
    if (!node) continue;
    if (block.type === 'code') continue;

    var isInline = _TP_INLINE_TAGS.has(node.tagName);
    // Normalize whitespace (innerText captures newlines around inline children)
    var cleanText = block.translatedText.replace(/[\s\n\r]+/g, ' ').trim();

    if (isInline) {
      // Inline nodes: NO wrapper — just swap text in place to preserve parent layout.
      // Store original text as data attribute for toggle, replace content directly.
      node.setAttribute('data-tp-original', node.textContent || '');
      node.textContent = cleanText;
      node.className = (node.className ? node.className + ' ' : '') + 'tp-inline';
      node.setAttribute('data-tp-state', 'translated');
    } else {
      // Block nodes: wrap in .tp-block container with data-state toggle
      // (same structure as twitter-render.js for consistent interaction)
      var translated = node.cloneNode(false);
      translated.textContent = cleanText;
      translated.className = (translated.className ? translated.className + ' ' : '') + 'tp-translated';
      translated.removeAttribute('data-tp-id');

      node.className = (node.className ? node.className + ' ' : '') + 'tp-original';

      var wrapper = doc.createElement('div');
      wrapper.className = 'tp-block';
      wrapper.setAttribute('data-state', 'translated');
      node.parentNode.insertBefore(wrapper, node);
      wrapper.appendChild(translated);
      wrapper.appendChild(node);
    }
  }

  // 2. Inject UI overlay
  _tp_injectUIOverlay(doc, data);

  // 3. Inject styles
  _tp_injectStyles(doc);

  // 4. Inject interaction script
  _tp_injectInteractionScript(doc);
}

function _tp_injectUIOverlay(doc, data) {
  var header = doc.createElement('div');
  header.className = 'tp-header';
  header.setAttribute('data-tp', 'true');
  header.innerHTML =
    '<div class="tp-header-inner">' +
      '<div class="tp-header-title">' +
        '<span class="tp-header-label">Translate Preview</span>' +
        (data.sourceUrl ? '<a class="tp-header-url" href="' + _tp_escapeHtml(data.sourceUrl) + '" target="_blank" rel="noopener">' + _tp_escapeHtml(data.sourceUrl) + '</a>' : '') +
      '</div>' +
      '<div class="tp-header-controls">' +
        '<button class="tp-btn tp-btn-active" data-tp-mode="translated">訳文</button>' +
        '<button class="tp-btn" data-tp-mode="both">対訳</button>' +
        '<button class="tp-btn" data-tp-mode="original">原文</button>' +
      '</div>' +
    '</div>';

  var body = doc.body;
  body.insertBefore(header, body.firstChild);

  // Add padding to body for fixed header
  var existingPadding = parseInt(body.style.paddingTop, 10) || 0;
  body.style.paddingTop = (existingPadding + 56) + 'px';
}

function _tp_injectStyles(doc) {
  var style = doc.createElement('style');
  style.setAttribute('data-tp', 'true');
  style.textContent =
    /* Header */
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

    /* Bilingual blocks — data-state driven (matches twitter-render.js) */
    '.tp-block { display: contents; }' +
    '.tp-block[data-state="translated"] .tp-original { display: none; }' +
    '.tp-block[data-state="original"] .tp-translated { display: none; }' +
    '.tp-block[data-state="both"] .tp-original { ' +
      'color: #6b7280; font-size: 0.85em; ' +
      'border-left: 3px solid rgba(59,130,246,0.3); ' +
      'padding-left: 8px; margin-top: 4px; }' +

    /* Dark mode */
    '@media (prefers-color-scheme: dark) {' +
      '.tp-header { background: rgba(17,24,39,0.85); border-bottom-color: rgba(255,255,255,0.1); }' +
      '.tp-header-label { color: #f3f4f6; }' +
      '.tp-header-url { color: #9ca3af; }' +
      '.tp-header-url:hover { color: #60a5fa; }' +
      '.tp-btn { border-color: #4b5563; color: #d1d5db; }' +
      '.tp-btn:hover { background: #374151; }' +
      '.tp-btn-active { background: #3b82f6; color: #fff; border-color: #3b82f6; }' +
      '.tp-block[data-state="both"] .tp-original { color: #9ca3af; }' +
    '}';

  (doc.head || doc.documentElement).appendChild(style);
}

function _tp_injectInteractionScript(doc) {
  var script = doc.createElement('script');
  script.setAttribute('data-tp', 'true');
  script.textContent =
    '(function(){' +
      // Toggle a single .tp-block through translated→both→original→translated
      'function tpToggle(block){' +
        'var s=block.getAttribute("data-state");' +
        'block.setAttribute("data-state",s==="translated"?"both":s==="both"?"original":"translated");' +
      '}' +

      // Global mode switch via header buttons
      'document.addEventListener("click",function(e){' +
        'var btn=e.target.closest("[data-tp-mode]");' +
        'if(!btn)return;' +
        'var mode=btn.getAttribute("data-tp-mode");' +
        // Set all blocks
        'document.querySelectorAll(".tp-block").forEach(function(b){b.setAttribute("data-state",mode);});' +
        // Inline elements: swap text content
        'document.querySelectorAll(".tp-inline").forEach(function(el){' +
          'var orig=el.getAttribute("data-tp-original")||"";' +
          'var trans=el.getAttribute("data-tp-translated")||el.textContent;' +
          'if(!el.hasAttribute("data-tp-translated"))el.setAttribute("data-tp-translated",el.textContent);' +
          'if(mode==="original")el.textContent=orig;' +
          'else el.textContent=trans;' +
          'el.setAttribute("data-tp-state",mode);' +
        '});' +
        'document.querySelectorAll(".tp-btn").forEach(function(b){b.classList.remove("tp-btn-active");});' +
        'btn.classList.add("tp-btn-active");' +
      '});' +

      // Long-press toggle on individual block (500ms)
      'var _tpTimer=null;' +
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
    '})();';

  doc.body.appendChild(script);
}

function _tp_escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Capture: inline CSS, absolutize URLs, strip scripts ──

/**
 * Rewrite localhost URLs to the page's actual origin.
 * Some sites (e.g. Next.js on Vercel) SSR with localhost URLs that the CDN
 * normally rewrites. When agent-browser fetches the page, these survive and
 * cause resource loads to fail.
 */
function _tp_rewriteLocalhost(href, base) {
  if (!href) return href;
  var m = href.match(/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/.*)/);
  if (!m) return href;
  try {
    var origin = new URL(base).origin;
    return origin + m[1];
  } catch (_) {
    return href;
  }
}

function _tp_capturePage(doc) {
  var base = doc.baseURI || '';

  // 1a. Capture CSS from CSSOM — gets whatever the browser actually loaded,
  // regardless of whether the URLs were correct or rewritten by JS at runtime.
  // Absolutize relative url() references using each sheet's href as base.
  var cssomTexts = [];
  for (var s = 0; s < doc.styleSheets.length; s++) {
    try {
      var sheet = doc.styleSheets[s];
      if (sheet.ownerNode && sheet.ownerNode.getAttribute && sheet.ownerNode.getAttribute('data-tp')) continue;
      var rules = sheet.cssRules || sheet.rules;
      if (!rules || !rules.length) continue;
      var sheetBase = sheet.href || base;
      var css = '';
      for (var r = 0; r < rules.length; r++) css += rules[r].cssText + '\n';
      // Resolve relative url() in CSS to absolute using the sheet's origin
      if (css && sheetBase) {
        css = css.replace(/url\(["']?([^"')]+)["']?\)/g, function(match, u) {
          if (u.startsWith('data:') || u.startsWith('http://') || u.startsWith('https://')) return match;
          try { return 'url("' + new URL(u, sheetBase).href + '")'; } catch (_) { return match; }
        });
      }
      if (css) cssomTexts.push(css);
    } catch (_) {
      // Cross-origin stylesheets throw SecurityError — handled in 1b
    }
  }

  // 1b. For <link rel="stylesheet"> tags whose CSS wasn't captured via CSSOM
  // (cross-origin or failed to load), fetch with localhost rewriting.
  var linkPromises = [];
  var links = doc.querySelectorAll('link[rel="stylesheet"]');
  for (var i = 0; i < links.length; i++) {
    (function(link) {
      var href = link.href;
      if (!href) { link.remove(); return; }
      // Check if this sheet was already captured via CSSOM
      try {
        var rules = link.sheet && (link.sheet.cssRules || link.sheet.rules);
        if (rules && rules.length > 0) { link.remove(); return; }
      } catch (_) { /* cross-origin — need to fetch */ }
      // Rewrite localhost URLs to the page's real origin before fetching
      var fetchUrl = _tp_rewriteLocalhost(href, base);
      var p = fetch(fetchUrl).then(function(res) {
        if (!res.ok) throw new Error(res.status);
        return res.text();
      }).then(function(css) {
        var style = doc.createElement('style');
        style.setAttribute('data-tp-inlined', 'true');
        style.textContent = css;
        link.replaceWith(style);
      }).catch(function() {
        link.remove();
      });
      linkPromises.push(p);
    })(links[i]);
  }

  return Promise.all(linkPromises).then(function() {
    // 1c. Inject CSSOM-captured CSS as inlined <style> block
    if (cssomTexts.length) {
      var inlined = doc.createElement('style');
      inlined.setAttribute('data-tp-inlined', 'true');
      inlined.textContent = cssomTexts.join('\n');
      (doc.head || doc.documentElement).appendChild(inlined);
    }

    // 2. Absolutize relative URLs
    _tp_absolutizeUrls(doc, base);

    // 3. Remove localhost preload/prefetch links (unreachable in saved HTML)
    var preloads = doc.querySelectorAll('link[rel="preload"], link[rel="prefetch"], link[rel="preconnect"], link[rel="modulepreload"]');
    for (var p = 0; p < preloads.length; p++) {
      var ph = preloads[p].getAttribute('href') || '';
      if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(ph)) {
        preloads[p].remove();
      }
    }

    // 4. Remove non-tp scripts
    var scripts = doc.querySelectorAll('script:not([data-tp])');
    for (var j = 0; j < scripts.length; j++) {
      scripts[j].remove();
    }

    // 5. Remove noscript tags
    var noscripts = doc.querySelectorAll('noscript');
    for (var k = 0; k < noscripts.length; k++) {
      noscripts[k].remove();
    }

    // 6. Return full HTML
    return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  });
}

function _tp_cleanImageUrl(url) {
  // Strip Substack session tokens ($s_!...!,) that break when accessed outside the browser
  return url.replace(/\$s_![^!]*!,?/g, '');
}

function _tp_absolutizeUrls(doc, base) {
  if (!base) return;

  var imgs = doc.querySelectorAll('img[src]');
  for (var i = 0; i < imgs.length; i++) {
    var src = imgs[i].getAttribute('src');
    if (src && !src.startsWith('data:')) {
      try { imgs[i].setAttribute('src', _tp_cleanImageUrl(new URL(src, base).href)); } catch (_) { /* skip */ }
    }
  }

  var anchors = doc.querySelectorAll('a[href]');
  for (var j = 0; j < anchors.length; j++) {
    var href = anchors[j].getAttribute('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !href.startsWith('mailto:')) {
      try { anchors[j].setAttribute('href', new URL(href, base).href); } catch (_) { /* skip */ }
    }
  }

  var sources = doc.querySelectorAll('source[srcset], img[srcset]');
  for (var k = 0; k < sources.length; k++) {
    var srcset = sources[k].getAttribute('srcset');
    if (srcset) {
      // Split on commas followed by whitespace (entry separators), not commas within URLs (e.g., Substack's w_40,h_40,c_fill)
      var resolved = srcset.split(/,\s+/).map(function(entry) {
        var parts = entry.trim().split(/\s+/);
        try { parts[0] = _tp_cleanImageUrl(new URL(parts[0], base).href); } catch (_) { /* skip */ }
        return parts.join(' ');
      }).join(', ');
      sources[k].setAttribute('srcset', resolved);
    }
  }

  // Clean link[href] (favicons, icons, etc.)
  var links = doc.querySelectorAll('link[href]');
  for (var l = 0; l < links.length; l++) {
    var lhref = links[l].getAttribute('href');
    if (lhref && !lhref.startsWith('data:')) {
      try { links[l].setAttribute('href', _tp_cleanImageUrl(new URL(lhref, base).href)); } catch (_) { /* skip */ }
    }
  }

  // Clean meta og:image / twitter:image
  var metas = doc.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]');
  for (var m = 0; m < metas.length; m++) {
    var content = metas[m].getAttribute('content');
    if (content) {
      try { metas[m].setAttribute('content', _tp_cleanImageUrl(new URL(content, base).href)); } catch (_) { /* skip */ }
    }
  }

  // Clean inline style background-image: url(...)
  var styled = doc.querySelectorAll('[style*="url("]');
  for (var n = 0; n < styled.length; n++) {
    var style = styled[n].getAttribute('style');
    if (style) {
      styled[n].setAttribute('style', style.replace(/url\(["']?([^"')]+)["']?\)/g, function(match, u) {
        if (u.startsWith('data:')) return match;
        try { return 'url("' + _tp_cleanImageUrl(new URL(u, base).href) + '")'; } catch (_) { return match; }
      }));
    }
  }
}

// Node.js export
try { module.exports = { injectTranslations: injectTranslations, _tp_capturePage: _tp_capturePage }; } catch (_) { /* browser */ }

// Browser auto-execute: inject translations + capture as self-contained HTML.
// Returns Promise<string> with the final HTML.
// Node.js: module is defined → skips. Browser: module is undefined → executes.
if (typeof module === 'undefined' && typeof window !== 'undefined' && window.__TP_DATA__) {
  // Re-run extractBlocks to re-mark DOM (SPA may have re-rendered since extraction)
  if (typeof extractBlocks === 'function') {
    extractBlocks(document);
  }
  injectTranslations(document, window.__TP_DATA__);
  _tp_capturePage(document);
}
