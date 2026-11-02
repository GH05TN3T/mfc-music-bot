const MAX_BOTS = 7;

function parseJsonArray(value, label) {
  if (!value?.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be a JSON array`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return parsed.map((item) => item.trim());
}

function loadBotConfigs(env = process.env) {
  const tokens = parseJsonArray(env.BOT_TOKENS_JSON, 'BOT_TOKENS_JSON');
  if (!tokens.length && env.DISCORD_TOKEN?.trim()) tokens.push(env.DISCORD_TOKEN.trim());
  if (!tokens.length) throw new Error('Set BOT_TOKENS_JSON to a JSON array of Discord bot tokens.');
  if (tokens.length > MAX_BOTS) throw new Error(`This stack supports up to ${MAX_BOTS} bot tokens.`);
  if (new Set(tokens).size !== tokens.length) throw new Error('BOT_TOKENS_JSON contains a duplicate token.');

  const names = parseJsonArray(env.BOT_NAMES_JSON, 'BOT_NAMES_JSON');
  return tokens.map((token, index) => ({
    token,
    name: names[index] || `MFC Music ${index + 1}`,
    index,
  }));
}

module.exports = { MAX_BOTS, parseJsonArray, loadBotConfigs };
