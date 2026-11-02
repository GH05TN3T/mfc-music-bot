const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

function validVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_RE.test(value) ? value : null;
}

function extractYoutubeVideoId(input) {
  const value = String(input || '').trim();
  if (VIDEO_ID_RE.test(value)) return value;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    return validVideoId(url.pathname.split('/').filter(Boolean)[0]);
  }

  const direct = url.searchParams.get('v');
  if (direct) return validVideoId(direct);

  const segments = url.pathname.split('/').filter(Boolean);
  if (['shorts', 'embed', 'live'].includes(segments[0])) {
    return validVideoId(segments[1]);
  }
  return null;
}

function targetForQuery(input) {
  const query = String(input || '').trim();
  if (!query) throw new TypeError('A song title or YouTube URL is required');
  if (query.length > 300) throw new TypeError('Search query is too long');

  const videoId = extractYoutubeVideoId(query);
  return videoId
    ? { videoId, target: `https://www.youtube.com/watch?v=${videoId}` }
    : { videoId: null, target: `ytsearch1:${query}` };
}

function commonYtDlpArgs({ denoPath, potProviderUrl, cookiesPath } = {}) {
  const args = [
    '--no-warnings',
    '--no-progress',
    '--no-cache-dir',
    '--no-playlist',
    '--js-runtimes',
    `deno:${denoPath || '/usr/local/bin/deno'}`,
    '--remote-components',
    'ejs:github',
    '--extractor-args',
    `youtubepot-bgutilhttp:base_url=${potProviderUrl || 'http://127.0.0.1:4416'}`,
  ];
  if (cookiesPath) args.push('--cookies', cookiesPath);
  return args;
}

function buildSearchArgs(input, options = {}) {
  const { target, videoId } = targetForQuery(input);
  return {
    videoId,
    args: [
      ...commonYtDlpArgs(options),
      '--dump-single-json',
      '--flat-playlist',
      target,
    ],
  };
}

function buildStreamArgs(videoId, options = {}) {
  const id = validVideoId(videoId);
  if (!id) throw new TypeError('Invalid YouTube video ID');
  return [
    ...commonYtDlpArgs(options),
    '--format',
    'bestaudio[acodec=opus]/bestaudio[ext=webm]',
    '--output',
    '-',
    `https://www.youtube.com/watch?v=${id}`,
  ];
}

module.exports = {
  VIDEO_ID_RE,
  extractYoutubeVideoId,
  targetForQuery,
  commonYtDlpArgs,
  buildSearchArgs,
  buildStreamArgs,
};
