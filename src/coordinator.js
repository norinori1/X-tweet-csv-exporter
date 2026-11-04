/*
 * X Tweet CSV Exporter (Local) — serialized storage coordinator (S2).
 *
 * This module is the storage authority. It is loaded in the MV3 extension
 * service worker (src/background.js) and, in the tests, in a Node vm. It is
 * never loaded in a page content script.
 *
 * Why a service worker:
 *   navigator.locks is scoped to one page origin, so x.com and twitter.com
 *   tabs sharing chrome.storage.local cannot see each other's locks. A
 *   short-lived lease in storage cannot fix that either: a writer may pause
 *   between registering the lease and issuing its chrome.storage.set for
 *   longer than the lease TTL, and a read-before-set cannot fence a set that
 *   was already handed to the browser. A lease TTL is therefore not a fencing
 *   token. Instead every snapshot read-modify-write runs in this one module,
 *   in one extension service-worker context, through a per-user promise
 *   queue. Two content scripts (any tab, either origin) that ask for the same
 *   user's bucket are serialized by that queue: the second commit does not
 *   even read storage until the first commit has settled.
 *
 * Service worker lifecycle:
 *   - The queue is intentionally in-memory. Chrome may evict an idle MV3
 *     worker; when it does, no commit is running (a running onMessage event
 *     keeps the worker alive until the response is sent). A restarted worker
 *     rebuilds the queue and reads all state from chrome.storage.local.
 *   - Every commit is wrapped in a per-user write-ahead journal
 *     (`xtce:wal:<user>`): the journal entry (the complete next payload) is
 *     written before the snapshot. If the worker is evicted (or the storage
 *     write is otherwise interrupted) between those two writes, the next
 *     worker repairs the snapshot from the journal before serving that user.
 *     This is not a lease and does not expire: it is the last committed
 *     payload, and a later repair write is issued after the interrupted write
 *     so the storage backend's operation order resolves it.
 *   - A client that loses its response (worker eviction) receives a messaging
 *     error/timeout and retries. Commits are idempotent: ingest is a union by
 *     tweet id and clear allocates a fresh clearEpoch.
 *   - If this module cannot prove it can serialize (no storage adapter, a
 *     malformed stored payload, a malformed journal, or an invalid request),
 *     it rejects and writes nothing. There is no best-effort path.
 *
 * Public API (globalThis.__XTCE_coordinator):
 *   createCoordinator({ storage, now? }) -> coordinator
 *   WAL_PREFIX, walKey(username), MESSAGE_TYPE, OPS
 *
 * Coordinator API:
 *   handle(request)   -> Promise<payload>; request is one of
 *                        {op:'read', username}
 *                        {op:'ingest', username, records, expectedEpoch}
 *                        {op:'clear', username, expectedEpoch}
 *                        {op:'recover', username}
 *   commit(request)   -> alias of handle
 *   read(username)    -> Promise<payload>
 *   recoverAll()      -> Promise<void>; repair every journal left behind
 *   waitForIdle(user) -> Promise<void>; tests only
 *
 * Storage adapter: get(key), set(key, value), remove(key), and optionally
 * getMany(keys) / keys(). It must be the single chrome.storage.local backend
 * shared by every extension context.
 */
