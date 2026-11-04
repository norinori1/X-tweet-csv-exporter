/*
 * X Tweet CSV Exporter (Local) — per-user tweet store (S2).
 *
 * Pure, dependency-free module used by the isolated-world collector
 * (src/content.js) and by the Node tests. It performs no DOM, network or
 * chrome.* calls. Persistence is injected as a `coordinator` (the MV3
 * extension service worker, or a test double) with two methods:
 *
 *   coordinator.read(username)   -> Promise<stored payload | undefined>
 *   coordinator.commit(request)  -> Promise<stored payload>
 *
 * The store keeps an in-memory cache for S3 and decides *what* to ask the
 * coordinator to do; the coordinator decides *when* and performs the
 * read-modify-write. The store never touches chrome.storage directly, so it
 * cannot silently fall back to an unserialized write.
 *
 * Public API (globalThis.__XTCE_store):
 *   createStore(options)                    -> store
 *   usernameFromPath(pathname)              -> lowercase username | null
 *   usernameFromLocation(pathname, search)  -> username | null
 *   isTweetMessage(data)                    -> boolean
 *   recordsFromStored(value)                -> records array
 *   normalizeUsername(value)                -> lowercase username | null
 *   storageKey(username)                    -> "xtce_<username>"
 *   clearEpochFromStored(value)             -> non-negative integer
 *   isValidRecord(record)                   -> boolean
 *   recordId(record)                        -> string id
 *   STORAGE_PREFIX, WAL_PREFIX, COORDINATE_MESSAGE, PAYLOAD_VERSION,
 *   RESERVED_SEGMENTS
 *
 * Store API:
 *   getState()          -> { username, count, records, error }
 *   getUsername()       -> current bucket username | null (cheap)
 *   getLastError()      -> { message, operation, username, at, code } | null
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
 *   mergeExternal(name, value, options) -> apply a snapshot written by another
 *                              tab (including its clear epoch / removal)
 *   dispose()           -> cancels the pending throttle timer
 *
 * Durability rules:
 *   - Every persisted read and write goes through the shared coordinator.
 *     If it is unavailable (extension messaging failed, the service worker
 *     was evicted and did not answer, or a test created the store without
 *     one), the store fails closed: no snapshot write happens, the bucket
 *     stays dirty, and getState().error carries XTCE_COORDINATION_UNAVAILABLE
 *     / XTCE_COORDINATION_TIMEOUT. There is no direct-storage or per-origin
 *     lock fallback.
 *   - The coordinator serializes all tabs and both x.com and twitter.com
 *     through one per-user queue. A commit is a read-modify-write performed
 *     inside that queue; the store's in-memory snapshot is only an input.
 *   - Every payload carries a monotonically increasing `clearEpoch`. A clear
 *     (or a removed storage key) advances it and empties the payload; a
 *     commit that sees a newer stored epoch adopts the clear instead of
 *     writing the stale bucket back. This is what stops a stale tab (or an
 *     in-flight pre-clear write) from resurrecting deleted tweets.
 *   - clearCurrent invalidates any in-flight restore, so an old read cannot
 *     resurrect records after the clear.
 *   - A failed read or write keeps the bucket dirty, records the error for S3
 *     and schedules a retry; it is never reported as success.
 *
 * Duplicate ids never increase the count. The newest in-memory record for an
 * id wins, while records restored from storage never replace one that arrived
 * while the read was in flight. A clear wins over any batch that was in memory
 * when the clear became visible; only batches received after the tab observed
 * the clear are kept.
 */
