require('dotenv').config();

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { Connectors, Shoukaku } = require('shoukaku');

const LAVALINK_HOST = process.env.LAVALINK_HOST || '127.0.0.1';
const LAVALINK_PORT = Number(process.env.LAVALINK_PORT || 2333);
const LAVALINK_PASSWORD = process.env.LAVALINK_PASSWORD;
const RESOLVER_URL = (process.env.RESOLVER_URL || 'http://127.0.0.1:4417').replace(/\/$/, '');
const GUILD_ID = process.env.DISCORD_GUILD_ID?.trim() || null;
const MAX_BOTS = 7;
const MAX_QUEUE_DISPLAY = 10;
const IDLE_DISCONNECT_MS = 60_000;

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a YouTube song or video in your voice channel')
    .addStringOption((option) => option.setName('query').setDescription('Song title or YouTube URL').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and leave the voice channel'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the current song'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current song and queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the player volume')
    .addIntegerOption((option) => option.setName('percent').setDescription('Volume from 1 to 100').setMinValue(1).setMaxValue(100).setRequired(true)),
].map((command) => command.toJSON());

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

function loadBotConfigs() {
  const tokens = parseJsonArray(process.env.BOT_TOKENS_JSON, 'BOT_TOKENS_JSON');
  if (!tokens.length && process.env.DISCORD_TOKEN?.trim()) tokens.push(process.env.DISCORD_TOKEN.trim());
  if (!tokens.length) throw new Error('Set BOT_TOKENS_JSON to a JSON array of Discord bot tokens.');
  if (tokens.length > MAX_BOTS) throw new Error(`This stack supports up to ${MAX_BOTS} bot tokens.`);
  if (new Set(tokens).size !== tokens.length) throw new Error('BOT_TOKENS_JSON contains a duplicate token.');

  const names = parseJsonArray(process.env.BOT_NAMES_JSON, 'BOT_NAMES_JSON');
  return tokens.map((token, index) => ({
    token,
    name: names[index] || `MFC Music ${index + 1}`,
    index,
  }));
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'LIVE';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function extractLoadedTracks(result) {
  if (!result) return [];
  const type = String(result.loadType || '').toLowerCase();
  if (type === 'track') return result.data ? [result.data] : [];
  if (type === 'search') return Array.isArray(result.data) ? result.data : [];
  if (type === 'playlist') return Array.isArray(result.data?.tracks) ? result.data.tracks : [];
  // Support both Lavalink v4 and wrapper response shapes.
  if (Array.isArray(result.tracks)) return result.tracks;
  return [];
}

async function searchResolver(query) {
  const response = await fetch(`${RESOLVER_URL}/search?q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(35_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Resolver returned HTTP ${response.status}`);
  return result;
}

async function loadHttpTrack(node, videoId) {
  const streamUrl = `${RESOLVER_URL}/yt/${encodeURIComponent(videoId)}`;
  const result = await node.rest.resolve(streamUrl);
  const track = extractLoadedTracks(result)[0];
  if (!track?.encoded) {
    const detail = result?.data?.message || result?.data?.cause || result?.exception?.message;
    throw new Error(detail ? `Lavalink could not load the audio: ${detail}` : 'Lavalink returned no playable audio track.');
  }
  return track;
}

function makeTrackEmbed(item, title = 'Queued') {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(item.title)
    .setURL(item.url)
    .setDescription(`${item.author} · ${formatDuration(item.duration)}`)
    .setFooter({ text: `${title} by ${item.requester}` });
  if (item.thumbnail) embed.setThumbnail(item.thumbnail);
  return embed;
}

function makeQueueEmbed(state) {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Music playlist');
  if (state.current) {
    embed.addFields({
      name: 'Now playing',
      value: `[${state.current.title}](${state.current.url}) · ${formatDuration(state.current.duration)}`,
    });
  }
  const upcoming = state.tracks.slice(0, MAX_QUEUE_DISPLAY)
    .map((track, index) => `**${index + 1}.** [${track.title.slice(0, 150)}](${track.url}) · ${formatDuration(track.duration)} · ${track.requester}`);
  embed.addFields({
    name: `Up next (${state.tracks.length})`,
    value: upcoming.join('\n') || 'Nothing queued.',
  });
  if (state.tracks.length > MAX_QUEUE_DISPLAY) {
    embed.setFooter({ text: `Showing the next ${MAX_QUEUE_DISPLAY} tracks` });
  }
  return embed;
}

function makePlayerControls(state) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mfc:back')
      .setLabel('Back')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!state.history.length),
    new ButtonBuilder()
      .setCustomId('mfc:skip')
      .setLabel('Skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!state.current),
    new ButtonBuilder()
      .setCustomId('mfc:stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!state.player),
    new ButtonBuilder()
      .setCustomId('mfc:playlist')
      .setLabel('Playlist')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!state.current && !state.tracks.length),
  )];
}

