/*
 * S2 tests for the interceptor, pure store and isolated-world collector.
 *
 * Run with: node tests/collector.test.mjs
 *
 * Everything here is synthetic: a fake fetch/XHR, a fake chrome.storage.local
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

function createFakeStorage(initial) {
  const data = new Map();
  const calls = { get: [], set: [] };
  if (initial) {
    for (const key of Object.keys(initial)) {
      data.set(key, clone(initial[key]));
    }
  }
  return {
    data,
    calls,
    async get(key) {
      calls.get.push(key);
      return data.has(key) ? clone(data.get(key)) : undefined;
    },
    async set(key, value) {
      calls.set.push({ key, value: clone(value) });
      data.set(key, clone(value));
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
    async runAll() {
      while (pending.size > 0) {
        const entry = pending.entries().next().value;
        pending.delete(entry[0]);
        await entry[1].fn();
      }
    }
  };
}

function createStoreHarness(initialStorage, persistDelay) {
  const storage = createFakeStorage(initialStorage);
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
    clearTimeout: timers.clearTimeout
  });
  return { api, store, storage, timers, sandbox };
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

function fixtureTweetResult(id) {
  return {
    __typename: 'Tweet',
    rest_id: String(id),
    core: { user_results: { result: fixtureUser('alice') } },
    legacy: {
      id_str: String(id),
      created_at: 'Wed May 01 12:34:56 +0000 2024',
      full_text: 'tweet ' + id,
      entities: {}
    }
  };
}

const interceptFixture = {
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
                    entryId: 'tweet-1001',
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: {
                        itemType: 'TimelineTweet',
                        tweet_results: { result: fixtureTweetResult('1001') }
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
  const FakeXHR = createFakeXhrClass();
  const sandbox = {
    console,
    URL,
    location: { href: 'https://x.com/alice', origin: 'https://x.com' },
    XMLHttpRequest: FakeXHR,
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });
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
  return { sandbox, messages, FakeXHR };
}

/* -------------------------------------------------------------------------
 * Isolated-world collector harness: fake window, chrome.storage and clock
 * ---------------------------------------------------------------------- */

