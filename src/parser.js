/*
 * X Tweet CSV Exporter (Local) — pure GraphQL tweet parser (S1).
 *
 * This file is intentionally dependency-free and side-effect-free: no DOM,
 * no network, no chrome.* APIs. It can be loaded as a classic script in the
 * page's MAIN world and also evaluated inside Node's `vm` for tests.
 *
 * Public API (window.__XTCE_parse):
 *   extractFromGraphQL(payload) -> record[]
 *   extractTweetResult(result)  -> record | null
 *   toCSV(records)              -> string (UTF-8 BOM + header + CRLF rows)
 *   CSV_COLUMNS                 -> frozen column list
 *
 * Record shape is exactly the frozen CSV column order from the brief.
 * Multi-value columns (hashtags, mentions, urls, media_urls, media_types)
 * are space-joined because those values never contain spaces themselves.
 */
(function () {
  'use strict';

  var CSV_COLUMNS = Object.freeze([
    'id',
    'created_at_iso',
    'text',
    'url',
    'author_username',
    'author_name',
    'like_count',
    'retweet_count',
    'reply_count',
    'quote_count',
    'bookmark_count',
    'view_count',
    'hashtags',
    'mentions',
    'urls',
    'media_urls',
    'media_types',
    'is_reply',
    'in_reply_to_status_id',
    'in_reply_to_username',
    'is_retweet',
    'retweeted_status_id',
    'is_quote',
    'quoted_status_id',
    'conversation_id',
    'lang',
    'source'
  ]);

  var MONTH_INDEX = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11
  };

  // Example X timestamp: "Wed Oct 10 20:19:24 +0000 2018"
  var TWITTER_DATE_RE =
    /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/;

  function toNumber(value) {
    if (typeof value === 'number' && isFinite(value)) {
      return value;
    }
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : 0;
  }

  function asString(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  /**
   * Convert an X/REST-style timestamp to an ISO-8601 UTC string.
   * Invalid input is returned as-is rather than throwing.
   */
  function toIsoUtc(value) {
    if (!value) {
      return '';
    }
    var raw = String(value);
    var match = TWITTER_DATE_RE.exec(raw);
    if (match) {
      var month = MONTH_INDEX[match[1]];
      if (month !== undefined) {
        var offsetMinutes =
          (match[6] === '-' ? -1 : 1) * (toNumber(match[7]) * 60 + toNumber(match[8]));
        var utcMs =
          Date.UTC(
            toNumber(match[9]),
            month,
            toNumber(match[2]),
            toNumber(match[3]),
            toNumber(match[4]),
            toNumber(match[5])
          ) -
          offsetMinutes * 60000;
        return new Date(utcMs).toISOString();
      }
    }
    var parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    return raw;
  }

  /** `source` is an HTML anchor in the payload; keep only the app label. */
  function stripHtml(value) {
    return String(value)
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  /** Unwrap TweetWithVisibilityResults into the actual Tweet object. */
  function unwrapVisibility(node) {
    if (
      node &&
      typeof node === 'object' &&
      node.__typename === 'TweetWithVisibilityResults' &&
      node.tweet
    ) {
      return node.tweet;
    }
    return node;
  }

  function restIdOf(result) {
    var node = unwrapVisibility(result);
    if (!node || typeof node !== 'object') {
      return '';
    }
    if (node.rest_id !== undefined && node.rest_id !== null) {
      return String(node.rest_id);
    }
    if (node.legacy && node.legacy.id_str) {
      return String(node.legacy.id_str);
    }
    return '';
  }

  function collectStringValues(list, key) {
    var values = [];
    if (!Array.isArray(list)) {
      return values;
    }
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (item && typeof item[key] === 'string' && item[key]) {
        values.push(item[key]);
      }
    }
    return values;
  }

  function collectUrls(list) {
    var values = [];
    if (!Array.isArray(list)) {
      return values;
    }
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (!item) {
        continue;
      }
      var value = item.expanded_url || item.url;
      if (typeof value === 'string' && value) {
        values.push(value);
      }
    }
    return values;
  }

  /**
   * Photos use media_url_https. Videos and animated GIFs use the
   * highest-bitrate MP4 variant (HLS playlists are not direct media URLs).
   */
  function bestMediaUrl(media) {
    if (!media || typeof media !== 'object') {
      return '';
    }
    if (media.type === 'photo') {
      return media.media_url_https || media.media_url || '';
    }
    var variants = media.video_info && media.video_info.variants;
    if (Array.isArray(variants)) {
      var best = null;
      for (var i = 0; i < variants.length; i += 1) {
        var variant = variants[i];
        if (!variant || !variant.url || variant.content_type !== 'video/mp4') {
          continue;
        }
        if (!best || toNumber(variant.bitrate) > toNumber(best.bitrate)) {
          best = variant;
        }
      }
      if (best) {
        return best.url;
      }
    }
    // Videos always have a thumbnail; better than dropping the media entry.
    return media.media_url_https || '';
  }

  function pickMedia(legacy) {
    var extended = legacy.extended_entities && legacy.extended_entities.media;
    if (Array.isArray(extended) && extended.length > 0) {
      return extended;
    }
    var plain = legacy.entities && legacy.entities.media;
    if (Array.isArray(plain) && plain.length > 0) {
      return plain;
    }
    return [];
  }

  /**
   * Map one `tweet_results.result` node to a CSV record.
   * Returns null for tombstones / unusable nodes.
   */
  function extractTweetResult(tweetResult) {
    if (!tweetResult || typeof tweetResult !== 'object') {
      return null;
    }

    var raw = tweetResult;
    // Tolerate being passed the `{ result: ... }` wrapper itself.
    if (!raw.__typename && raw.result && typeof raw.result === 'object') {
      raw = raw.result;
    }
    raw = unwrapVisibility(raw);
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    if (raw.__typename === 'TweetTombstone' || (raw.tombstone && !raw.legacy)) {
      return null;
    }

    var legacy = raw.legacy && typeof raw.legacy === 'object' ? raw.legacy : {};
    var id = asString(raw.rest_id || legacy.id_str);
    if (!id) {
      return null;
    }

    var core = raw.core && typeof raw.core === 'object' ? raw.core : {};
    var userResult =
      core.user_results && core.user_results.result && typeof core.user_results.result === 'object'
        ? core.user_results.result
        : {};
    var userLegacy =
      userResult.legacy && typeof userResult.legacy === 'object' ? userResult.legacy : {};
    var userCore = userResult.core && typeof userResult.core === 'object' ? userResult.core : {};
    var authorUsername = asString(userLegacy.screen_name || userCore.screen_name);
    var authorName = asString(userLegacy.name || userCore.name);

    var noteResult =
      raw.note_tweet &&
      raw.note_tweet.note_tweet_results &&
      raw.note_tweet.note_tweet_results.result;
    var noteText =
      noteResult && typeof noteResult.text === 'string' && noteResult.text ? noteResult.text : '';
    var text = noteText || asString(legacy.full_text || raw.full_text);
    var entities =
      (noteText && noteResult && noteResult.entity_set) ||
      (legacy.entities && typeof legacy.entities === 'object' ? legacy.entities : {});

    var media = pickMedia(legacy);
    var mediaUrls = [];
    var mediaTypes = [];
    for (var i = 0; i < media.length; i += 1) {
      var mediaItem = media[i];
      var mediaUrl = bestMediaUrl(mediaItem);
      if (mediaUrl) {
        mediaUrls.push(mediaUrl);
        mediaTypes.push(asString(mediaItem && mediaItem.type));
      }
    }

    var retweetedResult =
      legacy.retweeted_status_result && legacy.retweeted_status_result.result;
    var isRetweet = Boolean(retweetedResult || legacy.retweeted_status_id_str);
    var retweetedStatusId = retweetedResult
      ? restIdOf(retweetedResult)
      : asString(legacy.retweeted_status_id_str);

    var quotedResult = raw.quoted_status_result && raw.quoted_status_result.result;
    var isQuote = Boolean(legacy.is_quote_status || quotedResult);
    var quotedStatusId = quotedResult ? restIdOf(quotedResult) : '';

    var replyToStatusId = asString(legacy.in_reply_to_status_id_str);
    var replyToUsername = asString(legacy.in_reply_to_screen_name);
    var isReply = Boolean(replyToStatusId || replyToUsername);

    var source = raw.source || legacy.source || '';

    return {
      id: id,
      created_at_iso: toIsoUtc(legacy.created_at),
      text: text,
      url: id ? 'https://x.com/' + (authorUsername || 'i') + '/status/' + id : '',
      author_username: authorUsername,
      author_name: authorName,
      like_count: toNumber(legacy.favorite_count),
      retweet_count: toNumber(legacy.retweet_count),
      reply_count: toNumber(legacy.reply_count),
      quote_count: toNumber(legacy.quote_count),
      bookmark_count: toNumber(legacy.bookmark_count),
      view_count: toNumber(raw.views && raw.views.count),
      hashtags: collectStringValues(entities.hashtags, 'text').join(' '),
      mentions: collectStringValues(entities.user_mentions, 'screen_name').join(' '),
      urls: collectUrls(entities.urls).join(' '),
      media_urls: mediaUrls.join(' '),
      media_types: mediaTypes.join(' '),
      is_reply: isReply,
      in_reply_to_status_id: replyToStatusId,
      in_reply_to_username: replyToUsername,
      is_retweet: isRetweet,
      retweeted_status_id: retweetedStatusId,
      is_quote: isQuote,
      quoted_status_id: quotedStatusId,
      conversation_id: asString(legacy.conversation_id_str),
      lang: asString(legacy.lang),
      source: stripHtml(source)
    };
  }

  /**
   * Walk any GraphQL payload and collect every `tweet_results.result`.
   *
   * The walk stops at each `tweet_results` node, so nested originals that
   * live under `legacy.retweeted_status_result` or `quoted_status_result`
   * (which are not `tweet_results` nodes) never become records of their own.
   */
  function extractFromGraphQL(payload) {
    var results = [];

    function walk(node) {
      if (!node || typeof node !== 'object') {
        return;
      }
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i += 1) {
          walk(node[i]);
        }
        return;
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k += 1) {
        var key = keys[k];
        var value = node[key];
        if (key === 'tweet_results') {
          if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            value.result &&
            typeof value.result === 'object'
          ) {
            results.push(value.result);
          }
          continue;
        }
        walk(value);
      }
    }

    walk(payload);

    var records = [];
    for (var i = 0; i < results.length; i += 1) {
      var record = extractTweetResult(results[i]);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  /** RFC 4180-style field escaping (quotes, commas, CR, LF). */
  function csvEscape(value) {
    if (value === null || value === undefined) {
      return '';
    }
    if (value === true) {
      return 'true';
    }
    if (value === false) {
      return 'false';
    }
    var text = String(value);
    if (/[",\r\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  /**
   * Serialize records as UTF-8-BOM CSV with a CRLF header and rows.
   * The BOM is the JS character U+FEFF, which the browser writes as
   * EF BB BF when the string is turned into a UTF-8 Blob.
   */
  function toCSV(records) {
    var lines = [CSV_COLUMNS.join(',')];
    var list = Array.isArray(records) ? records : [];
    for (var i = 0; i < list.length; i += 1) {
      var record = list[i] && typeof list[i] === 'object' ? list[i] : {};
      var row = [];
      for (var c = 0; c < CSV_COLUMNS.length; c += 1) {
        row.push(csvEscape(record[CSV_COLUMNS[c]]));
      }
      lines.push(row.join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  var api = {
    extractFromGraphQL: extractFromGraphQL,
    extractTweetResult: extractTweetResult,
    toCSV: toCSV,
    CSV_COLUMNS: CSV_COLUMNS
  };

  if (typeof window !== 'undefined') {
    window.__XTCE_parse = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.__XTCE_parse = api;
  }
})();
