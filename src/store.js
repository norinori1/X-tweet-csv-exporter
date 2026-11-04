/*
 * X Tweet CSV Exporter (Local) — per-user tweet store (S2).
 *
 * Pure, dependency-free module used by the isolated-world collector
 * (src/content.js) and by the Node tests. It performs no DOM, network or
 * chrome.* calls: persistence is injected as a tiny adapter with get/set.
 *
 * Public API (globalThis.__XTCE_store):
 *   createStore(options)                    -> store
 *   usernameFromPath(pathname)              -> lowercase username | null
 *   usernameFromLocation(pathname, search)  -> username | null
 *   isTweetMessage(data)                    -> boolean
 *   recordsFromStored(value)                -> records array
 *   normalizeUsername(value)                -> lowercase username | null
 *   storageKey(username)                    -> "xtce_<username>"
 *   STORAGE_PREFIX, RESERVED_SEGMENTS
 *
 * Store API:
 *   getState()          -> { username, count, records, error }
 *   getUsername()       -> current bucket username | null (cheap)
 *   getLastError()      -> { message, operation, username, at } | null
 *   clearError()        -> void
 *   subscribe(fn)       -> unsubscribe; fn(state) on switch/ingest/clear/error
 *   ingest(records)     -> newly added ids for the current user (sync)
 *   ingestFor(name, records) -> Promise<newly added ids>; safely loads the
 *                              bucket first, so a late response can be routed
 *                              to its request-time user without overwriting
 *                              stored records with a partial snapshot.
 *   switchUser(name)    -> Promise<state>; restores that user's bucket once
 *   clearCurrent()      -> Promise<void>; clears memory and persisted bucket
 *   flushNow()          -> Promise<void>; writes pending buckets immediately
 *   ensureLoaded(name)  -> Promise<void>; restore-once helper
 *   mergeExternal(name, records) -> add records written by another tab
 *   dispose()           -> cancels the pending throttle timer
 *
 * Durability rules:
 *   - A merge-write never runs before that user's initial restore settled and
 *     it always re-reads storage under the injected lock before writing. Two
 *     tabs therefore merge snapshots instead of clobbering each other.
 *   - clearCurrent invalidates any in-flight restore, so an old read cannot
 *     resurrect records after the clear.
 *   - A failed read or write keeps the bucket dirty, records the error for S3
 *     and schedules a retry; it is never reported as success.
 *
 * Duplicate ids never increase the count. The newest in-memory record for an
 * id wins, while records restored from storage never replace one that arrived
 * while the read was in flight.
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
  var RETRY_MAX_DELAY = 30000;

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
  function recordsFromStored(value) {
    if (Array.isArray(value)) {
      return value;
    }
    if (value && typeof value === 'object' && Array.isArray(value.records)) {
      return value.records;
    }
    return [];
  }

  function errorMessage(error) {
    if (error && typeof error.message === 'string' && error.message) {
      return error.message;
    }
    return String(error || 'storage operation failed');
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
    var withLock =
      typeof opts.withLock === 'function'
        ? opts.withLock
        : function (name, task) {
            return Promise.resolve().then(task);
          };

    var buckets = new Map();
    var loaded = new Set();
    var restorePromises = new Map();
    var restoreVersions = new Map();
    var clearPending = new Set();
    var dirty = new Set();
    var revisions = new Map();
    var retryAttempts = new Map();
    var flushChains = new Map();
    var listeners = new Set();
    var currentUser = null;
    var timer = null;
    var lastError = null;

    function noop() {}

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
        records: records,
        error: lastError
          ? {
              message: lastError.message,
              operation: lastError.operation,
              username: lastError.username,
              at: lastError.at
            }
          : null
      };
    }

    function getUsername() {
      return currentUser;
    }

    function getLastError() {
      if (!lastError) {
        return null;
      }
      return {
        message: lastError.message,
        operation: lastError.operation,
        username: lastError.username,
        at: lastError.at
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

    function recordError(operation, username, error) {
      lastError = {
        message: errorMessage(error),
        operation: operation,
        username: username || null,
        at: new Date().toISOString()
      };
      try {
        if (error && typeof error === 'object') {
          error.__xtceFailureRecorded = true;
        }
      } catch (ignored) {
        /* Frozen error objects are fine. */
      }
    }

    function clearErrorFor(username) {
      if (!lastError) {
        return false;
      }
      if (username && lastError.username && lastError.username !== username) {
        return false;
      }
      lastError = null;
      return true;
    }

    function clearError() {
      if (!lastError) {
        return;
      }
      lastError = null;
      notify();
    }

    function scheduleFlush(delay) {
      if (timer !== null) {
        return;
      }
      var wait =
        typeof delay === 'number' && delay >= 0 ? delay : persistDelay;
      timer = schedule(function () {
        timer = null;
        var result;
        try {
          result = flushDirty();
        } catch (error) {
          return undefined;
        }
        if (result && typeof result.catch === 'function') {
          // Return the chain so the deterministic test scheduler can await it;
          // browsers ignore a timer callback's return value.
          return result.catch(noop);
        }
        return undefined;
      }, wait);
    }

    function cancelTimer() {
      if (timer === null) {
        return;
      }
      if (typeof cancel === 'function') {
        cancel(timer);
      }
      timer = null;
    }

    function scheduleRetry(username) {
      var attempts = (retryAttempts.get(username) || 0) + 1;
      retryAttempts.set(username, attempts);
      var base = persistDelay > 0 ? persistDelay : 1;
      var delay = Math.min(base * Math.pow(2, attempts - 1), RETRY_MAX_DELAY);
      if (!isFinite(delay) || delay < 1) {
        delay = 1;
      }
      scheduleFlush(delay);
    }

    function fail(username, operation, error) {
      dirty.add(username);
      if (!(error && error.__xtceFailureRecorded)) {
        recordError(operation, username, error);
      }
      scheduleRetry(username);
      // Always notify: S3 may be displaying another user's bucket while this
      // background write failed, and getState().error is global.
      notify();
      return Promise.reject(error);
    }

    function readStored(username) {
      try {
        return Promise.resolve(storage.get(storageKey(username)));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    function writePayload(username, records) {
      var payload = {
        version: 1,
        username: username,
        updatedAt: new Date().toISOString(),
        records: records
      };
      try {
        return Promise.resolve(storage.set(storageKey(username), payload));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    function runLocked(username, task) {
      try {
        return Promise.resolve(withLock(storageKey(username), task));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    /**
     * Merge records into a bucket. In-memory records win for the same id;
     * `override` is only used by ingest (a newer payload for the same id).
     */
    function mergeRecords(username, records, override) {
      var bucket = ensureBucket(username);
      var added = 0;
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        if (!isValidRecord(record)) {
          continue;
        }
        var id = recordId(record);
        if (!bucket.has(id)) {
          bucket.set(id, record);
          added += 1;
        } else if (override) {
          bucket.set(id, record);
        }
      }
      return added;
    }

    function restore(username) {
      if (!username) {
        return Promise.resolve();
      }
      if (loaded.has(username)) {
        return Promise.resolve();
      }
      var pending = restorePromises.get(username);
      if (pending) {
        return pending;
      }
      if (!storage || typeof storage.get !== 'function') {
        loaded.add(username);
        return Promise.resolve();
      }
      var version = restoreVersions.get(username) || 0;
      var reading = readStored(username).then(
        function (stored) {
          // A clear that happened while this read was in flight wins: do not
          // merge the old body back into memory.
          if ((restoreVersions.get(username) || 0) !== version) {
            return;
          }
          var added = mergeRecords(username, recordsFromStored(stored), false);
          loaded.add(username);
          retryAttempts.delete(username);
          var cleared = clearErrorFor(username);
          if (cleared || (currentUser === username && added > 0)) {
            notify();
          }
        },
        function (error) {
          if ((restoreVersions.get(username) || 0) === version) {
            recordError('read', username, error);
            if (currentUser === username) {
              notify();
            }
          }
          throw error;
        }
      );
      var tracked = reading.then(
        function () {
          restorePromises.delete(username);
        },
        function (error) {
          restorePromises.delete(username);
          throw error;
        }
      );
      restorePromises.set(username, tracked);
      return tracked;
    }

    function ensureLoaded(username) {
      if (!username || loaded.has(username)) {
        return Promise.resolve();
      }
      return restore(username);
    }

    function ingestInto(username, records) {
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
        revisions.set(username, (revisions.get(username) || 0) + 1);
        dirty.add(username);
        retryAttempts.delete(username);
        scheduleFlush();
        if (currentUser === username) {
          notify();
        }
      }
      return added;
    }

    function ingest(records) {
      var username = currentUser;
      if (!username || !Array.isArray(records)) {
        return 0;
      }
      return ingestInto(username, records);
    }

    function ingestFor(username, records) {
      var next = normalizeUsername(username);
      if (!next || isReserved(next) || !Array.isArray(records)) {
        return Promise.resolve(0);
      }
      var version = restoreVersions.get(next) || 0;
      return ensureLoaded(next)
        .catch(noop)
        .then(function () {
          // If the user cleared this bucket while the restore was in flight,
          // the batch was received for the pre-clear context: drop it.
          if ((restoreVersions.get(next) || 0) !== version) {
            return 0;
          }
          return ingestInto(next, records);
        });
    }

    function mergeTask(username) {
      return ensureLoaded(username).then(function () {
        if (!dirty.has(username) || clearPending.has(username)) {
          return undefined;
        }
        var revision = revisions.get(username) || 0;
        return runLocked(username, function () {
          if (!dirty.has(username) || clearPending.has(username)) {
            return undefined;
          }
          return readStored(username).then(function (stored) {
            if (!dirty.has(username) || clearPending.has(username)) {
              return undefined;
            }
            var added = mergeRecords(
              username,
              recordsFromStored(stored),
              false
            );
            if (added > 0 && currentUser === username) {
              notify();
            }
            return writePayload(username, snapshot(username)).then(function () {
              if ((revisions.get(username) || 0) === revision) {
                dirty.delete(username);
              } else {
                // A new batch arrived while the write was in flight; write it
                // in the next pass instead of dropping it.
                scheduleFlush();
              }
              retryAttempts.delete(username);
              if (clearErrorFor(username)) {
                notify();
              }
            });
          });
        });
      });
    }

    function clearTask(username) {
      if (!clearPending.has(username)) {
        return Promise.resolve();
      }
      var revision = revisions.get(username) || 0;
      return runLocked(username, function () {
        if (!clearPending.has(username)) {
          return undefined;
        }
        // Deliberately do not read-merge here: clear means empty. If new
        // tweets arrive afterwards they are written by a later merge pass.
        return writePayload(username, []).then(function () {
          clearPending.delete(username);
          if ((revisions.get(username) || 0) === revision) {
            dirty.delete(username);
          } else {
            scheduleFlush();
          }
          retryAttempts.delete(username);
          if (clearErrorFor(username)) {
            notify();
          }
        });
      });
    }

    function doFlushUser(username) {
      if (!dirty.has(username)) {
        return Promise.resolve();
      }
      if (!storage || typeof storage.set !== 'function') {
        dirty.delete(username);
        clearPending.delete(username);
        return Promise.resolve();
      }
      var isClear = clearPending.has(username);
      var task = isClear ? clearTask(username) : mergeTask(username);
      return task.catch(function (error) {
        return fail(username, isClear ? 'clear' : 'flush', error);
      });
    }

    function flushUser(username) {
      var previous = flushChains.get(username) || Promise.resolve();
      var job = previous.then(
        function () {
          return doFlushUser(username);
        },
        function () {
          return doFlushUser(username);
        }
      );
      var tracked = job.then(
        function () {
          return undefined;
        },
        function (error) {
          throw error;
        }
      );
      flushChains.set(username, tracked.catch(noop));
      return tracked;
    }

    function flushDirty() {
      cancelTimer();
      var users = Array.from(dirty);
      if (users.length === 0) {
        return Promise.resolve();
      }
      var jobs = users.map(function (username) {
        return flushUser(username).then(
          function () {
            return null;
          },
          function (error) {
            return error || new Error('flush failed');
          }
        );
      });
      return Promise.all(jobs).then(function (errors) {
        for (var i = 0; i < errors.length; i += 1) {
          if (errors[i]) {
            throw errors[i];
          }
        }
        return undefined;
      });
    }

    function switchUser(username) {
      var next = normalizeUsername(username);
      if (next && isReserved(next)) {
        next = null;
      }
      var finish = function () {
        return getState();
      };
      if (next === currentUser) {
        return restore(next).then(finish, finish);
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
          flushDirty().catch(noop);
        } catch (error) {
          /* Retried later. */
        }
      }
      return restore(next).then(finish, finish);
    }

    function clearCurrent() {
      var username = currentUser;
      if (!username) {
        return Promise.resolve();
      }
      // Invalidate any restore that started before this clear. It must never
      // merge the old body back after the bucket was emptied.
      restoreVersions.set(username, (restoreVersions.get(username) || 0) + 1);
      loaded.add(username);
      clearPending.add(username);
      ensureBucket(username).clear();
      revisions.set(username, (revisions.get(username) || 0) + 1);
      dirty.add(username);
      retryAttempts.delete(username);
      notify();
      return flushUser(username);
    }

    function mergeExternal(username, records) {
      var next = normalizeUsername(username);
      if (!next || isReserved(next) || !Array.isArray(records)) {
        return 0;
      }
      // Honour an in-progress clear instead of resurrecting records from a
      // change event fired by another tab.
      if (clearPending.has(next)) {
        return 0;
      }
      var added = mergeRecords(next, records, false);
      if (added > 0 && currentUser === next) {
        notify();
      }
      return added;
    }

    function dispose() {
      cancelTimer();
      listeners.clear();
    }

    return {
      getState: getState,
      getUsername: getUsername,
      getLastError: getLastError,
      clearError: clearError,
      subscribe: subscribe,
      ingest: ingest,
      ingestFor: ingestFor,
      switchUser: switchUser,
      clearCurrent: clearCurrent,
      flushNow: flushDirty,
      ensureLoaded: ensureLoaded,
      mergeExternal: mergeExternal,
      dispose: dispose
    };
  }

  var api = {
    createStore: createStore,
    usernameFromPath: usernameFromPath,
    usernameFromLocation: usernameFromLocation,
    isTweetMessage: isTweetMessage,
    recordsFromStored: recordsFromStored,
    normalizeUsername: normalizeUsername,
    storageKey: storageKey,
    STORAGE_PREFIX: STORAGE_PREFIX,
    RESERVED_SEGMENTS: RESERVED_SEGMENTS
  };

  if (root) {
    root.__XTCE_store = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
