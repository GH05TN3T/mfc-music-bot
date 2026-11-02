const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBotConfigs } = require('../src/config');

test('loads one primary and six companion bot tokens with labels', () => {
  const tokens = Array.from({ length: 7 }, (_, index) => `token-${index + 1}`);
  const names = Array.from({ length: 7 }, (_, index) => `MFC Music ${index + 1}`);
  const result = loadBotConfigs({
    BOT_TOKENS_JSON: JSON.stringify(tokens),
    BOT_NAMES_JSON: JSON.stringify(names),
  });

  assert.equal(result.length, 7);
  assert.deepEqual(result[0], { token: 'token-1', name: 'MFC Music 1', index: 0 });
  assert.deepEqual(result[6], { token: 'token-7', name: 'MFC Music 7', index: 6 });
});

test('supports one token while the remaining bot tokens are configured', () => {
  assert.deepEqual(loadBotConfigs({ DISCORD_TOKEN: 'single-token' }), [
    { token: 'single-token', name: 'MFC Music 1', index: 0 },
  ]);
});

test('rejects duplicate tokens and more than seven bots', () => {
  assert.throws(() => loadBotConfigs({ BOT_TOKENS_JSON: '["same","same"]' }), /duplicate token/);
  assert.throws(() => loadBotConfigs({ BOT_TOKENS_JSON: JSON.stringify(Array(8).fill('token')) }), /up to 7/);
});
