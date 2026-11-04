/*
 * X Tweet CSV Exporter (Local) — isolated-world collector (S2).
 *
 * Listens for XTCE_TWEETS batches from the MAIN-world interceptor, dedupes
 * them by tweet id in the current profile's Map, and asks the extension
 * service worker to persist each profile under `xtce_<username>` in
 * chrome.storage.local (throttled to ~500 ms).
 *
 * Loaded at document_start in the ISOLATED world. The interceptor also runs
 * at document_start, but the two worlds are not ordered relative to each
 * other, so startup is a handshake:
 *   - this collector posts XTCE_COLLECTOR_READY once its listener is installed;
 *   - the interceptor posts XTCE_INTERCEPTOR_HELLO and buffers batches until
 *     it hears READY, then replays them.
 * No early timeline response is lost, whichever world starts first.
 *
 * Attribution:
 *   The interceptor stamps every batch with the route (pathname/search) at
 *   request time. The collector resolves the bucket from that stamp, not from
 *   whatever route happens to be current when the response arrives. A late
 *   Alice response therefore goes to Alice even after the user navigated to
 *   Bob, and a response that starts right after pushState is not put into the
 *   previous bucket. The live route is still synced immediately so S3's
 *   getState() does not have to wait for the 500 ms poll.
 *
 * Conservative author filter:
 *   Only records whose `author_username` matches the request-time bucket are
 *   ingested. TweetDetail replies by other people and other authors' tweets
 *   from Likes therefore never pollute a person export.
 *
 * Persistence:
 *   - This content script never calls chrome.storage.local.set for a user
 *     snapshot. Every read and write is an XTCE_COORDINATE message to the MV3
 *     service worker (src/background.js), which owns the only writer queue.
 *     navigator.locks is origin-scoped and is not used at all: the service
 *     worker serializes x.com, twitter.com and every tab through one per-user
 *     queue. There is no per-origin lock fallback.
 *   - If the service worker cannot be reached, does not answer within the
 *     timeout, or returns an error, the store keeps the bucket dirty and
 *     surfaces XTCE_COORDINATION_UNAVAILABLE / XTCE_COORDINATION_TIMEOUT.
 *     It never writes directly to storage as a best-effort fallback.
 *   - chrome.storage.onChanged applies records *and clears* written by another
 *     tab. Empty snapshots are not ignored: the payload's clearEpoch tells a
 *     tab to drop records that predate the clear, so a stale tab cannot
 *     re-flush them. The write-ahead journal keys (xtce:wal:*) are ignored.
 *
 * S3 API (isolated world, globalThis.__XTCE_content):
 *   getState()        -> { username, count, records, error }
 *   getUsername()     -> current bucket username | null
 *   getLastError()    -> { message, operation, username, at, code } | null
 *   clearError()      -> void
 *   subscribe(fn)     -> unsubscribe; fn(state) on switch/ingest/clear/error
 *   clearCurrent()    -> Promise<void> (rejects on storage/coordination failure)
 *   flush()           -> Promise<void> (rejects on storage/coordination failure)
 *
 * Coordination errors carry `code` so S3 can distinguish a failed handoff to
 * the service worker from a quota failure (quota failures have no code).
 */
