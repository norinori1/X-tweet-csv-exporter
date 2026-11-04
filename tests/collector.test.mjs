/*
 * S2 tests for the interceptor, pure store and isolated-world collector.
 *
 * Run with: node tests/collector.test.mjs
 *
 * Everything here is synthetic: fake fetch/XHR, a fake chrome.storage.local
 * and a fake clock. No network, no real extension APIs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const storeSource = readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
const interceptorSource = readFileSync(new URL('../src/interceptor.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
const parserSource = readFileSync(new URL('../src/parser.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

let groups = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    groups += 1;
    console.log('ok - ' + name);
  } catch (error) {
    failures.push({ name, error });
    console.error('not ok - ' + name);
    console.error(error && error.stack ? error.stack : error);
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  await tick();
  await tick();
  await tick();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function makeRecord(id, extra) {
  return Object.assign(
    {
      id: String(id),
      created_at_iso: '2024-05-01T12:34:56.000Z',
      text: 'tweet ' + id,
      url: 'https://x.com/alice/status/' + id,
      author_username: 'alice',
      author_name: 'Alice Example',
      like_count: 1,
      retweet_count: 0,
      reply_count: 0,
      quote_count: 0,
      bookmark_count: 0,
      view_count: 1,
      hashtags: '',
      mentions: '',
      urls: '',
      media_urls: '',
      media_types: '',
      is_reply: false,
      in_reply_to_status_id: '',
      in_reply_to_username: '',
      is_retweet: false,
      retweeted_status_id: '',
      is_quote: false,
      quoted_status_id: '',
      conversation_id: String(id),
      lang: 'en',
      source: 'Twitter Web App'
    },
    extra || {}
  );
}

function idsOf(records) {
  return Array.from(records, (record) => String(record.id));
}

function tweetMessage(tweets, pathname, search, operation) {
  return {
    origin: 'https://x.com',
    data: {
      type: 'XTCE_TWEETS',
      tweets,
      source: {
        pathname: pathname || '/alice',
        search: search || '',
        operation: operation || 'UserTweets'
      }
    }
  };
}

function tweetMessages(entries) {
  return entries.filter(
    (entry) => entry && entry.message && entry.message.type === 'XTCE_TWEETS'
  );
}

/* -------------------------------------------------------------------------
 * Fake storage with controllable deferred/failing reads and writes
 * ---------------------------------------------------------------------- */

function createFakeStorage(initial) {
  const data = new Map();
  const calls = { get: [], getMany: [], set: [], remove: [] };
  const hooks = { get: [], getMany: [], set: [], remove: [] };
  if (initial) {
    for (const key of Object.keys(initial)) {
      data.set(key, clone(initial[key]));
    }
  }
  function matches(matcher, key) {
    if (!matcher) {
      return true;
    }
    if (typeof matcher === 'function') {
      return Boolean(matcher(key));
    }
    if (Array.isArray(matcher)) {
      return matcher.indexOf(key) !== -1;
    }
    return matcher === key;
  }
  function nextGate(list, key) {
    const index = list.findIndex((hook) => matches(hook.key, key));
    if (index === -1) {
      return undefined;
    }
    return list.splice(index, 1)[0].fn();
  }
  function defer(list, key) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    list.push({ key, fn: () => promise });
    return { promise, resolve, reject };
  }
  function fail(list, error, key) {
    list.push({
      key,
      fn: () => {
        throw error;
      }
    });
  }
  return {
    data,
    calls,
    async get(key) {
      calls.get.push(key);
      // Snapshot at read time: a read that is released late still returns the
      // body that existed when it was issued, like a real storage read.
      const value = data.has(key) ? clone(data.get(key)) : undefined;
      const gate = nextGate(hooks.get, key);
      if (gate) {
        await gate;
      }
      return value;
    },
    async getMany(keys) {
      const list = Array.isArray(keys) ? keys.slice() : [keys];
      calls.getMany.push(list);
      const snapshot = new Map();
      for (const key of list) {
        if (data.has(key)) {
          snapshot.set(key, clone(data.get(key)));
        }
      }
      const gate = nextGate(hooks.getMany, list);
      if (gate) {
        await gate;
      }
      const items = {};
      for (const [key, value] of snapshot) {
        items[key] = value;
      }
      return items;
    },
    async set(key, value) {
      calls.set.push({ key, value: clone(value) });
      const gate = nextGate(hooks.set, key);
      if (gate) {
        await gate;
      }
      data.set(key, clone(value));
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys.slice() : [keys];
      calls.remove.push(list);
      const gate = nextGate(hooks.remove, list);
      if (gate) {
        await gate;
      }
      for (const key of list) {
        data.delete(key);
      }
    },
    deferNextGet(key) {
      return defer(hooks.get, key);
    },
    deferNextGetMany(key) {
      return defer(hooks.getMany, key);
    },
    deferNextSet(key) {
      return defer(hooks.set, key);
    },
    deferNextRemove(key) {
      return defer(hooks.remove, key);
    },
    failNextGet(error, key) {
      fail(hooks.get, error, key);
    },
    failNextGetMany(error, key) {
      fail(hooks.getMany, error, key);
    },
    failNextSet(error, key) {
      fail(hooks.set, error, key);
    }
  };
}

/** Deterministic timer queue; nothing runs until runAll() is awaited. */
function createFakeScheduler() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    pendingCount() {
      return pending.size;
    },
    delays() {
      return Array.from(pending.values(), (entry) => entry.ms);
    },
    async runAll(maxIterations) {
      const limit = maxIterations || 1000;
      let iterations = 0;
      while (pending.size > 0) {
        iterations += 1;
        if (iterations > limit) {
          throw new Error('timer queue did not settle');
        }
        const entry = pending.entries().next().value;
        pending.delete(entry[0]);
        await entry[1].fn();
      }
    }
  };
}

function createFakeLockManager() {
  const queues = new Map();
  return {
    request(name, task) {
      const previous = queues.get(name) || Promise.resolve();
      const run = previous.catch(() => {}).then(() => task());
      queues.set(name, run.catch(() => {}));
      return run;
    }
  };
}

/**
 * Web Locks are origin-scoped. This manager serializes only tasks in the same
 * domain, exactly like two navigator.locks instances on x.com and twitter.com:
 * a task in domain A runs concurrently with a task in domain B.
 */
function createDomainLockManager() {
  const queues = new Map();
  let active = 0;
  let maxActive = 0;
  return {
    request(domain, name, task) {
      const key = domain + '|' + name;
      const previous = queues.get(key) || Promise.resolve();
      const run = previous.catch(() => {}).then(async () => {
        active += 1;
        if (active > maxActive) {
          maxActive = active;
        }
        try {
          return await task();
        } finally {
          active -= 1;
        }
      });
      queues.set(key, run.catch(() => {}));
      return run;
    },
    maxActive() {
      return maxActive;
    }
  };
}

function createStoreHarness(initialStorage, persistDelay, options) {
  const opts = options || {};
  const storage = opts.storage || createFakeStorage(initialStorage);
  const timers = createFakeScheduler();
  const sandbox = {
    console,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(storeSource, sandbox, { filename: 'src/store.js' });
  const api = sandbox.__XTCE_store;
  assert.ok(api, 'src/store.js must expose globalThis.__XTCE_store');
  const store = api.createStore({
    storage,
    persistDelay: persistDelay === undefined ? 500 : persistDelay,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    withLock: opts.withLock,
    origin: opts.origin,
    peerOrigins: opts.peerOrigins,
    now: opts.now,
    coordinationTtl: opts.coordinationTtl
  });
  return { api, store, storage, timers, sandbox };
}

function createCrossOriginPair(initialStorage) {
  const storage = createFakeStorage(initialStorage);
  const locks = createDomainLockManager();
  const clock = { t: 1000 };
  const now = () => clock.t;
  const options = {
    storage,
    now,
    origin: 'https://x.com',
    peerOrigins: ['https://twitter.com']
  };
  const a = createStoreHarness(undefined, 500, {
    ...options,
    withLock: (name, task) => locks.request('x.com', name, task)
  });
  const bOptions = {
    storage,
    now,
    origin: 'https://twitter.com',
    peerOrigins: ['https://x.com']
  };
  const b = createStoreHarness(undefined, 500, {
    ...bOptions,
    withLock: (name, task) => locks.request('twitter.com', name, task)
  });
  return { storage, locks, clock, a, b };
}

function userSetCalls(storage, key) {
  return storage.calls.set.filter((call) => call.key === key);
}

function createSharedStorePair(initialStorage) {
  const storage = createFakeStorage(initialStorage);
  const lock = createFakeLockManager();
  const a = createStoreHarness(undefined, 500, {
    storage,
    withLock: lock.request
  });
  const b = createStoreHarness(undefined, 500, {
    storage,
    withLock: lock.request
  });
  return { storage, lock, a, b };
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) {
      return;
    }
    await tick();
  }
  throw new Error('timed out waiting for ' + label);
}

/* -------------------------------------------------------------------------
 * Synthetic GraphQL fixture for the interceptor (same shape as S1's fixture)
 * ---------------------------------------------------------------------- */

function fixtureUser(screenName) {
  return {
    __typename: 'User',
    rest_id: 'u-' + screenName,
    legacy: { screen_name: screenName, name: screenName }
  };
}

function fixtureTweetResult(id, screenName) {
  return {
    __typename: 'Tweet',
    rest_id: String(id),
    core: { user_results: { result: fixtureUser(screenName || 'alice') } },
    legacy: {
      id_str: String(id),
      created_at: 'Wed May 01 12:34:56 +0000 2024',
      full_text: 'tweet ' + id,
      entities: {}
    }
  };
}

function makeInterceptFixture(screenName, id) {
  return {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [
                {
                  type: 'TimelineAddEntries',
                  entries: [
                    {
                      entryId: 'tweet-' + id,
                      content: {
                        entryType: 'TimelineTimelineItem',
                        itemContent: {
                          itemType: 'TimelineTweet',
                          tweet_results: {
                            result: fixtureTweetResult(id, screenName)
                          }
                        }
                      }
                    }
                  ]
                }
              ]
            }
          }
        }
      }
    }
  };
}