async function refreshControlMessage(state) {
  if (!state.controlMessage) return;
  if (!state.current) {
    await state.controlMessage.edit({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Playback finished').setDescription('The playlist is empty.')],
      components: [],
    }).catch(() => null);
    return;
  }
  await state.controlMessage.edit({
    embeds: [makeTrackEmbed(state.current, 'Now playing')],
    components: makePlayerControls(state),
  }).catch(() => null);
}

function getQueue(runtime, guildId) {
  let state = runtime.queues.get(guildId);
  if (!state) {
    state = {
      channelId: null,
      player: null,
      current: null,
      tracks: [],
      history: [],
      volume: 80,
      skipRequested: false,
      stopRequested: false,
      idleTimer: null,
      listenersAttached: false,
      controlMessage: null,
    };
    runtime.queues.set(guildId, state);
  }
  return state;
}

function resetIdleTimer(runtime, guildId, state) {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(async () => {
    if (state.current || state.tracks.length) return;
    await runtime.shoukaku.leaveVoiceChannel(guildId).catch(() => null);
    runtime.queues.delete(guildId);
    console.log(`[${runtime.name}] Left idle voice channel in guild ${guildId}`);
  }, IDLE_DISCONNECT_MS);
  state.idleTimer.unref?.();
}

async function playNext(runtime, guildId, state) {
  if (!state.player || state.stopRequested) return;
  clearTimeout(state.idleTimer);
  const item = state.tracks.shift();
  if (!item) {
    state.current = null;
    resetIdleTimer(runtime, guildId, state);
    void refreshControlMessage(state);
    return;
  }
  state.current = item;
  state.skipRequested = false;
  try {
    await state.player.playTrack({ track: { encoded: item.encoded } });
    console.log(`[${runtime.name}] Playing "${item.title}" in guild ${guildId}`);
  } catch (error) {
    console.error(`[${runtime.name}] Lavalink play error in guild ${guildId}: ${error.message}`);
    state.current = null;
    void playNext(runtime, guildId, state);
  }
}

function attachPlayerEvents(runtime, guildId, state) {
  if (state.listenersAttached || !state.player) return;
  state.listenersAttached = true;
  state.player.on('start', () => {
    if (state.current) console.log(`[${runtime.name}] Track started: ${state.current.title}`);
    void refreshControlMessage(state);
  });
  state.player.on('end', (event) => {
    const reason = String(event?.reason || '').toLowerCase();
    const shouldAdvance = reason === 'finished' || reason === 'loadfailed' || state.skipRequested;
    if (state.stopRequested) return;
    if (shouldAdvance) {
      if (state.current) state.history.push(state.current);
      if (state.history.length > 50) state.history.shift();
      state.current = null;
      state.skipRequested = false;
      void playNext(runtime, guildId, state);
    }
  });
  state.player.on('exception', (event) => {
    console.error(`[${runtime.name}] Lavalink track exception in guild ${guildId}: ${event?.exception?.message || 'unknown error'}`);
  });
  state.player.on('stuck', (event) => {
    console.error(`[${runtime.name}] Lavalink track stuck in guild ${guildId} after ${event?.thresholdMs || '?'}ms`);
    state.skipRequested = true;
    void state.player.stopTrack().catch((error) => console.error(`[${runtime.name}] Could not stop stuck track: ${error.message}`));
  });
}

