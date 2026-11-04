/*
 * X Tweet CSV Exporter (Local) — isolated-world collector (S2).
 *
 * Listens for XTCE_TWEETS batches from the MAIN-world interceptor, dedupes
 * them by tweet id in the current profile's Map, and persists each profile
 * under `xtce_<username>` in chrome.storage.local (throttled to ~500 ms).
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
 * Storage:
 *   - chrome.runtime.lastError is checked and converted into a rejected
 *     promise; quota/read failures are never reported as success.
 *   - The store keeps failed writes dirty and retries with backoff.
 *   - Merge-on-write (under navigator.locks when available) means two tabs on
 *     the same origin collecting the same user add to the snapshot instead of
 *     clobbering it.
 *   - chrome.storage.onChanged applies records *and clears* written by another
 *     tab. Empty snapshots are no longer ignored: the payload's clearEpoch
 *     tells a tab to drop records that predate the clear, so a stale tab
 *     cannot re-flush them.
 *   - navigator.locks is origin-scoped, so x.com and twitter.com tabs cannot
 *     serialize through it. The store publishes a short-lived per-user writer
 *     lease in chrome.storage.local (shared by both origins) and fails closed
 *     with XTCE_CROSS_ORIGIN_BUSY instead of overwriting a peer origin.
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
 * Coordination errors carry `code` so S3 can distinguish an unavoidable
 * cross-origin conflict (XTCE_CROSS_ORIGIN_BUSY) from a quota failure.
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

  function noop() {}

  function hasOwn(object, key) {
    return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
  }

  /**
   * Read chrome.runtime.lastError inside the storage callback. Returning it
   * instead of swallowing it is what lets the store keep a dirty retry and
   * lets S3 display the quota/read failure.
   */
  function storageLastError() {
    try {
      if (
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        chrome.runtime.lastError
      ) {
        return new Error(
          chrome.runtime.lastError.message || 'chrome.storage operation failed'
        );
      }
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    return null;
  }

  var storage = {
    get: function (key) {
      return new Promise(function (resolve, reject) {
        try {
          chrome.storage.local.get(key, function (items) {
            var error = storageLastError();
            if (error) {
              reject(error);
              return;
            }
            resolve(hasOwn(items, key) ? items[key] : undefined);
          });
        } catch (error) {
          reject(error);
        }
      });
    },
    set: function (key, value) {
      return new Promise(function (resolve, reject) {
        try {
          var items = {};
          items[key] = value;
          chrome.storage.local.set(items, function () {
            var error = storageLastError();
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        } catch (error) {
          reject(error);
        }
      });
    },
    /**
     * Read the peer origin's writer lease. The store uses this to detect an
     * x.com/twitter.com writer that a same-origin Web Lock cannot see.
     */
    getMany: function (keys) {
      return new Promise(function (resolve, reject) {
        try {
          chrome.storage.local.get(keys, function (items) {
            var error = storageLastError();
            if (error) {
              reject(error);
              return;
            }
            resolve(items || {});
          });
        } catch (error) {
          reject(error);
        }
      });
    },
    remove: function (keys) {
      return new Promise(function (resolve, reject) {
        try {
          chrome.storage.local.remove(keys, function () {
            var error = storageLastError();
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        } catch (error) {
          reject(error);
        }
      });
    }
  };

  /**
   * Web Locks are origin-scoped, so two tabs of the same origin serialize
   * their read-merge-write on the same user bucket. They cannot coordinate
   * x.com against twitter.com; the store's shared storage lease does that.
   */
  function withUserLock(username, task) {
    try {
      var locks =
        typeof navigator !== 'undefined' && navigator ? navigator.locks : null;
      if (locks && typeof locks.request === 'function') {
        return locks.request('xtce_lock_' + username, task);
      }
    } catch (error) {
      /* Fall through to the in-process chain. */
    }
    return Promise.resolve().then(task);
  }

  // The extension only runs on these two hosts (manifest host_permissions),
  // and both share chrome.storage.local. Web Locks never cross this boundary.
  var COORDINATION_ORIGINS = ['https://x.com', 'https://twitter.com'];
  var pageOrigin = '';
  try {
    pageOrigin =
      win.location && typeof win.location.origin === 'string'
        ? win.location.origin
        : '';
  } catch (error) {
    pageOrigin = '';
  }
  var peerOrigins = COORDINATION_ORIGINS.filter(function (candidate) {
    return candidate !== pageOrigin;
  });

  var store;
  try {
    store = storeApi.createStore({
      storage: storage,
      persistDelay: 500,
      withLock: withUserLock,
      origin: pageOrigin,
      peerOrigins: peerOrigins
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
        if (key.indexOf(storeApi.STORAGE_PREFIX) !== 0) {
          return;
        }
        // Writer leases share the storage area but are not user buckets.
        if (key.indexOf(storeApi.COORDINATION_PREFIX) === 0) {
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
