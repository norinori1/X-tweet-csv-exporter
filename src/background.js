/*
 * X Tweet CSV Exporter (Local) — MV3 service worker (S2).
 *
 * This worker is the only context that writes per-user snapshots to
 * chrome.storage.local. Content scripts on x.com and twitter.com (every tab,
 * both origins) send XTCE_COORDINATE requests here; src/coordinator.js runs
 * the read-modify-write through a per-user queue, so the two origins can no
 * longer overwrite each other no matter how long a write takes.
 *
 * Lifecycle notes:
 *   - The listener returns true so the message channel stays open until the
 *     commit (journal write + snapshot write + journal removal) has settled.
 *     A response is never sent for a write that has not completed.
 *   - If Chrome evicts the worker, the client sees a messaging error or its
 *     own timeout and retries; the journal left by an interrupted commit is
 *     repaired by the next worker before it serves that user.
 *   - No state is kept only in memory: the queue is rebuilt on every worker
 *     start and every payload comes from chrome.storage.local.
 *   - The extension has no externally_connectable surface; the sender checks
 *     below are defence in depth.
 */
importScripts('store.js', 'coordinator.js');

(function () {
  'use strict';

  var root = typeof globalThis !== 'undefined' ? globalThis : self;
  var storeApi = root.__XTCE_store;
  var coordinatorApi = root.__XTCE_coordinator;
  if (!storeApi || !coordinatorApi) {
    return;
  }

  var MESSAGE_TYPE = storeApi.COORDINATE_MESSAGE;
  var ALLOWED_ORIGINS = ['https://x.com', 'https://twitter.com'];

  /**
   * Content scripts from the two manifest hosts may coordinate. The
   * extension's own pages (a future S3 popup/options page) are allowed too;
   * a missing origin (older Chrome/test doubles) is not rejected here.
   */
  function isAllowedOrigin(origin) {
    if (typeof origin !== 'string' || !origin) {
      return true;
    }
    if (origin.indexOf('chrome-extension://') === 0) {
      return true;
    }
    return ALLOWED_ORIGINS.indexOf(origin) !== -1;
  }

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

  function hasOwn(object, key) {
    return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
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
    remove: function (key) {
      return new Promise(function (resolve, reject) {
        try {
          chrome.storage.local.remove(key, function () {
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
    keys: function () {
      return new Promise(function (resolve, reject) {
        try {
          if (typeof chrome.storage.local.getKeys === 'function') {
            chrome.storage.local.getKeys(function (keys) {
              var error = storageLastError();
              if (error) {
                reject(error);
                return;
              }
              resolve(Array.isArray(keys) ? keys : []);
            });
            return;
          }
          chrome.storage.local.get(null, function (items) {
            var error = storageLastError();
            if (error) {
              reject(error);
              return;
            }
            resolve(items ? Object.keys(items) : []);
          });
        } catch (error) {
          reject(error);
        }
      });
    }
  };

  var coordinator;
  try {
    coordinator = coordinatorApi.createCoordinator({ storage: storage });
  } catch (error) {
    // Without a coordinator the extension cannot prove serialization, so it
    // must not write. Content scripts will surface the unavailable error.
    console.error('[XTCE] coordinator unavailable:', error);
    return;
  }

  // Best effort at startup; every request also repairs its own user first, so
  // a failure here cannot cause an unjournaled overwrite.
  try {
    coordinator.recoverAll().catch(function (error) {
      console.error('[XTCE] write-ahead recovery failed:', error);
    });
  } catch (error) {
    console.error('[XTCE] write-ahead recovery failed:', error);
  }

  function serializeError(error) {
    var result = {
      message: error && error.message ? error.message : String(error)
    };
    if (error && typeof error.code === 'string' && error.code) {
      result.code = error.code;
    }
    return result;
  }

  function respond(sendResponse, payload) {
    try {
      sendResponse(payload);
    } catch (error) {
      // The content script navigated away or its port was closed. The commit
      // (if any) already happened; the client retries idempotently.
    }
  }

  function rejectMessage(sendResponse, message) {
    respond(sendResponse, {
      ok: false,
      error: {
        message: message,
        code: 'XTCE_COORDINATION_UNAVAILABLE'
      }
    });
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (
      !message ||
      typeof message !== 'object' ||
      message.type !== MESSAGE_TYPE
    ) {
      return false;
    }
    if (
      sender &&
      typeof sender.id === 'string' &&
      sender.id &&
      chrome.runtime.id &&
      sender.id !== chrome.runtime.id
    ) {
      rejectMessage(
        sendResponse,
        'Rejected a coordinator message from another extension.'
      );
      return false;
    }
    if (
      sender &&
      typeof sender.origin === 'string' &&
      sender.origin &&
      !isAllowedOrigin(sender.origin)
    ) {
      rejectMessage(
        sendResponse,
        'Rejected a coordinator message from ' + sender.origin + '.'
      );
      return false;
    }
    // Keep the channel open until the write has settled. Returning true is
    // what makes the service worker wait for the async commit instead of
    // closing the port immediately.
    Promise.resolve(coordinator.handle(message.request)).then(
      function (result) {
        respond(sendResponse, { ok: true, result: result });
      },
      function (error) {
        respond(sendResponse, { ok: false, error: serializeError(error) });
      }
    );
    return true;
  });
})();
