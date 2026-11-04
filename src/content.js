/*
 * X Tweet CSV Exporter (Local) — isolated-world collector (S2).
 *
 * Listens for XTCE_TWEETS batches from the MAIN-world interceptor, dedupes
 * them by tweet id in the current profile's Map, and persists each profile
 * under `xtce_<username>` in chrome.storage.local (throttled to ~500 ms).
 *
 * Route handling:
 *   - /alice, /alice/with_replies, /alice/media, /alice/status/123
 *     -> bucket "alice"
 *   - /search?q=from:alice ... (S3 deep scan) -> bucket "alice"
 *   - /home, /explore, /i/bookmarks, ... -> no bucket; batches are ignored
 *
 * x.com is a SPA, so the route is checked on popstate/hashchange and every
 * 500 ms (history.pushState cannot be observed from an isolated world).
 *
 * S3 API (isolated world, globalThis.__XTCE_content):
 *   getState()        -> { username, count, records }
 *   subscribe(fn)     -> unsubscribe; fn(state) on switch/ingest/clear
 *   clearCurrent()    -> Promise<void>
 *   flush()           -> Promise<void>
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

  function consumeLastError() {
    try {
      if (chrome.runtime && chrome.runtime.lastError) {
        /* Fragment-level data loss is recoverable on the next full write. */
      }
    } catch (error) {
      /* Extension context may have been invalidated. */
    }
  }

  var storage = {
    get: function (key) {
      return new Promise(function (resolve) {
        try {
          chrome.storage.local.get(key, function (items) {
            consumeLastError();
            resolve(
              items && Object.prototype.hasOwnProperty.call(items, key)
                ? items[key]
                : undefined
            );
          });
        } catch (error) {
          resolve(undefined);
        }
      });
    },
    set: function (key, value) {
      return new Promise(function (resolve) {
        try {
          var items = {};
          items[key] = value;
          chrome.storage.local.set(items, function () {
            consumeLastError();
            resolve();
          });
        } catch (error) {
          resolve();
        }
      });
    }
  };

  var store;
  try {
    store = storeApi.createStore({ storage: storage, persistDelay: 500 });
  } catch (error) {
    return;
  }

  function currentUsername() {
    try {
      return storeApi.usernameFromLocation(win.location.pathname, win.location.search);
    } catch (error) {
      return null;
    }
  }

  function syncUser() {
    try {
      store.switchUser(currentUsername()).catch(noop);
    } catch (error) {
      /* Route changes must never break the page. */
    }
  }

  function handleMessage(event) {
    try {
      if (!event || event.origin !== win.location.origin) {
        return;
      }
      if (!storeApi.isTweetMessage(event.data)) {
        return;
      }
      store.ingest(event.data.tweets);
    } catch (error) {
      /* Ignore malformed page messages. */
    }
  }

  function getState() {
    return store.getState();
  }

  function subscribe(listener) {
    return store.subscribe(listener);
  }

  function flush() {
    try {
      return store.flushNow();
    } catch (error) {
      return Promise.resolve();
    }
  }

  function clearCurrent() {
    try {
      return store.clearCurrent();
    } catch (error) {
      return Promise.resolve();
    }
  }

  root.__XTCE_content = {
    getState: getState,
    subscribe: subscribe,
    clearCurrent: clearCurrent,
    flush: flush
  };

  try {
    win.addEventListener('message', handleMessage, false);
    win.addEventListener('popstate', syncUser, false);
    win.addEventListener('hashchange', syncUser, false);
    win.addEventListener('pagehide', flush, false);
    setInterval(syncUser, 500);
  } catch (error) {
    /* The page may have frozen window; collection still works for now. */
  }

  syncUser();
})();
