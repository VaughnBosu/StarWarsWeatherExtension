import { describe, expect, test } from 'bun:test';
import { UpstreamError } from '../src/errors.js';
import { createWeatherService } from '../src/service.js';
import { baseConfig, MemoryStore, MetricCollector, weatherPayload } from './helpers.js';

const nowMs = Date.parse('2026-08-29T16:10:00Z');
const nowSeconds = Math.floor(nowMs / 1000);
const weatherRequest = { kind: 'weather', route: 'Weather', lat: 42.33, lon: -83.05 };

const make = ({ store = new MemoryStore(), provider = {}, config = baseConfig, now = () => nowMs } = {}) => {
  const metrics = new MetricCollector();
  const service = createWeatherService({
    store,
    provider,
    config,
    now,
    sleep: async () => {},
    owner: () => 'lease-owner'
  });
  return {
    store,
    provider,
    metrics,
    execute: (request, requestContext) => service(request, metrics, requestContext)
  };
};

describe('cache, quota, and upstream orchestration', () => {
  test('serves a fresh shared weather hit without reserving provider quota', async () => {
    const store = new MemoryStore();
    store.items.set('WX#42.33#-83.05', {
      payload: weatherPayload,
      negative: false,
      freshUntil: nowSeconds + 600,
      staleUntil: nowSeconds + 10000
    });
    const provider = { weather: () => { throw new Error('should not run'); } };
    const context = make({ store, provider });
    const result = await context.execute(weatherRequest);

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ stale: false, cacheStatus: 'fresh-hit', weather: weatherPayload.weather });
    expect(result.body.freshUntil).toBe(new Date((nowSeconds + 600) * 1000).toISOString());
    expect(context.metrics.values).toMatchObject({ CacheFreshHit: 1 });
    expect(store.calls.some(([name]) => name === 'quota')).toBe(false);
  });

  test('reserves quota, refreshes once, and writes a 20-minute weather item', async () => {
    let upstreamCalls = 0;
    const provider = { weather: async () => { upstreamCalls += 1; return weatherPayload; } };
    const context = make({ provider });
    const result = await context.execute(weatherRequest);

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ cacheStatus: 'refreshed', stale: false });
    expect(upstreamCalls).toBe(1);
    const put = context.store.calls.find(([name]) => name === 'put')[1];
    expect(put).toMatchObject({
      key: 'WX#42.33#-83.05',
      owner: 'lease-owner',
      freshUntil: nowSeconds + 1200,
      staleUntil: nowSeconds + 21600
    });
    expect(context.metrics.values).toMatchObject({
      CacheMiss: 1,
      QuotaReservation: 1,
      UpstreamAttempt: 1,
      UpstreamSuccess: 1,
      CacheWriteSuccess: 1
    });
  });

  test.each([
    ['rate_limited', 'UpstreamResponse429'],
    ['server_error', 'UpstreamResponse5xx'],
    ['timeout', 'UpstreamTimeout'],
    ['network_error', 'UpstreamNetworkError'],
    ['invalid_response', 'UpstreamInvalidResponse']
  ])('serves stale weather and records an exact %s provider outcome', async (kind, metric) => {
    const store = new MemoryStore();
    store.items.set('WX#42.33#-83.05', {
      payload: weatherPayload,
      negative: false,
      freshUntil: nowSeconds - 1,
      staleUntil: nowSeconds + 3600
    });
    const context = make({
      store,
      provider: { weather: async () => { throw new UpstreamError(kind); } }
    });
    const result = await context.execute(weatherRequest);

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ stale: true, cacheStatus: 'stale-upstream-error' });
    expect(result.headers.Warning).toContain('stale');
    expect(context.metrics.values).toMatchObject({ UpstreamAttempt: 1, [metric]: 1, CacheStaleServed: 1 });
  });

  test('returns a sanitized 503 when an upstream failure has no stale value', async () => {
    const context = make({ provider: { weather: async () => { throw new UpstreamError('rate_limited', 429); } } });
    const result = await context.execute(weatherRequest);
    expect(result).toMatchObject({
      statusCode: 503,
      body: { code: 'temporarily_unavailable' },
      headers: { 'Retry-After': '60' }
    });
    expect(JSON.stringify(result)).not.toContain('rate_limited');
    expect(context.store.calls).toContainEqual(['cooldown', {
      nowEpochSeconds: nowSeconds,
      cooldownSeconds: 60
    }]);
    expect(context.metrics.values.ProviderCooldownStarted).toBe(1);
  });

  test('a hard quota denial suppresses upstream and reports its exact window', async () => {
    const store = new MemoryStore();
    store.reservation = { allowed: false, deniedWindow: 'cooldown', retryAfterSeconds: 37 };
    let upstreamCalls = 0;
    const context = make({ store, provider: { weather: async () => { upstreamCalls += 1; } } });
    const result = await context.execute(weatherRequest);
    expect(result).toMatchObject({ statusCode: 503, headers: { 'Retry-After': '37' } });
    expect(upstreamCalls).toBe(0);
    expect(context.metrics.values).toMatchObject({
      UpstreamSuppressedQuota: 1,
      ProviderBudgetRefused: 1,
      QuotaCooldownDenied: 1
    });
  });

  test('lease contention serves stale immediately and never calls upstream', async () => {
    const store = new MemoryStore();
    store.acquire = false;
    store.items.set('WX#42.33#-83.05', {
      payload: weatherPayload,
      negative: false,
      freshUntil: nowSeconds - 5,
      staleUntil: nowSeconds + 500
    });
    let upstreamCalls = 0;
    const context = make({ store, provider: { weather: async () => { upstreamCalls += 1; } } });
    const result = await context.execute(weatherRequest);
    expect(result.body).toMatchObject({ stale: true, cacheStatus: 'stale-while-refresh' });
    expect(upstreamCalls).toBe(0);
    expect(context.metrics.values.CacheLeaseContended).toBe(1);
  });

  test('lease contention on a cold key waits briefly for the winning refresh', async () => {
    const store = new MemoryStore();
    store.acquire = false;
    store.readSequence.push(null, {
      payload: weatherPayload,
      negative: false,
      freshUntil: nowSeconds + 1200,
      staleUntil: nowSeconds + 21600
    });
    const context = make({ store, provider: {} });
    const result = await context.execute(weatherRequest);
    expect(result.body.cacheStatus).toBe('coalesced-hit');
    expect(context.metrics.values.CacheWaitHit).toBe(1);
  });

  test('caches empty search results for one day under a hashed key', async () => {
    const context = make({ provider: { search: async () => [] } });
    const request = { kind: 'search', route: 'Search', query: 'Atlantis', normalizedQuery: 'atlantis', limit: 5 };
    const first = await context.execute(request);
    const put = context.store.calls.find(([name]) => name === 'put')[1];
    expect(first.body).toEqual({ locations: [] });
    expect(put.negative).toBe(true);
    expect(put.freshUntil - nowSeconds).toBe(86400);
    expect(put.key.startsWith('SEARCH#')).toBe(true);
    expect(put.key).not.toContain('atlantis');

    const secondMetrics = new MetricCollector();
    const secondService = createWeatherService({
      store: context.store,
      provider: { search: () => { throw new Error('should not run'); } },
      config: baseConfig,
      now: () => nowMs,
      owner: () => 'other'
    });
    expect((await secondService(request, secondMetrics)).body).toEqual({ locations: [] });
    expect(secondMetrics.values).toMatchObject({ CacheFreshHit: 1, CacheNegativeHit: 1 });
  });

  test('returns successful provider data even if the cache write fails', async () => {
    const store = new MemoryStore();
    store.putError = new Error('dynamo unavailable');
    const context = make({ store, provider: { weather: async () => weatherPayload } });
    const result = await context.execute(weatherRequest);
    expect(result.statusCode).toBe(200);
    expect(context.metrics.values.CacheWriteError).toBe(1);
    expect(store.calls.some(([name]) => name === 'release')).toBe(true);
  });

  test('a slow refresh cannot overwrite a newer lease owner', async () => {
    const store = new MemoryStore();
    store.putResult = false;
    const context = make({ store, provider: { weather: async () => weatherPayload } });
    const result = await context.execute(weatherRequest);
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ cacheStatus: 'refreshed', weather: weatherPayload.weather });
    expect(context.metrics.values.CacheWriteConflict).toBe(1);
    expect(context.metrics.values.CacheWriteSuccess).toBeUndefined();
  });

  test('records provider credential rejection separately from other 4xx responses', async () => {
    const context = make({
      provider: { weather: async () => { throw new UpstreamError('client_error', 401); } }
    });
    expect((await context.execute(weatherRequest)).statusCode).toBe(503);
    expect(context.metrics.values.UpstreamAuthDenied).toBe(1);
    expect(context.metrics.values.UpstreamResponse4xx).toBeUndefined();
  });

  test('a client cannot monopolize upstream misses, while fresh shared hits bypass the client limiter', async () => {
    const store = new MemoryStore();
    store.clientReservation = { allowed: false, retryAfterSeconds: 41 };
    let upstreamCalls = 0;
    const config = {
      ...baseConfig,
      clientUpstreamLimit: 30,
      clientUpstreamWindowSeconds: 300,
      clientRatePepper: '0123456789abcdef0123456789abcdef'
    };
    const context = make({
      store,
      config,
      provider: { weather: async () => { upstreamCalls += 1; return weatherPayload; } }
    });

    const denied = await context.execute(weatherRequest, { clientIp: '203.0.113.10' });
    expect(denied).toMatchObject({
      statusCode: 429,
      body: { code: 'rate_limited' },
      headers: { 'Retry-After': '41' }
    });
    expect(upstreamCalls).toBe(0);
    const reservation = store.calls.find(([name]) => name === 'clientQuota')[1];
    expect(reservation.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(reservation)).not.toContain('203.0.113.10');
    expect(context.metrics.values.ClientUpstreamRateRefused).toBe(1);

    store.items.set('WX#42.33#-83.05', {
      payload: weatherPayload,
      negative: false,
      freshUntil: nowSeconds + 600,
      staleUntil: nowSeconds + 10000
    });
    const callCount = store.calls.filter(([name]) => name === 'clientQuota').length;
    expect((await context.execute(weatherRequest, { clientIp: '203.0.113.10' })).statusCode).toBe(200);
    expect(store.calls.filter(([name]) => name === 'clientQuota').length).toBe(callCount);
  });

  test('client rate limiting fails closed for cold misses without exposing the address', async () => {
    const config = {
      ...baseConfig,
      clientUpstreamLimit: 30,
      clientUpstreamWindowSeconds: 300,
      clientRatePepper: '0123456789abcdef0123456789abcdef'
    };
    const context = make({ config, provider: { weather: async () => weatherPayload } });
    const result = await context.execute(weatherRequest);
    expect(result).toMatchObject({ statusCode: 503, headers: { 'Retry-After': '5' } });
    expect(context.metrics.values.ClientIdentityMissing).toBe(1);
    expect(context.store.calls.some(([name]) => name === 'quota')).toBe(false);
  });

  test('client fingerprints rotate at the fixed-window boundary', async () => {
    const config = {
      ...baseConfig,
      clientUpstreamLimit: 60,
      clientUpstreamWindowSeconds: 300,
      clientRatePepper: '0123456789abcdef0123456789abcdef'
    };
    const first = make({
      config,
      now: () => 1001 * 1000,
      provider: { weather: async () => weatherPayload }
    });
    const second = make({
      config,
      now: () => 1201 * 1000,
      provider: { weather: async () => weatherPayload }
    });

    await first.execute(weatherRequest, { clientIp: '203.0.113.10' });
    await second.execute(weatherRequest, { clientIp: '203.0.113.10' });

    const firstFingerprint = first.store.calls.find(([name]) => name === 'clientQuota')[1].fingerprint;
    const secondFingerprint = second.store.calls.find(([name]) => name === 'clientQuota')[1].fingerprint;
    expect(firstFingerprint).not.toBe(secondFingerprint);
  });

  test('an exhausted daily budget is remembered so later misses skip every DynamoDB write', async () => {
    const store = new MemoryStore();
    store.reservation = { allowed: false, deniedWindow: 'day' };
    const context = make({ store, provider: { weather: async () => weatherPayload } });

    const first = await context.execute(weatherRequest);
    expect(first.statusCode).toBe(503);
    const writesAfterFirst = store.calls.filter(([name]) => name !== 'get').length;

    store.items.set('WX#42.33#-83.05', {
      payload: weatherPayload,
      negative: false,
      freshUntil: nowSeconds - 5,
      staleUntil: nowSeconds + 500
    });
    const second = await context.execute(weatherRequest);
    expect(second.body).toMatchObject({ stale: true, cacheStatus: 'stale-quota-limit' });
    const cold = await context.execute({ ...weatherRequest, lat: 10.5 });
    // Retry-After is capped so clients re-check well before the UTC day reopens.
    expect(cold).toMatchObject({ statusCode: 503, headers: { 'Retry-After': '300' } });
    expect(store.calls.filter(([name]) => name !== 'get').length).toBe(writesAfterFirst);
    expect(context.metrics.values.QuotaKnownBlocked).toBe(2);
  });

  test('the remembered budget refusal ends when the UTC day rolls over', async () => {
    const store = new MemoryStore();
    store.reservation = { allowed: false, deniedWindow: 'day' };
    let clock = Date.parse('2026-08-29T23:59:00Z');
    const context = make({ store, now: () => clock, provider: { weather: async () => weatherPayload } });
    await context.execute(weatherRequest);

    store.reservation = { allowed: true };
    clock = Date.parse('2026-08-30T00:00:01Z');
    const result = await context.execute(weatherRequest);
    expect(result.body).toMatchObject({ cacheStatus: 'refreshed' });
  });

  test('a provider 429 blocks this container for the cooldown without another quota read', async () => {
    const store = new MemoryStore();
    let upstreamCalls = 0;
    const context = make({
      store,
      provider: { weather: async () => { upstreamCalls += 1; throw new UpstreamError('rate_limited', 429); } }
    });
    await context.execute(weatherRequest);
    const quotaReads = store.calls.filter(([name]) => name === 'quota').length;
    const result = await context.execute(weatherRequest);
    expect(result).toMatchObject({ statusCode: 503, headers: { 'Retry-After': '60' } });
    expect(upstreamCalls).toBe(1);
    expect(store.calls.filter(([name]) => name === 'quota').length).toBe(quotaReads);
  });

  test('a short rate-token refusal is not remembered', async () => {
    const store = new MemoryStore();
    store.reservation = { allowed: false, deniedWindow: 'rate', retryAfterSeconds: 2 };
    const context = make({ store, provider: { weather: async () => weatherPayload } });
    await context.execute(weatherRequest);
    store.reservation = { allowed: true };
    expect((await context.execute(weatherRequest)).body).toMatchObject({ cacheStatus: 'refreshed' });
  });

  test('a lease waiter stops polling once the winner releases without writing', async () => {
    const store = new MemoryStore();
    store.acquire = false;
    store.readSequence.push(null, { leaseOwner: 'winner', leaseUntil: nowSeconds + 5 }, { pk: 'WX#42.33#-83.05' });
    const config = { ...baseConfig, leaseWaitAttempts: 8 };
    const context = make({ store, config, provider: {} });
    const result = await context.execute(weatherRequest);
    expect(result.statusCode).toBe(503);
    expect(store.calls.filter(([name]) => name === 'get').length).toBe(3);
    expect(context.metrics.values.CacheWaitAbandoned).toBe(1);
  });

  test('a source IP over its UTC-day miss budget is refused before the provider budget', async () => {
    const store = new MemoryStore();
    const config = {
      ...baseConfig,
      clientUpstreamLimit: 60,
      clientUpstreamWindowSeconds: 300,
      clientUpstreamDailyLimit: 300,
      clientRatePepper: '0123456789abcdef0123456789abcdef'
    };
    const reservations = [];
    store.reserveClientUpstream = async (input) => {
      reservations.push(input);
      return input.windowSeconds === 86400
        ? { allowed: false, retryAfterSeconds: 50000 }
        : { allowed: true, retryAfterSeconds: 0 };
    };
    const context = make({ store, config, provider: { weather: async () => weatherPayload } });
    const result = await context.execute(weatherRequest, { clientIp: '203.0.113.10' });

    expect(result).toMatchObject({ statusCode: 429, headers: { 'Retry-After': '3600' } });
    expect(reservations.map((input) => [input.windowSeconds, input.limit])).toEqual([[300, 60], [86400, 300]]);
    expect(reservations[0].fingerprint).not.toBe(reservations[1].fingerprint);
    expect(store.calls.some(([name]) => name === 'quota')).toBe(false);
    expect(context.metrics.values).toMatchObject({ ClientUpstreamRateRefused: 1, ClientUpstreamDailyRefused: 1 });
  });
});
