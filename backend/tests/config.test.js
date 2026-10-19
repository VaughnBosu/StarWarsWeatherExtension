import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config.js';

describe('runtime configuration', () => {
  test('loads safe cache and quota defaults', () => {
    const config = loadConfig({ CACHE_TABLE_NAME: 'cache', PROVIDER_SECRET_ID: 'secret' });
    expect(config).toMatchObject({
      tableName: 'cache',
      upstreamTimeoutMs: 3000,
      weatherFreshSeconds: 1200,
      weatherStaleSeconds: 21600,
      placePositiveSeconds: 2592000,
      placeNegativeSeconds: 86400,
      quotaLimits: { minute: 48, burst: 6, day: 25000, month: 800000 },
      providerCooldownSeconds: 60,
      clientUpstreamLimit: 0,
      clientUpstreamWindowSeconds: 300
    });
  });

  test('requires a table and exactly one usable credential source', () => {
    expect(() => loadConfig({ PROVIDER_SECRET_ID: 'secret' })).toThrow('CACHE_TABLE_NAME');
    expect(() => loadConfig({ CACHE_TABLE_NAME: 'cache' })).toThrow('PROVIDER_SECRET_ID');
    expect(loadConfig({
      CACHE_TABLE_NAME: 'cache',
      PROVIDER_SECRET_ID: 'secret',
      PROVIDER_API_KEY: 'inline-wins'
    }).inlineApiKey).toBe('inline-wins');
  });

  test('rejects unsafe numeric settings', () => {
    expect(() => loadConfig({
      CACHE_TABLE_NAME: 'cache',
      PROVIDER_SECRET_ID: 'secret',
      UPSTREAM_TIMEOUT_MS: 'not-a-number'
    })).toThrow('UPSTREAM_TIMEOUT_MS');
    expect(() => loadConfig({
      CACHE_TABLE_NAME: 'cache',
      PROVIDER_SECRET_ID: 'secret',
      CLIENT_UPSTREAM_LIMIT: '30'
    })).toThrow('CLIENT_RATE_PEPPER');
  });
});
