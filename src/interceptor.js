/*
 * X Tweet CSV Exporter (Local) — MAIN-world GraphQL interceptor (S2).
 *
 * Loaded at document_start before x.com's own scripts, so the fetch/XHR hooks
 * wrap the originals. The interceptor only *reads* responses that the page
 * already requested; it never creates requests, stores anything or talks to
 * another origin.
 *
 * Flow:
 *   fetch/XHR response (GraphQL timeline operation)
 *     -> JSON
 *     -> window.__XTCE_parse.extractFromGraphQL(payload)
 *     -> window.postMessage({ type: "XTCE_TWEETS", tweets }, location.origin)
 *
 * The isolated-world collector (src/content.js) receives that message. Every
 * hook path is wrapped in try/catch so a parser or postMessage failure can
 * never surface as an exception in page code.
 */
(function () {
  'use strict';

  var win = typeof window !== 'undefined' ? window : null;
  if (!win) {
    return;
  }
  if (win.__XTCE_INTERCEPTOR__) {
    return;
  }
  win.__XTCE_INTERCEPTOR__ = true;

  var TARGET_OPERATIONS = [
    'UserTweets',
    'UserTweetsAndReplies',
    'UserMedia',
    'Likes',
    'SearchTimeline',
    'TweetDetail',
    'Bookmarks',
    'ListLatestTweetsTimeline',
    'HomeTimeline',
    'HomeLatestTimeline'
  ];
  var OPERATION_RE = new RegExp(
    '(?:^|[/?&=])(' + TARGET_OPERATIONS.join('|') + ')(?:[/?&#]|$)'
  );
  var TARGET_PATH_MARKERS = ['/i/api/graphql/', '/i/api/2/'];

  function noop() {}

  function requestUrl(input) {
    try {
      if (typeof input === 'string') {
        return input;
      }
      if (input && typeof input.href === 'string') {
        return input.href;
      }
      if (input && typeof input.url === 'string') {
        return input.url;
      }
      return '';
    } catch (error) {
      return '';
    }
  }

  /**
   * Accept only same-origin x.com/twitter.com GraphQL (or /i/api/2/) URLs
   * whose path/query names one of the timeline operations we understand.
   */
  function isTargetUrl(rawUrl) {
    try {
      if (typeof rawUrl !== 'string' || rawUrl === '') {
        return false;
      }
      var absolute = new URL(rawUrl, win.location.href);
      var pageOrigin = win.location && win.location.origin;
      if (pageOrigin && absolute.origin !== pageOrigin) {
        return false;
      }
      var href = absolute.href;
      var hasMarker = false;
      for (var i = 0; i < TARGET_PATH_MARKERS.length; i += 1) {
        if (href.indexOf(TARGET_PATH_MARKERS[i]) !== -1) {
          hasMarker = true;
          break;
        }
      }
      if (!hasMarker) {
        return false;
      }
      return OPERATION_RE.test(absolute.pathname + absolute.search);
    } catch (error) {
      return false;
    }
  }

  /** Parse a response body and hand non-empty tweet batches to content.js. */
  function emitPayload(payload) {
    try {
      var data = payload;
      if (typeof payload === 'string') {
        if (!payload) {
          return;
        }
        data = JSON.parse(payload);
      }
      if (!data || typeof data !== 'object') {
        return;
      }
      var parser = win.__XTCE_parse;
      if (!parser || typeof parser.extractFromGraphQL !== 'function') {
        return;
      }
      var tweets = parser.extractFromGraphQL(data);
      if (!Array.isArray(tweets) || tweets.length === 0) {
        return;
      }
      win.postMessage(
        { type: 'XTCE_TWEETS', tweets: tweets },
        (win.location && win.location.origin) || location.origin
      );
    } catch (error) {
      /* Never let parsing/postMessage break the page. */
    }
  }

  function observeFetchResponse(promise) {
    try {
      if (!promise || typeof promise.then !== 'function') {
        return;
      }
      promise.then(function (response) {
        try {
          if (!response || typeof response.clone !== 'function') {
            return;
          }
          var clone = response.clone();
          if (!clone || typeof clone.json !== 'function') {
            return;
          }
          clone.json().then(emitPayload, noop);
        } catch (error) {
          /* A body that cannot be cloned/read is simply skipped. */
        }
      }, noop);
    } catch (error) {
      /* The page still owns the original promise. */
    }
  }

  function installFetchHook() {
    try {
      var originalFetch = win.fetch;
      if (typeof originalFetch !== 'function' || originalFetch.__xtceWrapped) {
        return;
      }
      var wrappedFetch = function (input) {
        var promise = originalFetch.apply(this, arguments);
        try {
          var url = requestUrl(input);
          if (url && isTargetUrl(url)) {
            observeFetchResponse(promise);
          }
        } catch (error) {
          /* Instrumentation must never change fetch behaviour. */
        }
        return promise;
      };
      try {
        wrappedFetch.__xtceWrapped = true;
      } catch (error) {
        /* Non-fatal. */
      }
      win.fetch = wrappedFetch;
    } catch (error) {
      /* Do not break the page when fetch cannot be wrapped. */
    }
  }

  function readXhr(xhr) {
    try {
      var status = xhr.status;
      if (status !== 0 && status !== 304 && (status < 200 || status >= 300)) {
        return;
      }
      var type = xhr.responseType || '';
      if (type === '' || type === 'text') {
        var text = xhr.responseText;
        if (typeof text === 'string' && text) {
          emitPayload(text);
        }
        return;
      }
      if (type === 'json') {
        if (xhr.response && typeof xhr.response === 'object') {
          emitPayload(xhr.response);
        }
        return;
      }
      if (type === 'arraybuffer' && xhr.response) {
        if (typeof TextDecoder === 'function') {
          var decoder = new TextDecoder('utf-8');
          emitPayload(decoder.decode(new Uint8Array(xhr.response)));
        }
        return;
      }
      if (type === 'blob' && xhr.response && typeof FileReader === 'function') {
        var reader = new FileReader();
        reader.onload = function () {
          try {
            emitPayload(reader.result);
          } catch (error) {
            /* Ignore unreadable blobs. */
          }
        };
        reader.onerror = noop;
        reader.readAsText(xhr.response);
      }
    } catch (error) {
      /* Ignore unusual XHR states. */
    }
  }

  function installXhrHook() {
    try {
      var XHR = win.XMLHttpRequest;
      if (!XHR || !XHR.prototype) {
        return;
      }
      var originalOpen = XHR.prototype.open;
      var originalSend = XHR.prototype.send;
      if (
        typeof originalOpen !== 'function' ||
        typeof originalSend !== 'function' ||
        originalOpen.__xtceWrapped
      ) {
        return;
      }
      var targets = typeof WeakMap === 'function' ? new WeakMap() : null;
      var handlers = typeof WeakMap === 'function' ? new WeakMap() : null;

      var wrappedOpen = function (method, url) {
        try {
          if (targets) {
            targets.set(this, String(url));
          }
        } catch (error) {
          /* The hook is best-effort. */
        }
        return originalOpen.apply(this, arguments);
      };

      var wrappedSend = function () {
        try {
          var xhr = this;
          var url = targets ? targets.get(xhr) : '';
          if (url && isTargetUrl(url) && typeof xhr.addEventListener === 'function') {
            var previous = handlers ? handlers.get(xhr) : null;
            if (previous) {
              try {
                xhr.removeEventListener('load', previous);
              } catch (error) {
                /* Ignore. */
              }
            }
            var handler = function () {
              try {
                readXhr(xhr);
              } catch (error) {
                /* Ignore. */
              }
            };
            xhr.addEventListener('load', handler);
            if (handlers) {
              handlers.set(xhr, handler);
            }
          }
        } catch (error) {
          /* Instrumentation must never change send behaviour. */
        }
        return originalSend.apply(this, arguments);
      };

      try {
        wrappedOpen.__xtceWrapped = true;
      } catch (error) {
        /* Non-fatal. */
      }
      try {
        wrappedSend.__xtceWrapped = true;
      } catch (error) {
        /* Non-fatal. */
      }
      XHR.prototype.open = wrappedOpen;
      XHR.prototype.send = wrappedSend;
    } catch (error) {
      /* Do not break the page when XHR cannot be wrapped. */
    }
  }

  installFetchHook();
  installXhrHook();
})();