const interceptFixture = makeInterceptFixture('alice', '1001');
const bobInterceptFixture = makeInterceptFixture('bob', '2001');

function makeResponse(payload) {
  return {
    ok: true,
    status: 200,
    clone() {
      return {
        json() {
          return Promise.resolve(payload);
        }
      };
    }
  };
}

function createFakeXhrClass() {
  return class FakeXMLHttpRequest {
    constructor() {
      this.listeners = Object.create(null);
      this.status = 200;
      this.responseType = '';
      this.responseText = '';
      this.response = null;
      this.method = '';
      this.url = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    send() {}
    addEventListener(type, listener) {
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(listener);
    }
    removeEventListener(type, listener) {
      const list = this.listeners[type];
      if (list) {
        this.listeners[type] = list.filter((item) => item !== listener);
      }
    }
    emit(type) {
      const list = (this.listeners[type] || []).slice();
      for (const listener of list) {
        listener.call(this, { type });
      }
    }
  };
}

function createInterceptorHarness(options) {
  const opts = options || {};
  const messages = [];
  const listeners = Object.create(null);
  const FakeXHR = createFakeXhrClass();
  const sandbox = {
    console,
    URL,
    location: {
      pathname: '/alice',
      search: '',
      origin: 'https://x.com',
      get href() {
        return 'https://x.com' + this.pathname + this.search;
      }
    },
    XMLHttpRequest: FakeXHR,
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });
    },
    addEventListener(type, listener) {
      if (!listeners[type]) {
        listeners[type] = [];
      }
      listeners[type].push(listener);
    },
    removeEventListener(type, listener) {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((item) => item !== listener);
      }
    },
    setTimeout,
    clearTimeout
  };
  sandbox.fetch = opts.fetch
    ? opts.fetch
    : () => Promise.resolve(makeResponse(opts.payload || interceptFixture));
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  if (opts.withParser !== false) {
    vm.runInContext(parserSource, sandbox, { filename: 'src/parser.js' });
  }
  vm.runInContext(interceptorSource, sandbox, { filename: 'src/interceptor.js' });
  function emitMessage(event) {
    const list = (listeners.message || []).slice();
    for (const listener of list) {
      listener.call(sandbox, event);
    }
  }
  // Most hook tests assume a collector is already listening. The ordering
  // regressions pass { ready: false } to exercise the buffer instead.
  if (opts.ready !== false) {
    emitMessage({
      origin: 'https://x.com',
      data: { type: 'XTCE_COLLECTOR_READY' }
    });
  }
  return {
    sandbox,
    messages,
    FakeXHR,
    emitMessage
  };
}

/* -------------------------------------------------------------------------
 * Isolated-world collector harness: fake window, chrome.storage and clock
 * ---------------------------------------------------------------------- */

/**
 * Shared change bus used by the two-tab content tests. Chrome notifies every
 * extension context (including the writer) after a storage mutation.
 */
function createChromeChangeBus() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    emit(changes, areaName) {
      for (const listener of [...listeners]) {
        listener(changes, areaName || 'local');
      }
    }
  };
}

function createFakeChrome(storage, bus) {
  const localListeners = [];
  const runtime = {};
  function setLastError(error) {
    runtime.lastError = {
      message: error && error.message ? error.message : String(error)
    };
  }
  function clearLastError() {
    delete runtime.lastError;
  }
  function deliver(changes) {
    if (bus) {
      bus.emit(changes, 'local');
      return;
    }
    for (const listener of localListeners.slice()) {
      listener(changes, 'local');
    }
  }
  function deliverLater(changes) {
    // chrome.storage.onChanged is delivered after the callback.
    Promise.resolve().then(() => deliver(changes));
  }
  function stored(key) {
    return storage.data.has(key) ? clone(storage.data.get(key)) : undefined;
  }
  const chrome = {
    runtime,
    storage: {
      local: {
        get(keyOrKeys, callback) {
          const isMany = Array.isArray(keyOrKeys);
          const reading = isMany
            ? storage.getMany(keyOrKeys)
            : storage.get(keyOrKeys).then((value) => {
                const items = {};
                if (value !== undefined) {
                  items[keyOrKeys] = value;
                }
                return items;
              });
          reading.then(
            (items) => {
              clearLastError();
              callback(items);
            },
            (error) => {
              setLastError(error);
              try {
                callback({});
              } finally {
                clearLastError();
              }
            }
          );
        },
        set(items, callback) {
          const key = Object.keys(items)[0];
          const oldValue = stored(key);
          const newValue = clone(items[key]);
          storage.set(key, items[key]).then(
            () => {
              clearLastError();
              if (callback) {
                callback();
              }
              deliverLater({ [key]: { oldValue, newValue } });
            },
            (error) => {
              setLastError(error);
              try {
                if (callback) {
                  callback();
                }
              } finally {
                clearLastError();
              }
            }
          );
        },
        remove(keyOrKeys, callback) {
          const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
          const changes = {};
          for (const key of keys) {
            changes[key] = { oldValue: stored(key) };
          }
          storage.remove(keys).then(
            () => {
              clearLastError();
              if (callback) {
                callback();
              }
              deliverLater(changes);
            },
            (error) => {
              setLastError(error);
              try {
                if (callback) {
                  callback();
                }
              } finally {
                clearLastError();
              }
            }
          );
        }
      },
      onChanged: {
        addListener(listener) {
          if (bus) {
            bus.addListener(listener);
          } else {
            localListeners.push(listener);
          }
        },
        removeListener(listener) {
          if (bus) {
            bus.removeListener(listener);
            return;
          }
          const index = localListeners.indexOf(listener);
          if (index !== -1) {
            localListeners.splice(index, 1);
          }
        }
      }
    }
  };
  return { chrome, deliver };
}

