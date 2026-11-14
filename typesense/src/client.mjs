// Typesense connections, built from the environment.
//
// Two of them, deliberately: writes need the admin key and must stay on a
// server, reads can use a search-only key that is safe to ship to the website.
import { Client, Errors } from 'typesense';

export const COLLECTION = 'photo_spots';
export const DEFAULT_URL = 'http://localhost:8108';

/** Thrown when the environment is missing something we cannot guess. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse TYPESENSE_URL into the node list the client wants. Accepts a
 * comma-separated list for a multi-node cluster.
 */
export function parseNodes(urls = DEFAULT_URL) {
  const list = String(urls)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (list.length === 0) throw new ConfigError('TYPESENSE_URL is empty.');

  return list.map(one => {
    let url;
    try {
      url = new URL(one);
    } catch {
      throw new ConfigError(
        `TYPESENSE_URL is not a URL: ${one}. Expected something like ${DEFAULT_URL}.`,
      );
    }
    const protocol = url.protocol.replace(':', '');
    if (protocol !== 'http' && protocol !== 'https') {
      throw new ConfigError(`TYPESENSE_URL must be http or https, got ${protocol}.`);
    }
    const node = {
      host: url.hostname,
      port: Number(url.port || (protocol === 'https' ? 443 : 80)),
      protocol,
    };
    const path = url.pathname.replace(/\/+$/, '');
    if (path) node.path = path;
    return node;
  });
}

function build({ apiKey, url, timeoutSeconds, retries, logLevel }) {
  return new Client({
    nodes: parseNodes(url),
    apiKey,
    connectionTimeoutSeconds: timeoutSeconds,
    numRetries: retries,
    retryIntervalSeconds: 0.2,
    // The client narrates every retry on stdout by default. This runs inside a
    // live voice call, so keep it quiet: we report failures ourselves, through
    // the return value of findNearbySpots.
    logLevel: logLevel ?? 'error',
  });
}

/**
 * Read-only client. Prefers TYPESENSE_SEARCH_KEY and falls back to the admin
 * key so a fresh checkout works before anyone has generated a scoped key.
 *
 * Short timeout on purpose: this sits inside a live voice call, where a slow
 * answer is worse than no answer.
 */
export function searchClient({ env = process.env, timeoutSeconds = 3, retries = 1, logLevel } = {}) {
  const apiKey = env.TYPESENSE_SEARCH_KEY || env.TYPESENSE_ADMIN_KEY;
  if (!apiKey) {
    throw new ConfigError(
      'No Typesense key. Set TYPESENSE_SEARCH_KEY (or TYPESENSE_ADMIN_KEY) in .env.local.',
    );
  }
  return build({ apiKey, url: env.TYPESENSE_URL || DEFAULT_URL, timeoutSeconds, retries, logLevel });
}

/**
 * Read-write client for the seeding scripts. Admin key only, never the search
 * key, and never from browser code.
 */
export function adminClient({ env = process.env, timeoutSeconds = 30, retries = 2, logLevel = 'warn' } = {}) {
  const apiKey = env.TYPESENSE_ADMIN_KEY;
  if (!apiKey) {
    throw new ConfigError(
      'TYPESENSE_ADMIN_KEY is not set. Copy .env.example to .env.local and fill it in.',
    );
  }
  return build({ apiKey, url: env.TYPESENSE_URL || DEFAULT_URL, timeoutSeconds, retries, logLevel });
}

/** True when the error means "that collection does not exist yet". */
export function isMissing(error) {
  return error instanceof Errors.ObjectNotFound;
}

/** The address we are talking to, for log lines and error messages. */
export function describeTarget(env = process.env) {
  return env.TYPESENSE_URL || DEFAULT_URL;
}