async function getVoiceState(interaction) {
  if (!interaction.guild) throw new Error('Use this command inside a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!member.voice.channel) throw new Error('Join a voice channel first.');
  const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
  const permissions = member.voice.channel.permissionsFor(botMember);
  if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    throw new Error('I need Connect and Speak permissions in your voice channel.');
  }
  return { guildId: interaction.guild.id, channel: member.voice.channel };
}

async function handlePlay(runtime, interaction) {
  await interaction.deferReply();
  const { guildId, channel } = await getVoiceState(interaction);
  const query = interaction.options.getString('query', true).trim();
  const state = getQueue(runtime, guildId);
  if (state.channelId && state.channelId !== channel.id && state.player) {
    throw new Error(`I am already playing in <#${state.channelId}>.`);
  }

  const result = await searchResolver(query);
  const node = runtime.shoukaku.options.nodeResolver(runtime.shoukaku.nodes);
  if (!node) throw new Error('Lavalink is not connected yet. Try again in a few seconds.');
  const loaded = await loadHttpTrack(node, result.videoId);
  const item = {
    encoded: loaded.encoded,
    title: result.title,
    author: result.author,
    duration: result.duration,
    thumbnail: result.thumbnail,
    url: result.url,
    requester: interaction.user.username,
  };

  if (!state.player) {
    state.player = await runtime.shoukaku.joinVoiceChannel({
      guildId,
      channelId: channel.id,
      shardId: 0,
      deaf: true,
    });
    state.channelId = channel.id;
    await state.player.setGlobalVolume(state.volume);
    attachPlayerEvents(runtime, guildId, state);
  }

  clearTimeout(state.idleTimer);
  state.tracks.push(item);
  const alreadyPlaying = !!state.current;
  if (!alreadyPlaying) await playNext(runtime, guildId, state);
  state.controlMessage = await interaction.editReply({
    embeds: [makeTrackEmbed(item, alreadyPlaying ? 'Queued' : 'Playing')],
    components: makePlayerControls(state),
  });
  if (!alreadyPlaying) await refreshControlMessage(state);
}

async function handleButton(runtime, interaction) {
  const action = interaction.customId.slice('mfc:'.length);
  const guildId = interaction.guildId;
  const state = guildId ? runtime.queues.get(guildId) : null;

  if (action === 'playlist') {
    if (!state || (!state.current && !state.tracks.length)) {
      return void await interaction.reply({ content: 'The playlist is empty.', ephemeral: true });
    }
    return void await interaction.reply({ embeds: [makeQueueEmbed(state)], ephemeral: true });
  }

  if (!state?.player || !state.current) {
    return void await interaction.reply({ content: 'There is no active player in this server.', ephemeral: true });
  }

  const { channel } = await getVoiceState(interaction);
  if (channel.id !== state.channelId) {
    return void await interaction.reply({ content: `Join <#${state.channelId}> to control this player.`, ephemeral: true });
  }

  if (action === 'back' && !state.history.length) {
    return void await interaction.reply({ content: 'There is no previous song to return to.', ephemeral: true });
  }

  await interaction.deferUpdate();
  state.controlMessage = interaction.message;

  switch (action) {
    case 'back': {
      const previous = state.history.pop();
      const current = state.current;
      if (current) state.tracks.unshift(current);
      state.current = previous;
      state.skipRequested = false;
      await state.player.playTrack({ track: { encoded: previous.encoded } });
      await refreshControlMessage(state);
      break;
    }
    case 'skip':
      state.skipRequested = true;
      await state.player.stopTrack();
      break;
    case 'stop': {
      state.stopRequested = true;
      state.tracks.length = 0;
      state.history.length = 0;
      clearTimeout(state.idleTimer);
      await state.player.stopTrack().catch(() => null);
      await runtime.shoukaku.leaveVoiceChannel(guildId);
      runtime.queues.delete(guildId);
      await interaction.message.edit({
        embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Playback stopped').setDescription('The player has left the voice channel.')],
        components: [],
      }).catch(() => null);
      break;
    }
    default:
      await interaction.followUp({ content: 'This music control is no longer available.', ephemeral: true });
  }
}

