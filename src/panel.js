/*
 * X Tweet CSV Exporter (Local) — S3 floating panel, auto-scroll and export.
 *
 * Loaded in the ISOLATED world after src/csv.js, src/store.js and
 * src/content.js (see manifest.json). It reads the S2 API on
 * globalThis.__XTCE_content and the shared CSV builder on
 * globalThis.__XTCE_csv; it never talks to chrome.storage.local directly.
 *
 * Behaviour:
 *   - fixed bottom-right panel, collapsible, shows @username, count and status;
 *   - auto-scroll scrolls to the bottom every ~1.8 s. After 6 consecutive
 *     checks without a new record it retries more slowly (every 5 s, 3 times)
 *     and then stops with "end of timeline or rate limit";
 *   - CSV/JSON downloads go through a Blob + hidden anchor click. CSV rows are
 *     sorted by created_at_iso ascending and serialized by the same builder
 *     the parser tests cover (src/csv.js);
 *   - clear empties the current user's memory bucket immediately and reports
 *     success only after the service-worker commit resolves.
 *
 * Loaded at document_start, so the DOM is built on DOMContentLoaded. The whole
 * file is defensive: a missing S2 API or a page that freezes the window must
 * never break x.com.
 *
 * Test hook (not used by the page): globalThis.__XTCE_panel exposes the same
 * factories with injected document/window/content/csv/timers so
 * tests/panel.test.mjs can drive it in Node's vm without a browser.
 */
