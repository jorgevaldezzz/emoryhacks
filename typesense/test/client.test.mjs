import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminClient, ConfigError, parseNodes, searchClient } from '../src/client.mjs';

const env = { TYPESENSE_URL: 'http://localhost:8108', TYPESENSE_SEARCH_KEY: 'search', TYPESENSE_ADMIN_KEY: 'admin' };

test('parseNodes handles host, port and protocol', () => {
  assert.deepEqual(parseNodes('http://localhost:8108'), [{ host: 'localhost', port: 8108, protocol: 'http' }]);
  assert.deepEqual(parseNodes('https://x.a1.typesense.net'), [{ host: 'x.a1.typesense.net', port: 443, protocol: 'https' }]);
});

test('parseNodes accepts a cluster and a path prefix', () => {
  const nodes = parseNodes('https://a.net:443/ts , https://b.net:443');
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].path, '/ts');
  assert.equal(nodes[1].path, undefined);
});

test('parseNodes rejects nonsense with a ConfigError', () => {
  assert.throws(() => parseNodes('not a url'), ConfigError);
  assert.throws(() => parseNodes('ftp://x.net'), /http or https/);
  assert.throws(() => parseNodes('  '), /empty/);
});

test('the search client prefers the search key and never the admin key alone', () => {
  assert.equal(searchClient({ env }).configuration.apiKey, 'search');
  // Falls back so a fresh checkout works before anyone mints a scoped key.
  assert.equal(searchClient({ env: { ...env, TYPESENSE_SEARCH_KEY: '' } }).configuration.apiKey, 'admin');
  assert.throws(() => searchClient({ env: { TYPESENSE_URL: env.TYPESENSE_URL } }), ConfigError);
});

test('the search client is quiet and quick, because it runs inside a live call', () => {
  const { configuration } = searchClient({ env });
  assert.equal(configuration.logLevel, 'error', 'retry chatter must not reach stdout during a call');
  assert.ok(configuration.connectionTimeoutSeconds <= 3, 'a slow answer is worse than no answer');
});

test('the admin client refuses to fall back to the search key', () => {
  assert.equal(adminClient({ env }).configuration.apiKey, 'admin');
  assert.throws(
    () => adminClient({ env: { TYPESENSE_URL: env.TYPESENSE_URL, TYPESENSE_SEARCH_KEY: 'search' } }),
    /TYPESENSE_ADMIN_KEY is not set/,
  );
});
