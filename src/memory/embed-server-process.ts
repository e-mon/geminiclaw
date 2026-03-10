/**
 * memory/embed-server-process.ts — Wait for the local embed-server to become healthy.
 *
 * The embed-server process itself is managed externally (Procfile / overmind).
 * This module only provides a health-check poller so that `geminiclaw start`
 * can block until the server is ready before accepting requests.
 */

const LOG_PREFIX = '[embed-server]';
const HEALTH_POLL_INTERVAL_MS = 1_000;
const HEALTH_POLL_TIMEOUT_MS = 120_000;

/**
 * Poll the embed-server /health endpoint until it responds 200.
 *
 * @throws After timeout if server never becomes healthy.
 */
export async function waitForEmbedServer(baseUrl: string): Promise<void> {
    // Already running? Return immediately.
    try {
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) {
            const health = (await res.json()) as Record<string, unknown>;
            process.stdout.write(`${LOG_PREFIX} Ready (backend=${health.backend}, dimensions=${health.dimensions})\n`);
            return;
        }
    } catch {
        // Not ready yet — fall through to polling
    }

    process.stdout.write(`${LOG_PREFIX} Waiting for embed-server at ${baseUrl}...\n`);

    const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
        try {
            const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
            if (res.ok) {
                const health = (await res.json()) as Record<string, unknown>;
                process.stdout.write(
                    `${LOG_PREFIX} Ready (backend=${health.backend}, dimensions=${health.dimensions})\n`,
                );
                return;
            }
        } catch {
            // Not ready yet — retry
        }
    }
    throw new Error(`${LOG_PREFIX} Server did not become healthy within ${HEALTH_POLL_TIMEOUT_MS / 1000}s`);
}