(function (root) {
  'use strict';

  var storeApi = root && root.__XTCE_store;
  if (!storeApi) {
    return;
  }

  var WAL_PREFIX = 'xtce:wal:';
  var WAL_VERSION = 1;
  var MESSAGE_TYPE = storeApi.COORDINATE_MESSAGE || 'XTCE_COORDINATE';
  var OPS = Object.freeze({
    READ: 'read',
    INGEST: 'ingest',
    CLEAR: 'clear',
    RECOVER: 'recover'
  });

  function noop() {}

  function hasOwn(object, key) {
    return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function errorMessage(error) {
    if (error && typeof error.message === 'string' && error.message) {
      return error.message;
    }
    return String(error || 'storage operation failed');
  }

  function coordinatorError(message, code) {
    var error = new Error(message);
    error.code = code || 'XTCE_COORDINATION_PROTOCOL';
    return error;
  }

  function walKey(username) {
    return WAL_PREFIX + username;
  }

  function normalizeUsername(value) {
    var username = storeApi.normalizeUsername(value);
    if (!username) {
      return null;
    }
    if (storeApi.RESERVED_SEGMENTS.indexOf(username) !== -1) {
      return null;
    }
    return username;
  }

  function normalizeEpoch(value) {
    if (value === undefined || value === null) {
      return 0;
    }
    if (typeof value !== 'number' || !isFinite(value) || value < 0) {
      return null;
    }
    return Math.floor(value);
  }

  function keepValidRecords(records) {
    var kept = [];
    for (var i = 0; i < records.length; i += 1) {
      if (storeApi.isValidRecord(records[i])) {
        kept.push(records[i]);
      }
    }
    return kept;
  }

  /**
   * Normalize a stored snapshot. A payload we cannot understand is never
   * treated as empty: doing so would overwrite records we failed to parse.
   */
  function payloadFromStored(value, username) {
    if (value === undefined || value === null) {
      return {
        version: storeApi.PAYLOAD_VERSION,
        username: username,
        updatedAt: null,
        clearEpoch: 0,
        records: []
      };
    }
    if (Array.isArray(value)) {
      return {
        version: storeApi.PAYLOAD_VERSION,
        username: username,
        updatedAt: null,
        clearEpoch: 0,
        records: keepValidRecords(value)
      };
    }
    if (typeof value !== 'object') {
      throw coordinatorError(
        'Stored snapshot for ' +
          username +
          ' is not a payload object; refusing to overwrite it.',
        'XTCE_STORAGE_CORRUPT'
      );
    }
    if (!Array.isArray(value.records)) {
      throw coordinatorError(
        'Stored snapshot for ' +
          username +
          ' has no records array; refusing to overwrite it.',
        'XTCE_STORAGE_CORRUPT'
      );
    }
    if (
      value.version !== undefined &&
      value.version !== 1 &&
      value.version !== storeApi.PAYLOAD_VERSION
    ) {
      throw coordinatorError(
        'Stored snapshot for ' +
          username +
          ' has unsupported version ' +
          String(value.version) +
          '; refusing to overwrite it.',
        'XTCE_STORAGE_CORRUPT'
      );
    }
    if (
      typeof value.username === 'string' &&
      value.username.toLowerCase() !== username
    ) {
      throw coordinatorError(
        'Stored snapshot for ' +
          username +
          ' belongs to ' +
          value.username +
          '; refusing to overwrite it.',
        'XTCE_STORAGE_CORRUPT'
      );
    }
    return {
      version: storeApi.PAYLOAD_VERSION,
      username: username,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
      clearEpoch: storeApi.clearEpochFromStored(value),
      records: keepValidRecords(value.records)
    };
  }

  function payloadFromWal(entry, username) {
    try {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('the journal entry is not an object');
      }
      if (entry.version !== undefined && entry.version !== WAL_VERSION) {
        throw new Error('unsupported journal version ' + String(entry.version));
      }
      if (
        typeof entry.username === 'string' &&
        entry.username.toLowerCase() !== username
      ) {
        throw new Error('the journal belongs to ' + entry.username);
      }
      if (!entry.payload || typeof entry.payload !== 'object') {
        throw new Error('the journal has no payload');
      }
      return payloadFromStored(entry.payload, username);
    } catch (error) {
      throw coordinatorError(
        'Write-ahead journal for ' +
          username +
          ' is unreadable (' +
          errorMessage(error) +
          '); refusing to overwrite it.',
        'XTCE_WAL_CORRUPT'
      );
    }
  }

  function makePayload(username, clearEpoch, records, now) {
    return {
      version: storeApi.PAYLOAD_VERSION,
      username: username,
      updatedAt: new Date(now()).toISOString(),
      clearEpoch: clearEpoch,
      records: records
    };
  }

  function mergeInto(stored, incoming, expectedEpoch, now) {
    var epoch = stored.clearEpoch;
    var base = stored.records;
    if (epoch < expectedEpoch) {
      // This tab knows about a newer clear than storage does. Its records were
      // collected after that clear, so the older stored records must not be
      // merged back in.
      base = [];
      epoch = expectedEpoch;
    }
    var byId = new Map();
    var i;
    for (i = 0; i < base.length; i += 1) {
      byId.set(storeApi.recordId(base[i]), base[i]);
    }
    for (i = 0; i < incoming.length; i += 1) {
      var record = incoming[i];
      if (!storeApi.isValidRecord(record)) {
        continue;
      }
      // The tab's in-memory record is the newest copy it knows about.
      byId.set(storeApi.recordId(record), record);
    }
    return makePayload(
      stored.username,
      epoch,
      Array.from(byId.values()),
      now
    );
  }

  function createCoordinator(options) {
    var opts = options || {};
    var storage = opts.storage;
    if (
      !storage ||
      typeof storage.get !== 'function' ||
      typeof storage.set !== 'function' ||
      typeof storage.remove !== 'function'
    ) {
      throw new Error(
        'createCoordinator requires a storage adapter with get/set/remove'
      );
    }
    var now =
      typeof opts.now === 'function'
        ? opts.now
        : function () {
            return Date.now();
          };

    // One promise chain per username. Every read-modify-write for a user is
    // appended here, across every tab and every origin.
    var queues = new Map();
    var commits = 0;

    function enqueue(username, task) {
      var previous = queues.get(username) || Promise.resolve();
      // Run even when the previous task failed: one bad commit must not wedge
      // the user's queue forever.
      var run = previous.then(task, task);
      queues.set(
        username,
        run.then(noop, noop)
      );
      return run;
    }

    function readBoth(username) {
      var userKey = storeApi.storageKey(username);
      var journalKey = walKey(username);
      if (typeof storage.getMany === 'function') {
        return Promise.resolve(storage.getMany([userKey, journalKey])).then(
          function (items) {
            return {
              stored: hasOwn(items, userKey) ? items[userKey] : undefined,
              journal: hasOwn(items, journalKey) ? items[journalKey] : undefined
            };
          }
        );
      }
      return Promise.all([
        storage.get(userKey),
        storage.get(journalKey)
      ]).then(function (values) {
        return { stored: values[0], journal: values[1] };
      });
    }

    /**
     * Finish an interrupted commit. The journal payload is written again and
     * only then removed. Re-writing is idempotent; the repair set is issued
     * after the interrupted set, so the storage backend's operation order
     * leaves the journal payload in place.
     */
    function recover(username) {
      return Promise.resolve(storage.get(walKey(username))).then(
        function (entry) {
          if (entry === undefined || entry === null) {
            return false;
          }
          var payload = payloadFromWal(entry, username);
          return Promise.resolve(
            storage.set(storeApi.storageKey(username), clone(payload))
          )
            .then(function () {
              return storage.remove(walKey(username));
            })
            .then(function () {
              return true;
            });
        }
      );
    }

    function writePayload(username, payload) {
      var entry = {
        version: WAL_VERSION,
        username: username,
        at: new Date(now()).toISOString(),
        payload: clone(payload)
      };
      return Promise.resolve(storage.set(walKey(username), entry))
        .then(function () {
          return storage.set(storeApi.storageKey(username), clone(payload));
        })
        .then(function () {
          return storage.remove(walKey(username));
        })
        .then(function () {
          commits += 1;
          return payload;
        });
    }

    function commitIngest(username, records, expectedEpoch) {
      return recover(username)
        .then(function () {
          return storage.get(storeApi.storageKey(username));
        })
        .then(function (storedValue) {
          var stored = payloadFromStored(storedValue, username);
          if (stored.clearEpoch > expectedEpoch) {
            // The tab's batch predates a clear it did not observe. Do not
            // write; return the authoritative post-clear payload so the tab
            // can adopt the clear.
            return stored;
          }
          var merged = mergeInto(stored, records, expectedEpoch, now);
          if (
            merged.records.length === 0 &&
            stored.clearEpoch === expectedEpoch
          ) {
            // Nothing to persist and no epoch repair needed.
            return stored;
          }
          return writePayload(username, merged);
        });
    }

    function commitClear(username, expectedEpoch) {
      return recover(username)
        .then(function () {
          return storage.get(storeApi.storageKey(username));
        })
        .then(function (storedValue) {
          var stored = payloadFromStored(storedValue, username);
          var epoch = Math.max(stored.clearEpoch, expectedEpoch) + 1;
          return writePayload(
            username,
            makePayload(username, epoch, [], now)
          );
        });
    }

    function read(username) {
      return readBoth(username).then(function (items) {
        if (items.journal !== undefined && items.journal !== null) {
          var payload = payloadFromWal(items.journal, username);
          // Repair in the background. A read must not block a writer that is
          // already queued for this user; the journal is the authoritative
          // value until the repair lands.
          enqueue(username, function () {
            return recover(username);
          }).catch(noop);
          return payload;
        }
        return payloadFromStored(items.stored, username);
      });
    }

    function protocolError(message) {
      return coordinatorError(message, 'XTCE_COORDINATION_PROTOCOL');
    }

    function handle(request) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        return Promise.reject(protocolError('Malformed coordinator request.'));
      }
      var username = normalizeUsername(request.username);
      if (!username) {
        return Promise.reject(
          protocolError('Invalid username for a coordinator request.')
        );
      }
      var op = request.op;
      if (op === OPS.READ) {
        return read(username);
      }
      if (op === OPS.RECOVER) {
        return enqueue(username, function () {
          return recover(username);
        });
      }
      var expectedEpoch = normalizeEpoch(request.expectedEpoch);
      if (expectedEpoch === null) {
        return Promise.reject(
          protocolError('expectedEpoch must be a non-negative number.')
        );
      }
      if (op === OPS.INGEST) {
        if (!Array.isArray(request.records)) {
          return Promise.reject(
            protocolError('ingest requires a records array.')
          );
        }
        var records;
        try {
          records = clone(request.records);
        } catch (error) {
          return Promise.reject(
            protocolError(
              'ingest records are not serializable: ' + errorMessage(error)
            )
          );
        }
        return enqueue(username, function () {
          return commitIngest(username, records, expectedEpoch);
        });
      }
      if (op === OPS.CLEAR) {
        return enqueue(username, function () {
          return commitClear(username, expectedEpoch);
        });
      }
      return Promise.reject(
        protocolError('Unknown coordinator operation: ' + String(op))
      );
    }

    function recoverAll() {
      if (typeof storage.keys !== 'function') {
        return Promise.resolve();
      }
      return Promise.resolve(storage.keys()).then(function (keys) {
        var users = [];
        var list = Array.isArray(keys) ? keys : [];
        for (var i = 0; i < list.length; i += 1) {
          var key = list[i];
          if (typeof key !== 'string' || key.indexOf(WAL_PREFIX) !== 0) {
            continue;
          }
          var username = normalizeUsername(key.slice(WAL_PREFIX.length));
          if (username && users.indexOf(username) === -1) {
            users.push(username);
          }
        }
        return Promise.all(
          users.map(function (username) {
            return enqueue(username, function () {
              return recover(username);
            });
          })
        ).then(function () {
          return undefined;
        });
      });
    }

    function waitForIdle(username) {
      var normalized = normalizeUsername(username);
      var key = normalized || username;
      var chain = queues.get(key);
      return chain ? chain.then(noop, noop) : Promise.resolve();
    }

    return {
      handle: handle,
      commit: handle,
      read: read,
      recoverAll: recoverAll,
      waitForIdle: waitForIdle,
      pendingUsers: function () {
        return Array.from(queues.keys());
      },
      commitCount: function () {
        return commits;
      }
    };
  }

  var api = {
    createCoordinator: createCoordinator,
    WAL_PREFIX: WAL_PREFIX,
    walKey: walKey,
    MESSAGE_TYPE: MESSAGE_TYPE,
    OPS: OPS
  };

  if (root) {
    root.__XTCE_coordinator = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
