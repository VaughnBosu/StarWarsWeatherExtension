import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __testing,
  BackendRequestError,
  buildWeatherCoordinateKey,
  getReverseLocation,
  getWeather,
  normalizeLocationQuery,
  searchLocations
} from '../backend-client.js';
import { createFetchMock } from './testUtils.js';

const realFetch = globalThis.fetch;
const realBackendBaseUrl = globalThis.BACKEND_BASE_URL;

const VALID_WEATHER_RESPONSE = Object.freeze({
  weather: {
    weather: [{ main: 'Clear', description: 'clear sky' }],
    main: { temp: 74, humidity: 40 },
    wind: { speed: 6 },
    name: 'Detroit',
    sys: { country: 'US' }
  },
  observedAt: '2026-08-29T12:00:00.000Z',
  freshUntil: '2026-08-29T12:20:00.000Z',
  stale: false,
  cacheStatus: 'miss',
  location: { name: 'Detroit', state: 'Michigan', country: 'US' }
});

beforeEach(() => {
  globalThis.BACKEND_BASE_URL = 'https://weather.example.test';
});

afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch; else delete globalThis.fetch;
  if (realBackendBaseUrl) {
    globalThis.BACKEND_BASE_URL = realBackendBaseUrl;
  } else {
    delete globalThis.BACKEND_BASE_URL;
  }
});

describe('backend configuration', () => {
  test('requires a configured backend and never falls back to a provider key', async () => {
    delete globalThis.BACKEND_BASE_URL;
    await expect(getWeather(42.33, -83.05)).rejects.toMatchObject({
      code: 'backend_not_configured'
    });
  });

  test('rejects insecure non-local backend URLs', () => {
    globalThis.BACKEND_BASE_URL = 'http://weather.example.test';
    expect(() => __testing.getBackendBaseUrl()).toThrow('must use HTTPS');
  });
});

describe('weather requests', () => {
  test('uses the provider-neutral route and validates the response', async () => {
    globalThis.fetch = createFetchMock([{ json: VALID_WEATHER_RESPONSE }]);

    const result = await getWeather(42.33, -83.05);

    const url = new URL(globalThis.fetch.calls[0]);
    expect(url.pathname).toBe('/v1/weather');
    expect(url.searchParams.get('lat')).toBe('42.33');
    expect(url.searchParams.get('lon')).toBe('-83.05');
    expect(url.searchParams.has('appid')).toBe(false);
    expect(result.weather.main.temp).toBe(74);
    expect(result.location.name).toBe('Detroit');
    expect(result.observedAt).toBe('2026-08-29T12:00:00.000Z');
  });

  test('canonicalizes high-precision coordinates to the two-decimal weather grid', async () => {
    globalThis.fetch = createFetchMock([{ json: VALID_WEATHER_RESPONSE }]);

    await getWeather(42.331234567891, 1e-7);

    const url = new URL(globalThis.fetch.calls[0]);
    expect(url.searchParams.get('lat')).toBe('42.33');
    expect(url.searchParams.get('lon')).toBe('0');
    expect(buildWeatherCoordinateKey(42.331234567891, 1e-7)).toBe('42.33,0.00');
  });

  test('rejects a payload without temperature instead of interpreting it as zero', async () => {
    globalThis.fetch = createFetchMock([{
      json: {
        ...VALID_WEATHER_RESPONSE,
        weather: { weather: [{ main: 'Clear' }], main: {} }
      }
    }]);

    await expect(getWeather(42.33, -83.05)).rejects.toMatchObject({
      code: 'invalid_response'
    });
  });

  test('preserves retryable HTTP status details for stale fallback decisions', async () => {
    globalThis.fetch = createFetchMock([{ ok: false, status: 429 }]);

    await expect(getWeather(42.33, -83.05)).rejects.toMatchObject({
      status: 429,
      retryable: true,
      code: 'http_error'
    });
  });

  test('carries a delta-seconds Retry-After so clients can back off', async () => {
    globalThis.fetch = createFetchMock([{ ok: false, status: 503, headers: { 'Retry-After': '300' } }]);

    await expect(getWeather(42.33, -83.05)).rejects.toMatchObject({
      status: 503,
      retryable: true,
      retryAfterSeconds: 300
    });
  });

  test('reads an HTTP-date Retry-After and ignores a missing one', async () => {
    const inTwoMinutes = new Date(Date.now() + 120000).toUTCString();
    globalThis.fetch = createFetchMock([
      { ok: false, status: 429, headers: { 'Retry-After': inTwoMinutes } },
      { ok: false, status: 429 }
    ]);

    const first = await getWeather(42.33, -83.05).catch((error) => error);
    expect(first.retryAfterSeconds).toBeGreaterThanOrEqual(118);
    expect(first.retryAfterSeconds).toBeLessThanOrEqual(120);
    await expect(getWeather(42.33, -83.05)).rejects.toMatchObject({ retryAfterSeconds: null });
  });

  test('aborts a stalled request at the configured timeout', async () => {
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });

    const url = new URL('https://weather.example.test/v1/weather?lat=1&lon=2');
    await expect(__testing.requestJson(url, 5)).rejects.toMatchObject({
      code: 'timeout',
      retryable: true
    });
  });
});

