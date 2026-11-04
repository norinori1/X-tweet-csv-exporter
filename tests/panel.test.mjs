/*
 * S3 tests for src/panel.js (panel UI, auto-scroll, CSV/JSON export, clear).
 *
 * Run with: node tests/panel.test.mjs
 *
 * Everything is synthetic: a minimal fake DOM, a fake clock and the same fake
 * S2 content API shape that src/content.js exposes. No network, no browser.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const csvSource = readFileSync(new URL('../src/csv.js', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/panel.js', import.meta.url), 'utf8');
const panelCss = readFileSync(new URL('../src/panel.css', import.meta.url), 'utf8');
const manifest = JSON.parse(
  readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')
);

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

/* -------------------------------------------------------------------------
 * Fake DOM (only the API surface src/panel.js uses)
 * ---------------------------------------------------------------------- */

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = Object.create(null);
    this.listeners = Object.create(null);
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.id = '';
    this.href = '';
    this.download = '';
    this.type = '';
    this.clicks = 0;
    this.scrollHeight = 0;
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener(type, listener) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
  }

  removeEventListener(type, listener) {
    const list = this.listeners[type] || [];
    const index = list.indexOf(listener);
    if (index !== -1) {
      list.splice(index, 1);
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'hidden') {
      this.hidden = true;
    }
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  click() {
    this.clicks += 1;
    const list = (this.listeners.click || []).slice();
    for (const listener of list) {
      listener.call(this, {
        type: 'click',
        target: this,
        preventDefault() {}
      });
    }
  }
}

function createFakeDocument() {
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');
  body.scrollHeight = 5000;
  documentElement.scrollHeight = 5000;
  const listeners = Object.create(null);
  return {
    readyState: 'loading',
    body,
    documentElement,
    listeners,
    createElement(tag) {
      const element = new FakeElement(tag);
      if (element.tagName === 'A') {
        // Object URLs and filenames stay inspectable on the anchor.
        this.lastAnchor = element;
      }
      return element;
    },
    addEventListener(type, listener) {
      if (!listeners[type]) {
        listeners[type] = [];
      }
      listeners[type].push(listener);
    },
    removeEventListener(type, listener) {
      const list = listeners[type] || [];
      const index = list.indexOf(listener);
      if (index !== -1) {
        list.splice(index, 1);
      }
    },
    fire(type, event) {
      const list = (listeners[type] || []).slice();
      for (const listener of list) {
        listener.call(this, event || { type });
      }
    }
  };
}

/* -------------------------------------------------------------------------
 * Fake clock
 * ---------------------------------------------------------------------- */

function createFakeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  function setTimeout(fn, ms) {
    const id = nextId;
    nextId += 1;
    timers.set(id, {
      fn,
      at: now + Math.max(0, Number(ms) || 0)
    });
    return id;
  }

  function clearTimeout(id) {
    timers.delete(id);
  }

  function advance(ms) {
    const target = now + Math.max(0, Number(ms) || 0);
    let guard = 0;
    while (guard < 10000) {
      guard += 1;
      let chosenId = null;
      let chosen = null;
      for (const [id, timer] of timers) {
        if (timer.at > target) {
          continue;
        }
        if (
          !chosen ||
          timer.at < chosen.at ||
          (timer.at === chosen.at && id < chosenId)
        ) {
          chosen = timer;
          chosenId = id;
        }
      }
      if (!chosen) {
        break;
      }
      timers.delete(chosenId);
      now = chosen.at;
      chosen.fn();
    }
    now = target;
  }

  return {
    setTimeout,
    clearTimeout,
    advance,
    pending() {
      return timers.size;
    },
    now() {
      return now;
    }
  };
}

/* -------------------------------------------------------------------------
 * Fake S2 content API
 * ---------------------------------------------------------------------- */

