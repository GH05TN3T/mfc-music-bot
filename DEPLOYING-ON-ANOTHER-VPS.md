# Run MFC Music on another VPS

This guide restores the standalone Docker stack from the source backup. It
uses one container to supervise the Discord music bot, Lavalink, the local
yt-dlp resolver, and the bgutil PO-token provider. Inside that container the
local endpoints are `127.0.0.1:2333`, `127.0.0.1:4417`, and `127.0.0.1:4416`.

## Requirements

- Linux VPS with Docker Engine and the Docker Compose plugin.
- At least 4 GB RAM and 2 CPU cores for the configured limits.
- Outbound internet access for Discord, YouTube, the PO-token provider, and
  Lavalink startup. The stack does not require inbound public ports.

## Restore and configure

1. Extract `MFC-Music-Bot-backup-2026-10-28.tar.gz` and enter its `music-bot`
   directory.
2. Copy `.env.example` to `.env` and configure `BOT_TOKENS_JSON` with the bot
   token or tokens to run. It accepts one primary token and up to six companion
   tokens. The backup intentionally excludes real tokens and cookies.
3. Set a strong, unique `LAVALINK_PASSWORD`. Set `DISCORD_GUILD_ID` to the
   destination server ID for faster slash-command registration; leave it blank
   to register globally.
4. If YouTube requires cookies for your VPS IP, add a current Netscape-format
   cookies export at `secrets/youtube-cookies.txt`. Keep it private; it is not
   included in the backup.
5. Start the stack:

   ```sh
   docker compose up -d --build
   docker compose logs -f music-bot
   ```

The bot applications need the `bot` and `applications.commands` OAuth scopes
and Connect, Speak, Send Messages, and Embed Links permissions. No privileged
Discord intents are required.

## Restore the saved Docker image instead

The companion archive `MFC-Music-Bot-image-2026-10-28.tar` contains the built
`veltramon/music-bot:local` image for Linux/AMD64. On an AMD64 VPS, load it and
start Compose without rebuilding:

```sh
docker load -i MFC-Music-Bot-image-2026-10-28.tar
docker compose up -d --no-build
```

For another CPU architecture, build from the included Dockerfile instead.

## Commands and troubleshooting

The bot provides `/play`, `/skip`, `/stop`, `/pause`, `/resume`, `/queue`,
`/nowplaying`, and `/volume`. The `/play` embed also has Back, Skip, Stop, and
Playlist buttons.

If `/play` is not visible immediately, allow time for global slash-command
registration or set `DISCORD_GUILD_ID` for guild-scoped registration. Check
`docker compose logs -f music-bot` for resolver and Lavalink errors. PO tokens
and cookies may help with YouTube restrictions, but cannot guarantee every
video is playable.

## Moving from Veltramon

The current Veltramon-managed bot is `MFC Music` (`mfcmusic-17749b27`). Stop it
in the Veltramon panel before starting this VPS deployment with the same bot
token. Do not run both copies with the same token at the same time. The
standalone Compose stack keeps its data in the `music-data` named volume;
`docker compose down` preserves it, while `docker compose down -v` deletes it.
