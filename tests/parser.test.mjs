/*
 * S1 tests for src/parser.js.
 *
 * Run with: node tests/parser.test.mjs
 *
 * The fixture is a synthetic (never fetched) UserTweets-shaped GraphQL
 * payload covering normal tweet with photo+video, retweet, long post
 * (note_tweet), visibility wrapper, tombstone and cursor entries.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const parserSource = readFileSync(new URL('../src/parser.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(parserSource, sandbox, { filename: 'src/parser.js' });

const api = sandbox.window.__XTCE_parse;
assert.ok(api, 'src/parser.js must expose window.__XTCE_parse in a vm context');
const { extractFromGraphQL, extractTweetResult, toCSV, CSV_COLUMNS } = api;

const EXPECTED_COLUMNS = [
  'id',
  'created_at_iso',
  'text',
  'url',
  'author_username',
  'author_name',
  'like_count',
  'retweet_count',
  'reply_count',
  'quote_count',
  'bookmark_count',
  'view_count',
  'hashtags',
  'mentions',
  'urls',
  'media_urls',
  'media_types',
  'is_reply',
  'in_reply_to_status_id',
  'in_reply_to_username',
  'is_retweet',
  'retweeted_status_id',
  'is_quote',
  'quoted_status_id',
  'conversation_id',
  'lang',
  'source'
];
const EXPECTED_HEADER = EXPECTED_COLUMNS.join(',');

let groups = 0;

function test(name, fn) {
  try {
    fn();
    groups += 1;
    console.log('ok - ' + name);
  } catch (error) {
    console.error('not ok - ' + name);
    throw error;
  }
}

function user(screenName, name) {
  return { __typename: 'User', rest_id: 'u-' + screenName, legacy: { screen_name: screenName, name } };
}

function tweetEntry(entryId, result) {
  return {
    entryId,
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineTweet',
        tweet_results: { result }
      }
    }
  };
}

// --- Synthetic GraphQL fixture -------------------------------------------

const quotedOriginal = {
  __typename: 'Tweet',
  rest_id: '9003',
  core: { user_results: { result: user('carol', 'Carol') } },
  legacy: { id_str: '9003', full_text: 'Quoted original', entities: {} }
};

const normalTweet = {
  __typename: 'Tweet',
  rest_id: '1001',
  core: { user_results: { result: user('alice', 'Alice Example') } },
  legacy: {
    id_str: '1001',
    created_at: 'Wed May 01 12:34:56 +0000 2024',
    full_text: 'Hello, world! #test @bob https://t.co/abc',
    favorite_count: 10,
    retweet_count: 2,
    reply_count: 1,
    quote_count: 1,
    bookmark_count: 3,
    lang: 'en',
    conversation_id_str: '1001',
    entities: {
      hashtags: [{ text: 'test' }],
      user_mentions: [{ screen_name: 'bob' }],
      urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/abc' }]
    },
    extended_entities: {
      media: [
        { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/photo1.jpg' },
        {
          type: 'video',
          media_url_https: 'https://pbs.twimg.com/media/thumb2.jpg',
          video_info: {
            variants: [
              {
                bitrate: 832000,
                content_type: 'video/mp4',
                url: 'https://video.twimg.com/low.mp4'
              },
              {
                content_type: 'application/x-mpegURL',
                url: 'https://video.twimg.com/playlist.m3u8'
              },
              {
                bitrate: 2176000,
                content_type: 'video/mp4',
                url: 'https://video.twimg.com/high.mp4'
              }
            ]
          }
        }
      ]
    }
  },
  quoted_status_result: { result: quotedOriginal },
  views: { count: '1234' },
  source: '<a href="https://mobile.twitter.com" rel="nofollow">Twitter for iPhone</a>'
};

const retweetedOriginal = {
  __typename: 'Tweet',
  rest_id: '9002',
  core: { user_results: { result: user('carol', 'Carol') } },
  legacy: {
    id_str: '9002',
    full_text: 'Original nested text',
    created_at: 'Thu May 02 07:00:00 +0000 2024',
    favorite_count: 99,
    entities: {}
  }
};

const retweet = {
  __typename: 'Tweet',
  rest_id: '1002',
  core: { user_results: { result: user('alice', 'Alice Example') } },
  legacy: {
    id_str: '1002',
    created_at: 'Thu May 02 08:00:00 +0000 2024',
    full_text: 'RT @carol: Original nested text',
    favorite_count: 1,
    retweet_count: 0,
    reply_count: 0,
    quote_count: 0,
    bookmark_count: 0,
    lang: 'en',
    conversation_id_str: '1002',
    entities: {},
    retweeted_status_result: { result: retweetedOriginal }
  }
};

const longNoteText =
  'This is the full long post.\n' +
  'It mentions #longform and @frank and links https://t.co/full';

const longTweet = {
  __typename: 'Tweet',
  rest_id: '1003',
  core: { user_results: { result: user('erin', 'Erin') } },
  legacy: {
    id_str: '1003',
    created_at: 'Fri May 03 10:20:30 +0900 2024',
    full_text: 'This is a long post that got truncated! https://t.co/legacy',
    favorite_count: 42,
    retweet_count: 5,
    reply_count: 0,
    quote_count: 0,
    bookmark_count: 7,
    lang: 'ja',
    conversation_id_str: '1003',
    entities: {
      hashtags: [],
      user_mentions: [],
      urls: [{ url: 'https://t.co/legacy', expanded_url: 'https://example.com/legacy' }]
    }
  },
  note_tweet: {
    note_tweet_results: {
      result: {
        id: 'note-1003',
        text: longNoteText,
        entity_set: {
          hashtags: [{ text: 'longform' }],
          user_mentions: [{ screen_name: 'frank' }],
          urls: [{ url: 'https://t.co/full', expanded_url: 'https://example.com/full' }]
        }
      }
    }
  },
  views: { count: '900' }
};

const visibilityTweet = {
  __typename: 'TweetWithVisibilityResults',
  tweet: {
    __typename: 'Tweet',
    rest_id: '1004',
    core: { user_results: { result: user('dave', 'Dave') } },
    legacy: {
      id_str: '1004',
      created_at: 'Sat Jun 01 00:00:00 +0000 2024',
      full_text: 'Visibility-wrapped tweet',
      favorite_count: 4,
      retweet_count: 0,
      reply_count: 0,
      quote_count: 0,
      bookmark_count: 0,
      lang: 'en',
      conversation_id_str: '1004',
      in_reply_to_status_id_str: '777',
      in_reply_to_screen_name: 'gina',
      entities: {}
    },
    views: { count: '44' }
  },
  limitedActionResults: { limited_actions: [] }
};

const tombstone = {
  __typename: 'TweetTombstone',
  tombstone: { text: { text: 'This post is unavailable.' } }
};

const fixture = {
  data: {
    user: {
      result: {
        __typename: 'User',
        timeline_v2: {
          timeline: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  tweetEntry('tweet-1001', normalTweet),
                  tweetEntry('tweet-1002', retweet),
                  tweetEntry('tweet-1003', longTweet),
                  tweetEntry('tombstone-1009', tombstone),
                  {
                    entryId: 'cursor-bottom-1',
                    content: {
                      entryType: 'TimelineTimelineCursor',
                      cursorType: 'Bottom',
                      value: 'DAABCgAB-example-cursor'
                    }
                  },
                  {
                    entryId: 'module-1004',
                    content: {
                      entryType: 'TimelineTimelineModule',
                      items: [
                        {
                          entryId: 'module-item-1004',
                          item: {
                            itemContent: {
                              itemType: 'TimelineTweet',
                              tweet_results: { result: visibilityTweet }
                            }
                          }
                        }
                      ]
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

const records = extractFromGraphQL(fixture);
const byId = (id) => records.find((record) => record.id === id);

// --- Tests ----------------------------------------------------------------

test('parser loads in vm and exposes the frozen API', () => {
  assert.equal(typeof extractFromGraphQL, 'function');
  assert.equal(typeof extractTweetResult, 'function');
  assert.equal(typeof toCSV, 'function');
  assert.ok(Array.isArray(CSV_COLUMNS));
  assert.equal(Object.isFrozen(CSV_COLUMNS), true);
  assert.deepEqual([...CSV_COLUMNS], EXPECTED_COLUMNS);
});

test('walks the timeline and skips tombstone and cursor entries', () => {
  assert.equal(records.length, 4);
  assert.deepEqual(
    Array.from(records, (record) => record.id),
    ['1001', '1002', '1003', '1004']
  );
  // The retweeted original (9002) and quoted original (9003) are nested
  // under legacy.retweeted_status_result / quoted_status_result, not under
  // tweet_results, and must never become separate records.
  assert.ok(!records.some((record) => record.id === '9002'));
  assert.ok(!records.some((record) => record.id === '9003'));
});

test('maps a normal tweet, its entities, media and views', () => {
  const record = byId('1001');
  assert.ok(record, 'normal tweet record must exist');
  assert.equal(record.created_at_iso, '2024-05-01T12:34:56.000Z');
  assert.equal(record.text, 'Hello, world! #test @bob https://t.co/abc');
  assert.equal(record.url, 'https://x.com/alice/status/1001');
  assert.equal(record.author_username, 'alice');
  assert.equal(record.author_name, 'Alice Example');
  assert.equal(record.like_count, 10);
  assert.equal(record.retweet_count, 2);
  assert.equal(record.reply_count, 1);
  assert.equal(record.quote_count, 1);
  assert.equal(record.bookmark_count, 3);
  assert.equal(record.view_count, 1234);
  assert.equal(record.hashtags, 'test');
  assert.equal(record.mentions, 'bob');
  assert.equal(record.urls, 'https://example.com/abc');
  assert.equal(
    record.media_urls,
    'https://pbs.twimg.com/media/photo1.jpg https://video.twimg.com/high.mp4'
  );
  assert.equal(record.media_types, 'photo video');
  assert.equal(record.is_reply, false);
  assert.equal(record.in_reply_to_status_id, '');
  assert.equal(record.in_reply_to_username, '');
  assert.equal(record.is_retweet, false);
  assert.equal(record.retweeted_status_id, '');
  assert.equal(record.is_quote, true);
  assert.equal(record.quoted_status_id, '9003');
  assert.equal(record.conversation_id, '1001');
  assert.equal(record.lang, 'en');
  assert.equal(record.source, 'Twitter for iPhone');
});

test('flags a retweet and keeps the nested original out of the records', () => {
  const record = byId('1002');
  assert.ok(record, 'retweet record must exist');
  assert.equal(record.text, 'RT @carol: Original nested text');
  assert.equal(record.author_username, 'alice');
  assert.equal(record.is_retweet, true);
  assert.equal(record.retweeted_status_id, '9002');
  assert.equal(record.is_quote, false);
  assert.equal(record.quoted_status_id, '');
  assert.equal(record.media_urls, '');
  assert.equal(record.media_types, '');
});

test('prefers note_tweet text and its entity_set for long posts', () => {
  const record = byId('1003');
  assert.ok(record, 'long post record must exist');
  assert.equal(record.text, longNoteText);
  assert.ok(!record.text.includes('truncated'));
  assert.equal(record.hashtags, 'longform');
  assert.equal(record.mentions, 'frank');
  assert.equal(record.urls, 'https://example.com/full');
  assert.equal(record.created_at_iso, '2024-05-03T01:20:30.000Z');
  assert.equal(record.like_count, 42);
  assert.equal(record.view_count, 900);
});

test('unwraps TweetWithVisibilityResults and maps reply fields', () => {
  const record = byId('1004');
  assert.ok(record, 'visibility-wrapped record must exist');
  assert.equal(record.author_username, 'dave');
  assert.equal(record.author_name, 'Dave');
  assert.equal(record.text, 'Visibility-wrapped tweet');
  assert.equal(record.view_count, 44);
  assert.equal(record.is_reply, true);
  assert.equal(record.in_reply_to_status_id, '777');
  assert.equal(record.in_reply_to_username, 'gina');
});

test('extractTweetResult returns null for tombstones and empty input', () => {
  assert.equal(extractTweetResult(tombstone), null);
  assert.equal(extractTweetResult({ result: tombstone }), null);
  assert.equal(extractTweetResult(null), null);
  assert.equal(extractTweetResult(undefined), null);
  assert.equal(extractTweetResult({}), null);
});

test('toCSV writes BOM, frozen header, CRLF rows and RFC escaping', () => {
  const csv = toCSV(records);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const body = csv.slice(1);
  assert.ok(body.startsWith(EXPECTED_HEADER + '\r\n'));
  assert.ok(body.endsWith('\r\n'));
  assert.equal(body.split('\r\n')[0], EXPECTED_HEADER);
  // header + 4 records + trailing empty element after the final CRLF
  assert.equal(body.split('\r\n').length, 6);

  const tricky = Object.assign({}, byId('1001'), {
    text: 'Comma, "quote", and\nnewline'
  });
  assert.ok(toCSV([tricky]).includes('"Comma, ""quote"", and\nnewline"'));

  const trickyCrlf = Object.assign({}, byId('1001'), { text: 'first\r\nsecond' });
  assert.ok(toCSV([trickyCrlf]).includes('"first\r\nsecond"'));

  const retweetRow = toCSV([byId('1002')]).slice(1).split('\r\n')[1];
  const retweetColumns = retweetRow.split(',');
  assert.equal(retweetColumns.length, EXPECTED_COLUMNS.length);
  assert.equal(retweetColumns[17], 'false'); // is_reply
  assert.equal(retweetColumns[20], 'true'); // is_retweet
  assert.equal(retweetColumns[21], '9002'); // retweeted_status_id
  assert.equal(retweetColumns[22], 'false'); // is_quote
  assert.equal(retweetColumns[23], ''); // quoted_status_id

  assert.equal(toCSV([]), '\uFEFF' + EXPECTED_HEADER + '\r\n');
});

test('manifest stays inside the S1 frozen scope', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'X Tweet CSV Exporter (Local)');
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, [
    'https://x.com/*',
    'https://twitter.com/*'
  ]);
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].js, ['src/parser.js']);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    'https://x.com/*',
    'https://twitter.com/*'
  ]);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');

  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes('webRequest'));
  assert.ok(!serialized.includes('<all_urls>'));
  assert.ok(!manifest.permissions.includes('tabs'));
});

console.log('PASS (' + groups + ' test groups)');
