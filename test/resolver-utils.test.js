const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSearchArgs,
  buildStreamArgs,
  extractYoutubeVideoId,
  targetForQuery,
} = require('../src/resolver-utils');

test('extracts direct YouTube video ids only from allowed YouTube URL forms', () => {
  assert.equal(extractYoutubeVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=4'), 'dQw4w9WgXcQ');
  assert.equal(extractYoutubeVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYoutubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYoutubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
});

test('builds a search target without invoking a shell or interpreting query text', () => {
  assert.deepEqual(targetForQuery('blue & gold'), { videoId: null, target: 'ytsearch1:blue & gold' });
  assert.deepEqual(targetForQuery('https://youtube.com/watch?v=dQw4w9WgXcQ'), {
    videoId: 'dQw4w9WgXcQ',
    target: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
  assert.throws(() => targetForQuery(''), /required/);
  assert.throws(() => targetForQuery('x'.repeat(301)), /too long/);
});

test('configures yt-dlp to use Deno, bgutil POT provider, and optional cookies', () => {
  const { args } = buildSearchArgs('lofi beats', {
    denoPath: '/usr/local/bin/deno',
    potProviderUrl: 'http://127.0.0.1:4416',
    cookiesPath: '/run/secrets/youtube-cookies.txt',
  });
  assert.ok(args.includes('deno:/usr/local/bin/deno'));
  assert.ok(args.includes('ejs:github'));
  assert.ok(args.includes('youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'));
  assert.ok(args.includes('/run/secrets/youtube-cookies.txt'));
});

test('creates a local HTTP-source URL stream request for Lavalink', () => {
  const args = buildStreamArgs('dQw4w9WgXcQ', { denoPath: '/usr/local/bin/deno' });
  assert.ok(args.includes('bestaudio[acodec=opus]/bestaudio[ext=webm]'));
  assert.ok(args.includes('-'));
  assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.throws(() => buildStreamArgs('bad-id'), /Invalid YouTube video ID/);
});
