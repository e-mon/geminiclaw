# GeminiClaw sandbox.Dockerfile
#
# Self-contained sandbox image that works on both amd64 and arm64.
# Uses node:20-bookworm as the base instead of the official Gemini CLI
# sandbox image (which is amd64-only as of 2026-03).
#
# Gemini CLI is NOT installed inside the container — it is bind-mounted
# from the host via SANDBOX_MOUNTS along with the GeminiClaw dist/ tree.
# The host's patched node_modules/.bin/gemini is exposed in PATH via
# SANDBOX_ENV set by buildDockerEnv() in acp/client.ts.
#
# Built automatically by ensureSandboxImage() at server startup.
# Force rebuild: geminiclaw sandbox rebuild
ARG BASE_IMAGE=node:20-bookworm
FROM ${BASE_IMAGE}

USER root

# ── SANDBOX marker ───────────────────────────────────────────────
# Gemini CLI checks this env var to detect it's already inside a sandbox
# and skip the re-exec loop.
ENV SANDBOX=geminiclaw-sandbox
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global

# ── System packages ────────────────────────────────────────────────
# - git: workspace operations, git-based tools
# - curl, ca-certificates: network access for MCP servers / web fetch
# - chromium: headless browser for agent-browser skill
# - poppler-utils: pdftotext / pdftoppm for pdf skill
# - tesseract-ocr: OCR engine for scanned PDFs (pdf skill)
# - gh: GitHub CLI for github skill
# - python3: scripting support for agent skills
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        chromium \
        poppler-utils \
        tesseract-ocr \
        gh \
        python3 \
        python3-venv \
        jq \
        sudo \
    && echo '%sudo ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers \
    && usermod -aG sudo node \
    && rm -rf /var/lib/apt/lists/*

# ── agent-browser (Rust-native CDP backend) ────────────────────────
# Global install inside the container so shell_exec can find it.
RUN npm install -g agent-browser@latest 2>/dev/null || true

# ── Chromium path for agent-browser ────────────────────────────────
# agent-browser native backend looks for Chrome/Chromium in standard paths.
ENV CHROME_PATH=/usr/bin/chromium
ENV AGENT_BROWSER_NATIVE=1

# ── uv (fast Python package manager) ─────────────────────────────
# Replaces pip for in-container Python package management.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh 2>/dev/null || true
ENV PATH="/usr/local/share/npm-global/bin:/home/node/.local/bin:/root/.local/bin:${PATH}"

# ── Writable directories for GeminiClaw ────────────────────────────
# The container user (node) needs write access to these paths.
# ~/.geminiclaw is mounted from host but may not exist yet.
RUN mkdir -p /home/node/.geminiclaw /home/node/.cache /home/node/.bun && \
    chown -R node:node /home/node/.geminiclaw /home/node/.cache /home/node/.bun

# ── Entrypoint (matches official sandbox image) ──────────────────
# The official image uses docker-entrypoint.sh from node base image.
# node:20-bookworm already includes it.

USER node
