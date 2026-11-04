/*
 * X Tweet CSV Exporter (Local) — per-user tweet store (S2).
 *
 * Pure, dependency-free module used by the isolated-world collector
 * (src/content.js) and by the Node tests. It performs no DOM, network or
 * chrome.* calls: persistence is injected as a tiny adapter with get/set.
 *
 * Public API (globalThis.__XTCE_store):
 *   createStore(options)                 -> store
 *   usernameFromPath(pathname)           -> lowercase username | null
 *   usernameFromLocation(pathname, search) -> username | null
 *   isTweetMessage(data)                 -> boolean
 *   storageKey(username)                 -> "xtce_<username>"
 *   STORAGE_PREFIX, RESERVED_SEGMENTS
 *
 * Store API:
 *   getState()        -> { username, count, records } for the current user
 *   subscribe(fn)     -> unsubscribe; fn(state) runs on switch/ingest/clear
 *   ingest(records)   -> number of newly added ids (dedupe by id)
 *   switchUser(name)  -> Promise<state>; restores that user's bucket once
 *   clearCurrent()    -> Promise<void>; clears memory and persisted bucket
 *   flushNow()        -> Promise<void>; writes pending buckets immediately
 *   dispose()         -> cancels the pending throttle timer
 *
 * Duplicate ids never increase the count. The newest record for an id wins
 * so refreshed engagement counts from later timeline pages are kept.
 */
