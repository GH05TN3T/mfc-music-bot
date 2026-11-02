# MFC Music bot stack

This is a new, separate music-bot project. It runs the Discord bot, Lavalink,
the local YouTube stream resolver, and the bgutil PO-token HTTP provider
together in one supervised Docker container. It supports one main Discord bot
and up to six companion bot tokens; each token runs the same slash commands.

The local audio path matches the provided log notes:

```text
Discord bot -> 127.0.0.1:2333 (Lavalink)
Lavalink -> http://127.0.0.1:4417/yt/<video-id> (yt-dlp audio stream)
yt-dlp -> http://127.0.0.1:4416 (bgutil PO-token provider)
```

None of those ports are published to the public host. Lavalink downloads the
audio from the local resolver, which uses yt-dlp, Deno, the PO-token provider,
and optional YouTube cookies.

## Setup

1. Copy `.env.example` to `.env` and add your real Discord bot tokens to
   `BOT_TOKENS_JSON`. Keep the JSON array on one line. You can start with one
   token and add the six support tokens later.
   Stop any old deployment using those same tokens before starting this stack;
   do not run both copies at once.
2. Set a long random `LAVALINK_PASSWORD`.
3. For fast slash-command updates while testing, set `DISCORD_GUILD_ID` to the
   server ID where the bots are invited. Leave it blank for global commands.
4. If you have a YouTube cookies export, put it at
   `secrets/youtube-cookies.txt`. The file is mounted read-only and ignored by
   Git. Cookies are optional, but may help when YouTube blocks datacenter
   requests.
5. Build and start the stack:

   ```sh
   docker compose up -d --build
   docker compose logs -f music-bot
   ```

The Discord applications need the `bot` and `applications.commands` OAuth
scopes, plus Connect, Speak, Send Messages, and Embed Links permissions in the
music channels. No privileged Discord intents are required.

## Veltramon account

The managed MFC Music resource runs under its Veltramon account with the Pro
resource limits. Its process code is supplied by the local `veltramon/music-bot:local`
image; the bot's panel file area holds persistent data and optional cookies.
Use the panel's power controls and Variables tab for the managed instance.

The Docker Compose setup above is for standalone use. Do not start it while the
same Discord token is running in a Veltramon-managed container.

## Slash commands

- `/play query:<title or YouTube URL>`
- `/skip`
- `/stop`
- `/pause`
- `/resume`
- `/queue`
- `/nowplaying`
- `/volume percent:<1-100>`

Each bot has its own Lavalink player and queue per server. An empty player
leaves voice after one minute. The `/play` and `/nowplaying` embeds include
Back, Skip, Stop, and Playlist buttons; Back returns to the previous track.

## Logs and troubleshooting

```sh
docker compose logs -f music-bot
```

Look for these startup lines:

- `[po-token-provider]` starts on local port 4416.
- Lavalink starts on local port 2333.
- `[resolver] Listening on http://127.0.0.1:4417`.
- Each bot logs in and registers its slash commands.
- Lavalink logs `HTTP` as an enabled source.

If YouTube still rejects a request, inspect the yt-dlp resolver error in the
container logs and check that the optional cookies file is current. PO tokens
and cookies can help with YouTube restrictions, but do not guarantee that
YouTube will serve every video or IP address.

## Runtime notes

The `Dockerfile` pins Lavalink 4.2.2 and the bgutil provider 2.0.2. The image
includes Node.js, Java 17, yt-dlp, Deno, FFmpeg, and Supervisor. Supervisor
starts the four local processes in dependency order and forwards their logs to
Docker. The container runs non-root with a read-only root filesystem and no
Linux capabilities; only `/tmp`, the persistent Lavalink/Deno data volume, and
the read-only secrets directory are mounted.