(function () {
  'use strict';

  var win = typeof window !== 'undefined' ? window : null;
  var root = typeof globalThis !== 'undefined' ? globalThis : win;
  if (!win || !root) {
    return;
  }

  var DEFAULTS = {
    scrollIntervalMs: 1800,
    stallChecks: 6,
    slowRetryMs: 5000,
    slowChecks: 3
  };

  var STATUS = {
    idle: '待機中',
    scrolling: '自動スクロール中…',
    slowing: '応答がありません。間隔を延ばして再試行しています…',
    stopped: '停止しました',
    ended: 'タイムラインの末尾、またはレート制限の可能性があります',
    waiting: 'プロフィールページを開いてください。',
    empty: 'ダウンロードできるツイートがありません',
    clearing: 'クリアしています…',
    cleared: 'クリアしました',
    clearFailed: 'クリアに失敗しました',
    downloadFailed: 'ダウンロードに失敗しました',
    userChanged: 'ユーザーが切り替わったため自動スクロールを停止しました'
  };

  function noop() {}

  function messageOf(error) {
    if (!error) {
      return 'unknown error';
    }
    return error.message ? String(error.message) : String(error);
  }

  function numberOrZero(value) {
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : 0;
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function toDate(value) {
    if (value && typeof value.getTime === 'function') {
      return value;
    }
    return new Date(value);
  }

  /** `yyyy-mm-dd-hhmmss` in the browser's local timezone. */
  function formatTimestamp(date) {
    var value = toDate(date);
    if (!isFinite(value.getTime())) {
      value = new Date();
    }
    return (
      value.getFullYear() +
      '-' +
      pad2(value.getMonth() + 1) +
      '-' +
      pad2(value.getDate()) +
      '-' +
      pad2(value.getHours()) +
      pad2(value.getMinutes()) +
      pad2(value.getSeconds())
    );
  }

  /** X usernames are [A-Za-z0-9_]; fall back to a stable placeholder. */
  function sanitizeUsername(username) {
    var text = String(username === undefined || username === null ? '' : username);
    if (text.charAt(0) === '@') {
      text = text.slice(1);
    }
    var safe = text.replace(/[^A-Za-z0-9_]/g, '');
    return safe || 'unknown';
  }

  function buildFilename(username, date, extension) {
    return (
      'tweets_' +
      sanitizeUsername(username) +
      '_' +
      formatTimestamp(date) +
      '.' +
      String(extension || 'csv').replace(/[^a-z0-9]/gi, '')
    );
  }

  /**
   * Stable ascending sort by created_at_iso. ISO-8601 UTC strings compare
   * lexicographically, which is also chronological. Missing values sort first.
   */
  function sortRecordsAsc(records) {
    if (!Array.isArray(records)) {
      return [];
    }
    return records.slice().sort(function (left, right) {
      var a =
        left && typeof left.created_at_iso === 'string'
          ? left.created_at_iso
          : '';
      var b =
        right && typeof right.created_at_iso === 'string'
          ? right.created_at_iso
          : '';
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      return 0;
    });
  }

  /**
   * Auto-scroll controller with stall detection.
   *
   * Each tick reads the current record count, scrolls to the bottom and
   * schedules the next tick. A tick whose count is not greater than the
   * previous tick's count is a "no growth" check:
   *   - fast phase: 6 consecutive no-growth checks -> slow phase;
   *   - slow phase: retries every `slowRetryMs`; after `slowChecks` more
   *     no-growth checks it stops with STATUS.ended. Growth at any point
   *     resets the counters (and returns to the fast interval).
   *
   * Timers, scroll and count are injected so tests can use a fake clock.
   */
  function createAutoScroller(options) {
    var opts = options || {};
    var intervalMs =
      opts.intervalMs > 0 ? opts.intervalMs : DEFAULTS.scrollIntervalMs;
    var slowRetryMs =
      opts.slowRetryMs > 0 ? opts.slowRetryMs : DEFAULTS.slowRetryMs;
    var stallChecks =
      opts.stallChecks > 0 ? opts.stallChecks : DEFAULTS.stallChecks;
    var slowChecks =
      opts.slowChecks > 0 ? opts.slowChecks : DEFAULTS.slowChecks;
    var setTimer =
      typeof opts.setTimeout === 'function'
        ? opts.setTimeout
        : function (fn, ms) {
            return win.setTimeout(fn, ms);
          };
    var clearTimer =
      typeof opts.clearTimeout === 'function'
        ? opts.clearTimeout
        : function (id) {
            win.clearTimeout(id);
          };
    var getCount =
      typeof opts.getCount === 'function'
        ? opts.getCount
        : function () {
            return 0;
          };
    var scrollToBottom =
      typeof opts.scrollToBottom === 'function' ? opts.scrollToBottom : noop;
    var onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : noop;

    var timer = null;
    var running = false;
    var slow = false;
    var lastCount = 0;
    var noGrowth = 0;
    var slowNoGrowth = 0;

    function clearScheduled() {
      if (timer !== null) {
        try {
          clearTimer(timer);
        } catch (error) {
          /* A frozen window must not keep the controller stuck. */
        }
        timer = null;
      }
    }

    function schedule(delay) {
      clearScheduled();
      if (!running) {
        return;
      }
      timer = setTimer(tick, delay);
    }

    function tick() {
      timer = null;
      if (!running) {
        return;
      }
      var count = numberOrZero(getCount());
      var grew = count > lastCount;
      lastCount = count;

      if (grew) {
        noGrowth = 0;
        slowNoGrowth = 0;
        if (slow) {
          slow = false;
          onStatus(STATUS.scrolling, 'info');
        }
      } else if (!slow) {
        noGrowth += 1;
        if (noGrowth >= stallChecks) {
          slow = true;
          slowNoGrowth = 0;
          onStatus(STATUS.slowing, 'warn');
        }
      } else {
        slowNoGrowth += 1;
        if (slowNoGrowth >= slowChecks) {
          running = false;
          clearScheduled();
          onStatus(STATUS.ended, 'warn');
          return;
        }
      }

      scrollToBottom();
      schedule(slow ? slowRetryMs : intervalMs);
    }

    function start() {
      if (running) {
        return;
      }
      running = true;
      slow = false;
      lastCount = numberOrZero(getCount());
      noGrowth = 0;
      slowNoGrowth = 0;
      onStatus(STATUS.scrolling, 'info');
      scrollToBottom();
      schedule(intervalMs);
    }

    function stop(reason) {
      if (!running) {
        return;
      }
      running = false;
      clearScheduled();
      onStatus(reason || STATUS.stopped, 'muted');
    }

    function isRunning() {
      return running;
    }

    function dispose() {
      running = false;
      clearScheduled();
    }

    return {
      start: start,
      stop: stop,
      isRunning: isRunning,
      dispose: dispose
    };
  }

  function createElement(doc, tag, className, text) {
    var node = doc.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = String(text);
    }
    return node;
  }

  /**
   * Build and mount the panel. Returns a controller, or null when the S2/S3
   * APIs or the document are unavailable.
   */
  function createPanel(options) {
    var opts = options || {};
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var content = opts.content || root.__XTCE_content || null;
    var csv = opts.csv || root.__XTCE_csv || null;
    if (
      !doc ||
      typeof doc.createElement !== 'function' ||
      !content ||
      typeof content.getState !== 'function' ||
      typeof content.subscribe !== 'function' ||
      typeof content.clearCurrent !== 'function' ||
      !csv ||
      typeof csv.toCSV !== 'function'
    ) {
      return null;
    }

    var view = opts.window || win;
    var now = typeof opts.now === 'function' ? opts.now : function () {
      return new Date();
    };
    var BlobCtor = opts.Blob || (view && view.Blob);
    var urlApi = opts.URL || (view && view.URL);
    var setTimer =
      typeof opts.setTimeout === 'function'
        ? opts.setTimeout
        : function (fn, ms) {
            return view.setTimeout(fn, ms);
          };
    var clearTimer =
      typeof opts.clearTimeout === 'function'
        ? opts.clearTimeout
        : function (id) {
            view.clearTimeout(id);
          };
    var scrollToBottom =
      typeof opts.scrollToBottom === 'function'
        ? opts.scrollToBottom
        : function () {
            try {
              var docEl = doc.documentElement || {};
              var bodyEl = doc.body || {};
              var height = Math.max(
                numberOrZero(docEl.scrollHeight),
                numberOrZero(bodyEl.scrollHeight)
              );
              if (typeof view.scrollTo === 'function') {
                view.scrollTo(0, height);
              } else if (doc.scrollingElement) {
                doc.scrollingElement.scrollTop = height;
              }
            } catch (error) {
              /* Scrolling must not break the page. */
            }
          };

    var panel = createElement(doc, 'div', 'xtce-panel');
    panel.id = 'xtce-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'X Tweet CSV Exporter');
    panel.setAttribute('data-collapsed', 'false');

    var header = createElement(doc, 'div', 'xtce-header');
    var title = createElement(doc, 'span', 'xtce-title', 'X Tweet CSV Exporter');
    var collapse = createElement(doc, 'button', 'xtce-collapse', '▾');
    collapse.type = 'button';
    collapse.setAttribute('aria-label', 'パネルを折りたたむ');
    collapse.setAttribute('aria-expanded', 'true');
    collapse.setAttribute('title', '折りたたむ');
    header.appendChild(title);
    header.appendChild(collapse);

    var body = createElement(doc, 'div', 'xtce-body');

    function makeRow(labelText) {
      var row = createElement(doc, 'div', 'xtce-row');
      var label = createElement(doc, 'span', 'xtce-label', labelText);
      var value = createElement(doc, 'span', 'xtce-value', '');
      row.appendChild(label);
      row.appendChild(value);
      return value;
    }

    var userValue = makeRow('ユーザー');
    var countValue = makeRow('取得件数');
    body.appendChild(userValue.parentNode);
    body.appendChild(countValue.parentNode);

    var statusEl = createElement(doc, 'div', 'xtce-status', STATUS.idle);
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.setAttribute('data-tone', 'muted');
    body.appendChild(statusEl);

    var actions = createElement(doc, 'div', 'xtce-actions');
    function makeButton(action, label) {
      var button = createElement(doc, 'button', 'xtce-button', label);
      button.type = 'button';
      button.setAttribute('data-action', action);
      actions.appendChild(button);
      return button;
    }
    var startBtn = makeButton('scroll', '自動スクロール開始');
    var stopBtn = makeButton('stop', '停止');
    var csvBtn = makeButton('csv', 'CSV ダウンロード');
    var jsonBtn = makeButton('json', 'JSON ダウンロード');
    var clearBtn = makeButton('clear', 'クリア');
    body.appendChild(actions);

    panel.appendChild(header);
    panel.appendChild(body);

    var lastState = {
      username: null,
      count: 0,
      records: [],
      error: null
    };
    var baseStatus = STATUS.idle;
    var baseTone = 'muted';
    var collapsed = false;
    var lastUsername;
    var disposed = false;
    var unsubscribe = null;

    function renderStatus() {
      var text = baseStatus;
      var tone = baseTone;
      if (lastState.error) {
        text = '保存エラー: ' + messageOf(lastState.error);
        if (lastState.error.code) {
          text += ' (' + lastState.error.code + ')';
        }
        tone = 'error';
      }
      statusEl.textContent = text;
      statusEl.setAttribute('data-tone', tone);
    }

    function setStatus(text, tone) {
      baseStatus = String(text === undefined || text === null ? '' : text);
      baseTone = tone || 'muted';
      renderStatus();
    }

    var auto = createAutoScroller({
      intervalMs: opts.scrollIntervalMs,
      slowRetryMs: opts.slowRetryMs,
      stallChecks: opts.stallChecks,
      slowChecks: opts.slowChecks,
      setTimeout: setTimer,
      clearTimeout: clearTimer,
      getCount: function () {
        return lastState.count;
      },
      scrollToBottom: scrollToBottom,
      onStatus: function (text, tone) {
        setStatus(text, tone);
        syncButtons();
      }
    });

    function syncButtons() {
      startBtn.disabled = auto.isRunning() || !lastState.username;
      stopBtn.disabled = !auto.isRunning();
    }

    function update(nextState) {
      var state =
        nextState && typeof nextState === 'object'
          ? nextState
          : content.getState();
      if (!state || typeof state !== 'object' || disposed) {
        return;
      }
      lastState = {
        username:
          typeof state.username === 'string' && state.username
            ? state.username
            : null,
        count: numberOrZero(state.count),
        records: Array.isArray(state.records) ? state.records : [],
        error:
          state.error && typeof state.error === 'object' ? state.error : null
      };
      if (lastUsername !== lastState.username) {
        if (lastUsername !== undefined && auto.isRunning()) {
          auto.stop(STATUS.userChanged);
        }
        lastUsername = lastState.username;
      }
      setText(userValue, lastState.username ? '@' + lastState.username : '—');
      setText(countValue, String(lastState.count));
      renderStatus();
      syncButtons();
    }

    function setText(node, text) {
      if (node) {
        node.textContent = String(text);
      }
    }

    function preventDefault(event) {
      if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
    }

    function downloadBlob(blob, filename) {
      if (typeof opts.download === 'function') {
        opts.download(blob, filename);
        return;
      }
      if (
        !urlApi ||
        typeof urlApi.createObjectURL !== 'function' ||
        typeof BlobCtor !== 'function'
      ) {
        throw new Error('この環境では Blob ダウンロードを利用できません。');
      }
      var url = urlApi.createObjectURL(blob);
      var anchor = doc.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.style.display = 'none';
      (doc.body || doc.documentElement).appendChild(anchor);
      try {
        if (typeof anchor.click === 'function') {
          anchor.click();
        }
      } finally {
        setTimer(function () {
          try {
            if (typeof urlApi.revokeObjectURL === 'function') {
              urlApi.revokeObjectURL(url);
            }
          } catch (error) {
            /* Object URLs are best-effort cleanup. */
          }
          try {
            if (anchor.parentNode) {
              anchor.parentNode.removeChild(anchor);
            }
          } catch (error) {
            /* The page may have removed the anchor first. */
          }
        }, 1000);
      }
    }

    function exportRecords(kind) {
      try {
        var state = content.getState();
        var records =
          state && Array.isArray(state.records) ? state.records : [];
        var username = state && state.username ? state.username : null;
        if (records.length === 0) {
          setStatus(STATUS.empty, 'muted');
          return;
        }
        var sorted = sortRecordsAsc(records);
        var filename = buildFilename(username, now(), kind);
        var blob;
        if (kind === 'csv') {
          blob = new BlobCtor([csv.toCSV(sorted)], {
            type: 'text/csv;charset=utf-8'
          });
        } else {
          blob = new BlobCtor([JSON.stringify(sorted, null, 2) + '\n'], {
            type: 'application/json;charset=utf-8'
          });
        }
        downloadBlob(blob, filename);
        setStatus(
          sorted.length + ' 件を ' + filename + ' としてダウンロードしました',
          'ok'
        );
      } catch (error) {
        setStatus(STATUS.downloadFailed + ': ' + messageOf(error), 'error');
      }
    }

    function handleClear() {
      var username = lastState.username;
      setStatus(STATUS.clearing, 'muted');
      var result;
      try {
        result = content.clearCurrent();
      } catch (error) {
        setStatus(STATUS.clearFailed + ': ' + messageOf(error), 'error');
        return;
      }
      Promise.resolve(result).then(
        function () {
          setStatus(
            STATUS.cleared + (username ? '（@' + username + '）' : ''),
            'ok'
          );
          syncButtons();
        },
        function (error) {
          setStatus(STATUS.clearFailed + ': ' + messageOf(error), 'error');
        }
      );
    }

    function setCollapsed(next) {
      collapsed = Boolean(next);
      body.hidden = collapsed;
      panel.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
      collapse.textContent = collapsed ? '▸' : '▾';
      collapse.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      collapse.setAttribute(
        'aria-label',
        collapsed ? 'パネルを展開する' : 'パネルを折りたたむ'
      );
      collapse.setAttribute('title', collapsed ? '展開する' : '折りたたむ');
    }

    collapse.addEventListener('click', function (event) {
      preventDefault(event);
      setCollapsed(!collapsed);
    });
    startBtn.addEventListener('click', function (event) {
      preventDefault(event);
      if (!lastState.username) {
        setStatus(STATUS.waiting, 'warn');
        return;
      }
      auto.start();
      syncButtons();
    });
    stopBtn.addEventListener('click', function (event) {
      preventDefault(event);
      auto.stop();
      syncButtons();
    });
    csvBtn.addEventListener('click', function (event) {
      preventDefault(event);
      exportRecords('csv');
    });
    jsonBtn.addEventListener('click', function (event) {
      preventDefault(event);
      exportRecords('json');
    });
    clearBtn.addEventListener('click', function (event) {
      preventDefault(event);
      handleClear();
    });

    (doc.body || doc.documentElement).appendChild(panel);

    try {
      unsubscribe = content.subscribe(update);
    } catch (error) {
      unsubscribe = null;
    }
    try {
      update(content.getState());
    } catch (error) {
      /* The panel still renders its idle state if getState misbehaves. */
    }

    function destroy() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        if (unsubscribe) {
          unsubscribe();
        }
      } catch (error) {
        /* Unsubscribing twice is harmless. */
      }
      auto.dispose();
      if (panel.parentNode) {
        panel.parentNode.removeChild(panel);
      }
    }

    return {
      element: panel,
      header: header,
      body: body,
      statusEl: statusEl,
      userValue: userValue,
      countValue: countValue,
      buttons: {
        start: startBtn,
        stop: stopBtn,
        csv: csvBtn,
        json: jsonBtn,
        clear: clearBtn,
        collapse: collapse
      },
      auto: auto,
      update: update,
      setStatus: setStatus,
      setCollapsed: setCollapsed,
      isCollapsed: function () {
        return collapsed;
      },
      destroy: destroy
    };
  }

  var booted = null;

  /**
   * Mount once the DOM exists. document_start means document.body is usually
   * absent when this file runs; boot() waits for DOMContentLoaded below.
   */
  function boot() {
    if (booted) {
      return booted;
    }
    if (typeof document === 'undefined' || !document) {
      return null;
    }
    booted = createPanel({
      document: document,
      window: win,
      content: root.__XTCE_content,
      csv: root.__XTCE_csv
    });
    return booted;
  }

  root.__XTCE_panel = {
    createPanel: createPanel,
    createAutoScroller: createAutoScroller,
    buildFilename: buildFilename,
    formatTimestamp: formatTimestamp,
    sanitizeUsername: sanitizeUsername,
    sortRecordsAsc: sortRecordsAsc,
    boot: boot,
    DEFAULTS: DEFAULTS,
    STATUS: STATUS
  };

  try {
    if (
      typeof document !== 'undefined' &&
      document &&
      typeof document.addEventListener === 'function'
    ) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, false);
      } else {
        boot();
      }
    }
  } catch (error) {
    /* A page that forbids DOM access must not break x.com. */
  }
})();