async function handleCommand(runtime, interaction) {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('mfc:')) {
      return await handleButton(runtime, interaction);
    }
    if (!interaction.isChatInputCommand()) return;
    switch (interaction.commandName) {
      case 'play':
        return await handlePlay(runtime, interaction);
      case 'skip': {
        const { guildId } = await getVoiceState(interaction);
        const state = runtime.queues.get(guildId);
        if (!state?.current || !state.player) return void await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
        const skippedTitle = state.current.title;
        state.skipRequested = true;
        await state.player.stopTrack();
        return void await interaction.reply({ content: `Skipped **${skippedTitle}**.` });
      }
      case 'stop': {
        const { guildId } = await getVoiceState(interaction);
        const state = runtime.queues.get(guildId);
        if (!state?.player) return void await interaction.reply({ content: 'I am not playing in this server.', ephemeral: true });
        state.stopRequested = true;
        state.tracks.length = 0;
        state.history.length = 0;
        clearTimeout(state.idleTimer);
        await state.player.stopTrack().catch(() => null);
        await runtime.shoukaku.leaveVoiceChannel(guildId);
        runtime.queues.delete(guildId);
        await state.controlMessage?.edit({
          embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Playback stopped').setDescription('The player has left the voice channel.')],
          components: [],
        }).catch(() => null);
        return void await interaction.reply({ content: 'Stopped playback and left the voice channel.' });
      }
      case 'pause':
      case 'resume': {
        const { guildId } = await getVoiceState(interaction);
        const state = runtime.queues.get(guildId);
        if (!state?.player || !state.current) return void await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
        const paused = interaction.commandName === 'pause';
        await state.player.setPaused(paused);
        return void await interaction.reply({ content: paused ? 'Paused.' : 'Resumed.' });
      }
      case 'queue': {
        const { guildId } = await getVoiceState(interaction);
        const state = runtime.queues.get(guildId);
        if (!state?.current && !state?.tracks.length) return void await interaction.reply({ content: 'The queue is empty.', ephemeral: true });
        state.controlMessage = await interaction.reply({
          embeds: [makeQueueEmbed(state)],
          components: makePlayerControls(state),
          fetchReply: true,
        });
        return;
      }
      case 'nowplaying': {
        const { guildId } = await getVoiceState(interaction);
        const state = runtime.queues.get(guildId);
        if (!state?.current) return void await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
        state.controlMessage = await interaction.reply({
          embeds: [makeTrackEmbed(state.current, 'Now playing')],
          components: makePlayerControls(state),
          fetchReply: true,
        });
        return;
      }
      case 'volume': {
        const { guildId } = await getVoiceState(interaction);
        const state = runtime.queues.get(guildId);
        if (!state?.player) return void await interaction.reply({ content: 'Start a song before setting volume.', ephemeral: true });
        state.volume = interaction.options.getInteger('percent', true);
        await state.player.setGlobalVolume(state.volume);
        return void await interaction.reply({ content: `Volume set to **${state.volume}%**.` });
      }
      default:
        return void await interaction.reply({ content: 'Unknown music command.', ephemeral: true });
    }
  } catch (error) {
    console.error(`[${runtime.name}] /${interaction.commandName} failed: ${error.message}`);
    const response = { content: error.message || 'The music command failed. Check the bot and Lavalink logs.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(response).catch(() => null);
    else await interaction.reply(response).catch(() => null);
  }
}

