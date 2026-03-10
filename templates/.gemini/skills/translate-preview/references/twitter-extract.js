// twitter-extract.js — Extract blocks from X/Twitter articles via fxtwitter API
//
// Usage (CLI):
//   node twitter-extract.js <tweet-url>
//   Outputs blocks JSON to stdout (same format as extract-blocks.js).
//
// Usage (Node.js):
//   const { parseTweetUrl, convertFxtwitter } = require('./twitter-extract.js');
//   const blocks = convertFxtwitter(fxtwitterApiResponse);
//
// Exit codes:
//   0 — success
//   1 — invalid URL / missing arguments
//   2 — not an article tweet
//   3 — API fetch or conversion failed

/* eslint-disable no-var */

function _te_escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseTweetUrl(url) {
  var match = url.match(/(x\.com|twitter\.com)\/([^/]+)\/status\/(\d+)/);
  if (!match) return null;
  return { user: match[2], statusId: match[3] };
}

function _te_applyInlineStyles(text, inlineRanges, entityRanges, entityMap) {
  if (!text) return '';
  if ((!inlineRanges || !inlineRanges.length) && (!entityRanges || !entityRanges.length)) {
    return _te_escapeHtml(text);
  }

  var n = text.length;
  var openTags = [];
  var closeTags = [];
  for (var x = 0; x < n; x++) {
    openTags.push([]);
    closeTags.push([]);
  }

  // Bold / Italic
  for (var s = 0; inlineRanges && s < inlineRanges.length; s++) {
    var sr = inlineRanges[s];
    var offset = sr.offset || 0;
    var length = sr.length || 0;
    var end = Math.min(offset + length, n);
    if (offset >= n || length <= 0) continue;
    if (sr.style === 'Bold') {
      openTags[offset].push('<strong>');
      closeTags[end - 1].unshift('</strong>');
    } else if (sr.style === 'Italic') {
      openTags[offset].push('<em>');
      closeTags[end - 1].unshift('</em>');
    }
  }

  // Entity ranges (links)
  for (var e = 0; entityRanges && e < entityRanges.length; e++) {
    var er = entityRanges[e];
    var eOffset = er.offset || 0;
    var eLength = er.length || 0;
    var eEnd = Math.min(eOffset + eLength, n);
    if (eOffset >= n || eLength <= 0 || er.key == null) continue;
    var entity = entityMap[er.key];
    var eUrl = entity && entity.value && entity.value.data && entity.value.data.url;
    if (eUrl) {
      openTags[eOffset].push('<a href="' + _te_escapeHtml(eUrl) + '">');
      closeTags[eEnd - 1].unshift('</a>');
    }
  }

  var result = '';
  for (var i = 0; i < n; i++) {
    for (var oi = 0; oi < openTags[i].length; oi++) result += openTags[i][oi];
    result += _te_escapeHtml(text[i]);
    for (var ci = 0; ci < closeTags[i].length; ci++) result += closeTags[i][ci];
  }
  return result;
}

