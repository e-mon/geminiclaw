FROM us-docker.pkg.dev/gemini-code-dev/gemini-cli/sandbox:latest

# Install agent-browser for browser automation
RUN npm install -g agent-browser

# Pre-install Playwright browsers (Chromium only for size)
RUN npx playwright install chromium --with-deps 2>/dev/null || true