(function (root) {
  'use strict';

  var STORAGE_PREFIX = 'xtce_';
  var WAL_PREFIX = 'xtce:wal:';
  var COORDINATE_MESSAGE = 'XTCE_COORDINATE';
  var PAYLOAD_VERSION = 2;
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

  /**
   * Read the clear generation from a stored payload. Payloads written before
   * the clear epoch existed (or bare arrays) are generation 0.
   */
  function clearEpochFromStored(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return 0;
    }
    var epoch = value.clearEpoch;
    if (typeof epoch !== 'number' || !isFinite(epoch) || epoch <= 0) {
      return 0;
    }
    return Math.floor(epoch);
  }

  function errorMessage(error) {
    if (error && typeof error.message === 'string' && error.message) {
      return error.message;
    }
    return String(error || 'storage operation failed');
  }

  function coordinationError(message, code) {
    var error = new Error(message);
    error.code = code || 'XTCE_COORDINATION_UNAVAILABLE';
    return error;
  }

  function createStore(options) {
    var opts = options || {};
    if (opts.withLock || opts.origin || opts.peerOrigins || opts.coordinationTtl) {
      // These options belonged to the removed per-origin lock / writer-lease
      // design. Silently accepting them would make a caller believe a write is
      // serialized when it is not.
      throw new Error(
        'createStore no longer accepts per-origin locks or writer leases; ' +
          'all snapshot writes must go through the shared coordinator.'
      );
    }
    var coordinator =
      opts.coordinator &&
      typeof opts.coordinator.read === 'function' &&
      typeof opts.coordinator.commit === 'function'
        ? opts.coordinator
        : null;
    var persistDelay =
      typeof opts.persistDelay === 'number' && opts.persistDelay >= 0
        ? opts.persistDelay
        : 500;
    var schedule = opts.setTimeout || (root && root.setTimeout) || setTimeout;
    var cancel = opts.clearTimeout || (root && root.clearTimeout) || null;

    var buckets = new Map();
    var loaded = new Set();
    var restorePromises = new Map();
    var restoreVersions = new Map();
    var clearPending = new Set();
    var clearTokens = new Map();
    var clearEpochs = new Map();
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
              at: lastError.at,
              code: lastError.code || null
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
        at: lastError.at,
        code: lastError.code || null
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
        at: new Date().toISOString(),
        code:
          error && typeof error.code === 'string' && error.code
            ? error.code
            : null
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

    function readPayload(username) {
      if (!coordinator) {
        return Promise.reject(
          coordinationError(
            'The shared storage coordinator is unavailable; refusing to read ' +
              username +
              "'s snapshot.",
            'XTCE_COORDINATION_UNAVAILABLE'
          )
        );
      }
      var reading;
      try {
        reading = Promise.resolve(coordinator.read(username));
      } catch (error) {
        return Promise.reject(error);
      }
      return reading.then(function (stored) {
        if (
          stored !== undefined &&
          stored !== null &&
          (typeof stored !== 'object' ||
            (!Array.isArray(stored) && !Array.isArray(stored.records)))
        ) {
          throw coordinationError(
            'The storage coordinator returned a snapshot without records ' +
              'for ' +
              username +
              '; refusing to treat it as empty.',
            'XTCE_COORDINATION_UNAVAILABLE'
          );
        }
        return stored;
      });
    }

    function commitPayload(request) {
      if (!coordinator) {
        return Promise.reject(
          coordinationError(
            'The shared storage coordinator is unavailable; refusing to write ' +
              request.username +
              "'s snapshot.",
            'XTCE_COORDINATION_UNAVAILABLE'
          )
        );
      }
      try {
        return Promise.resolve(coordinator.commit(request));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    function requireSnapshot(response) {
      if (!response || typeof response !== 'object') {
        throw coordinationError(
          'The storage coordinator returned an invalid snapshot.',
          'XTCE_COORDINATION_UNAVAILABLE'
        );
      }
      if (!Array.isArray(response) && !Array.isArray(response.records)) {
        throw coordinationError(
          'The storage coordinator returned a snapshot without records; ' +
            'refusing to treat it as an empty bucket.',
          'XTCE_COORDINATION_UNAVAILABLE'
        );
      }
      return response;
    }

    /**
     * Adopt a newer clear generation. Every in-memory record is dropped: the
     * clear happened while this tab was stale, so its records may predate the
     * clear. Epochs are monotonic, so this only runs for a genuinely newer
     * clear. A pending local clear stays pending and will bump the epoch again.
     */
    function adoptClear(username, epoch) {
      var known = clearEpochs.get(username) || 0;
      if (epoch <= known) {
        return false;
      }
      clearEpochs.set(username, epoch);
      ensureBucket(username).clear();
      // Any restore that read the pre-clear body must not merge it back.
      restoreVersions.set(username, (restoreVersions.get(username) || 0) + 1);
      revisions.set(username, (revisions.get(username) || 0) + 1);
      retryAttempts.delete(username);
      if (clearPending.has(username)) {
        // The local clear still has to run; keep the bucket dirty so it does.
        dirty.add(username);
      } else {
        dirty.delete(username);
      }
      return true;
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
      var version = restoreVersions.get(username) || 0;
      var reading = readPayload(username).then(
        function (stored) {
          // A clear that happened while this read was in flight wins: do not
          // merge the old body back into memory.
          if ((restoreVersions.get(username) || 0) !== version) {
            return;
          }
          var storedEpoch = clearEpochFromStored(stored);
          var knownEpoch = clearEpochs.get(username) || 0;
          if (storedEpoch > knownEpoch) {
            // Another tab cleared before our read resolved; the body we read
            // is pre-clear and must not be restored.
            adoptClear(username, storedEpoch);
          } else if (storedEpoch < knownEpoch) {
            // Storage has a pre-clear snapshot (e.g. a stale writer). Never
            // merge it back; repair the stored clear marker on the next pass.
            loaded.add(username);
            retryAttempts.delete(username);
            dirty.add(username);
            scheduleFlush();
            if (currentUser === username) {
              notify();
            }
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

    /**
     * Reconcile a commit response with the local cache. The coordinator is
     * authoritative: it may have adopted another tab's clear (epoch bump) or
     * merged records this tab had not seen.
     */
    function applyCommitResponse(username, response, revision, version) {
      var payload = requireSnapshot(response);
      var responseEpoch = clearEpochFromStored(payload);
      var currentEpoch = clearEpochs.get(username) || 0;
      var localClear = clearPending.has(username);
      var superseded = (restoreVersions.get(username) || 0) !== version;
      if (responseEpoch > currentEpoch) {
        adoptClear(username, responseEpoch);
      }
      if (localClear || superseded) {
        // A local clear (or an adopted clear) happened while this commit was
        // in flight. Never merge the response back: the queued clear will
        // persist the empty bucket with a newer epoch.
        dirty.add(username);
        scheduleFlush(0);
        return;
      }
      if (responseEpoch < (clearEpochs.get(username) || 0)) {
        // A newer clear was adopted while the commit was in flight; repair
        // storage with the adopted state instead of writing this response.
        dirty.add(username);
        scheduleFlush(0);
        return;
      }
      mergeRecords(username, recordsFromStored(payload), false);
      loaded.add(username);
      retryAttempts.delete(username);
      if (clearErrorFor(username) && currentUser === username) {
        notify();
      }
      if ((revisions.get(username) || 0) === revision) {
        dirty.delete(username);
      } else {
        // A new batch arrived while the write was in flight; write it in the
        // next pass instead of dropping it.
        scheduleFlush();
      }
    }

    function mergeTask(username) {
      return ensureLoaded(username).then(function () {
        if (!dirty.has(username) || clearPending.has(username)) {
          return undefined;
        }
        var revision = revisions.get(username) || 0;
        var version = restoreVersions.get(username) || 0;
        var expectedEpoch = clearEpochs.get(username) || 0;
        var records = snapshot(username);
        return commitPayload({
          op: 'ingest',
          username: username,
          records: records,
          expectedEpoch: expectedEpoch
        }).then(function (response) {
          applyCommitResponse(username, response, revision, version);
        });
      });
    }

    function clearTask(username) {
      if (!clearPending.has(username)) {
        return Promise.resolve();
      }
      var token = clearTokens.get(username) || 0;
      var revision = revisions.get(username) || 0;
      var expectedEpoch = clearEpochs.get(username) || 0;
      return commitPayload({
        op: 'clear',
        username: username,
        expectedEpoch: expectedEpoch
      }).then(function (response) {
        var payload = requireSnapshot(response);
        var responseEpoch = clearEpochFromStored(payload);
        var currentEpoch = clearEpochs.get(username) || 0;
        if (responseEpoch > currentEpoch) {
          adoptClear(username, responseEpoch);
        }
        if ((clearTokens.get(username) || 0) !== token) {
          // Another clear was requested while this one was in flight. Keep
          // clearPending and run again so the newer request also bumps the
          // epoch instead of being collapsed into the earlier one.
          dirty.add(username);
          scheduleFlush(0);
          return;
        }
        clearPending.delete(username);
        if ((clearEpochs.get(username) || 0) !== responseEpoch) {
          // A newer clear was adopted while our empty body was in flight;
          // rewrite the adopted state so its marker survives.
          dirty.add(username);
          scheduleFlush(0);
          return;
        }
        if ((revisions.get(username) || 0) === revision) {
          dirty.delete(username);
        } else {
          // New tweets arrived while the clear was in flight; persist them in
          // a later merge pass.
          scheduleFlush();
        }
        retryAttempts.delete(username);
        if (clearErrorFor(username)) {
          notify();
        }
      });
    }

    function doFlushUser(username) {
      if (!dirty.has(username)) {
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
      clearTokens.set(username, (clearTokens.get(username) || 0) + 1);
      ensureBucket(username).clear();
      revisions.set(username, (revisions.get(username) || 0) + 1);
      dirty.add(username);
      retryAttempts.delete(username);
      notify();
      return flushUser(username);
    }

    /**
     * Apply a snapshot written by another tab.
     *
     * `value` is either a records array (legacy) or the full stored payload
     * `{version, username, clearEpoch, records}`. `options.removed` means the
     * storage key was deleted and the whole bucket must be forgotten.
     *
     * A newer `clearEpoch` empties this tab before its records can be merged
     * or flushed back. A snapshot with an older epoch is ignored, which is the
     * last line of defence against a stale tab resurrecting a cleared bucket.
     */
    function mergeExternal(username, value, options) {
      var next = normalizeUsername(username);
      if (!next || isReserved(next)) {
        return 0;
      }
      var opts = options || {};
      var knownEpoch = clearEpochs.get(next) || 0;
      if (opts.removed) {
        var removedEpoch = knownEpoch + 1;
        adoptClear(next, removedEpoch);
        if (currentUser === next) {
          notify();
        }
        return 0;
      }
      if (!Array.isArray(value) && (!value || typeof value !== 'object')) {
        return 0;
      }
      var epoch = clearEpochFromStored(value);
      if (epoch > knownEpoch) {
        adoptClear(next, epoch);
      } else if (epoch < knownEpoch) {
        // A pre-clear snapshot must never be merged back, even if it arrived
        // late through a queued chrome.storage.onChanged event.
        return 0;
      }
      // A local clear is already queued; its write will empty the bucket and
      // bump the epoch, so merging records here would only resurrect them.
      if (clearPending.has(next)) {
        return 0;
      }
      var added = mergeRecords(next, recordsFromStored(value), false);
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
    clearEpochFromStored: clearEpochFromStored,
    isValidRecord: isValidRecord,
    recordId: recordId,
    STORAGE_PREFIX: STORAGE_PREFIX,
    WAL_PREFIX: WAL_PREFIX,
    COORDINATE_MESSAGE: COORDINATE_MESSAGE,
    PAYLOAD_VERSION: PAYLOAD_VERSION,
    RESERVED_SEGMENTS: RESERVED_SEGMENTS
  };

  if (root) {
    root.__XTCE_store = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