describe('location requests', () => {
  test('keeps reverse lookups on the two-decimal place-name grid', async () => {
    globalThis.fetch = createFetchMock([{
      json: { location: { name: 'Detroit', state: 'Michigan', country: 'US' } }
    }]);

    await getReverseLocation(42.3319, -83.0458);

    const url = new URL(globalThis.fetch.calls[0]);
    expect(url.searchParams.get('lat')).toBe('42.33');
    expect(url.searchParams.get('lon')).toBe('-83.05');
  });

  test('coalesces two identical in-flight reverse lookups', async () => {
    let resolveFetch;
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    };

    const first = getReverseLocation(42.33, -83.05);
    const second = getReverseLocation(42.33, -83.05);
    await Promise.resolve();
    expect(calls).toBe(1);

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ location: { name: 'Detroit', state: 'Michigan', country: 'US' } })
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.name).toBe('Detroit');
  });

  test('normalizes search text and ignores malformed location entries', async () => {
    globalThis.fetch = createFetchMock([{
      json: {
        locations: [
          { name: 'Detroit', state: 'Michigan', country: 'US', lat: 42.33, lon: -83.05 },
          { name: 'Missing coordinates', country: 'US' }
        ]
      }
    }]);

    const results = await searchLocations('  Detroit   MI  ');
    const url = new URL(globalThis.fetch.calls[0]);
    expect(url.pathname).toBe('/v1/locations/search');
    expect(url.searchParams.get('q')).toBe('Detroit MI');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(results).toHaveLength(1);
  });

  test('bounds location queries before issuing a request', () => {
    expect(normalizeLocationQuery(' Detroit   MI ')).toBe('Detroit MI');
    expect(() => normalizeLocationQuery(' A ')).toThrow(BackendRequestError);
    expect(() => normalizeLocationQuery('')).toThrow(BackendRequestError);
    expect(() => normalizeLocationQuery('x'.repeat(81))).toThrow(BackendRequestError);
  });
});

describe('search queries the backend would reject', () => {
  test('resolve to no results without issuing a request', async () => {
    globalThis.fetch = createFetchMock([]);
    expect(await searchLocations('A')).toEqual([]);
    expect(await searchLocations('New York!')).toEqual([]);
    expect(globalThis.fetch.calls).toHaveLength(0);
  });

  test('normalizeLocationQuery applies the backend character contract', () => {
    expect(normalizeLocationQuery("St. John's")).toBe("St. John's");
    expect(normalizeLocationQuery('\u0628\u0646\u062f\u0631\u200c\u0639\u0628\u0627\u0633')).toContain('\u200c');
    expect(() => normalizeLocationQuery('Detroit?')).toThrow(BackendRequestError);
    expect(() => normalizeLocationQuery('De\u200btroit')).toThrow(BackendRequestError);
  });
});