function makeRecord(id, iso, extra) {
  return Object.assign(
    {
      id: String(id),
      created_at_iso: iso,
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

function createFakeContent(initialState) {
  const state = Object.assign(
    {
      username: 'alice',
      count: 2,
      records: [
        makeRecord('2', '2024-05-02T12:00:00.000Z'),
        makeRecord('1', '2024-05-01T12:00:00.000Z')
      ],
      error: null
    },
    initialState || {}
  );
  if (!state.error) {
    state.error = null;
  }
  const listeners = new Set();
  const calls = { clear: 0, subscribe: 0, unsubscribe: 0 };
  let clearFailure = null;

  const api = {
    calls,
    getState() {
      return state;
    },
    getUsername() {
      return state.username;
    },
    subscribe(listener) {
      calls.subscribe += 1;
      listeners.add(listener);
      return function () {
        calls.unsubscribe += 1;
        listeners.delete(listener);
      };
    },
    clearCurrent() {
      calls.clear += 1;
      if (clearFailure) {
        return Promise.reject(clearFailure);
      }
      state.count = 0;
      state.records = [];
      api.set({});
      return Promise.resolve();
    },
    flush() {
      return Promise.resolve();
    },
    getLastError() {
      return state.error;
    },
    clearError() {
      state.error = null;
    },
    set(next) {
      Object.assign(state, next || {});
      for (const listener of Array.from(listeners)) {
        listener(state);
      }
    },
    failClear(error) {
      clearFailure = error;
    }
  };
  return api;
}

/* -------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------- */

function createPanelHarness(options) {
  const opts = options || {};
  const doc = createFakeDocument();
  const timers = createFakeScheduler();
  const content = opts.content || createFakeContent(opts.initialState);
  const scrolls = [];
  const blobs = [];
  const objectUrls = [];
  let urlSeq = 0;

  class FakeBlob {
    constructor(parts, blobOptions) {
      this.parts = parts;
      this.type = blobOptions && blobOptions.type;
    }
    text() {
      return this.parts.join('');
    }
  }

  const sandbox = {
    console,
    document: doc,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    Blob: FakeBlob,
    URL: {
      createObjectURL(blob) {
        urlSeq += 1;
        const url = 'blob:fake-' + urlSeq;
        objectUrls.push(url);
        blobs.push(blob);
        return url;
      },
      revokeObjectURL(url) {
        objectUrls.push('revoked:' + url);
      }
    },
    location: { pathname: '/alice', search: '', origin: 'https://x.com' },
    addEventListener() {},
    removeEventListener() {},
    scrollTo(x, y) {
      scrolls.push({ x, y });
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(csvSource, sandbox, { filename: 'src/csv.js' });
  sandbox.__XTCE_content = content;
  vm.runInContext(panelSource, sandbox, { filename: 'src/panel.js' });

  const panelApi = sandbox.__XTCE_panel;
  const fixedNow = opts.now || new Date(2024, 4, 1, 12, 34, 56);

  function mount(overrides) {
    return panelApi.createPanel(
      Object.assign(
        {
          document: doc,
          window: sandbox,
          content,
          csv: sandbox.__XTCE_csv,
          now: function () {
            return fixedNow;
          },
          setTimeout: timers.setTimeout,
          clearTimeout: timers.clearTimeout
        },
        overrides || {}
      )
    );
  }

  return {
    doc,
    timers,
    content,
    sandbox,
    panelApi,
    scrolls,
    blobs,
    objectUrls,
    mount,
    anchors() {
      return doc.body.children.filter((node) => node.tagName === 'A');
    }
  };
}

function flushPromises() {
  return Promise.resolve()
    .then(() => {})
    .then(() => {})
    .then(() => {});
}

const STATUS = {
  idle: '待機中',
  scrolling: '自動スクロール中…',
  slowing: '応答がありません。間隔を延ばして再試行しています…',
  stopped: '停止しました',
  ended: 'タイムラインの末尾、またはレート制限の可能性があります'
};

/* -------------------------------------------------------------------------
 * Panel rendering / collapse
 * ---------------------------------------------------------------------- */

await test('panel mounts bottom-right with username, count, status and five controls', () => {
  const h = createPanelHarness();
  const panel = h.mount();
  assert.ok(panel, 'panel must mount with the S2 API and csv builder');
  assert.equal(h.doc.body.children.length, 1);
  assert.equal(panel.element.id, 'xtce-panel');
  assert.equal(panel.element.getAttribute('role'), 'region');
  assert.equal(panel.userValue.textContent, '@alice');
  assert.equal(panel.countValue.textContent, '2');
  assert.equal(panel.statusEl.textContent, STATUS.idle);
  assert.equal(panel.statusEl.getAttribute('role'), 'status');

  const actions = panel.buttons;
  for (const key of ['start', 'stop', 'csv', 'json', 'clear', 'collapse']) {
    assert.ok(actions[key], key + ' control must exist');
  }
  assert.equal(actions.start.disabled, false);
  assert.equal(actions.stop.disabled, true);
  assert.equal(actions.start.getAttribute('data-action'), 'scroll');
  assert.equal(actions.clear.getAttribute('data-action'), 'clear');
  assert.equal(h.content.calls.subscribe, 1);
});

await test('panel is collapsible and restores its body', () => {
  const h = createPanelHarness();
  const panel = h.mount();
  assert.equal(panel.isCollapsed(), false);
  assert.equal(panel.body.hidden, false);

  panel.buttons.collapse.click();
  assert.equal(panel.isCollapsed(), true);
  assert.equal(panel.body.hidden, true);
  assert.equal(panel.element.getAttribute('data-collapsed'), 'true');
  assert.equal(panel.buttons.collapse.getAttribute('aria-expanded'), 'false');

  panel.buttons.collapse.click();
  assert.equal(panel.isCollapsed(), false);
  assert.equal(panel.body.hidden, false);
  assert.equal(panel.element.getAttribute('data-collapsed'), 'false');
});

await test('panel follows content state updates and shows storage errors', () => {
  const h = createPanelHarness();
  const panel = h.mount();
  h.content.set({
    username: 'bob',
    count: 7,
    records: [],
    error: {
      message: 'storage write failed',
      operation: 'commit',
      username: 'bob',
      at: '2024-05-01T00:00:00.000Z',
      code: 'XTCE_COORDINATION_UNAVAILABLE'
    }
  });
  assert.equal(panel.userValue.textContent, '@bob');
  assert.equal(panel.countValue.textContent, '7');
  assert.equal(panel.statusEl.getAttribute('data-tone'), 'error');
  assert.ok(panel.statusEl.textContent.startsWith('保存エラー: storage write failed'));
  assert.ok(panel.statusEl.textContent.includes('XTCE_COORDINATION_UNAVAILABLE'));

  h.content.set({ error: null });
  assert.equal(panel.statusEl.textContent, STATUS.idle);
  assert.equal(panel.statusEl.getAttribute('data-tone'), 'muted');
});

/* -------------------------------------------------------------------------
 * Auto-scroll
 * ---------------------------------------------------------------------- */

await test('auto-scroll ticks every 1.8s and scrolls to the bottom', () => {
  const h = createPanelHarness();
  const panel = h.mount();
  panel.buttons.start.click();

  assert.equal(panel.auto.isRunning(), true);
  assert.equal(panel.buttons.start.disabled, true);
  assert.equal(panel.buttons.stop.disabled, false);
  assert.equal(panel.statusEl.textContent, STATUS.scrolling);
  assert.deepEqual(h.scrolls[0], { x: 0, y: 5000 });
  assert.equal(h.timers.pending(), 1);

  h.timers.advance(1800);
  assert.equal(h.scrolls.length, 2);
  assert.equal(h.timers.now(), 1800);

  panel.buttons.stop.click();
  assert.equal(panel.auto.isRunning(), false);
  assert.equal(panel.buttons.stop.disabled, true);
  assert.equal(panel.statusEl.textContent, STATUS.stopped);
  assert.equal(h.timers.pending(), 0);
});

await test('auto-scroll slows after 6 stalled checks and stops after slow retries', () => {
  const h = createPanelHarness();
  const panel = h.mount();
  panel.buttons.start.click();

  // Five no-growth ticks keep the fast interval.
  h.timers.advance(1800 * 5);
  assert.equal(panel.auto.isRunning(), true);
  assert.equal(panel.statusEl.textContent, STATUS.scrolling);

  // The sixth no-growth check switches to the slower retry interval.
  h.timers.advance(1800);
  assert.equal(panel.statusEl.textContent, STATUS.slowing);
  assert.equal(panel.auto.isRunning(), true);

  // Two slow retries are still running; the third stops.
  h.timers.advance(5000 * 2);
  assert.equal(panel.auto.isRunning(), true);
  h.timers.advance(5000);
  assert.equal(panel.auto.isRunning(), false);
  assert.equal(panel.statusEl.textContent, STATUS.ended);
  assert.equal(h.timers.pending(), 0);
  assert.equal(panel.buttons.stop.disabled, true);
  assert.equal(panel.buttons.start.disabled, false);
});

await test('count growth resets the stall counter and resumes the fast interval', () => {
  const h = createPanelHarness();
  const panel = h.mount();
  panel.buttons.start.click();

  h.timers.advance(1800 * 5);
  h.content.set({ count: 3 });
  h.timers.advance(1800);
  assert.equal(panel.statusEl.textContent, STATUS.scrolling);

  // The counter was reset: five more stalled ticks still do not slow down.
  h.timers.advance(1800 * 5);
  assert.equal(panel.statusEl.textContent, STATUS.scrolling);
  h.timers.advance(1800);
  assert.equal(panel.statusEl.textContent, STATUS.slowing);
});

await test('auto-scroll stops when the profile changes', () => {
  const h = createPanelHarness();
  const panel = h.mount();
  panel.buttons.start.click();
  assert.equal(panel.auto.isRunning(), true);

  h.content.set({ username: 'bob', count: 0, records: [] });
  assert.equal(panel.auto.isRunning(), false);
  assert.equal(panel.buttons.stop.disabled, true);
  assert.equal(panel.statusEl.textContent, 'ユーザーが切り替わったため自動スクロールを停止しました');
});

await test('start is refused on non-profile pages', () => {
  const h = createPanelHarness({
    initialState: { username: null, count: 0, records: [], error: null }
  });
  const panel = h.mount();
  assert.equal(panel.buttons.start.disabled, true);
  panel.buttons.start.click();
  assert.equal(panel.auto.isRunning(), false);
  assert.equal(h.timers.pending(), 0);
  assert.equal(panel.statusEl.textContent, 'プロフィールページを開いてください。');
});

/* -------------------------------------------------------------------------
 * Downloads
 * ---------------------------------------------------------------------- */

await test('CSV download sorts ascending, keeps BOM and names the file', () => {
  const h = createPanelHarness();
  const panel = h.mount();
  panel.buttons.csv.click();

  assert.equal(h.blobs.length, 1);
  const blob = h.blobs[0];
  assert.equal(blob.type, 'text/csv;charset=utf-8');
  const text = blob.text();
  assert.ok(text.startsWith('\uFEFF'));
  const rows = text.slice(1).split('\r\n');
  assert.ok(rows[0].startsWith('id,created_at_iso,text,url,author_username'));
  assert.ok(rows[1].startsWith('1,2024-05-01T12:00:00.000Z'));
  assert.ok(rows[2].startsWith('2,2024-05-02T12:00:00.000Z'));

  const anchors = h.anchors();
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].clicks, 1);
  assert.equal(anchors[0].download, 'tweets_alice_2024-05-01-123456.csv');
  assert.ok(anchors[0].href.startsWith('blob:'));
  assert.ok(panel.statusEl.textContent.includes('ダウンロードしました'));

  h.timers.advance(1000);
  assert.ok(h.objectUrls.includes('revoked:blob:fake-1'));
  assert.equal(h.anchors().length, 0);
});

await test('JSON download writes the same ascending order and .json name', () => {
  const h = createPanelHarness();
  const panel = h.mount();
  panel.buttons.json.click();

  assert.equal(h.blobs.length, 1);
  const blob = h.blobs[0];
  assert.equal(blob.type, 'application/json;charset=utf-8');
  const parsed = JSON.parse(blob.text());
  assert.deepEqual(
    parsed.map((record) => record.id),
    ['1', '2']
  );
  assert.equal(h.anchors()[0].download, 'tweets_alice_2024-05-01-123456.json');
});

await test('empty export reports that there is nothing to download', () => {
  const h = createPanelHarness({
    initialState: { username: 'alice', count: 0, records: [], error: null }
  });
  const panel = h.mount();
  panel.buttons.csv.click();
  panel.buttons.json.click();
  assert.equal(h.blobs.length, 0);
  assert.equal(h.anchors().length, 0);
  assert.equal(panel.statusEl.textContent, 'ダウンロードできるツイートがありません');
});

await test('download failures are surfaced in the status line', () => {
  const h = createPanelHarness();
  const panel = h.mount();
  h.sandbox.URL.createObjectURL = function () {
    throw new Error('object URL blocked');
  };
  panel.buttons.csv.click();
  assert.ok(panel.statusEl.textContent.startsWith('ダウンロードに失敗しました'));
  assert.ok(panel.statusEl.textContent.includes('object URL blocked'));
  assert.equal(panel.statusEl.getAttribute('data-tone'), 'error');
});

/* -------------------------------------------------------------------------
 * Clear
 * ---------------------------------------------------------------------- */

await test('clear empties the current bucket immediately and reports success', async () => {
  const h = createPanelHarness();
  const panel = h.mount();
  panel.buttons.clear.click();
  assert.equal(h.content.calls.clear, 1);
  assert.equal(panel.countValue.textContent, '0');
  assert.equal(panel.statusEl.textContent, 'クリアしています…');

  await flushPromises();
  assert.equal(panel.statusEl.textContent, 'クリアしました（@alice）');
  assert.equal(panel.statusEl.getAttribute('data-tone'), 'ok');
});

await test('clear failure is surfaced without claiming success', async () => {
  const h = createPanelHarness();
  const panel = h.mount();
  h.content.failClear(new Error('quota exceeded'));
  panel.buttons.clear.click();
  await flushPromises();
  assert.ok(panel.statusEl.textContent.startsWith('クリアに失敗しました'));
  assert.ok(panel.statusEl.textContent.includes('quota exceeded'));
  assert.equal(panel.statusEl.getAttribute('data-tone'), 'error');
});

/* -------------------------------------------------------------------------
 * Helpers, boot and safety properties
 * ---------------------------------------------------------------------- */

await test('filename helpers handle @, invalid characters and unknown users', () => {
  const h = createPanelHarness();
  const date = new Date(2024, 0, 2, 3, 4, 5);
  assert.equal(h.panelApi.formatTimestamp(date), '2024-01-02-030405');
  assert.equal(
    h.panelApi.buildFilename('@alice', date, 'csv'),
    'tweets_alice_2024-01-02-030405.csv'
  );
  assert.equal(
    h.panelApi.buildFilename('a/b c', date, 'json'),
    'tweets_abc_2024-01-02-030405.json'
  );
  assert.equal(
    h.panelApi.buildFilename(null, date, 'csv'),
    'tweets_unknown_2024-01-02-030405.csv'
  );
});

await test('sortRecordsAsc keeps records ordered by created_at_iso', () => {
  const h = createPanelHarness();
  const sorted = h.panelApi.sortRecordsAsc([
    { id: '3', created_at_iso: '2024-05-03T00:00:00.000Z' },
    { id: '1', created_at_iso: '2024-05-01T00:00:00.000Z' },
    { id: '2', created_at_iso: '2024-05-02T00:00:00.000Z' }
  ]);
  assert.deepEqual(
    sorted.map((record) => record.id),
    ['1', '2', '3']
  );
});

await test('boot() mounts after DOMContentLoaded with the page APIs', () => {
  const h = createPanelHarness();
  assert.equal(h.doc.body.children.length, 0, 'document_start must not mount yet');
  assert.equal(h.doc.listeners.DOMContentLoaded.length, 1);
  h.doc.fire('DOMContentLoaded');
  assert.equal(h.doc.body.children.length, 1);
  assert.equal(h.doc.body.children[0].id, 'xtce-panel');
});

await test('panel code is storage-free, XSS-free and CSS is scoped/above the page', () => {
  assert.ok(
    !panelSource.includes('chrome.storage.local.set'),
    'panel must not write storage directly'
  );
  assert.ok(
    !panelSource.includes('chrome.storage.local.get'),
    'panel must not read storage directly'
  );
  assert.ok(!panelSource.includes('innerHTML'), 'panel must not inject HTML strings');
  assert.ok(panelCss.includes('#xtce-panel {'));
  assert.ok(panelCss.includes('position: fixed'));
  assert.ok(panelCss.includes('z-index: 2147483647'));
  assert.ok(!/inset:\s*0/.test(panelCss), 'no full-screen overlay');
  assert.ok(!/width:\s*100vw/.test(panelCss), 'no full-viewport box');
  assert.deepEqual(manifest.content_scripts[1].css, ['src/panel.css']);
  assert.deepEqual(manifest.permissions, ['storage']);
});

console.log('');
if (failures.length > 0) {
  console.error('FAIL (' + failures.length + ' of ' + (groups + failures.length) + ' test groups)');
  process.exitCode = 1;
} else {
  console.log('PASS (' + groups + ' test groups)');
}
