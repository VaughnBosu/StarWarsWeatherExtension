import { describe, expect, test } from 'bun:test';
import { UpstreamError } from '../src/errors.js';
import { ProviderClient } from '../src/provider.js';

const client = (fetchImpl, options = {}) => new ProviderClient({
  fetchImpl,
  apiKeyProvider: async () => 'secret-key',
  baseUrl: 'https://weather.invalid',
  timeoutMs: 50,
  maximumBytes: 1024,
  now: () => Date.parse('2026-08-29T16:10:00Z'),
  ...options
});

describe('provider adapter', () => {
  test('returns only the app-compatible weather fields in imperial units', async () => {
    let requestedUrl;
    const result = await client(async (url) => {
      requestedUrl = url;
      return Response.json({
        dt: 1788020000,
        main: { temp: 74.25, humidity: 61, pressure: 1000 },
        weather: [{ id: 800, main: 'Clear', description: 'clear sky', icon: '01d' }],
        wind: { speed: 5.5, deg: 180 },
        sys: { sunrise: 1787990000, sunset: 1788039000, country: 'us' },
        timezone: -14400,
        name: 'Detroit',
        ignored: 'never returned'
      });
    }).weather({ lat: 42.33, lon: -83.05 });

    expect(requestedUrl.searchParams.get('units')).toBe('imperial');
    expect(requestedUrl.searchParams.get('appid')).toBe('secret-key');
    expect(result.weather).toEqual({
      weather: [{ main: 'Clear', description: 'clear sky' }],
      main: { temp: 74.25, humidity: 61 },
      wind: { speed: 5.5 },
      sys: { sunrise: 1787990000, sunset: 1788039000, country: 'US' },
      timezone: -14400,
      name: 'Detroit'
    });
    expect(result.location).toEqual({ name: 'Detroit', state: '', country: 'US' });
    expect(result).not.toHaveProperty('ignored');
  });

  test('maps reverse and search results to a provider-neutral shape', async () => {
    const reverse = await client(async () => Response.json([
      { name: 'Montréal', state: 'Québec', country: 'ca', lat: 45.5, lon: -73.57, local_names: { en: 'Montreal' } }
    ])).reverse({ lat: 45.5, lon: -73.57 });
    expect(reverse).toEqual({ name: 'Montréal', state: 'Québec', country: 'CA', lat: 45.5, lon: -73.57 });

    const empty = await client(async () => Response.json([])).search({ query: 'Atlantis', limit: 5 });
    expect(empty).toEqual([]);
  });

  test.each([
    [429, 'rate_limited'],
    [503, 'server_error'],
    [401, 'client_error']
  ])('classifies HTTP %s without exposing a response body', async (status, kind) => {
    const promise = client(async () => new Response('private provider detail', { status }))
      .weather({ lat: 1, lon: 2 });
    await expect(promise).rejects.toMatchObject({ name: 'UpstreamError', kind });
  });

  test('invalidates only the rejected cached credential after a 401/403', async () => {
    const apiKeyProvider = async () => 'old-key';
    const rejected = [];
    apiKeyProvider.invalidate = (key) => rejected.push(key);
    await expect(client(async () => new Response('', { status: 401 }), { apiKeyProvider })
      .weather({ lat: 1, lon: 2 })).rejects.toMatchObject({ kind: 'client_error', statusCode: 401 });
    expect(rejected).toEqual(['old-key']);
  });

  test('classifies secret-loading failures as configuration errors', async () => {
    const apiKeyProvider = async () => { throw new Error('secret unavailable'); };
    await expect(client(async () => Response.json({}), { apiKeyProvider })
      .weather({ lat: 1, lon: 2 })).rejects.toMatchObject({ kind: 'configuration' });
  });

  test('rejects malformed and oversized successful responses', async () => {
    await expect(client(async () => Response.json({ main: { temp: 70 }, weather: [] }))
      .weather({ lat: 1, lon: 2 })).rejects.toBeInstanceOf(UpstreamError);
    await expect(client(async () => new Response('x'.repeat(2000)))
      .weather({ lat: 1, lon: 2 })).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  test('aborts a stalled request and classifies it as a timeout', async () => {
    const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    await expect(client(fetchImpl, { timeoutMs: 10 }).weather({ lat: 1, lon: 2 }))
      .rejects.toMatchObject({ kind: 'timeout' });
  });

  test('keeps the timeout active while reading the response body', async () => {
    const fetchImpl = async (_url, { signal }) => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: () => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('body stalled')), { once: true });
          })
        })
      }
    });
    await expect(client(fetchImpl, { timeoutMs: 10 }).weather({ lat: 1, lon: 2 }))
      .rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('provider search resilience', () => {
  test('drops a malformed search candidate instead of failing the whole query', async () => {
    const results = await client(async () => Response.json([
      { name: 'Detroit', state: 'Michigan', country: 'us', lat: 42.33, lon: -83.05 },
      { name: '', lat: 1, lon: 2 },
      { name: 'Detroit Lakes', country: 'us', lat: 'bad', lon: -95.85 }
    ])).search({ query: 'Detroit', limit: 5 });
    expect(results).toEqual([
      { name: 'Detroit', state: 'Michigan', country: 'US', lat: 42.33, lon: -83.05 }
    ]);
  });
});