function createContentHarnessWithStorage(storage, pathname, search, options) {
  const opts = options || {};
  const timers = createFakeScheduler();
  const listeners = Object.create(null);
  const intervals = [];
  const bus = opts.bus || null;
  const locks = opts.locks || createFakeLockManager();
  const fakeChrome = createFakeChrome(storage, bus);
  const sandbox = {
    console,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval() {},
    chrome: fakeChrome.chrome,
    navigator: {
      locks: {
        request(name, task) {
          return locks.request(name, task);
        }
      }
    },
    location: {
      pathname: pathname || '/alice',
      search: search || '',
      origin: 'https://x.com',
      get href() {
        return 'https://x.com' + this.pathname + this.search;
      }
    },
    addEventListener(type, listener) {
      if (!listeners[type]) {
        listeners[type] = [];
      }
      listeners[type].push(listener);
    },
    removeEventListener(type, listener) {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((item) => item !== listener);
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(storeSource, sandbox, { filename: 'src/store.js' });
  vm.runInContext(contentSource, sandbox, { filename: 'src/content.js' });
  return {
    sandbox,
    storage,
    timers,
    listeners,
    intervals,
    chrome: fakeChrome.chrome,
    emit(type, event) {
      const list = (listeners[type] || []).slice();
      for (const listener of list) {
        listener.call(sandbox, event);
      }
    },
    emitStorageChange(changes, areaName) {
      fakeChrome.deliver(changes, areaName || 'local');
    }
  };
}

function createContentHarness(initialStorage, pathname, search) {
  return createContentHarnessWithStorage(
    createFakeStorage(initialStorage),
    pathname,
    search
  );
}

/* -------------------------------------------------------------------------
 * Two-world harness: MAIN interceptor and ISOLATED collector share a fake
 * window message bus, location and chrome.storage. This is the realistic
 * ordering regression used for early responses and late attribution.
 * ---------------------------------------------------------------------- */

function createTwoWorldHarness(options) {
  const opts = options || {};
  const storage = createFakeStorage(opts.initialStorage);
  const timers = createFakeScheduler();
  const intervals = [];
  const location = {
    pathname: opts.pathname || '/alice',
    search: opts.search || '',
    origin: 'https://x.com',
    get href() {
      return 'https://x.com' + this.pathname + this.search;
    }
  };
  const mainListeners = Object.create(null);
  const isolatedListeners = Object.create(null);
  const posted = [];
  const deliveries = [];
  const errors = [];
  const fakeChrome = createFakeChrome(storage);
  let dispatchScheduled = false;

  function addListener(map, type, listener) {
    if (!map[type]) {
      map[type] = [];
    }
    map[type].push(listener);
  }
  function removeListener(map, type, listener) {
    if (map[type]) {
      map[type] = map[type].filter((item) => item !== listener);
    }
  }
  function dispatch() {
    dispatchScheduled = false;
    while (deliveries.length > 0) {
      const event = deliveries.shift();
      for (const map of [mainListeners, isolatedListeners]) {
        const list = (map.message || []).slice();
        for (const listener of list) {
          try {
            listener.call(null, event);
          } catch (error) {
            errors.push(error);
          }
        }
      }
    }
  }
  function post(world, message, targetOrigin) {
    posted.push({ world, message, targetOrigin });
    deliveries.push({ origin: location.origin, data: message, source: null });
    if (!dispatchScheduled) {
      dispatchScheduled = true;
      Promise.resolve().then(dispatch);
    }
  }

  const main = {
    console,
    URL,
    location,
    XMLHttpRequest: createFakeXhrClass(),
    postMessage(message, targetOrigin) {
      post('main', message, targetOrigin);
    },
    addEventListener(type, listener) {
      addListener(mainListeners, type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(mainListeners, type, listener);
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  };
  main.fetch = opts.fetch
    ? opts.fetch
    : () => Promise.resolve(makeResponse(opts.payload || interceptFixture));
  main.window = main;
  vm.createContext(main);

  const isolatedLocks = createFakeLockManager();
  const isolated = {
    console,
    location,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval() {},
    chrome: fakeChrome.chrome,
    navigator: {
      locks: {
        request(name, task) {
          return isolatedLocks.request(name, task);
        }
      }
    },
    postMessage(message, targetOrigin) {
      post('isolated', message, targetOrigin);
    },
    addEventListener(type, listener) {
      addListener(isolatedListeners, type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(isolatedListeners, type, listener);
    }
  };
  isolated.window = isolated;
  vm.createContext(isolated);

  return {
    main,
    isolated,
    storage,
    timers,
    intervals,
    posted,
    errors,
    loadInterceptor() {
      vm.runInContext(parserSource, main, { filename: 'src/parser.js' });
      vm.runInContext(interceptorSource, main, { filename: 'src/interceptor.js' });
    },
    loadCollector() {
      vm.runInContext(storeSource, isolated, { filename: 'src/store.js' });
      vm.runInContext(contentSource, isolated, { filename: 'src/content.js' });
    },
    navigate(pathname, search) {
      location.pathname = pathname;
      location.search = search || '';
    },
    tickInterval() {
      for (const entry of intervals) {
        entry.fn();
      }
    },
    async settle() {
      await settle();
      if (errors.length > 0) {
        throw errors[0];
      }
    },
    tweetMessages() {
      return posted.filter(
        (entry) => entry.message && entry.message.type === 'XTCE_TWEETS'
      );
    }
  };
}

/* -------------------------------------------------------------------------
 * Store tests
 * ---------------------------------------------------------------------- */

await test('store loads in vm and exposes the S2 helpers', () => {
  const { api } = createStoreHarness();
  assert.equal(typeof api.createStore, 'function');
  assert.equal(typeof api.usernameFromPath, 'function');
  assert.equal(typeof api.usernameFromLocation, 'function');
  assert.equal(typeof api.isTweetMessage, 'function');
  assert.equal(typeof api.recordsFromStored, 'function');
  assert.equal(typeof api.normalizeUsername, 'function');
  assert.equal(typeof api.clearEpochFromStored, 'function');
  assert.equal(typeof api.coordinationKey, 'function');
  assert.equal(api.clearEpochFromStored({ clearEpoch: 3 }), 3);
  assert.equal(api.clearEpochFromStored({ clearEpoch: -1 }), 0);
  assert.equal(api.clearEpochFromStored([{ id: '1' }]), 0);
  assert.equal(
    api.coordinationKey('https://x.com', 'alice'),
    'xtce_coord_https%3A%2F%2Fx.com_alice'
  );
  assert.equal(api.STORAGE_PREFIX, 'xtce_');
  assert.equal(api.COORDINATION_PREFIX, 'xtce_coord_');
  assert.deepEqual(
    [...api.RESERVED_SEGMENTS],
    [
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
    ]
  );
});

await test('usernameFromPath extracts profiles and rejects reserved/invalid routes', () => {
  const { api } = createStoreHarness();
  assert.equal(api.usernameFromPath('/norinori1'), 'norinori1');
  assert.equal(api.usernameFromPath('/Norinori1/with_replies'), 'norinori1');
  assert.equal(api.usernameFromPath('/alice/status/123'), 'alice');
  assert.equal(api.usernameFromPath('/alice/media/'), 'alice');
  assert.equal(api.usernameFromPath('/'), null);
  assert.equal(api.usernameFromPath(''), null);
  assert.equal(api.usernameFromPath('/a.b'), null);
  assert.equal(api.usernameFromPath('/this_name_is_way_too_long'), null);
  assert.equal(api.usernameFromPath('/%E3%81%82'), null);
  for (const reserved of [
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
  ]) {
    assert.equal(api.usernameFromPath('/' + reserved), null, reserved);
    assert.equal(api.usernameFromPath('/' + reserved + '/x'), null, reserved);
  }
  assert.equal(api.usernameFromPath('/i/bookmarks'), null);
});

await test('usernameFromLocation falls back to /search?q=from:user', () => {
  const { api } = createStoreHarness();
  assert.equal(
    api.usernameFromLocation('/search', '?q=from%3Aalice%20since%3A2020-01-01&f=live'),
    'alice'
  );
  assert.equal(api.usernameFromLocation('/search/', '?q=from%3A%40bob'), 'bob');
  assert.equal(api.usernameFromLocation('/search', '?q=hello%20world'), null);
  assert.equal(api.usernameFromLocation('/search', ''), null);
  assert.equal(api.usernameFromLocation('/home', '?q=from%3Aalice'), null);
  assert.equal(api.usernameFromLocation('/alice', '?q=from%3Abob'), 'alice');
});

await test('isTweetMessage validates the interceptor message shape', () => {
  const { api } = createStoreHarness();
  assert.equal(api.isTweetMessage({ type: 'XTCE_TWEETS', tweets: [] }), true);
  assert.equal(api.isTweetMessage({ type: 'OTHER', tweets: [] }), false);
  assert.equal(api.isTweetMessage({ type: 'XTCE_TWEETS', tweets: {} }), false);
  assert.equal(api.isTweetMessage({ type: 'XTCE_TWEETS' }), false);
  assert.equal(api.isTweetMessage(null), false);
  assert.equal(api.isTweetMessage([]), false);
});

await test('store dedupes by id and keeps the newest record', async () => {
  const { store } = createStoreHarness();
  await store.switchUser('alice');
  const added = store.ingest([
    makeRecord(1, { text: 'first' }),
    makeRecord(1, { text: 'updated' }),
    makeRecord(2)
  ]);
  assert.equal(added, 2);
  let state = store.getState();
  assert.equal(state.username, 'alice');
  assert.equal(state.count, 2);
  assert.equal(state.records.find((record) => record.id === '1').text, 'updated');
  assert.equal(store.ingest([makeRecord(1)]), 0);
  state = store.getState();
  assert.equal(state.count, 2);
  await store.flushNow();
});

await test('store ignores malformed records and coerces numeric ids', async () => {
  const { store } = createStoreHarness();
  await store.switchUser('alice');
  store.ingest([null, {}, { id: '' }, { id: '   ' }, { id: null }, 'x', { id: NaN }]);
  assert.equal(store.getState().count, 0);
  store.ingest([{ id: 123, text: 'numeric id' }]);
  assert.equal(store.getState().count, 1);
  assert.equal(store.getState().records[0].id, 123);
  store.ingest([{ id: '123', text: 'string id' }]);
  assert.equal(store.getState().count, 1);
});

await test('store switches per-user buckets and persists each one', async () => {
  const { store, storage } = createStoreHarness();
  await store.switchUser('alice');
  store.ingest([makeRecord(1), makeRecord(2)]);
  await store.flushNow();
  await store.switchUser('bob');
  store.ingest([makeRecord(3)]);
  await store.flushNow();
  assert.ok(storage.data.has('xtce_alice'));
  assert.ok(storage.data.has('xtce_bob'));
  assert.equal(storage.data.get('xtce_alice').records.length, 2);
  assert.equal(storage.data.get('xtce_bob').records.length, 1);
  await store.switchUser('alice');
  const state = store.getState();
  assert.equal(state.username, 'alice');
  assert.equal(state.count, 2);
  assert.deepEqual(idsOf(state.records), ['1', '2']);
});

await test('store restores object and bare-array payloads from storage', async () => {
  const seeded = {
    xtce_carol: {
      version: 1,
      username: 'carol',
      records: [makeRecord(10), { id: 11, text: 'restored' }, { id: '' }]
    },
    xtce_dave: [makeRecord(12)]
  };
  const { store } = createStoreHarness(seeded);
  await store.switchUser('carol');
  let state = store.getState();
  assert.equal(state.count, 2);
  assert.deepEqual(idsOf(state.records), ['10', '11']);
  await store.switchUser('dave');
  state = store.getState();
  assert.equal(state.count, 1);
  assert.deepEqual(idsOf(state.records), ['12']);
});

await test('store throttles persistence into one write per 500 ms window', async () => {
  const { store, storage, timers } = createStoreHarness(undefined, 500);
  await store.switchUser('alice');
  assert.equal(storage.calls.set.length, 0);
  store.ingest([makeRecord(1)]);
  store.ingest([makeRecord(2)]);
  assert.equal(storage.calls.set.length, 0, 'must not write before the window');
  assert.equal(timers.pendingCount(), 1);
  assert.deepEqual(timers.delays(), [500]);
  await timers.runAll();
  assert.equal(storage.calls.set.length, 1);
  assert.equal(storage.calls.set[0].key, 'xtce_alice');
  assert.equal(storage.calls.set[0].value.records.length, 2);
  store.ingest([makeRecord(3)]);
  assert.equal(timers.pendingCount(), 1);
  await timers.runAll();
  assert.equal(storage.calls.set.length, 2);
  assert.equal(storage.calls.set[1].value.records.length, 3);
});

await test('store clearCurrent empties memory and the persisted bucket', async () => {
  const { store, storage } = createStoreHarness();
  await store.switchUser('alice');
  store.ingest([makeRecord(1), makeRecord(2)]);
  await store.flushNow();
  assert.equal(storage.data.get('xtce_alice').records.length, 2);
  await store.clearCurrent();
  assert.equal(store.getState().count, 0);
  await store.flushNow();
  assert.equal(storage.data.get('xtce_alice').records.length, 0);
  await store.switchUser('bob');
  await store.switchUser('alice');
  assert.equal(store.getState().count, 0);
});

await test('store notifies subscribers and unsubscribes cleanly', async () => {
  const { store } = createStoreHarness();
  const seen = [];
  const unsubscribe = store.subscribe((state) => {
    seen.push({ username: state.username, count: state.count });
  });
  await store.switchUser('alice');
  store.ingest([makeRecord(1)]);
  await store.clearCurrent();
  assert.ok(seen.length >= 3, 'switch, ingest and clear must notify');
  assert.equal(seen[seen.length - 1].count, 0);
  unsubscribe();
  const before = seen.length;
  await store.switchUser('bob');
  assert.equal(seen.length, before);
});

/* -------------------------------------------------------------------------
 * Store durability regressions (review items 3, 4, 5)
 * ---------------------------------------------------------------------- */

await test('store waits for an in-flight restore before writing a merge', async () => {
  const harness = createStoreHarness({
    xtce_alice: { version: 1, username: 'alice', records: [makeRecord(1)] }
  });
  const gate = harness.storage.deferNextGet();
  const switching = harness.store.switchUser('alice');
  harness.store.ingest([makeRecord(2)]);
  const flushing = harness.store.flushNow();
  await settle();
  assert.equal(
    harness.storage.calls.set.length,
    0,
    'a partial snapshot must not overwrite stored records before the read settles'
  );
  gate.resolve();
  await switching;
  await flushing;
  assert.deepEqual(
    idsOf(harness.storage.data.get('xtce_alice').records).sort(),
    ['1', '2']
  );
  assert.equal(harness.store.getState().count, 2);
});

await test('store does not write a partial snapshot when the read fails and retries', async () => {
  const harness = createStoreHarness({
    xtce_alice: { version: 1, username: 'alice', records: [makeRecord(1)] }
  });
  const gate = harness.storage.deferNextGet();
  const switching = harness.store.switchUser('alice');
  harness.store.ingest([makeRecord(2)]);
  const flushing = harness.store.flushNow();
  await settle();
  assert.equal(harness.storage.calls.set.length, 0);
  gate.reject(new Error('storage read failed'));
  await switching;
  await assert.rejects(flushing, /storage read failed/);
  assert.equal(
    harness.storage.calls.set.length,
    0,
    'a failed read must not overwrite storage'
  );
  assert.match(harness.store.getState().error.message, /storage read failed/);
  await harness.timers.runAll();
  assert.deepEqual(
    idsOf(harness.storage.data.get('xtce_alice').records).sort(),
    ['1', '2']
  );
  assert.equal(harness.store.getState().error, null);
});

await test('store clearCurrent is not undone by a delayed restore', async () => {
  const harness = createStoreHarness({
    xtce_alice: {
      version: 1,
      username: 'alice',
      records: [makeRecord(1), makeRecord(2)]
    }
  });
  const gate = harness.storage.deferNextGet();
  const switching = harness.store.switchUser('alice');
  const clearing = harness.store.clearCurrent();
  await settle();
  gate.resolve();
  await switching;
  await clearing;
  await harness.store.flushNow();
  assert.equal(harness.store.getState().count, 0);
  assert.deepEqual(harness.storage.data.get('xtce_alice').records, []);
});

await test('store retries a failed clear without resurrecting records', async () => {
  const harness = createStoreHarness({
    xtce_alice: { version: 1, username: 'alice', records: [makeRecord(1)] }
  });
  await harness.store.switchUser('alice');
  harness.storage.failNextSet(new Error('QUOTA_BYTES quota exceeded'));
  await assert.rejects(harness.store.clearCurrent(), /quota/i);
  assert.match(harness.store.getState().error.message, /quota/i);
  assert.equal(harness.store.getState().count, 0);
  assert.equal(
    harness.storage.data.get('xtce_alice').records.length,
    1,
    'the failed clear must leave storage untouched'
  );
  await harness.timers.runAll();
  assert.deepEqual(harness.storage.data.get('xtce_alice').records, []);
  assert.equal(harness.store.getState().error, null);
});

await test('store propagates quota failures, keeps the bucket dirty and retries', async () => {
  const harness = createStoreHarness();
  await harness.store.switchUser('alice');
  harness.store.ingest([makeRecord(1)]);
  harness.storage.failNextSet(new Error('QUOTA_BYTES quota exceeded'));
  await assert.rejects(harness.store.flushNow(), /quota/i);
  assert.match(harness.store.getState().error.message, /quota/i);
  assert.equal(harness.store.getState().error.operation, 'flush');
  assert.equal(harness.storage.data.has('xtce_alice'), false);
  assert.ok(harness.timers.pendingCount() > 0, 'a retry must be scheduled');
  await harness.timers.runAll();
  assert.equal(harness.storage.data.get('xtce_alice').records.length, 1);
  assert.equal(harness.store.getState().error, null);
});

await test('two stores on the same user merge interleaved writes', async () => {
  const pair = createSharedStorePair();
  await pair.a.store.switchUser('alice');
  await pair.b.store.switchUser('alice');
  pair.a.store.ingest([makeRecord(1)]);
  pair.b.store.ingest([makeRecord(2)]);

  const gate = pair.storage.deferNextSet();
  const flushingA = pair.a.store.flushNow();
  await waitFor(() => pair.storage.calls.set.length === 1, 'first write to start');
  const flushingB = pair.b.store.flushNow();
  await settle();
  assert.equal(
    pair.storage.calls.set.length,
    1,
    'the second writer must wait for the user lock'
  );
  gate.resolve();
  await Promise.all([flushingA, flushingB]);

  assert.deepEqual(
    idsOf(pair.storage.data.get('xtce_alice').records).sort(),
    ['1', '2']
  );
  assert.deepEqual(
    idsOf(pair.b.store.getState().records).sort(),
    ['1', '2'],
    'the second store merges the first snapshot into memory'
  );

  pair.a.store.ingest([makeRecord(3)]);
  pair.b.store.ingest([makeRecord(4)]);
  await pair.a.store.flushNow();
  await pair.b.store.flushNow();
  assert.deepEqual(
    idsOf(pair.storage.data.get('xtce_alice').records).sort(),
    ['1', '2', '3', '4']
  );
});

await test('store merges records written by another tab without marking them dirty', async () => {
  const harness = createStoreHarness();
  await harness.store.switchUser('alice');
  assert.equal(harness.store.mergeExternal('alice', [makeRecord(9)]), 1);
  assert.equal(harness.store.getState().count, 1);
  assert.equal(harness.timers.pendingCount(), 0, 'external records are already stored');
  assert.equal(harness.store.mergeExternal('alice', [makeRecord(9)]), 0);
});

/* -------------------------------------------------------------------------
 * Cross-tab clear propagation (second review, item 1)
 * ---------------------------------------------------------------------- */

await test('store applies an external clear snapshot instead of ignoring it', async () => {
  const harness = createStoreHarness({
    xtce_alice: {
      version: 2,
      username: 'alice',
      clearEpoch: 0,
      records: [makeRecord(1), makeRecord(2)]
    }
  });
  await harness.store.switchUser('alice');
  assert.equal(harness.store.getState().count, 2);

  // Tab A's clear committed while this tab is stale. The full payload has an
  // empty records array, which the old onChanged path ignored.
  assert.equal(
    harness.store.mergeExternal('alice', {
      version: 2,
      username: 'alice',
      clearEpoch: 1,
      records: []
    }),
    0
  );
  assert.equal(
    harness.store.getState().count,
    0,
    'an empty snapshot with a newer clear epoch must empty the memory bucket'
  );

  // A later batch is post-clear and must survive the next merge write.
  harness.store.ingest([makeRecord(3)]);
  await harness.store.flushNow();
  const stored = harness.storage.data.get('xtce_alice');
  assert.deepEqual(idsOf(stored.records), ['3']);
  assert.equal(stored.clearEpoch, 1);
});

await test('store ignores a stale snapshot with an older clear epoch', async () => {
  const harness = createStoreHarness();
  await harness.store.switchUser('alice');
  harness.store.mergeExternal('alice', {
    version: 2,
    username: 'alice',
    clearEpoch: 2,
    records: []
  });
  assert.equal(harness.store.getState().count, 0);

  // A queued pre-clear onChanged event arrives late; it must not resurrect.
  assert.equal(
    harness.store.mergeExternal('alice', {
      version: 2,
      username: 'alice',
      clearEpoch: 1,
      records: [makeRecord(1)]
    }),
    0
  );
  assert.equal(harness.store.getState().count, 0);
});

await test('store removes a deleted storage key from memory without writing it back', async () => {
  const harness = createStoreHarness({
    xtce_alice: {
      version: 2,
      username: 'alice',
      clearEpoch: 0,
      records: [makeRecord(1)]
    }
  });
  await harness.store.switchUser('alice');
  assert.equal(harness.store.getState().count, 1);
  harness.storage.data.delete('xtce_alice');
  harness.store.mergeExternal('alice', undefined, { removed: true });
  assert.equal(harness.store.getState().count, 0);
  await harness.store.flushNow();
  assert.equal(
    harness.storage.data.has('xtce_alice'),
    false,
    'a deleted bucket must not be recreated from memory'
  );
});

await test('a stale tab re-reads the clear epoch and does not resurrect records', async () => {
  const harness = createStoreHarness({
    xtce_alice: {
      version: 2,
      username: 'alice',
      clearEpoch: 0,
      records: [makeRecord(1), makeRecord(2)]
    }
  });
  await harness.store.switchUser('alice');
  harness.store.ingest([makeRecord(3)]);
  assert.equal(harness.store.getState().count, 3);

  // Another tab cleared; this tab was frozen/suspended and never received
  // chrome.storage.onChanged. Its dirty batch must not win on the next flush.
  harness.storage.data.set('xtce_alice', {
    version: 2,
    username: 'alice',
    clearEpoch: 1,
    records: []
  });
  await harness.store.flushNow();
  const stored = harness.storage.data.get('xtce_alice');
  assert.deepEqual(stored.records, [], 'the cleared records must stay deleted');
  assert.equal(stored.clearEpoch, 1);
  assert.equal(harness.store.getState().count, 0);
});

await test('a clear queued behind an in-flight merge write still wins', async () => {
  const harness = createStoreHarness({
    xtce_alice: {
      version: 2,
      username: 'alice',
      clearEpoch: 0,
      records: [makeRecord(1)]
    }
  });
  await harness.store.switchUser('alice');
  harness.store.ingest([makeRecord(2)]);

  const gate = harness.storage.deferNextSet('xtce_alice');
  const flushing = harness.store.flushNow();
  await waitFor(
    () => userSetCalls(harness.storage, 'xtce_alice').length === 1,
    'the merge write to start'
  );
  const clearing = harness.store.clearCurrent();
  await settle();
  assert.equal(
    userSetCalls(harness.storage, 'xtce_alice').length,
    1,
    'the clear must wait for the in-flight merge write'
  );
  gate.resolve();
  await flushing;
  await clearing;
  const stored = harness.storage.data.get('xtce_alice');
  assert.deepEqual(stored.records, []);
  assert.equal(stored.clearEpoch, 1);
});

await test('a cross-tab clear observed during a clear write cannot be overwritten', async () => {
  const harness = createStoreHarness({
    xtce_alice: {
      version: 2,
      username: 'alice',
      clearEpoch: 0,
      records: [makeRecord(1)]
    }
  });
  await harness.store.switchUser('alice');

  const gate = harness.storage.deferNextSet('xtce_alice');
  const clearing = harness.store.clearCurrent();
  await waitFor(
    () => userSetCalls(harness.storage, 'xtce_alice').length === 1,
    'the clear write to start'
  );

  // A newer clear commits while our empty body is still in flight.
  harness.storage.data.set('xtce_alice', {
    version: 2,
    username: 'alice',
    clearEpoch: 2,
    records: [makeRecord(9)]
  });
  harness.store.mergeExternal(
    'alice',
    harness.storage.data.get('xtce_alice')
  );
  gate.resolve();
  await clearing;

  // The repair pass keeps the newer clear epoch and does not keep record 9:
  // the local clear was requested first, so it must not be undone.
  await harness.store.flushNow();
  const stored = harness.storage.data.get('xtce_alice');
  assert.deepEqual(stored.records, []);
  assert.equal(stored.clearEpoch, 2);
});

/* -------------------------------------------------------------------------
 * Cross-origin coordination (second review, item 2)
 *
 * The real hazard is that navigator.locks is origin-scoped: an x.com tab and
 * a twitter.com tab can enter their critical sections at the same time. These
 * tests use a lock manager that only serializes inside one domain, so the
 * overlap is real; the shared-storage writer lease is what prevents the
 * overwrite.
 * ---------------------------------------------------------------------- */

await test('separate-origin lock domains overlap yet never overwrite each other', async () => {
  const pair = createCrossOriginPair({
    xtce_alice: {
      version: 2,
      username: 'alice',
      clearEpoch: 0,
      records: [makeRecord(1)]
    }
  });
  await pair.a.store.switchUser('alice');
  await pair.b.store.switchUser('alice');
  pair.a.store.ingest([makeRecord(2)]);
  pair.b.store.ingest([makeRecord(3)]);
  assert.equal(pair.b.store.getState().count, 2);

  const gate = pair.storage.deferNextSet('xtce_alice');
  const flushingA = pair.a.store.flushNow();
  await waitFor(
    () => userSetCalls(pair.storage, 'xtce_alice').length === 1,
    'A user write to start'
  );

  const flushingB = pair.b.store.flushNow();
  await assert.rejects(
    flushingB,
    (error) => error && error.code === 'XTCE_CROSS_ORIGIN_BUSY'
  );
  assert.ok(
    pair.locks.maxActive() >= 2,
    'the two origin locks must really overlap, otherwise this test is vacuous'
  );
  assert.equal(
    userSetCalls(pair.storage, 'xtce_alice').length,
    1,
    'the peer origin must not write the user snapshot'
  );
  assert.deepEqual(
    idsOf(pair.storage.data.get('xtce_alice').records),
    ['1']
  );
  assert.equal(
    pair.b.store.getState().error.code,
    'XTCE_CROSS_ORIGIN_BUSY'
  );
  assert.match(
    pair.b.store.getState().error.message,
    /x\.com/,
    'the refusal must name the origin that owns the lease'
  );

  gate.resolve();
  await flushingA;
  assert.deepEqual(
    idsOf(pair.storage.data.get('xtce_alice').records).sort(),
    ['1', '2']
  );

  // The loser keeps its records in memory and persists them once the lease is
  // released; a read-merge-write recovers the union.
  await pair.b.store.flushNow();
  assert.deepEqual(
    idsOf(pair.storage.data.get('xtce_alice').records).sort(),
    ['1', '2', '3']
  );
  assert.equal(pair.b.store.getState().error, null);
});

await test('simultaneous cross-origin lease registrations let only one writer proceed', async () => {
  const pair = createCrossOriginPair();
  await pair.a.store.switchUser('alice');
  await pair.b.store.switchUser('alice');
  pair.a.store.ingest([makeRecord(2)]);
  pair.b.store.ingest([makeRecord(3)]);

  const isXLease = (key) =>
    key.indexOf(pair.a.api.COORDINATION_PREFIX) === 0 &&
    key.indexOf(encodeURIComponent('https://x.com')) !== -1;
  const gateA = pair.storage.deferNextSet(isXLease);
  const flushingA = pair.a.store.flushNow();
  await waitFor(
    () => pair.storage.calls.set.some((call) => isXLease(call.key)),
    'A lease registration'
  );

  const gateB = pair.storage.deferNextSet('xtce_alice');
  const flushingB = pair.b.store.flushNow();
  await waitFor(
    () => userSetCalls(pair.storage, 'xtce_alice').length === 1,
    'B user write to start'
  );

  // A registers after B already read the lease table: A must observe B.
  gateA.resolve();
  await assert.rejects(
    flushingA,
    (error) => error && error.code === 'XTCE_CROSS_ORIGIN_BUSY'
  );
  gateB.resolve();
  await flushingB;

  assert.deepEqual(
    idsOf(pair.storage.data.get('xtce_alice').records),
    ['3'],
    'only the origin that won the race may write'
  );
  assert.equal(pair.a.store.getState().error.code, 'XTCE_CROSS_ORIGIN_BUSY');
});

await test('a malformed peer lease fails closed without touching the snapshot', async () => {
  const pair = createCrossOriginPair({
    xtce_alice: {
      version: 2,
      username: 'alice',
      clearEpoch: 0,
      records: []
    }
  });
  await pair.a.store.switchUser('alice');
  const peerKey = pair.a.api.coordinationKey(
    'https://twitter.com',
    'alice'
  );
  pair.storage.data.set(peerKey, { nonsense: true });
  pair.a.store.ingest([makeRecord(2)]);

  await assert.rejects(
    pair.a.store.flushNow(),
    (error) => error && error.code === 'XTCE_CROSS_ORIGIN_BUSY'
  );
  assert.equal(
    userSetCalls(pair.storage, 'xtce_alice').length,
    0,
    'an unreadable peer lease must not allow an overwrite'
  );
  assert.match(pair.a.store.getState().error.message, /twitter\.com/);

  // An expired peer lease is ignored, so the tab recovers without a reload.
  pair.storage.data.get(peerKey).expiresAt = 0;
  await pair.a.store.flushNow();
  assert.deepEqual(
    idsOf(pair.storage.data.get('xtce_alice').records),
    ['2']
  );
});

await test('a failed peer lease read fails closed and also succeeds on retry', async () => {
  const pair = createCrossOriginPair();
  await pair.a.store.switchUser('alice');
  pair.a.store.ingest([makeRecord(2)]);
  pair.storage.failNextGetMany(new Error('registry read failed'));

  await assert.rejects(
    pair.a.store.flushNow(),
    (error) => error && error.code === 'XTCE_COORDINATION_UNAVAILABLE'
  );
  assert.match(
    pair.a.store.getState().error.message,
    /registry read failed/
  );
  assert.equal(userSetCalls(pair.storage, 'xtce_alice').length, 0);

  await pair.a.store.flushNow();
  assert.deepEqual(
    idsOf(pair.storage.data.get('xtce_alice').records),
    ['2']
  );
});

await test('a storage adapter without shared-lease APIs fails closed', async () => {
  const storage = createFakeStorage();
  delete storage.getMany;
  const harness = createStoreHarness(undefined, 500, {
    storage,
    origin: 'https://x.com',
    peerOrigins: ['https://twitter.com']
  });
  await harness.store.switchUser('alice');
  harness.store.ingest([makeRecord(1)]);
  await assert.rejects(
    harness.store.flushNow(),
    (error) => error && error.code === 'XTCE_COORDINATION_UNAVAILABLE'
  );
  assert.equal(storage.calls.set.length, 0);
});

/* -------------------------------------------------------------------------
 * Manifest test
 * ---------------------------------------------------------------------- */

await test('manifest wires MAIN interceptor and isolated collector with frozen permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'X Tweet CSV Exporter (Local)');
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, [
    'https://x.com/*',
    'https://twitter.com/*'
  ]);
  assert.equal(manifest.content_scripts.length, 2);

  const main = manifest.content_scripts[0];
  assert.deepEqual(main.js, ['src/parser.js', 'src/interceptor.js']);
  assert.deepEqual(main.matches, ['https://x.com/*', 'https://twitter.com/*']);
  assert.equal(main.world, 'MAIN');
  assert.equal(main.run_at, 'document_start');

  const isolated = manifest.content_scripts[1];
  assert.deepEqual(isolated.js, ['src/store.js', 'src/content.js']);
  assert.deepEqual(isolated.matches, ['https://x.com/*', 'https://twitter.com/*']);
  assert.equal(isolated.world, 'ISOLATED');
  assert.equal(
    isolated.run_at,
    'document_start',
    'the collector must listen before early page responses'
  );

  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes('webRequest'));
  assert.ok(!serialized.includes('<all_urls>'));
  assert.ok(!serialized.includes('"tabs"'));

  for (const file of [
    'manifest.json',
    'src/parser.js',
    'src/interceptor.js',
    'src/store.js',
    'src/content.js'
  ]) {
    assert.ok(readFileSync(new URL('../' + file, import.meta.url), 'utf8').length > 0, file);
  }
});

/* -------------------------------------------------------------------------
 * Interceptor tests
 * ---------------------------------------------------------------------- */

await test('interceptor hooks fetch and posts extracted target tweets', async () => {
  const { sandbox, messages } = createInterceptorHarness();
  const response = await sandbox.fetch(
    'https://x.com/i/api/graphql/abc/UserTweets?variables=%7B%7D'
  );
  assert.equal(response.status, 200);
  await settle();
  const tweets = tweetMessages(messages);
  assert.equal(tweets.length, 1);
  assert.equal(tweets[0].targetOrigin, 'https://x.com');
  assert.equal(tweets[0].message.tweets.length, 1);
  assert.equal(tweets[0].message.tweets[0].id, '1001');
});

await test('interceptor accepts URL and Request-like fetch inputs', async () => {
  const { sandbox, messages } = createInterceptorHarness();
  await sandbox.fetch(new URL('https://x.com/i/api/graphql/abc/UserTweets'));
  await sandbox.fetch({ url: 'https://x.com/i/api/graphql/abc/SearchTimeline' });
  await settle();
  assert.equal(tweetMessages(messages).length, 2);
});

await test('interceptor accepts every listed operation and ignores other URLs', async () => {
  const { sandbox, messages } = createInterceptorHarness();
  const operations = [
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
  for (const operation of operations) {
    await sandbox.fetch('https://x.com/i/api/graphql/abc/' + operation + '?variables=%7B%7D');
  }
  await settle();
  assert.equal(tweetMessages(messages).length, operations.length);

  const beforeIgnored = tweetMessages(messages).length;
  await sandbox.fetch('https://x.com/i/api/graphql/abc/OtherTimeline');
  await sandbox.fetch('https://x.com/i/api/2/guide.json');
  await sandbox.fetch('https://x.com/normal/page');
  await sandbox.fetch('https://example.com/i/api/graphql/abc/UserTweets');
  await settle();
  assert.equal(tweetMessages(messages).length, beforeIgnored);
});

await test('interceptor hooks XHR open/send for text and json responses', async () => {
  const { sandbox, messages } = createInterceptorHarness();

  const textXhr = new sandbox.XMLHttpRequest();
  textXhr.open('GET', 'https://x.com/i/api/graphql/abc/UserTweets');
  textXhr.send();
  textXhr.status = 200;
  textXhr.responseText = JSON.stringify(interceptFixture);
  textXhr.emit('load');
  await tick();
  assert.equal(tweetMessages(messages).length, 1);

  const jsonXhr = new sandbox.XMLHttpRequest();
  jsonXhr.open('POST', 'https://x.com/i/api/graphql/abc/SearchTimeline');
  jsonXhr.responseType = 'json';
  jsonXhr.send();
  jsonXhr.status = 200;
  jsonXhr.response = interceptFixture;
  jsonXhr.emit('load');
  await tick();
  assert.equal(tweetMessages(messages).length, 2);
});

await test('interceptor ignores non-target, failed and malformed XHR responses', async () => {
  const { sandbox, messages } = createInterceptorHarness();

  const nonTarget = new sandbox.XMLHttpRequest();
  nonTarget.open('GET', 'https://x.com/i/api/graphql/abc/OtherTimeline');
  nonTarget.send();
  nonTarget.responseText = JSON.stringify(interceptFixture);
  nonTarget.emit('load');
  await tick();

  const failed = new sandbox.XMLHttpRequest();
  failed.open('GET', 'https://x.com/i/api/graphql/abc/UserTweets');
  failed.send();
  failed.status = 500;
  failed.responseText = JSON.stringify(interceptFixture);
  failed.emit('load');
  await tick();

  const badJson = new sandbox.XMLHttpRequest();
  badJson.open('GET', 'https://x.com/i/api/graphql/abc/UserTweets');
  badJson.send();
  badJson.responseText = 'not json';
  badJson.emit('load');
  await tick();

  assert.equal(tweetMessages(messages).length, 0);
});

await test('interceptor never surfaces parser/JSON failures into page code', async () => {
  const badJson = createInterceptorHarness({
    fetch: () =>
      Promise.resolve({
        clone() {
          return {
            json() {
              return Promise.reject(new Error('bad json'));
            }
          };
        }
      })
  });
  const response = await badJson.sandbox.fetch(
    'https://x.com/i/api/graphql/abc/UserTweets'
  );
  assert.ok(response);
  await settle();
  assert.equal(tweetMessages(badJson.messages).length, 0);

  const rejecting = createInterceptorHarness({
    fetch: () => Promise.reject(new Error('network'))
  });
  await assert.rejects(
    rejecting.sandbox.fetch('https://x.com/i/api/graphql/abc/UserTweets'),
    /network/
  );
  await settle();
  assert.equal(tweetMessages(rejecting.messages).length, 0);

  const noParser = createInterceptorHarness({ withParser: false });
  const noParserResponse = await noParser.sandbox.fetch(
    'https://x.com/i/api/graphql/abc/UserTweets'
  );
  assert.ok(noParserResponse);
  await settle();
  assert.equal(tweetMessages(noParser.messages).length, 0);
});

await test('interceptor installs only once', async () => {
  const { sandbox, messages } = createInterceptorHarness();
  assert.equal(sandbox.__XTCE_INTERCEPTOR__, true);
  vm.runInContext(interceptorSource, sandbox, { filename: 'src/interceptor.js' });
  await sandbox.fetch('https://x.com/i/api/graphql/abc/UserTweets');
  await settle();
  assert.equal(tweetMessages(messages).length, 1);
});

await test('interceptor buffers timeline batches until the collector is ready', async () => {
  const harness = createInterceptorHarness({ ready: false });
  await harness.sandbox.fetch('https://x.com/i/api/graphql/abc/UserTweets');
  await settle();
  assert.equal(
    tweetMessages(harness.messages).length,
    0,
    'a batch received before READY must be buffered, not dropped'
  );
  harness.emitMessage({
    origin: 'https://x.com',
    data: { type: 'XTCE_COLLECTOR_READY' }
  });
  await settle();
  const tweets = tweetMessages(harness.messages);
  assert.equal(tweets.length, 1);
  assert.equal(tweets[0].message.tweets[0].id, '1001');
});

await test('interceptor stamps the request-time route and operation', async () => {
  const harness = createInterceptorHarness();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const delayed = createInterceptorHarness({ fetch: () => pending });

  const first = harness.sandbox.fetch(
    'https://x.com/i/api/graphql/abc/UserTweets'
  );
  harness.sandbox.location.pathname = '/bob';
  await first;
  await settle();
  const firstMessage = tweetMessages(harness.messages)[0].message;
  assert.equal(firstMessage.source.pathname, '/alice');
  assert.equal(firstMessage.source.operation, 'UserTweets');

  const xhr = new harness.sandbox.XMLHttpRequest();
  harness.sandbox.location.pathname = '/alice';
  xhr.open('GET', 'https://x.com/i/api/graphql/abc/UserTweets');
  xhr.send();
  harness.sandbox.location.pathname = '/bob';
  xhr.status = 200;
  xhr.responseText = JSON.stringify(interceptFixture);
  xhr.emit('load');
  await tick();
  const xhrMessage = tweetMessages(harness.messages).pop().message;
  assert.equal(xhrMessage.source.pathname, '/alice');

  const second = delayed.sandbox.fetch(
    'https://x.com/i/api/graphql/abc/UserTweets'
  );
  delayed.sandbox.location.pathname = '/bob';
  release(makeResponse(interceptFixture));
  await second;
  await settle();
  const delayedMessage = tweetMessages(delayed.messages)[0].message;
  assert.equal(delayedMessage.source.pathname, '/alice');
  assert.equal(delayedMessage.source.operation, 'UserTweets');
});

/* -------------------------------------------------------------------------
 * Isolated-world collector tests
 * ---------------------------------------------------------------------- */

await test('content collector receives batches, dedupes and persists', async () => {
  const harness = createContentHarness();
  await settle();
  let state = harness.sandbox.__XTCE_content.getState();
  assert.equal(state.username, 'alice');
  assert.equal(state.count, 0);

  harness.emit(
    'message',
    tweetMessage([makeRecord(1), makeRecord(2), makeRecord(2)])
  );
  await settle();
  state = harness.sandbox.__XTCE_content.getState();
  assert.equal(state.count, 2);

  harness.emit(
    'message',
    tweetMessage([makeRecord(2, { text: 'new' }), makeRecord(3)])
  );
  await settle();
  state = harness.sandbox.__XTCE_content.getState();
  assert.equal(state.count, 3);
  assert.equal(state.records.find((record) => record.id === '2').text, 'new');

  await harness.sandbox.__XTCE_content.flush();
  assert.equal(harness.storage.data.get('xtce_alice').records.length, 3);
});

await test('content collector restores an existing bucket on load', async () => {
  const harness = createContentHarness({
    xtce_alice: {
      version: 1,
      username: 'alice',
      records: [makeRecord(50), makeRecord(51)]
    }
  });
  await settle();
  const state = harness.sandbox.__XTCE_content.getState();
  assert.equal(state.username, 'alice');
  assert.equal(state.count, 2);
  assert.deepEqual(idsOf(state.records), ['50', '51']);
});

await test('content collector rejects wrong-origin, wrong-type, malformed and unbound messages', async () => {
  const harness = createContentHarness();
  await settle();
  harness.emit('message', {
    origin: 'https://evil.example',
    data: {
      type: 'XTCE_TWEETS',
      tweets: [makeRecord(1)],
      source: { pathname: '/alice', search: '' }
    }
  });
  harness.emit('message', {
    origin: 'https://x.com',
    data: { type: 'OTHER', tweets: [makeRecord(2)] }
  });
  harness.emit('message', {
    origin: 'https://x.com',
    data: { type: 'XTCE_TWEETS', tweets: 'nope' }
  });
  harness.emit('message', {});
  harness.emit('message', {
    origin: 'https://x.com',
    data: { type: 'XTCE_TWEETS', tweets: [makeRecord(3)] }
  });
  harness.emit('message', {
    origin: 'https://x.com',
    data: {
      type: 'XTCE_TWEETS',
      tweets: [makeRecord(4)],
      source: { pathname: 'alice', search: '' }
    }
  });
  await settle();
  assert.equal(harness.sandbox.__XTCE_content.getState().count, 0);
});

await test('content collector switches and restores per-user buckets on SPA navigation', async () => {
  const harness = createContentHarness({
    xtce_bob: {
      version: 1,
      username: 'bob',
      records: [makeRecord(20, { author_username: 'bob' })]
    }
  });
  await settle();
  harness.emit('message', tweetMessage([makeRecord(1)], '/alice'));
  await settle();
  assert.equal(harness.sandbox.__XTCE_content.getState().count, 1);

  harness.sandbox.location.pathname = '/bob';
  harness.sandbox.location.search = '';
  harness.intervals[0].fn();
  await settle();
  let state = harness.sandbox.__XTCE_content.getState();
  assert.equal(state.username, 'bob');
  assert.equal(state.count, 1);
  assert.deepEqual(idsOf(state.records), ['20']);

  harness.emit(
    'message',
    tweetMessage([makeRecord(21, { author_username: 'bob' })], '/bob')
  );
  await settle();
  assert.equal(harness.sandbox.__XTCE_content.getState().count, 2);
  await harness.sandbox.__XTCE_content.flush();
  assert.equal(harness.storage.data.get('xtce_bob').records.length, 2);
  assert.equal(harness.storage.data.get('xtce_alice').records.length, 1);

  harness.sandbox.location.pathname = '/alice';
  harness.intervals[0].fn();
  await settle();
  state = harness.sandbox.__XTCE_content.getState();
  assert.equal(state.username, 'alice');
  assert.equal(state.count, 1);
});

await test('content collector uses /search?q=from:user and ignores /home', async () => {
  const search = createContentHarness(
    {},
    '/search',
    '?q=from%3Aalice%20since%3A2020-01-01&f=live'
  );
  await settle();
  assert.equal(search.sandbox.__XTCE_content.getState().username, 'alice');
  search.emit(
    'message',
    tweetMessage(
      [makeRecord(30)],
      '/search',
      '?q=from%3Aalice%20since%3A2020-01-01&f=live',
      'SearchTimeline'
    )
  );
  await settle();
  assert.equal(search.sandbox.__XTCE_content.getState().count, 1);
  await search.sandbox.__XTCE_content.flush();
  assert.equal(search.storage.data.get('xtce_alice').records.length, 1);

  const home = createContentHarness({}, '/home', '');
  await settle();
  assert.equal(home.sandbox.__XTCE_content.getState().username, null);
  home.emit('message', tweetMessage([makeRecord(40)], '/home'));
  await settle();
  assert.equal(home.sandbox.__XTCE_content.getState().count, 0);
});

await test('content collector flushes on pagehide and clearCurrent empties the bucket', async () => {
  const harness = createContentHarness();
  await settle();
  harness.emit('message', tweetMessage([makeRecord(1), makeRecord(2)]));
  await settle();
  assert.equal(harness.storage.data.has('xtce_alice'), false);
  harness.emit('pagehide', {});
  await waitFor(() => harness.storage.data.has('xtce_alice'), 'pagehide flush');
  assert.equal(harness.storage.data.get('xtce_alice').records.length, 2);

  await harness.sandbox.__XTCE_content.clearCurrent();
  assert.equal(harness.sandbox.__XTCE_content.getState().count, 0);
  assert.equal(harness.storage.data.get('xtce_alice').records.length, 0);
});

await test('content collector exposes getState/getUsername/subscribe/error API for S3', async () => {
  const harness = createContentHarness();
  await settle();
  const api = harness.sandbox.__XTCE_content;
  assert.equal(typeof api.getState, 'function');
  assert.equal(typeof api.getUsername, 'function');
  assert.equal(typeof api.getLastError, 'function');
  assert.equal(typeof api.clearError, 'function');
  assert.equal(api.getUsername(), 'alice');
  assert.equal(api.getLastError(), null);
  const seen = [];
  const unsubscribe = api.subscribe((state) => {
    seen.push(state.count);
  });
  harness.emit('message', tweetMessage([makeRecord(1)]));
  await settle();
  assert.deepEqual(seen, [1]);
  unsubscribe();
  harness.emit('message', tweetMessage([makeRecord(2)]));
  await settle();
  assert.equal(seen.length, 1);
});

await test('content collector filters other authors from TweetDetail and Likes', async () => {
  const harness = createContentHarness();
  await settle();
  harness.emit(
    'message',
    tweetMessage(
      [
        makeRecord(1, { author_username: 'alice' }),
        makeRecord(2, { author_username: 'bob' })
      ],
      '/alice',
      '',
      'TweetDetail'
    )
  );
  await settle();
  assert.deepEqual(idsOf(harness.sandbox.__XTCE_content.getState().records), ['1']);

  harness.emit(
    'message',
    tweetMessage(
      [
        makeRecord(3, { author_username: 'bob' }),
        makeRecord(4, { author_username: 'carol' })
      ],
      '/alice',
      '',
      'Likes'
    )
  );
  await settle();
  assert.equal(harness.sandbox.__XTCE_content.getState().count, 1);

  harness.emit(
    'message',
    tweetMessage(
      [
        makeRecord(5, { author_username: 'alice' }),
        makeRecord(6, { author_username: 'bob' })
      ],
      '/search',
      '?q=from%3Aalice',
      'SearchTimeline'
    )
  );
  await settle();
  assert.deepEqual(
    idsOf(harness.sandbox.__XTCE_content.getState().records),
    ['1', '5']
  );
});

await test('content collector catches up to pushState without waiting for the poll', async () => {
  const harness = createContentHarness();
  await settle();
  assert.equal(harness.sandbox.__XTCE_content.getUsername(), 'alice');
  harness.sandbox.location.pathname = '/bob';
  harness.sandbox.location.search = '';
  harness.emit(
    'message',
    tweetMessage([makeRecord(7, { author_username: 'bob' })], '/bob')
  );
  await settle();
  const state = harness.sandbox.__XTCE_content.getState();
  assert.equal(state.username, 'bob');
  assert.equal(state.count, 1);
  await harness.sandbox.__XTCE_content.flush();
  assert.equal(harness.storage.data.get('xtce_bob').records.length, 1);
  assert.equal(harness.storage.data.has('xtce_alice'), false);
});

await test('content collector merges records written by another tab', async () => {
  const harness = createContentHarness();
  await settle();
  harness.emitStorageChange({
    xtce_alice: {
      newValue: {
        version: 1,
        username: 'alice',
        records: [makeRecord(70)]
      }
    }
  });
  const state = harness.sandbox.__XTCE_content.getState();
  assert.equal(state.count, 1);
  assert.deepEqual(idsOf(state.records), ['70']);
  assert.equal(harness.timers.pendingCount(), 0);
});

await test('content collector propagates chrome.runtime.lastError and retries quota failures', async () => {
  const harness = createContentHarness();
  await settle();
  harness.storage.failNextSet(new Error('QUOTA_BYTES quota exceeded'));
  harness.emit('message', tweetMessage([makeRecord(80)]));
  await settle();
  await assert.rejects(harness.sandbox.__XTCE_content.flush(), /quota/i);
  assert.match(
    harness.sandbox.__XTCE_content.getLastError().message,
    /quota/i
  );
  assert.equal(
    harness.sandbox.__XTCE_content.getState().error.operation,
    'flush'
  );
  assert.equal(harness.storage.data.has('xtce_alice'), false);
  await harness.timers.runAll();
  assert.equal(harness.storage.data.get('xtce_alice').records.length, 1);
  assert.equal(harness.sandbox.__XTCE_content.getLastError(), null);
});

await test('content collector exposes storage read failures instead of treating them as empty', async () => {
  const storage = createFakeStorage({
    xtce_alice: {
      version: 1,
      username: 'alice',
      records: [makeRecord(90)]
    }
  });
  storage.failNextGet(new Error('storage read failed'));
  const harness = createContentHarnessWithStorage(storage);
  await settle();
  assert.match(
    harness.sandbox.__XTCE_content.getLastError().message,
    /storage read failed/
  );
  // The route poll also retries a transient restore failure.
  harness.intervals[0].fn();
  await settle();
  assert.equal(harness.sandbox.__XTCE_content.getState().count, 1);
  assert.equal(harness.sandbox.__XTCE_content.getLastError(), null);
  harness.emit('message', tweetMessage([makeRecord(91)]));
  await settle();
  await harness.sandbox.__XTCE_content.flush();
  assert.deepEqual(
    idsOf(harness.storage.data.get('xtce_alice').records).sort(),
    ['90', '91']
  );
  assert.equal(harness.sandbox.__XTCE_content.getLastError(), null);
});

/* -------------------------------------------------------------------------
 * Content-level clear propagation and origin safety (second review, items 1-2)
 * ---------------------------------------------------------------------- */

await test('content collector applies an empty cross-tab snapshot as a clear', async () => {
  const harness = createContentHarness({
    xtce_alice: {
      version: 2,
      username: 'alice',
      clearEpoch: 0,
      records: [makeRecord(1), makeRecord(2)]
    }
  });
  await settle();
  assert.equal(harness.sandbox.__XTCE_content.getState().count, 2);

  harness.emitStorageChange({
    xtce_alice: {
      oldValue: {
        version: 2,
        username: 'alice',
        clearEpoch: 0,
        records: [makeRecord(1), makeRecord(2)]
      },
      newValue: {
        version: 2,
        username: 'alice',
        clearEpoch: 1,
        records: []
      }
    }
  });
  assert.equal(
    harness.sandbox.__XTCE_content.getState().count,
    0,
    'the empty snapshot carries a clear epoch and must not be ignored'
  );

  harness.emit('message', tweetMessage([makeRecord(3)]));
  await settle();
  await harness.sandbox.__XTCE_content.flush();
  const stored = harness.storage.data.get('xtce_alice');
  assert.deepEqual(idsOf(stored.records), ['3']);
  assert.equal(stored.clearEpoch, 1);
});

await test('content collector treats a removed storage key as a clear', async () => {
  const harness = createContentHarness({
    xtce_alice: {
      version: 2,
      username: 'alice',
      clearEpoch: 0,
      records: [makeRecord(1)]
    }
  });
  await settle();
  assert.equal(harness.sandbox.__XTCE_content.getState().count, 1);

  // Another context removed the key from chrome.storage.local.
  harness.storage.data.delete('xtce_alice');
  harness.emitStorageChange({
    xtce_alice: {
      oldValue: {
        version: 2,
        username: 'alice',
        clearEpoch: 0,
        records: [makeRecord(1)]
      }
    }
  });
  assert.equal(harness.sandbox.__XTCE_content.getState().count, 0);
  await harness.sandbox.__XTCE_content.flush();
  assert.equal(
    harness.storage.data.has('xtce_alice'),
    false,
    'a removed bucket must not be recreated from stale memory'
  );
});

await test('a stale tab adopts a live tab clear and never resurrects the records', async () => {
  const storage = createFakeStorage({
    xtce_alice: {
      version: 2,
      username: 'alice',
      clearEpoch: 0,
      records: [makeRecord(1), makeRecord(2)]
    }
  });
  const bus = createChromeChangeBus();
  const locks = createFakeLockManager();
  const tabA = createContentHarnessWithStorage(storage, '/alice', '', {
    bus,
    locks
  });
  const tabB = createContentHarnessWithStorage(storage, '/alice', '', {
    bus,
    locks
  });
  await settle();
  assert.equal(tabA.sandbox.__XTCE_content.getState().count, 2);
  assert.equal(tabB.sandbox.__XTCE_content.getState().count, 2);

  await tabA.sandbox.__XTCE_content.clearCurrent();
  await settle();
  assert.equal(
    tabB.sandbox.__XTCE_content.getState().count,
    0,
    'the clear must propagate to the other tab through onChanged'
  );

  // B later receives a fresh tweet. Flushing it must not bring back 1 and 2.
  tabB.emit('message', tweetMessage([makeRecord(3)]));
  await settle();
  await tabB.sandbox.__XTCE_content.flush();
  const stored = storage.data.get('xtce_alice');
  assert.deepEqual(idsOf(stored.records), ['3']);
  assert.equal(stored.clearEpoch, 1);
});

await test('a cross-tab clear invalidates an in-flight restore', async () => {
  const storage = createFakeStorage({
    xtce_alice: {
      version: 2,
      username: 'alice',
      clearEpoch: 0,
      records: [makeRecord(1), makeRecord(2)]
    }
  });
  const bus = createChromeChangeBus();
  const locks = createFakeLockManager();
  const gate = storage.deferNextGet('xtce_alice');
  const tabB = createContentHarnessWithStorage(storage, '/alice', '', {
    bus,
    locks
  });
  await settle();
  assert.equal(tabB.sandbox.__XTCE_content.getState().count, 0);

  // A second tab can still restore normally; only B's read is deferred.
  const tabA = createContentHarnessWithStorage(storage, '/alice', '', {
    bus,
    locks
  });
  await settle();
  assert.equal(tabA.sandbox.__XTCE_content.getState().count, 2);
  await tabA.sandbox.__XTCE_content.clearCurrent();
  await settle();
  gate.resolve();
  await settle();
  assert.equal(
    tabB.sandbox.__XTCE_content.getState().count,
    0,
    'the late restore must not merge the pre-clear body'
  );
  assert.deepEqual(storage.data.get('xtce_alice').records, []);
});

await test('a tab that missed onChanged still refuses to resurrect on flush', async () => {
  const storage = createFakeStorage({
    xtce_alice: {
      version: 2,
      username: 'alice',
      clearEpoch: 0,
      records: [makeRecord(1), makeRecord(2)]
    }
  });
  const tab = createContentHarnessWithStorage(storage, '/alice', '');
  await settle();
  assert.equal(tab.sandbox.__XTCE_content.getState().count, 2);

  // A stale batch is pending when another tab clears. This tab is frozen, so
  // it never sees chrome.storage.onChanged.
  tab.emit('message', tweetMessage([makeRecord(3)]));
  await settle();
  await storage.set('xtce_alice', {
    version: 2,
    username: 'alice',
    clearEpoch: 1,
    records: []
  });
  await tab.sandbox.__XTCE_content.flush();

  const stored = storage.data.get('xtce_alice');
  assert.deepEqual(stored.records, [], 'the stale flush must not paste 1-3 back');
  assert.equal(stored.clearEpoch, 1);
  assert.equal(tab.sandbox.__XTCE_content.getState().count, 0);
});

await test('content collector surfaces a peer-origin writer conflict', async () => {
  const harness = createContentHarness();
  await settle();
  const storeApi = harness.sandbox.__XTCE_store;
  const peerKey = storeApi.coordinationKey('https://twitter.com', 'alice');
  harness.storage.data.set(peerKey, {
    origin: 'https://twitter.com',
    username: 'alice',
    at: Date.now(),
    expiresAt: Date.now() + 60000
  });

  harness.emit('message', tweetMessage([makeRecord(1)]));
  await settle();
  await assert.rejects(
    harness.sandbox.__XTCE_content.flush(),
    (error) => error && error.code === 'XTCE_CROSS_ORIGIN_BUSY'
  );
  const error = harness.sandbox.__XTCE_content.getLastError();
  assert.equal(error.code, 'XTCE_CROSS_ORIGIN_BUSY');
  assert.match(error.message, /twitter\.com/);
  assert.equal(
    harness.storage.data.has('xtce_alice'),
    false,
    'the snapshot must not be written while a peer origin may own it'
  );
});

/* -------------------------------------------------------------------------
 * Two-world ordering and attribution regressions (review items 1 and 2)
 * ---------------------------------------------------------------------- */

await test('early timeline batches are replayed when the collector loads later', async () => {
  let call = 0;
  const harness = createTwoWorldHarness({
    fetch: () => {
      call += 1;
      const payload =
        call === 1
          ? makeInterceptFixture('alice', '1001')
          : makeInterceptFixture('alice', '1002');
      return Promise.resolve(makeResponse(payload));
    }
  });
  harness.loadInterceptor();
  await harness.main.fetch('https://x.com/i/api/graphql/abc/UserTweets');
  await harness.main.fetch(
    'https://x.com/i/api/graphql/abc/UserTweetsAndReplies'
  );
  await harness.settle();
  assert.equal(
    harness.tweetMessages().length,
    0,
    'the interceptor must buffer while the collector is absent'
  );

  harness.loadCollector();
  await harness.settle();
  await harness.settle();
  const state = harness.isolated.__XTCE_content.getState();
  assert.equal(state.username, 'alice');
  assert.equal(state.count, 2);
  assert.deepEqual(idsOf(state.records), ['1001', '1002']);
  await harness.isolated.__XTCE_content.flush();
  assert.equal(harness.storage.data.get('xtce_alice').records.length, 2);
});

await test('collector-first startup still receives a later interceptor batch', async () => {
  const harness = createTwoWorldHarness();
  harness.loadCollector();
  await harness.settle();
  harness.loadInterceptor();
  await harness.settle();
  await harness.main.fetch('https://x.com/i/api/graphql/abc/UserTweets');
  await harness.settle();
  const state = harness.isolated.__XTCE_content.getState();
  assert.equal(state.username, 'alice');
  assert.equal(state.count, 1);
});

await test('a delayed Alice response after navigating to Bob stays in the Alice bucket', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const harness = createTwoWorldHarness({ fetch: () => pending });
  harness.loadCollector();
  harness.loadInterceptor();
  await harness.settle();

  const response = harness.main.fetch(
    'https://x.com/i/api/graphql/abc/UserTweets'
  );
  await harness.settle();
  harness.navigate('/bob', '');
  // Deliberately do not run the 500 ms poll: the collector must use the
  // request-time route, not the route that is current at receipt.
  release(makeResponse(interceptFixture));
  await response;
  await harness.settle();
  await harness.isolated.__XTCE_content.flush();

  const alice = harness.storage.data.get('xtce_alice');
  assert.ok(alice, 'the Alice bucket must exist');
  assert.deepEqual(idsOf(alice.records), ['1001']);
  assert.equal(
    harness.storage.data.has('xtce_bob'),
    false,
    'Bob must not be polluted by a late Alice response'
  );
  assert.equal(
    harness.isolated.__XTCE_content.getState().username,
    'bob',
    'the live route is synced without waiting for the poll'
  );
});

await test('a response right after pushState lands in the new bucket', async () => {
  const harness = createTwoWorldHarness({
    pathname: '/alice',
    initialStorage: {
      xtce_bob: {
        version: 1,
        username: 'bob',
        records: [makeRecord(20, { author_username: 'bob' })]
      }
    },
    fetch: () => Promise.resolve(makeResponse(bobInterceptFixture))
  });
  harness.loadCollector();
  harness.loadInterceptor();
  await harness.settle();
  assert.equal(harness.isolated.__XTCE_content.getUsername(), 'alice');

  harness.navigate('/bob', '');
  // No interval call: the collector must catch up from the message itself.
  await harness.main.fetch('https://x.com/i/api/graphql/abc/UserTweets');
  await harness.settle();
  const state = harness.isolated.__XTCE_content.getState();
  assert.equal(state.username, 'bob');
  assert.equal(state.count, 2);
  assert.deepEqual(idsOf(state.records).sort(), ['20', '2001']);

  await harness.isolated.__XTCE_content.flush();
  assert.equal(harness.storage.data.get('xtce_bob').records.length, 2);
  assert.equal(harness.storage.data.has('xtce_alice'), false);
});

/* ------------------------------------------------------------------------- */

if (failures.length > 0) {
  console.error(
    'FAIL (' + failures.length + ' of ' + (groups + failures.length) + ' test groups failed)'
  );
  process.exitCode = 1;
} else {
  console.log('PASS (' + groups + ' test groups)');
}