function convertFxtwitter(data) {
  var tweet = data.tweet || {};
  var article = tweet.article;
  if (!article) return null;

  var content = article.content || {};
  var fxBlocks = content.blocks || [];

  // Build entity map: key → entity object
  var entityMapArr = content.entityMap || [];
  var entityMap = {};
  for (var em = 0; em < entityMapArr.length; em++) {
    entityMap[entityMapArr[em].key] = entityMapArr[em];
  }

  // Build media lookup: media_id → original_img_url
  // Also build ordered URL list for positional fallback (mediaItems often lack media_id)
  var mediaEntities = article.media_entities || [];
  var mediaLookup = {};
  var mediaUrlList = [];
  for (var mi = 0; mi < mediaEntities.length; mi++) {
    var me = mediaEntities[mi];
    var mid = String(me.media_id || '');
    var mUrl = me.media_info && me.media_info.original_img_url || '';
    if (mid && mUrl) mediaLookup[mid] = mUrl;
    if (mUrl) mediaUrlList.push(mUrl);
  }
  var mediaUrlIndex = 0;

  var blocks = [];
  var blockId = 0;

  for (var i = 0; i < fxBlocks.length; i++) {
    var fb = fxBlocks[i];
    var btype = fb.type || 'unstyled';
    var text = fb.text || '';
    var inlineRanges = fb.inlineStyleRanges || [];
    var eRanges = fb.entityRanges || [];

    if (btype === 'header-one' || btype === 'header-two' || btype === 'header-three') {
      var level = btype === 'header-one' ? 1 : btype === 'header-two' ? 2 : 3;
      blocks.push({
        id: blockId++, tag: 'h' + level, type: 'heading',
        text: text, html: _te_applyInlineStyles(text, inlineRanges, eRanges, entityMap), level: level,
      });

    } else if (btype === 'atomic') {
      for (var ei = 0; ei < eRanges.length; ei++) {
        var key = eRanges[ei].key;
        if (key == null) continue;
        var ent = entityMap[key];
        var edata = ent && ent.value && ent.value.data || {};

        // Code block
        if (edata.markdown) {
          blocks.push({
            id: blockId++, tag: 'pre', type: 'code',
            text: edata.markdown, html: _te_escapeHtml(edata.markdown), level: null,
          });
          continue;
        }

        // Image — try mediaId lookup first, fall back to positional matching
        // Note: Draft.js mediaItems use camelCase "mediaId", while
        // media_entities use snake_case "media_id" — handle both.
        var mediaItems = edata.mediaItems || [];
        for (var mj = 0; mj < mediaItems.length; mj++) {
          var imgId = String(mediaItems[mj].mediaId || mediaItems[mj].media_id || '');
          var imgUrl = imgId ? (mediaLookup[imgId] || '') : '';
          if (!imgUrl && mediaUrlIndex < mediaUrlList.length) {
            imgUrl = mediaUrlList[mediaUrlIndex++];
          } else if (imgUrl) {
            mediaUrlIndex++;
          }
          var caption = mediaItems[mj].caption || edata.caption || '';
          if (imgUrl) {
            var alt = caption ? _te_escapeHtml(caption) : '';
            blocks.push({
              id: blockId++, tag: 'img', type: 'image',
              text: caption, html: '<img src="' + _te_escapeHtml(imgUrl) + '" alt="' + alt + '">', level: null,
            });
          }
        }
      }

    } else if (btype === 'ordered-list-item' || btype === 'unordered-list-item') {
      blocks.push({
        id: blockId++, tag: 'li', type: 'list-item',
        text: text, html: _te_applyInlineStyles(text, inlineRanges, eRanges, entityMap), level: null,
      });

    } else if (btype === 'blockquote') {
      blocks.push({
        id: blockId++, tag: 'blockquote', type: 'quote',
        text: text, html: _te_applyInlineStyles(text, inlineRanges, eRanges, entityMap), level: null,
      });

    } else {
      // unstyled → paragraph (skip empty)
      if (!text.trim()) continue;
      blocks.push({
        id: blockId++, tag: 'p', type: 'paragraph',
        text: text, html: _te_applyInlineStyles(text, inlineRanges, eRanges, entityMap), level: null,
      });
    }
  }

  // Title: article title or first heading
  var title = article.title || '';
  if (!title) {
    for (var ti = 0; ti < blocks.length; ti++) {
      if (blocks[ti].type === 'heading') { title = blocks[ti].text; break; }
    }
  }

  var author = tweet.author || {};
  return {
    title: title,
    url: 'https://x.com/' + (author.screen_name || '') + '/status/' + (tweet.id || ''),
    domain: 'x.com',
    blockCount: blocks.length,
    blocks: blocks,
  };
}

// Node.js export
try {
  module.exports = { parseTweetUrl: parseTweetUrl, convertFxtwitter: convertFxtwitter };
} catch (_) { /* browser */ }

// CLI mode: node twitter-extract.js <tweet-url>
if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
    process.argv[1].replace(/\\/g, '/').endsWith('twitter-extract.js')) {
  var url = process.argv[2];
  if (!url) {
    process.stderr.write('Usage: node twitter-extract.js <tweet-url>\n');
    process.exit(1);
  }
  var parsed = parseTweetUrl(url);
  if (!parsed) {
    process.stderr.write('Error: Not a valid X/Twitter status URL: ' + url + '\n');
    process.exit(1);
  }
  var apiUrl = 'https://api.fxtwitter.com/' + parsed.user + '/status/' + parsed.statusId;

  fetch(apiUrl)
    .then(function(res) {
      if (!res.ok) throw new Error('API returned ' + res.status);
      return res.json();
    })
    .then(function(json) {
      var result = convertFxtwitter(json);
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
}