function createContentHarness(initialStorage, pathname, search) {
  const storage = createFakeStorage(initialStorage);
  const timers = createFakeScheduler();
  const listeners = Object.create(null);
  const intervals = [];
  const sandbox = {
    console,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval() {},
    chrome: {
      runtime: {},
      storage: {
        local: {
          get(key, callback) {
            storage.get(key).then(
              (value) => {
                const items = {};
                if (value !== undefined) {
                  items[key] = value;
                }
                callback(items);
              },
              () => callback({})
            );
          },
          set(items, callback) {
            const keys = Object.keys(items);
            storage.set(keys[0], items[keys[0]]).then(
              () => {
                if (callback) callback();
              },
              () => {
                if (callback) callback();
              }
            );
          }
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
    emit(type, event) {
      const list = (listeners[type] || []).slice();
      for (const listener of list) {
        listener.call(sandbox, event);
      }
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
  assert.equal(api.STORAGE_PREFIX, 'xtce_');
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
  assert.deepEqual(Array.from(state.records, (record) => record.id), ['1', '2']);
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
  assert.deepEqual(Array.from(state.records, (record) => String(record.id)), ['10', '11']);
  await store.switchUser('dave');
  state = store.getState();
  assert.equal(state.count, 1);
  assert.deepEqual(Array.from(state.records, (record) => record.id), ['12']);
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
  assert.equal(isolated.run_at, 'document_idle');

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
  assert.equal(messages.length, 1);
  assert.equal(messages[0].targetOrigin, 'https://x.com');
  assert.equal(messages[0].message.type, 'XTCE_TWEETS');
  assert.equal(messages[0].message.tweets.length, 1);
  assert.equal(messages[0].message.tweets[0].id, '1001');
});

await test('interceptor accepts URL and Request-like fetch inputs', async () => {
  const { sandbox, messages } = createInterceptorHarness();
  await sandbox.fetch(new URL('https://x.com/i/api/graphql/abc/UserTweets'));
  await sandbox.fetch({ url: 'https://x.com/i/api/graphql/abc/SearchTimeline' });
  await settle();
  assert.equal(messages.length, 2);
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
  assert.equal(messages.length, operations.length);

  const beforeIgnored = messages.length;
  await sandbox.fetch('https://x.com/i/api/graphql/abc/OtherTimeline');
  await sandbox.fetch('https://x.com/i/api/2/guide.json');
  await sandbox.fetch('https://x.com/normal/page');
  await sandbox.fetch('https://example.com/i/api/graphql/abc/UserTweets');
  await settle();
  assert.equal(messages.length, beforeIgnored);
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
  assert.equal(messages.length, 1);

  const jsonXhr = new sandbox.XMLHttpRequest();
  jsonXhr.open('POST', 'https://x.com/i/api/graphql/abc/SearchTimeline');
  jsonXhr.responseType = 'json';
  jsonXhr.send();
  jsonXhr.status = 200;
  jsonXhr.response = interceptFixture;
  jsonXhr.emit('load');
  await tick();
  assert.equal(messages.length, 2);
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

  assert.equal(messages.length, 0);
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
  assert.equal(badJson.messages.length, 0);

  const rejecting = createInterceptorHarness({
    fetch: () => Promise.reject(new Error('network'))
  });
  await assert.rejects(
    rejecting.sandbox.fetch('https://x.com/i/api/graphql/abc/UserTweets'),
    /network/
  );
  await settle();
  assert.equal(rejecting.messages.length, 0);

  const noParser = createInterceptorHarness({ withParser: false });
  const noParserResponse = await noParser.sandbox.fetch(
    'https://x.com/i/api/graphql/abc/UserTweets'
  );
  assert.ok(noParserResponse);
  await settle();
  assert.equal(noParser.messages.length, 0);
});

await test('interceptor installs only once', async () => {
  const { sandbox, messages } = createInterceptorHarness();
  assert.equal(sandbox.__XTCE_INTERCEPTOR__, true);
  vm.runInContext(interceptorSource, sandbox, { filename: 'src/interceptor.js' });
  await sandbox.fetch('https://x.com/i/api/graphql/abc/UserTweets');
  await settle();
  assert.equal(messages.length, 1);
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

  harness.emit('message', {
    origin: 'https://x.com',
    data: { type: 'XTCE_TWEETS', tweets: [makeRecord(1), makeRecord(2), makeRecord(2)] }
  });
  state = harness.sandbox.__XTCE_content.getState();
  assert.equal(state.count, 2);

  harness.emit('message', {
    origin: 'https://x.com',
    data: { type: 'XTCE_TWEETS', tweets: [makeRecord(2, { text: 'new' }), makeRecord(3)] }
  });
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
  assert.deepEqual(Array.from(state.records, (record) => record.id), ['50', '51']);
});

await test('content collector rejects wrong-origin, wrong-type and malformed messages', async () => {
  const harness = createContentHarness();
  await settle();
  harness.emit('message', {
    origin: 'https://evil.example',
    data: { type: 'XTCE_TWEETS', tweets: [makeRecord(1)] }
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
  await settle();
  assert.equal(harness.sandbox.__XTCE_content.getState().count, 0);
});

await test('content collector switches and restores per-user buckets on SPA navigation', async () => {
  const harness = createContentHarness({
    xtce_bob: { version: 1, username: 'bob', records: [makeRecord(20)] }
  });
  await settle();
  harness.emit('message', {
    origin: 'https://x.com',
    data: { type: 'XTCE_TWEETS', tweets: [makeRecord(1)] }
  });
  assert.equal(harness.sandbox.__XTCE_content.getState().count, 1);

  harness.sandbox.location.pathname = '/bob';
  harness.sandbox.location.search = '';
  harness.intervals[0].fn();
  await settle();
  let state = harness.sandbox.__XTCE_content.getState();
  assert.equal(state.username, 'bob');
  assert.equal(state.count, 1);
  assert.deepEqual(Array.from(state.records, (record) => record.id), ['20']);

  harness.emit('message', {
    origin: 'https://x.com',
    data: { type: 'XTCE_TWEETS', tweets: [makeRecord(21)] }
  });
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
  search.emit('message', {
    origin: 'https://x.com',
    data: { type: 'XTCE_TWEETS', tweets: [makeRecord(30)] }
  });
  assert.equal(search.sandbox.__XTCE_content.getState().count, 1);
  await search.sandbox.__XTCE_content.flush();
  assert.equal(search.storage.data.get('xtce_alice').records.length, 1);

  const home = createContentHarness({}, '/home', '');
  await settle();
  assert.equal(home.sandbox.__XTCE_content.getState().username, null);
  home.emit('message', {
    origin: 'https://x.com',
    data: { type: 'XTCE_TWEETS', tweets: [makeRecord(40)] }
  });
  assert.equal(home.sandbox.__XTCE_content.getState().count, 0);
});

await test('content collector flushes on pagehide and clearCurrent empties the bucket', async () => {
  const harness = createContentHarness();
  await settle();
  harness.emit('message', {
    origin: 'https://x.com',
    data: { type: 'XTCE_TWEETS', tweets: [makeRecord(1), makeRecord(2)] }
  });
  assert.equal(harness.storage.data.has('xtce_alice'), false);
  harness.emit('pagehide', {});
  await settle();
  assert.equal(harness.storage.data.get('xtce_alice').records.length, 2);

  await harness.sandbox.__XTCE_content.clearCurrent();
  assert.equal(harness.sandbox.__XTCE_content.getState().count, 0);
  assert.equal(harness.storage.data.get('xtce_alice').records.length, 0);
});

await test('content collector exposes getState/subscribe for S3', async () => {
  const harness = createContentHarness();
  await settle();
  const api = harness.sandbox.__XTCE_content;
  assert.equal(typeof api.getState, 'function');
  assert.equal(typeof api.subscribe, 'function');
  const seen = [];
  const unsubscribe = api.subscribe((state) => {
    seen.push(state.count);
  });
  harness.emit('message', {
    origin: 'https://x.com',
    data: { type: 'XTCE_TWEETS', tweets: [makeRecord(1)] }
  });
  assert.deepEqual(seen, [1]);
  unsubscribe();
  harness.emit('message', {
    origin: 'https://x.com',
    data: { type: 'XTCE_TWEETS', tweets: [makeRecord(2)] }
  });
  assert.equal(seen.length, 1);
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