function createRuntime(config) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  const nodeConfig = [{
    name: 'local-lavalink',
    url: `${LAVALINK_HOST}:${LAVALINK_PORT}`,
    auth: LAVALINK_PASSWORD,
  }];
  const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), nodeConfig, {
    reconnectTries: 30,
    reconnectInterval: 5,
    restTimeout: 90_000,
  });
  const runtime = { ...config, client, shoukaku, queues: new Map() };

  shoukaku.on('error', (name, error) => console.error(`[${config.name}] Lavalink node ${name}: ${error.message}`));
  shoukaku.on('ready', (name, resumed) => console.log(`[${config.name}] Lavalink ${name} ready (resumed=${resumed})`));
  shoukaku.on('close', (name, code, reason) => console.warn(`[${config.name}] Lavalink ${name} closed (${code}): ${reason || 'no reason supplied'}`));
  shoukaku.on('reconnecting', (name, remaining, interval) => console.warn(`[${config.name}] Retrying Lavalink ${name} in ${interval}s (${remaining} tries left)`));
  if (process.env.SHOUKAKU_DEBUG === 'true') {
    shoukaku.on('debug', (name, message) => console.log(`[${config.name}] Shoukaku ${name}: ${message}`));
    shoukaku.on('raw', (name, packet) => {
      if (packet?.op === 'ready') {
        console.log(`[${config.name}] Shoukaku ${name}: READY received (session id=${!!packet.sessionId})`);
      }
    });
  }
  client.on(Events.InteractionCreate, (interaction) => void handleCommand(runtime, interaction));
  client.once(Events.ClientReady, async () => {
    try {
      if (!client.application) throw new Error('Discord application is not ready');
      console.log(`[${config.name}] Gateway ready (user=${client.user.id}, Lavalink connector=${shoukaku.id})`);
      if (GUILD_ID) await client.application.commands.set(COMMANDS, GUILD_ID);
      else await client.application.commands.set(COMMANDS);
      console.log(`[${config.name}] Logged in as ${client.user.tag}; slash commands registered${GUILD_ID ? ` for guild ${GUILD_ID}` : ' globally'}.`);
    } catch (error) {
      console.error(`[${config.name}] Slash-command registration failed: ${error.message}`);
    }
  });
  client.on('error', (error) => console.error(`[${config.name}] Discord client error: ${error.message}`));
  return runtime;
}

async function main() {
  if (!LAVALINK_PASSWORD) throw new Error('LAVALINK_PASSWORD is required.');
  await waitForLavalink();
  const configs = loadBotConfigs();
  const runtimes = configs.map(createRuntime);
  for (const runtime of runtimes) {
    await runtime.client.login(runtime.token);
    // Do not keep Discord credentials in runtime objects longer than needed.
    runtime.token = undefined;
  }
  console.log(`[music-bot] Started ${runtimes.length} Discord bot client(s).`);

  const shutdown = async () => {
    console.log('[music-bot] Shutting down Discord clients.');
    await Promise.all(runtimes.map(async (runtime) => {
      for (const [guildId, state] of runtime.queues) {
        clearTimeout(state.idleTimer);
        await runtime.shoukaku.leaveVoiceChannel(guildId).catch(() => null);
      }
      runtime.client.destroy();
    }));
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

async function waitForLavalink() {
  const endpoint = `http://${LAVALINK_HOST}:${LAVALINK_PORT}/version`;
  const deadline = Date.now() + Number(process.env.LAVALINK_READY_TIMEOUT_MS || 120_000);
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: LAVALINK_PASSWORD },
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        console.log('[music-bot] Lavalink REST is ready; connecting Discord clients.');
        return;
      }
      lastError = `Lavalink returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Lavalink did not become ready within the configured timeout (${lastError}).`);
}

main().catch((error) => {
  console.error(`[music-bot] Startup failed: ${error.message}`);
  process.exitCode = 1;
});
