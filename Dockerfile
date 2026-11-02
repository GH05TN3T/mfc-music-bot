FROM alpine:3.22 AS bgutil-source
ARG BGUTIL_VERSION=2.0.2
RUN apk add --no-cache curl tar \
  && mkdir -p /src \
  && curl -fsSL "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz" \
    | tar -xz --strip-components=1 -C /src

FROM node:22-bookworm-slim AS bgutil-build
WORKDIR /opt/bgutil
COPY --from=bgutil-source /src/server/ ./
RUN npm ci --no-audit --no-fund \
  && npx tsc --project tsconfig.json

FROM denoland/deno:debian-2.9.5 AS deno-runtime

FROM node:22-bookworm-slim
ARG LAVALINK_VERSION=4.2.2
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    openjdk-17-jre-headless \
    python3 \
    python3-venv \
    supervisor \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /opt/lavalink /var/lib/music-bot/lavalink/plugins /var/lib/music-bot/tmp \
  && chown -R node:node /opt/lavalink /var/lib/music-bot

COPY --from=deno-runtime /usr/bin/deno /usr/local/bin/deno
COPY --from=bgutil-build /opt/bgutil/build /opt/bgutil/build
COPY --from=bgutil-build /opt/bgutil/node_modules /opt/bgutil/node_modules
COPY --from=bgutil-build /opt/bgutil/package.json /opt/bgutil/package.json

RUN curl -fsSL \
    "https://github.com/lavalink-devs/Lavalink/releases/download/${LAVALINK_VERSION}/Lavalink.jar" \
    -o /opt/lavalink/Lavalink.jar \
  && python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/yt-dlp/bin/pip install --no-cache-dir yt-dlp bgutil-ytdlp-pot-provider==2.0.2 \
  && chown -R node:node /opt/lavalink /opt/yt-dlp /opt/bgutil /var/lib/music-bot

WORKDIR /opt/music-bot
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node config ./config
COPY config/supervisord.conf /etc/supervisor/supervisord.conf

ENV PATH="/opt/yt-dlp/bin:/usr/local/bin:/usr/bin:/bin" \
  MUSIC_DATA_DIR=/var/lib/music-bot \
  YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp \
  DENO_PATH=/usr/local/bin/deno \
  YT_COOKIES_PATH=/run/secrets/youtube-cookies.txt \
  POT_PROVIDER_URL=http://127.0.0.1:4416 \
  RESOLVER_URL=http://127.0.0.1:4417 \
  LAVALINK_HOST=127.0.0.1 \
  LAVALINK_PORT=2333

USER node
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
