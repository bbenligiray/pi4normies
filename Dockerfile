FROM ubuntu:24.04

# Base tooling. ripgrep and fd-find are what pi downloads on first run;
# installing them here (fd-find provides `fdfind`, which pi detects) skips that.
# ffmpeg, python and poppler-utils (pdftotext etc.) are not needed by pi
# itself, but so many one-off tasks (media, documents, data) need them that it's
# worth sparing the agent the install every job; web_fetch also uses pdftotext
# for PDFs. Anything else the agent installs itself, with sudo.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git sudo less jq zip unzip \
      ripgrep fd-find \
      ffmpeg python3 python3-pip python3-venv poppler-utils \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y nodejs \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Headless browser for the bundled `browser` extension. Installing Google
# Chrome via its .deb pulls in the shared libraries a bare ubuntu image lacks;
# fonts keep screenshots from rendering tofu boxes. amd64 only (Google ships no
# arm64 Linux Chrome), which is what Codespaces runs on.
RUN curl -fsSL -o /tmp/chrome.deb \
      https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      /tmp/chrome.deb fonts-liberation fonts-noto-color-emoji \
 && rm /tmp/chrome.deb \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
# Used by the browser extension; also honoured by puppeteer/playwright-style
# tooling the agent might install, so nothing re-downloads Chrome.
ENV CHROME_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# The codespace user is the stock `ubuntu` user (uid 1000) with passwordless
# sudo, so the agent can apt-get whatever a task needs.
RUN echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu \
 && chmod 0440 /etc/sudoers.d/ubuntu

# Global npm installs and pip installs go to ~/.local for the ubuntu user, so
# neither pi's own update (post-create) nor the agent needs sudo for them.
# The codespace is throwaway, so let pip install outside a venv (PEP 668).
ENV NPM_CONFIG_PREFIX=/home/ubuntu/.local
ENV PATH=/home/ubuntu/.local/bin:$PATH
ENV PIP_BREAK_SYSTEM_PACKAGES=1
# pi is updated on every codespace creation instead (scripts/post-create).
ENV PI_SKIP_VERSION_CHECK=1

COPY extensions /opt/pi/extensions
# The browser extension's web_fetch needs a few npm packages (Readability,
# linkedom, Turndown), pinned by its package-lock.json.
RUN cd /opt/pi/extensions/browser && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chmod=755 scripts/pi-start scripts/post-create /usr/local/bin/
# User-level pi config: OpenRouter + default model, bundled extensions, and the
# standing instructions (AGENTS.md) for working with non-technical users.
COPY config /opt/pi/config

USER ubuntu
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
 && mkdir -p /home/ubuntu/.pi/agent \
 && cp /opt/pi/config/settings.json /opt/pi/config/AGENTS.md /home/ubuntu/.pi/agent/
