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

# Install prod deps deterministically. Puppeteer downloads its Chromium here.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Run as the non-root user that ships with the node image.
USER node

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "./bin/www"]