(function (root) {
  'use strict';

  var STORAGE_PREFIX = 'xtce_';
  var RESERVED_SEGMENTS = Object.freeze([
    'home',
    'explore',
    'notifications',
    'messages',
    'i',
    'search',
    'settings',
    'compose',
    'bookmarks',
    'lists',
    'communities',
    'premium'
  ]);
  var USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
  var SEARCH_FROM_RE = /(?:^|\s)from:@?([A-Za-z0-9_]{1,15})(?=$|\s)/i;

  /** Lowercase and validate a username; returns null when it is not valid. */
  function normalizeUsername(value) {
    if (typeof value !== 'string') {
      return null;
    }
    var candidate = value.trim().toLowerCase();
    return USERNAME_RE.test(candidate) ? candidate : null;
  }

  function isReserved(value) {
    return RESERVED_SEGMENTS.indexOf(value) !== -1;
  }

  /**
   * The first path segment is the profile username on x.com:
   * /alice, /alice/with_replies, /alice/media, /alice/status/123.
   * Reserved application routes and malformed names return null.
   */
  function usernameFromPath(pathname) {
    if (typeof pathname !== 'string') {
      return null;
    }
    var path = pathname.split('?')[0].split('#')[0];
    var segments = path.split('/');
    var first = '';
    for (var i = 0; i < segments.length; i += 1) {
      if (segments[i]) {
        first = segments[i];
        break;
      }
    }
    if (!first) {
      return null;
    }
    var decoded = first;
    try {
      decoded = decodeURIComponent(first);
    } catch (error) {
      return null;
    }
    var username = normalizeUsername(decoded);
    if (!username || isReserved(username)) {
      return null;
    }
    return username;
  }

  function decodeQueryValue(value) {
    try {
      return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch (error) {
      return value.replace(/\+/g, ' ');
    }
  }

  /**
   * Resolve the bucket for the current route. Profile routes use the first
   * path segment. The /search route falls back to the `from:user` operator so
   * S3's date-sliced deep scan can collect into the same user bucket.
   */
  function usernameFromLocation(pathname, search) {
    var fromPath = usernameFromPath(pathname);
    if (fromPath) {
      return fromPath;
    }
    if (pathname !== '/search' && pathname !== '/search/') {
      return null;
    }
    var queryMatch = /[?&]q=([^&]*)/.exec(typeof search === 'string' ? search : '');
    if (!queryMatch) {
      return null;
    }
    var query = decodeQueryValue(queryMatch[1]);
    var fromMatch = SEARCH_FROM_RE.exec(query);
    if (!fromMatch) {
      return null;
    }
    var username = normalizeUsername(fromMatch[1]);
    if (!username || isReserved(username)) {
      return null;
    }
    return username;
  }

  function storageKey(username) {
    return STORAGE_PREFIX + username;
  }

  /** Shape check for messages posted by the MAIN-world interceptor. */
  function isTweetMessage(data) {
    return Boolean(
      data &&
        typeof data === 'object' &&
        data.type === 'XTCE_TWEETS' &&
        Array.isArray(data.tweets)
    );
  }

  function isValidRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return false;
    }
    var id = record.id;
    if (typeof id === 'number' && isFinite(id)) {
      return true;
    }
    return typeof id === 'string' && id.trim() !== '';
  }

  function recordId(record) {
    return String(record.id).trim();
  }

  /** Accept both the current object payload and a bare records array. */
  function storedRecords(value) {
    if (Array.isArray(value)) {
      return value;
    }
    if (value && typeof value === 'object' && Array.isArray(value.records)) {
      return value.records;
    }
    return [];
  }

  function createStore(options) {
    var opts = options || {};
    var storage = opts.storage || null;
    var persistDelay =
      typeof opts.persistDelay === 'number' && opts.persistDelay >= 0
        ? opts.persistDelay
        : 500;
    var schedule = opts.setTimeout || (root && root.setTimeout) || setTimeout;
    var cancel = opts.clearTimeout || (root && root.clearTimeout) || null;

    var buckets = new Map();
    var loaded = new Set();
    var dirty = new Set();
    var listeners = new Set();
    var currentUser = null;
    var timer = null;
    var writeChain = Promise.resolve();

    function ensureBucket(username) {
      var bucket = buckets.get(username);
      if (!bucket) {
        bucket = new Map();
        buckets.set(username, bucket);
      }
      return bucket;
    }

    function snapshot(username) {
      var bucket = buckets.get(username);
      return bucket ? Array.from(bucket.values()) : [];
    }

    function getState() {
      var records = currentUser ? snapshot(currentUser) : [];
      return {
        username: currentUser,
        count: records.length,
        records: records
      };
    }

    function notify() {
      var state = getState();
      listeners.forEach(function (listener) {
        try {
          listener(state);
        } catch (error) {
          /* A bad subscriber must not break collection. */
        }
      });
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') {
        return function () {};
      }
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    }

    function scheduleFlush() {
      if (timer !== null) {
        return;
      }
      timer = schedule(function () {
        timer = null;
        try {
          return flushDirty();
        } catch (error) {
          /* Storage failures are retried by the next ingest/switch. */
          return undefined;
        }
      }, persistDelay);
    }

    function enqueueWrite(username, records) {
      if (!storage || typeof storage.set !== 'function') {
        return Promise.resolve();
      }
      var key = storageKey(username);
      var payload = {
        version: 1,
        username: username,
        updatedAt: new Date().toISOString(),
        records: records
      };
      writeChain = writeChain
        .then(function () {
          try {
            return Promise.resolve(storage.set(key, payload)).catch(function () {
              // Keep the snapshot dirty; the next ingest/switch/pagehide
              // retries it instead of spinning on a broken quota forever.
              dirty.add(username);
            });
          } catch (error) {
            dirty.add(username);
            return undefined;
          }
        })
        .catch(function () {
          // Keep the chain usable even if a previous write failed oddly.
          dirty.add(username);
        });
      return writeChain;
    }

    function flushDirty() {
      if (timer !== null) {
        if (typeof cancel === 'function') {
          cancel(timer);
        }
        timer = null;
      }
      var users = Array.from(dirty);
      dirty.clear();
      if (users.length === 0 || !storage || typeof storage.set !== 'function') {
        return writeChain;
      }
      var writes = [];
      for (var i = 0; i < users.length; i += 1) {
        writes.push(enqueueWrite(users[i], snapshot(users[i])));
      }
      return Promise.all(writes);
    }

    function flushNow() {
      return flushDirty();
    }

    function restore(username) {
      if (!username || loaded.has(username)) {
        return Promise.resolve();
      }
      loaded.add(username);
      if (!storage || typeof storage.get !== 'function') {
        return Promise.resolve();
      }
      var reading;
      try {
        reading = storage.get(storageKey(username));
      } catch (error) {
        loaded.delete(username);
        return Promise.resolve();
      }
      return Promise.resolve(reading)
        .then(function (stored) {
          var records = storedRecords(stored);
          var bucket = ensureBucket(username);
          for (var i = 0; i < records.length; i += 1) {
            var record = records[i];
            if (!isValidRecord(record)) {
              continue;
            }
            var id = recordId(record);
            // Keep an in-memory record if one arrived while storage loaded.
            if (!bucket.has(id)) {
              bucket.set(id, record);
            }
          }
          if (currentUser === username) {
            notify();
          }
        })
        .catch(function () {
          loaded.delete(username);
        });
    }

    function switchUser(username) {
      var next = normalizeUsername(username);
      if (next && isReserved(next)) {
        next = null;
      }
      if (next === currentUser) {
        return restore(next).then(function () {
          return getState();
        });
      }
      currentUser = next;
      if (next) {
        ensureBucket(next);
      }
      notify();
      // Persist the previous bucket promptly instead of waiting for the
      // throttle window when the route changes.
      if (dirty.size > 0) {
        try {
          flushNow();
        } catch (error) {
          /* Retried later. */
        }
      }
      return restore(next).then(function () {
        return getState();
      });
    }

    function ingest(records) {
      var username = currentUser;
      if (!username || !Array.isArray(records)) {
        return 0;
      }
      var bucket = ensureBucket(username);
      var added = 0;
      var accepted = 0;
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        if (!isValidRecord(record)) {
          continue;
        }
        accepted += 1;
        var id = recordId(record);
        if (!bucket.has(id)) {
          added += 1;
        }
        bucket.set(id, record);
      }
      if (accepted > 0) {
        dirty.add(username);
        scheduleFlush();
        notify();
      }
      return added;
    }

    function clearCurrent() {
      var username = currentUser;
      if (!username) {
        return Promise.resolve();
      }
      var bucket = ensureBucket(username);
      bucket.clear();
      dirty.delete(username);
      // Do not re-read the old body from storage if this route is revisited.
      loaded.add(username);
      notify();
      return enqueueWrite(username, []);
    }

    function dispose() {
      if (timer !== null) {
        if (typeof cancel === 'function') {
          cancel(timer);
        }
        timer = null;
      }
      listeners.clear();
    }

    return {
      getState: getState,
      subscribe: subscribe,
      ingest: ingest,
      switchUser: switchUser,
      clearCurrent: clearCurrent,
      flushNow: flushNow,
      dispose: dispose
    };
  }

  var api = {
    createStore: createStore,
    usernameFromPath: usernameFromPath,
    usernameFromLocation: usernameFromLocation,
    isTweetMessage: isTweetMessage,
    storageKey: storageKey,
    STORAGE_PREFIX: STORAGE_PREFIX,
    RESERVED_SEGMENTS: RESERVED_SEGMENTS
  };

  if (root) {
    root.__XTCE_store = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