(function () {
  'use strict';

  var win = typeof window !== 'undefined' ? window : null;
  var root = typeof globalThis !== 'undefined' ? globalThis : win;
  if (!win || !root) {
    return;
  }
  var storeApi = root.__XTCE_store;
  if (!storeApi || typeof storeApi.createStore !== 'function') {
    return;
  }

  var DEFAULT_COORDINATE_TIMEOUT = 15000;
  var coordinateTimeout =
    typeof root.__XTCE_COORDINATION_TIMEOUT_MS === 'number' &&
    root.__XTCE_COORDINATION_TIMEOUT_MS > 0
      ? root.__XTCE_COORDINATION_TIMEOUT_MS
      : DEFAULT_COORDINATE_TIMEOUT;

  function noop() {}

  function coordinationError(message, code) {
    var error = new Error(message);
    error.code = code || 'XTCE_COORDINATION_UNAVAILABLE';
    return error;
  }

  /**
   * Read chrome.runtime.lastError inside a sendMessage callback. Returning it
   * instead of swallowing it is what turns a closed port or a rejected
   * message into a visible failure (and a dirty retry), never into a success.
   */
  function runtimeLastError() {
    try {
      if (
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        chrome.runtime.lastError
      ) {
        return (
          chrome.runtime.lastError.message || 'extension messaging failed'
        );
      }
    } catch (error) {
      return error && error.message ? error.message : String(error);
    }
    return null;
  }

  /**
   * Send one coordinator request to the MV3 service worker. Resolves only with
   * the service worker's committed payload; rejects on messaging errors,
   * timeouts and coordinator rejections. The timeout matters when Chrome
   * evicts the worker without closing the port promptly: an unanswered write
   * must never be reported as committed.
   */
  function sendCoordinatorRequest(request) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;

      function finish(callback, value) {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          try {
            clearTimeout(timer);
          } catch (error) {
            /* A frozen window must not break the failure path. */
          }
          timer = null;
        }
        callback(value);
      }

      var sendMessage = null;
      try {
        sendMessage =
          typeof chrome !== 'undefined' && chrome.runtime
            ? chrome.runtime.sendMessage
            : null;
      } catch (error) {
        sendMessage = null;
      }
      if (typeof sendMessage !== 'function') {
        reject(
          coordinationError(
            'The extension service worker is unavailable; refusing to read or ' +
              'write snapshots without serialization.',
            'XTCE_COORDINATION_UNAVAILABLE'
          )
        );
        return;
      }

      timer = setTimeout(function () {
        finish(
          reject,
          coordinationError(
            'The extension service worker did not answer within ' +
              coordinateTimeout +
              'ms; refusing to treat the snapshot write as committed.',
            'XTCE_COORDINATION_TIMEOUT'
          )
        );
      }, coordinateTimeout);

      try {
        chrome.runtime.sendMessage(
          { type: storeApi.COORDINATE_MESSAGE, request: request },
          function (response) {
            var lastError = runtimeLastError();
            if (lastError) {
              finish(
                reject,
                coordinationError(
                  'Extension messaging failed: ' + lastError,
                  'XTCE_COORDINATION_UNAVAILABLE'
                )
              );
              return;
            }
            if (!response || typeof response !== 'object') {
              finish(
                reject,
                coordinationError(
                  'The extension service worker returned no result; refusing ' +
                    'to treat the snapshot write as committed.',
                  'XTCE_COORDINATION_UNAVAILABLE'
                )
              );
              return;
            }
            if (response.ok) {
              var result = response.result;
              if (
                request &&
                request.op !== 'recover' &&
                (!result || typeof result !== 'object')
              ) {
                finish(
                  reject,
                  coordinationError(
                    'The extension service worker returned an invalid ' +
                      'snapshot; refusing to treat the write as committed.',
                    'XTCE_COORDINATION_UNAVAILABLE'
                  )
                );
                return;
              }
              finish(resolve, result);
              return;
            }
            var details = response.error || {};
            var error = new Error(
              details.message ||
                'The extension service worker rejected the request.'
            );
            if (typeof details.code === 'string' && details.code) {
              error.code = details.code;
            }
            finish(reject, error);
          }
        );
      } catch (error) {
        finish(
          reject,
          coordinationError(
            'Extension messaging failed: ' +
              (error && error.message ? error.message : String(error)),
            'XTCE_COORDINATION_UNAVAILABLE'
          )
        );
      }
    });
  }

  var coordinator = {
    read: function (username) {
      return sendCoordinatorRequest({ op: 'read', username: username });
    },
    commit: function (request) {
      return sendCoordinatorRequest(request);
    }
  };

  var store;
  try {
    store = storeApi.createStore({
      coordinator: coordinator,
      persistDelay: 500
    });
  } catch (error) {
    return;
  }

  function currentUsername() {
    try {
      return storeApi.usernameFromLocation(
        win.location.pathname,
        win.location.search
      );
    } catch (error) {
      return null;
    }
  }

  function syncUser() {
    try {
      var next = currentUsername();
      if (next !== store.getUsername()) {
        store.switchUser(next).catch(noop);
        return;
      }
      // Retry a transient restore failure even if no new batch arrives; the
      // store's write retries are handled by its own backoff timer.
      var lastError = store.getLastError();
      if (next && lastError && lastError.operation === 'read') {
        store.switchUser(next).catch(noop);
      }
    } catch (error) {
      /* Route changes must never break the page. */
    }
  }

  /** Request-time route stamped by the interceptor; null when untrusted. */
  function sourceFrom(data) {
    var source = data && data.source;
    if (!source || typeof source !== 'object') {
      return null;
    }
    if (
      typeof source.pathname !== 'string' ||
      source.pathname.charAt(0) !== '/'
    ) {
      return null;
    }
    return {
      pathname: source.pathname,
      search: typeof source.search === 'string' ? source.search : '',
      operation: typeof source.operation === 'string' ? source.operation : null
    };
  }

  function recordBelongsTo(record, username) {
    if (!record || typeof record !== 'object') {
      return false;
    }
    if (typeof record.author_username !== 'string') {
      return false;
    }
    return record.author_username.trim().toLowerCase() === username;
  }

  function tweetsByUser(tweets, username) {
    var kept = [];
    for (var i = 0; i < tweets.length; i += 1) {
      if (recordBelongsTo(tweets[i], username)) {
        kept.push(tweets[i]);
      }
    }
    return kept;
  }

  function postToPage(message) {
    try {
      var target = (win.location && win.location.origin) || '*';
      win.postMessage(message, target);
    } catch (error) {
      /* postMessage failures must not break the page. */
    }
  }

  function announceReady() {
    postToPage({ type: 'XTCE_COLLECTOR_READY' });
  }

  function handleMessage(event) {
    try {
      if (!event || event.origin !== win.location.origin) {
        return;
      }
      var data = event.data;
      if (!data || typeof data !== 'object') {
        return;
      }
      if (data.type === 'XTCE_INTERCEPTOR_HELLO') {
        announceReady();
        return;
      }
      if (!storeApi.isTweetMessage(data)) {
        return;
      }
      var source = sourceFrom(data);
      if (!source) {
        // A batch without a request-time route cannot be attributed safely.
        return;
      }
      var requestUser = storeApi.usernameFromLocation(
        source.pathname,
        source.search
      );
      if (!requestUser) {
        return;
      }

      // Catch up with pushState now instead of waiting for the 500 ms poll,
      // even when this response belongs to a route we already left.
      var liveUser = currentUsername();
      if (liveUser !== store.getUsername()) {
        store.switchUser(liveUser).catch(noop);
      }

      var tweets = tweetsByUser(data.tweets, requestUser);
      if (tweets.length === 0) {
        return;
      }
      store.ingestFor(requestUser, tweets).catch(noop);
    } catch (error) {
      /* Ignore malformed page messages. */
    }
  }

  function getState() {
    return store.getState();
  }

  function getUsername() {
    return store.getUsername();
  }

  function subscribe(listener) {
    return store.subscribe(listener);
  }

  function flush() {
    return store.flushNow();
  }

  function clearCurrent() {
    return store.clearCurrent();
  }

  function getLastError() {
    return store.getLastError();
  }

  function clearError() {
    return store.clearError();
  }

  root.__XTCE_content = {
    getState: getState,
    getUsername: getUsername,
    subscribe: subscribe,
    clearCurrent: clearCurrent,
    flush: flush,
    getLastError: getLastError,
    clearError: clearError
  };

  function handleStorageChanged(changes, areaName) {
    try {
      if (areaName && areaName !== 'local') {
        return;
      }
      if (!changes || typeof changes !== 'object') {
        return;
      }
      Object.keys(changes).forEach(function (key) {
        // Write-ahead journal entries share the area but are not user buckets.
        if (key.indexOf(storeApi.WAL_PREFIX) === 0) {
          return;
        }
        if (key.indexOf(storeApi.STORAGE_PREFIX) !== 0) {
          return;
        }
        var change = changes[key];
        var value = change ? change.newValue : undefined;
        if (!value) {
          // The key was removed (chrome.storage.local.remove/clear): the
          // bucket is gone, so make the stale in-memory copy go away too.
          store.mergeExternal(
            key.slice(storeApi.STORAGE_PREFIX.length),
            undefined,
            { removed: true }
          );
          return;
        }
        // Pass the whole payload, not just records: an empty records array
        // with a newer clearEpoch is a cross-tab clear, not a no-op.
        store.mergeExternal(key.slice(storeApi.STORAGE_PREFIX.length), value);
      });
    } catch (error) {
      /* A malformed change event must not break collection. */
    }
  }

  function flushQuietly() {
    try {
      store.flushNow().catch(noop);
    } catch (error) {
      /* pagehide cannot await; the next load restores from storage. */
    }
  }

  try {
    win.addEventListener('message', handleMessage, false);
    win.addEventListener('popstate', syncUser, false);
    win.addEventListener('hashchange', syncUser, false);
    win.addEventListener('pagehide', flushQuietly, false);
    setInterval(syncUser, 500);
  } catch (error) {
    /* The page may have frozen window; collection still works for now. */
  }

  try {
    if (
      typeof chrome !== 'undefined' &&
      chrome.storage &&
      chrome.storage.onChanged &&
      typeof chrome.storage.onChanged.addListener === 'function'
    ) {
      chrome.storage.onChanged.addListener(handleStorageChanged);
    }
  } catch (error) {
    /* Older Chrome builds without onChanged still merge on write. */
  }

  // The listener is installed, so buffered interceptor batches can replay.
  announceReady();
  syncUser();
})();
