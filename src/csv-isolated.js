/*
 * X Tweet CSV Exporter (Local) — shared CSV builder (S3).
 *
 * This file is the single source of truth for the frozen CSV column order,
 * RFC 4180-style escaping, the UTF-8 BOM and the CRLF line endings. It is
 * loaded in both worlds:
 *   - MAIN world before src/parser.js (parser.toCSV/CSV_COLUMNS delegate here);
 *   - ISOLATED world before src/panel.js (the panel downloads the same CSV).
 *
 * Dependency-free and side-effect-free apart from exposing the API. It can be
 * evaluated inside Node's `vm` for tests, exactly like src/parser.js.
 *
 * Public API (window.__XTCE_csv / globalThis.__XTCE_csv):
 *   CSV_COLUMNS -> frozen column list (brief's fixed order)
 *   csvEscape(value) -> RFC-style escaped field
 *   toCSV(records) -> BOM + header + CRLF rows
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
    CSV_COLUMNS: CSV_COLUMNS,
    csvEscape: csvEscape,
    toCSV: toCSV
  };

  if (typeof window !== 'undefined') {
    window.__XTCE_csv = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.__XTCE_csv = api;
  }
})();
