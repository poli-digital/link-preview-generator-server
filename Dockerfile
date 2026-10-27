# The fast path is pure fetch + parse (no browser). The Puppeteer fallback is
# ON by default (for JS-rendered / bot-protected pages), so the image ships with
# Chromium's runtime libs. Disable the fallback with PUPPETEER_FALLBACK=false if
# you want a slimmer footprint.
FROM node:20-slim

# dumb-init reaps zombies and forwards signals so SIGTERM triggers graceful shutdown.
# The rest are the shared libraries Chromium needs to launch headless.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		dumb-init \
		ca-certificates \
		fonts-liberation \
		libasound2 \
		libatk-bridge2.0-0 \
		libatk1.0-0 \
		libc6 \
		libcairo2 \
		libcups2 \
		libdbus-1-3 \
		libexpat1 \
		libgbm1 \
		libglib2.0-0 \
		libgtk-3-0 \
		libnspr4 \
		libnss3 \
		libpango-1.0-0 \
		libx11-6 \
		libx11-xcb1 \
		libxcb1 \
		libxcomposite1 \
		libxcursor1 \
		libxdamage1 \
		libxext6 \
		libxfixes3 \
		libxi6 \
		libxrandr2 \
		libxrender1 \
		libxss1 \
		libxtst6 \
		xdg-utils \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Chrome cache lives in node's home so the BUILD-time download (runs as root) and
# the RUNTIME lookup (USER node) agree. Without this, Chromium lands in
# /root/.cache/puppeteer and the node user looks in /home/node/.cache/puppeteer
# and reports "Could not find Chrome". Kept writable so the runtime self-heal
# (lib/puppeteerFallback.js) can re-download if the binary is ever missing.
ENV PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer

# Install prod deps deterministically. Puppeteer downloads its Chromium into
# PUPPETEER_CACHE_DIR during postinstall.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
	&& mkdir -p /home/node/.cache/puppeteer \
	&& chown -R node:node /home/node/.cache /usr/src/app

COPY --chown=node:node . .

# Run as the non-root user that ships with the node image.
USER node

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "./bin/www"]
