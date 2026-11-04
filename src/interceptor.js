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
 *     -> window.postMessage({
 *          type: "XTCE_TWEETS",
 *          tweets,
 *          source: { pathname, search, operation }   // captured at request time
 *        }, location.origin)
 *
 * The isolated-world collector also runs at document_start, but the two
 * worlds have no ordering guarantee. The collector posts
 * XTCE_COLLECTOR_READY once its listener is installed; this script posts
 * XTCE_INTERCEPTOR_HELLO and buffers batches until it hears READY, then
 * replays them in order. A page script could forge the ready message, but
 * that only causes an early replay and is not a security boundary.
 *
 * The source route is captured when the request starts, not when the
 * response arrives, so a late response is attributed to the profile that
 * requested it instead of the route that happens to be current later.
 *
 * Every hook path is wrapped in try/catch so a parser or postMessage failure
 * can never surface as an exception in page code.
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
  var MAX_PENDING_BATCHES = 50;

  var collectorReady = false;
  var pendingMessages = [];

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
   * Return the target operation name for a same-origin x.com/twitter.com
   * GraphQL (or /i/api/2/) URL, or null. The operation is also stored in the
   * message source so the collector can see what produced the batch.
   */
  function operationFromUrl(rawUrl) {
    try {
      if (typeof rawUrl !== 'string' || rawUrl === '') {
        return null;
      }
      var absolute = new URL(rawUrl, win.location.href);
      var pageOrigin = win.location && win.location.origin;
      if (pageOrigin && absolute.origin !== pageOrigin) {
        return null;
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
        return null;
      }
      var match = OPERATION_RE.exec(absolute.pathname + absolute.search);
      return match ? match[1] : null;
    } catch (error) {
      return null;
    }
  }

  /** Route snapshot taken when the page starts the request. */
  function contextFor(operation) {
    var pathname = '';
    var search = '';
    try {
      if (win.location && typeof win.location.pathname === 'string') {
        pathname = win.location.pathname;
      }
      if (win.location && typeof win.location.search === 'string') {
        search = win.location.search;
      }
    } catch (error) {
      /* Location can be unusual in tests; empty context is rejected later. */
    }
    return {
      pathname: pathname,
      search: search,
      operation: operation || null
    };
  }

  function postToPage(message) {
    try {
      var target = (win.location && win.location.origin) || '*';
      win.postMessage(message, target);
      return true;
    } catch (error) {
      return false;
    }
  }

  function queueMessage(message) {
    pendingMessages.push(message);
    while (pendingMessages.length > MAX_PENDING_BATCHES) {
      pendingMessages.shift();
    }
  }

  function deliver(message) {
    if (collectorReady && postToPage(message)) {
      return;
    }
    queueMessage(message);
  }

  function flushPending() {
    if (!collectorReady || pendingMessages.length === 0) {
      return;
    }
    var queued = pendingMessages;
    pendingMessages = [];
    for (var i = 0; i < queued.length; i += 1) {
      if (!postToPage(queued[i])) {
        pendingMessages = queued.slice(i);
        return;
      }
    }
  }

  function handleWindowMessage(event) {
    try {
      if (!event || event.origin !== (win.location && win.location.origin)) {
        return;
      }
      var data = event.data;
      if (!data || typeof data !== 'object') {
        return;
      }
      if (data.type === 'XTCE_COLLECTOR_READY') {
        collectorReady = true;
        flushPending();
      }
    } catch (error) {
      /* Ignore malformed window messages. */
    }
  }

  function installHandshake() {
    try {
      win.addEventListener('message', handleWindowMessage, false);
    } catch (error) {
      return;
    }
    postToPage({ type: 'XTCE_INTERCEPTOR_HELLO' });
    try {
      if (typeof win.setTimeout === 'function') {
        win.setTimeout(function () {
          if (!collectorReady) {
            postToPage({ type: 'XTCE_INTERCEPTOR_HELLO' });
          }
        }, 0);
      }
    } catch (error) {
      /* The collector's own READY is enough in the normal case. */
    }
  }

  /** Parse a response body and hand non-empty tweet batches to content.js. */
  function emitPayload(payload, context) {
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
      deliver({
        type: 'XTCE_TWEETS',
        tweets: tweets,
        source: context || contextFor(null)
      });
    } catch (error) {
      /* Never let parsing/postMessage break the page. */
    }
  }

  function observeFetchResponse(promise, context) {
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
          clone.json().then(function (payload) {
            emitPayload(payload, context);
          }, noop);
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
          var operation = url ? operationFromUrl(url) : null;
          if (operation) {
            observeFetchResponse(promise, contextFor(operation));
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

  function readXhr(xhr, context) {
    try {
      var status = xhr.status;
      if (status !== 0 && status !== 304 && (status < 200 || status >= 300)) {
        return;
      }
      var type = xhr.responseType || '';
      if (type === '' || type === 'text') {
        var text = xhr.responseText;
        if (typeof text === 'string' && text) {
          emitPayload(text, context);
        }
        return;
      }
      if (type === 'json') {
        if (xhr.response && typeof xhr.response === 'object') {
          emitPayload(xhr.response, context);
        }
        return;
      }
      if (type === 'arraybuffer' && xhr.response) {
        if (typeof TextDecoder === 'function') {
          var decoder = new TextDecoder('utf-8');
          emitPayload(decoder.decode(new Uint8Array(xhr.response)), context);
        }
        return;
      }
      if (type === 'blob' && xhr.response && typeof FileReader === 'function') {
        var reader = new FileReader();
        reader.onload = function () {
          try {
            emitPayload(reader.result, context);
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
      var contexts = typeof WeakMap === 'function' ? new WeakMap() : null;
      var handlers = typeof WeakMap === 'function' ? new WeakMap() : null;

      var wrappedOpen = function (method, url) {
        try {
          if (handlers) {
            var previous = handlers.get(this);
            if (previous) {
              try {
                this.removeEventListener('load', previous);
              } catch (error) {
                /* Ignore. */
              }
              handlers.delete(this);
            }
          }
          if (contexts) {
            contexts.delete(this);
          }
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
          var operation = url ? operationFromUrl(url) : null;
          if (
            operation &&
            typeof xhr.addEventListener === 'function'
          ) {
            var previous = handlers ? handlers.get(xhr) : null;
            if (previous) {
              try {
                xhr.removeEventListener('load', previous);
              } catch (error) {
                /* Ignore. */
              }
            }
            // Capture the route at send time; the load event may fire after a
            // pushState navigation.
            var context = contextFor(operation);
            if (contexts) {
              contexts.set(xhr, context);
            }
            var handler = function () {
              try {
                readXhr(xhr, context);
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
  installHandshake();
})();
