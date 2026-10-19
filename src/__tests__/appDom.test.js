import { afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HYPERSPACE_MIN_MS } from '../config.js';
import {
  createLocalizationMock,
  installDom,
  installNavigator,
  installRuntimeMock,
  installStorageMock,
  teardownDom
} from './testUtils.js';
import {
  getPreferredUnit,
  setManualLocation,
  setPreferredUnit,
  writeWeatherCache,
  writeLastKnownWeather,
  STORAGE_KEYS
} from '../storage.js';

globalThis.__SWW_SKIP_INIT__ = true;

let app = null;

beforeAll(async () => {
  app = await import('../app.js');
});

beforeEach(() => {
  installStorageMock();
  installDom(`
    <div id="background"></div>
    <div id="test"></div>
    <div id="planet" tabindex="-1"></div>
    <div id="center1Text"></div>
    <div id="center3Text"></div>
    <div id="message"></div>
    <div id="description"></div>
    <div id="LastUpdated"></div>
    <div id="locationLabel"></div>
    <div id="loading"></div>
  `);
});

afterEach(() => {
  teardownDom();
  delete globalThis.localStorage;
});

describe('app DOM updates', () => {
  test('applyWeatherToUi updates core elements', () => {
    const localization = createLocalizationMock({
      location_display: { message: 'Showing weather in: $1' },
      last_updated_placeholder: { message: 'Last Updated: --' }
    });

    app.applyWeatherToUi({
      planetClass: 'tatooine',
      planetName: 'Tatooine',
      headingPrefix: "IT'S LIKE",
      headingSuffix: 'OUTSIDE',
      message: 'Hot',
      description: 'Dry',
      lastUpdated: new Date().toISOString(),
      lastUpdatedLabel: 'Last Updated: now',
      locationName: 'Austin',
      locationKey: 'auto',
      language: 'en',
      unit: 'fahrenheit',
      timeOfDay: 'afternoon',
      timeOfDayLabel: 'Afternoon'
    }, localization);

    expect(document.getElementById('background').className).toBe('tatooine');
    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
    expect(document.getElementById('message').innerText).toBe('Hot');
    expect(document.getElementById('description').innerText).toBe('Dry');
    expect(document.getElementById('LastUpdated').innerText).toBe('Last Updated: now');
    expect(document.getElementById('locationLabel').innerText).toBe('Showing weather in: Austin');
    expect(document.getElementById('test').style.display).toBe('none');
  });

  test('updateMessage wraps temperature in a temp-toggle control', () => {
    const localization = createLocalizationMock({
      temp_toggle_hint: { message: 'Click to switch units' }
    });

    app.updateMessage('90\u00B0F, It\'s a Hot Afternoon', {
      tempF: 90,
      tempC: 32,
      unit: 'fahrenheit'
    }, localization);

    const toggle = document.querySelector('#message .temp-toggle');
    expect(toggle).toBeTruthy();
    expect(toggle.textContent).toBe('90\u00B0F');
    expect(toggle.getAttribute('title')).toBe('Click to switch units');
    expect(toggle.className).toBe('temp-toggle');
  });

  test('handleTempToggle flips preferred unit and rebuilds message', async () => {
    const localization = createLocalizationMock({
      location_display: { message: 'Showing weather in: $1' },
      planet_tatooine_summary: { message: '$1, It\'s a Hot $2' },
      temp_toggle_hint: { message: 'Click to switch units' }
    });

    app.applyWeatherToUi({
      planetClass: 'tatooine',
      planetId: 'tatooine',
      planetName: 'Tatooine',
      headingPrefix: "IT'S LIKE",
      headingSuffix: 'OUTSIDE',
      message: '90\u00B0F, It\'s a Hot Afternoon',
      description: 'Dry',
      lastUpdated: new Date().toISOString(),
      lastUpdatedLabel: 'Last Updated: now',
      locationName: 'Austin',
      locationKey: 'auto',
      language: 'en',
      unit: 'fahrenheit',
      tempF: 90,
      tempC: 32,
      timeOfDay: 'afternoon',
      timeOfDayLabel: 'Afternoon'
    }, localization);

    expect(document.querySelector('#message .temp-toggle').textContent).toBe('90\u00B0F');

    await app.handleTempToggle();

    expect(getPreferredUnit()).toBe('celsius');
    expect(document.querySelector('#message .temp-toggle').textContent).toBe('32\u00B0C');
    expect(document.getElementById('message').innerText.includes('32\u00B0C')).toBe(true);
  });

  test('showLoadingState clears loading and sets placeholder', () => {
    const localization = createLocalizationMock({
      last_updated_placeholder: { message: 'Last Updated: --' },
      location_display: { message: 'Showing weather in: $1' },
      location_display_unknown: { message: 'Showing weather in: your area' }
    });
    document.getElementById('loading').innerText = 'Loading...';

    app.showLoadingState(localization, 'Paris');

    expect(document.getElementById('loading').innerText).toBe('');
    expect(document.getElementById('locationLabel').innerText).toBe('Showing weather in: Paris');
    expect(document.getElementById('LastUpdated').innerText).toBe('Last Updated: --');

    const video = document.querySelector('#test video');
    expect(video).toBeTruthy();
    expect(video.autoplay).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.preload).toBe('auto');
    expect(video.querySelector('source').getAttribute('src')).toBe('/public/assets/hyperspace.mp4');
    expect(video.querySelector('source').getAttribute('type')).toBe('video/mp4');

    app.showLoadingState(localization, 'Paris');
    expect(document.querySelectorAll('#test video')).toHaveLength(1);
  });

  test('showErrorState updates message and clears description', () => {
    const localization = createLocalizationMock({
      error_weather_unavailable: { message: 'Unable to retrieve weather data right now.' },
      last_updated_placeholder: { message: 'Last Updated: --' },
      location_display_unknown: { message: 'Showing weather in: your area' }
    });

    app.showErrorState(localization, null);

    expect(document.getElementById('message').innerText).toBe('Unable to retrieve weather data right now.');
    expect(document.getElementById('description').innerText).toBe('');
    expect(document.getElementById('LastUpdated').innerText).toBe('Last Updated: --');
  });

  test('applyOfflineFallback random planet clears hyperspace-style empty loading', () => {
    const localization = createLocalizationMock({
      offline_random_planet: { message: 'Sensors offline — signal lost. Displaying a random sector.' },
      offline_signal_lost: { message: 'Sensors offline — last known: $1' },
      center_heading_prefix: { message: "IT'S LIKE" },
      center_heading_suffix: { message: 'OUTSIDE' },
      location_display_unknown: { message: 'Showing weather in: your area' },
      time_of_day_morning: { message: 'Morning' },
      time_of_day_afternoon: { message: 'Afternoon' },
      time_of_day_evening: { message: 'Evening' },
      time_of_day_night: { message: 'Night' },
      time_of_day_pre_dawn: { message: 'Late Night' },
      planet_hoth_name: { message: 'Hoth' },
      planet_hoth_description: { message: 'Cold' },
      planet_kamino_name: { message: 'Kamino' },
      planet_kamino_description: { message: 'Rain' },
      planet_endor_name: { message: 'Endor' },
      planet_endor_description: { message: 'Fog' },
      planet_bespin_name: { message: 'Bespin' },
      planet_bespin_description: { message: 'Wind' },
      planet_scarif_name: { message: 'Scarif' },
      planet_scarif_description: { message: 'Beach' },
      planet_dagobah_name: { message: 'Dagobah' },
      planet_dagobah_description: { message: 'Swamp' },
      planet_naboo_name: { message: 'Naboo' },
      planet_naboo_description: { message: 'Mild' },
      planet_coruscant_name: { message: 'Coruscant' },
      planet_coruscant_description: { message: 'City' },
      planet_tatooine_name: { message: 'Tatooine' },
      planet_tatooine_description: { message: 'Desert' },
      planet_mustafar_name: { message: 'Mustafar' },
      planet_mustafar_description: { message: 'Lava' }
    });

    document.getElementById('background').className = 'hyperspace';
    document.getElementById('loading').innerText = 'Loading...';

    app.applyOfflineFallback(localization, 'en', 'fahrenheit');

    expect(document.getElementById('background').className).not.toBe('hyperspace');
    expect(document.getElementById('loading').innerText).toBe('');
    expect(document.getElementById('message').innerText).toContain('Sensors offline');
    expect(document.getElementById('LastUpdated').innerText).toContain('Sensors offline');
  });
});

const LOCALE_PATH = join(import.meta.dir, '..', '..', '_locales', 'en', 'messages.json');
const LOCALE_MESSAGES = JSON.parse(readFileSync(LOCALE_PATH, 'utf8'));

const AUSTIN = { latitude: 30.2672, longitude: -97.7431 };

/** Planet rules match this to Tatooine. */
const HOT_WEATHER = {
  weather: [{ main: 'Clear', description: 'clear sky' }],
  main: { temp: 90, humidity: 10 },
  wind: { speed: 5 },
  name: 'Austin',
  sys: { country: 'US', state: 'Texas' }
};

const LOCALE_ROUTE = { match: '_locales', json: LOCALE_MESSAGES };
const GEOCODE_ROUTE = {
  match: '/v1/locations/reverse',
  json: { location: { name: 'Austin', state: 'Texas', country: 'US' } }
};
const WEATHER_OK = {
  match: '/v1/weather',
  json: {
    weather: HOT_WEATHER,
    observedAt: new Date().toISOString(),
    freshUntil: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    stale: false,
    cacheStatus: 'miss'
  }
};

/**
 * Routes by URL because refreshWeather()'s request order shifts with the caches each
 * test seeds. Unmatched URLs reject like an unreachable network: TypeError, no status.
 */
function installFetchRouter(routes) {
  const calls = [];
  const fetchMock = async (input) => {
    const url = String(input);
    calls.push(url);

    const route = routes.find((entry) => url.includes(entry.match));
    if (!route || route.error) {
      throw route?.error ?? new TypeError('Failed to fetch');
    }

    return {
      ok: route.ok !== false,
      status: route.status ?? 200,
      headers: { get: (name) => route.headers?.[name] ?? null },
      json: async () => route.json ?? {}
    };
  };
  fetchMock.calls = calls;
  globalThis.fetch = fetchMock;
  return fetchMock;
}

/** Drain the promise chain of an event-triggered refresh, which nothing awaits. */
async function flushAsync(ticks = 50) {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

function seedLastKnownHoth(overrides = {}) {
  writeLastKnownWeather({
    planetId: 'hoth',
    planetName: 'Hoth',
    planetClass: 'hoth',
    message: "10°F, It's a Very Cold Afternoon",
    description: 'Ice',
    language: 'en',
    unit: 'fahrenheit',
    locationKey: 'auto',
    locationName: 'Austin, TX',
    tempF: 10,
    tempC: -12,
    timeOfDayLabel: 'Afternoon',
    lastUpdated: new Date().toISOString(),
    ...overrides
  });
}

describe('new tab render', () => {
  const realFetch = globalThis.fetch;
  const realNavigator = globalThis.navigator;
  const realSetTimeout = globalThis.setTimeout;
  const realBackendBaseUrl = globalThis.BACKEND_BASE_URL;

  beforeEach(() => {
    installRuntimeMock();
    globalThis.BACKEND_BASE_URL = 'https://weather.example.test';
    // skip the hyperspace hold, it's a UX floor and isn't under test
    globalThis.setTimeout = (callback) => {
      callback();
      return 0;
    };
    installNavigator(globalThis.window, {
      language: 'en-US',
      onLine: true,
      geolocation: {
        getCurrentPosition(success) {
          success({
            coords: { latitude: AUSTIN.latitude, longitude: AUSTIN.longitude, accuracy: 50 },
            timestamp: Date.now()
          });
        }
      }
    });
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.browser;
    if (realFetch) {
      globalThis.fetch = realFetch;
    } else {
      delete globalThis.fetch;
    }
    if (realNavigator) {
      globalThis.navigator = realNavigator;
    } else {
      delete globalThis.navigator;
    }
    if (realBackendBaseUrl) {
      globalThis.BACKEND_BASE_URL = realBackendBaseUrl;
    } else {
      delete globalThis.BACKEND_BASE_URL;
    }
  });

  test('a fresh cache hit never instantiates the hyperspace video', async () => {
    writeWeatherCache({
      planetId: 'hoth',
      planetClass: 'hoth',
      planetName: 'Hoth',
      headingPrefix: "IT'S LIKE",
      headingSuffix: 'OUTSIDE',
      message: 'Cold',
      description: 'Ice',
      lastUpdated: new Date().toISOString(),
      lastUpdatedLabel: 'Last Updated: now',
      freshUntil: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      locationKey: 'auto',
      locationName: 'Austin, TX',
      weatherLocation: {
        cell: '30.27,-97.74',
        accuracyMeters: 50,
        positionAt: new Date().toISOString()
      },
      language: 'en',
      unit: 'fahrenheit',
      timeOfDay: 'afternoon',
      timeOfDayLabel: 'Afternoon'
    });
    const fetchMock = installFetchRouter([LOCALE_ROUTE]);

    await app.refreshWeather();

    expect(document.getElementById('planet').innerText).toBe('HOTH');
    expect(document.querySelector('#test video')).toBeNull();
    expect(fetchMock.calls.some((url) => url.includes('/v1/weather'))).toBe(false);
  });

  function cachedHoth(overrides = {}) {
    return {
      planetId: 'hoth',
      planetClass: 'hoth',
      planetName: 'Hoth',
      headingPrefix: "IT'S LIKE",
      headingSuffix: 'OUTSIDE',
      message: 'Cold',
      description: 'Ice',
      lastUpdated: new Date().toISOString(),
      lastUpdatedLabel: 'Last Updated: now',
      locationKey: 'auto',
      locationName: 'Austin, TX',
      weatherLocation: {
        cell: '30.27,-97.74',
        accuracyMeters: 50,
        positionAt: new Date().toISOString()
      },
      language: 'en',
      unit: 'fahrenheit',
      timeOfDay: 'afternoon',
      timeOfDayLabel: 'Afternoon',
      ...overrides
    };
  }

  test('a same-cell cached reading is kept after the backend freshness window passes', async () => {
    writeWeatherCache(cachedHoth({
      freshUntil: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      cachedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString()
    }));
    const fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();

    expect(document.getElementById('planet').innerText).toBe('HOTH');
    expect(fetchMock.calls.some((url) => url.includes('/v1/weather'))).toBe(false);
  });

  test('a manual-location reading is kept for the local TTL too', async () => {
    setManualLocation({ name: 'Austin', displayName: 'Austin, TX', lat: 30.2672, lon: -97.7431, country: 'US' });
    writeWeatherCache(cachedHoth({
      locationKey: 'manual:30.2672,-97.7431',
      freshUntil: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      weatherLocation: undefined
    }));
    const fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();

    expect(document.getElementById('planet').innerText).toBe('HOTH');
    expect(fetchMock.calls.some((url) => url.includes('/v1/weather'))).toBe(false);
  });

  test('a reading the backend served stale is re-checked after 15 minutes, not before', async () => {
    writeWeatherCache(cachedHoth({
      stale: true,
      cachedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
    }));
    let fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);
    await app.refreshWeather();
    expect(fetchMock.calls.some((url) => url.includes('/v1/weather'))).toBe(false);

    writeWeatherCache(cachedHoth({
      stale: true,
      cachedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString()
    }));
    fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);
    await app.refreshWeather();
    expect(fetchMock.calls.filter((url) => url.includes('/v1/weather'))).toHaveLength(1);
    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.cache));
    expect(stored.stale).toBeUndefined();
  });

  test('a v2.4 cache entry without a recorded cell adopts the current one without a request', async () => {
    // v2.4 wrote neither a cell nor cachedAt; its lastUpdated was the fetch time.
    const fetchedTenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { weatherLocation, ...v24Record } = cachedHoth({ lastUpdated: fetchedTenMinutesAgo });
    localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify(v24Record));
    const fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();

    expect(fetchMock.calls.some((url) => url.includes('/v1/weather'))).toBe(false);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.cache));
    expect(stored.weatherLocation.cell).toBe('30.27,-97.74');
    expect(stored.cachedAt).toBe(fetchedTenMinutesAgo);
  });

  test('after a 503 with Retry-After, new tabs use last-known weather until the wait ends', async () => {
    seedLastKnownHoth();
    installFetchRouter([
      LOCALE_ROUTE,
      GEOCODE_ROUTE,
      { match: '/v1/weather', ok: false, status: 503, headers: { 'Retry-After': '120' } }
    ]);
    await app.refreshWeather();
    expect(document.getElementById('LastUpdated').innerText).toContain('Sensors offline');
    const retryAt = Number(localStorage.getItem(STORAGE_KEYS.backendRetryAt));
    expect(retryAt - Date.now()).toBeGreaterThan(110 * 1000);
    expect(retryAt - Date.now()).toBeLessThanOrEqual(180 * 1000);

    let fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);
    await app.refreshWeather();
    expect(fetchMock.calls.some((url) => url.includes('/v1/weather'))).toBe(false);
    expect(document.getElementById('planet').innerText).toBe('HOTH');

    // A settings change or the online retry is user-driven and still tries.
    fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);
    await app.refreshWeather({ isNewTab: false });
    expect(fetchMock.calls.some((url) => url.includes('/v1/weather'))).toBe(true);
    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
    expect(localStorage.getItem(STORAGE_KEYS.backendRetryAt)).toBeNull();
  });

  test('a client error does not start a backoff', async () => {
    installFetchRouter([LOCALE_ROUTE, GEOCODE_ROUTE, { match: '/v1/weather', ok: false, status: 400 }]);
    await app.refreshWeather();
    expect(localStorage.getItem(STORAGE_KEYS.backendRetryAt)).toBeNull();
  });

  test('a retry time further ahead than any backoff can write is discarded', async () => {
    seedLastKnownHoth();
    localStorage.setItem(STORAGE_KEYS.backendRetryAt, String(Date.now() + 24 * 60 * 60 * 1000));
    const fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();

    expect(fetchMock.calls.some((url) => url.includes('/v1/weather'))).toBe(true);
    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
    expect(localStorage.getItem(STORAGE_KEYS.backendRetryAt)).toBeNull();
  });

  test('a network failure while the device is offline does not hold back other tabs', async () => {
    seedLastKnownHoth();
    installNavigator(globalThis.window, {
      language: 'en-US',
      onLine: false,
      geolocation: {
        getCurrentPosition(success) {
          success({ coords: { latitude: AUSTIN.latitude, longitude: AUSTIN.longitude } });
        }
      }
    });
    installFetchRouter([LOCALE_ROUTE, GEOCODE_ROUTE, { match: '/v1/weather', error: new TypeError('Failed to fetch') }]);

    await app.refreshWeather();

    expect(document.getElementById('LastUpdated').innerText).toContain('Sensors offline');
    expect(localStorage.getItem(STORAGE_KEYS.backendRetryAt)).toBeNull();
  });

  test('a position jittering just across the cell edge is not treated as travel', async () => {
    writeWeatherCache(cachedHoth());
    for (const latitude of [30.2649, 30.2651, 30.2648]) {
      installNavigator(globalThis.window, {
        language: 'en-US',
        onLine: true,
        geolocation: {
          getCurrentPosition(success) {
            success({ coords: { latitude, longitude: AUSTIN.longitude, accuracy: 30 }, timestamp: Date.now() });
          }
        }
      });
      const fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

      await app.refreshWeather();

      expect(fetchMock.calls.some((url) => url.includes('/v1/weather'))).toBe(false);
      expect(document.getElementById('planet').innerText).toBe('HOTH');
      expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.cache)).weatherLocation.cell).toBe('30.27,-97.74');
    }
  });

  test('a poor same-cell cache validation can refine after cached weather is visible', async () => {
    writeWeatherCache({
      planetId: 'hoth',
      planetClass: 'hoth',
      planetName: 'Hoth',
      headingPrefix: "IT'S LIKE",
      headingSuffix: 'OUTSIDE',
      message: 'Cold',
      description: 'Ice',
      lastUpdated: new Date().toISOString(),
      lastUpdatedLabel: 'Last Updated: now',
      freshUntil: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      locationKey: 'auto',
      locationName: 'Austin, TX',
      weatherLocation: {
        cell: '30.27,-97.74',
        accuracyMeters: 2000,
        positionAt: new Date().toISOString()
      },
      language: 'en',
      unit: 'fahrenheit',
      timeOfDay: 'afternoon',
      timeOfDayLabel: 'Afternoon'
    });

    const optionsSeen = [];
    const planetsWhenLocationWasRequested = [];
    installNavigator(globalThis.window, {
      language: 'en-US',
      onLine: true,
      geolocation: {
        getCurrentPosition(success, _error, options) {
          optionsSeen.push(options);
          planetsWhenLocationWasRequested.push(document.getElementById('planet').innerText);
          if (options.enableHighAccuracy) {
            success({
              coords: { latitude: 30.2578, longitude: -97.7525, accuracy: 100 },
              timestamp: Date.now()
            });
            return;
          }
          success({
            coords: { latitude: AUSTIN.latitude, longitude: AUSTIN.longitude, accuracy: 2000 },
            timestamp: Date.now()
          });
        }
      }
    });
    const fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();

    expect(optionsSeen.map((options) => [options.enableHighAccuracy, options.maximumAge]))
      .toEqual([[false, 120000], [true, 0]]);
    expect(planetsWhenLocationWasRequested).toEqual(['HOTH', 'HOTH']);
    expect(fetchMock.calls.filter((url) => url.includes('/v1/weather'))).toHaveLength(1);
    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
    expect(document.querySelector('#test video')).toBeNull();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.cache));
    expect(stored.weatherLocation.cell).toBe('30.26,-97.75');
    expect(stored.weatherLocation.accuracyMeters).toBe(100);
  });

  test('renders cached weather before checking location, then refreshes after movement', async () => {
    writeWeatherCache({
      planetId: 'hoth',
      planetClass: 'hoth',
      planetName: 'Hoth',
      headingPrefix: "IT'S LIKE",
      headingSuffix: 'OUTSIDE',
      message: 'Cold',
      description: 'Ice',
      lastUpdated: new Date().toISOString(),
      lastUpdatedLabel: 'Last Updated: now',
      freshUntil: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      locationKey: 'auto',
      locationName: 'Austin, TX',
      weatherLocation: {
        cell: '30.27,-97.74',
        accuracyMeters: 50,
        positionAt: new Date().toISOString()
      },
      language: 'en',
      unit: 'fahrenheit',
      timeOfDay: 'afternoon',
      timeOfDayLabel: 'Afternoon'
    });

    let planetWhenLocationWasRequested = null;
    installNavigator(globalThis.window, {
      language: 'en-US',
      onLine: true,
      geolocation: {
        getCurrentPosition(success, _error, options) {
          planetWhenLocationWasRequested = document.getElementById('planet').innerText;
          expect(options.enableHighAccuracy).toBe(false);
          expect(options.maximumAge).toBe(120000);
          success({
            coords: { latitude: 32.7767, longitude: -96.797, accuracy: 50 },
            timestamp: Date.now()
          });
        }
      }
    });
    const fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();

    expect(planetWhenLocationWasRequested).toBe('HOTH');
    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
    const weatherUrl = new URL(fetchMock.calls.find((url) => url.includes('/v1/weather')));
    expect(weatherUrl.searchParams.get('lat')).toBe('32.78');
    expect(weatherUrl.searchParams.get('lon')).toBe('-96.8');
    expect(document.querySelector('#test video')).toBeNull();
  });

  test('a poor fast fix is refined only after weather is visible', async () => {
    const optionsSeen = [];
    let planetWhenHighAccuracyStarted = null;
    installNavigator(globalThis.window, {
      language: 'en-US',
      onLine: true,
      geolocation: {
        getCurrentPosition(success, _error, options) {
          optionsSeen.push(options);
          if (options.enableHighAccuracy) {
            planetWhenHighAccuracyStarted = document.getElementById('planet').innerText;
            success({
              coords: { latitude: 30.2578, longitude: -97.7525, accuracy: 100 },
              timestamp: Date.now()
            });
            return;
          }
          success({
            coords: { latitude: AUSTIN.latitude, longitude: AUSTIN.longitude, accuracy: 2000 },
            timestamp: Date.now()
          });
        }
      }
    });
    const fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();

    expect(optionsSeen.map((options) => options.enableHighAccuracy)).toEqual([false, true]);
    expect(planetWhenHighAccuracyStarted).toBe('TATOOINE');
    expect(fetchMock.calls.filter((url) => url.includes('/v1/weather'))).toHaveLength(2);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.cache));
    expect(stored.weatherLocation.cell).toBe('30.26,-97.75');
    expect(stored.weatherLocation.accuracyMeters).toBe(100);
    expect(stored.weatherLocation.highAccuracyCheckedAt).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.lastKnownWeather)).weatherLocation).toBeUndefined();
  });

  test('a failing refinement never repaints a rendered result as offline', async () => {
    installNavigator(globalThis.window, {
      language: 'en-US',
      onLine: true,
      geolocation: {
        getCurrentPosition(success, _error, options) {
          if (options.enableHighAccuracy) {
            // A broken provider hands back a better accuracy with unusable coordinates.
            success({ coords: { latitude: 'north', longitude: 'west', accuracy: 10 }, timestamp: Date.now() });
            return;
          }
          success({
            coords: { latitude: AUSTIN.latitude, longitude: AUSTIN.longitude, accuracy: 2000 },
            timestamp: Date.now()
          });
        }
      }
    });
    const fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();

    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
    expect(document.getElementById('LastUpdated').innerText).not.toContain('offline');
    expect(fetchMock.calls.filter((url) => url.includes('/v1/weather'))).toHaveLength(1);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.cache));
    expect(stored.offline).toBeUndefined();
    expect(stored.weatherLocation.cell).toBe('30.27,-97.74');
  });

  test('a stale fast position is replaced by a fresh standard fix after first paint', async () => {
    const optionsSeen = [];
    let planetWhenFreshCheckStarted = null;
    installNavigator(globalThis.window, {
      language: 'en-US',
      onLine: true,
      geolocation: {
        getCurrentPosition(success, _error, options) {
          optionsSeen.push(options);
          if (options.maximumAge === 120000) {
            planetWhenFreshCheckStarted = document.getElementById('planet').innerText;
            success({
              coords: { latitude: 32.7767, longitude: -96.797, accuracy: 50 },
              timestamp: Date.now()
            });
            return;
          }
          success({
            coords: { latitude: AUSTIN.latitude, longitude: AUSTIN.longitude, accuracy: 50 },
            timestamp: Date.now() - 9 * 60 * 1000
          });
        }
      }
    });
    const fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();

    expect(optionsSeen.map((options) => [options.enableHighAccuracy, options.maximumAge]))
      .toEqual([[false, 600000], [false, 120000]]);
    expect(planetWhenFreshCheckStarted).toBe('TATOOINE');
    expect(fetchMock.calls.filter((url) => url.includes('/v1/weather'))).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.cache)).weatherLocation.cell)
      .toBe('32.78,-96.80');
  });

  test('a superseded background result cannot overwrite a setting change', async () => {
    writeWeatherCache({
      planetId: 'hoth',
      planetClass: 'hoth',
      planetName: 'Hoth',
      headingPrefix: "IT'S LIKE",
      headingSuffix: 'OUTSIDE',
      message: 'Cold',
      description: 'Ice',
      lastUpdated: new Date().toISOString(),
      lastUpdatedLabel: 'Last Updated: now',
      freshUntil: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      locationKey: 'auto',
      locationName: 'Austin, TX',
      weatherLocation: {
        cell: '30.27,-97.74',
        accuracyMeters: 50,
        positionAt: new Date().toISOString()
      },
      language: 'en',
      unit: 'fahrenheit',
      timeOfDay: 'afternoon',
      timeOfDayLabel: 'Afternoon'
    });
    installNavigator(globalThis.window, {
      language: 'en-US',
      onLine: true,
      geolocation: {
        getCurrentPosition(success) {
          setPreferredUnit('celsius');
          success({
            coords: { latitude: 32.7767, longitude: -96.797, accuracy: 50 },
            timestamp: Date.now()
          });
        }
      }
    });
    installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();

    expect(document.getElementById('planet').innerText).toBe('HOTH');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.cache)).planetId).toBe('hoth');
    expect(getPreferredUnit()).toBe('celsius');
  });

  /** Holds the first location request open; later requests answer from Austin at once. */
  function installHangingFirstFix() {
    const held = [];
    installNavigator(globalThis.window, {
      language: 'en-US',
      onLine: true,
      geolocation: {
        getCurrentPosition(success, error) {
          if (held.length === 0) {
            held.push({ success, error });
            return;
          }
          success({
            coords: { latitude: AUSTIN.latitude, longitude: AUSTIN.longitude, accuracy: 50 },
            timestamp: Date.now()
          });
        }
      }
    });
    return held;
  }

  /** Fails held requests so a failed assertion cannot leave the refresh chain hung. */
  async function releaseHeld(held, chain) {
    held.forEach((request) => request.error({ code: 3, message: 'Timeout expired' }));
    await chain;
  }

  /** Resolves 'blocked' if the refresh is still waiting after real time has passed. */
  function settleOrBlock(promise) {
    return Promise.race([
      promise.then(() => 'rendered'),
      new Promise((resolve) => realSetTimeout(() => resolve('blocked'), 100))
    ]);
  }

  test('a setting change starts at once instead of waiting on the background location check', async () => {
    writeWeatherCache(cachedHoth());
    const held = installHangingFirstFix();
    const fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    const chain = app.refreshWeather();
    try {
      await flushAsync();
      expect(document.getElementById('planet').innerText).toBe('HOTH');
      expect(held).toHaveLength(1);

      setManualLocation({ name: 'Tokyo', displayName: 'Tokyo, JP', lat: 35.6895, lon: 139.6917, country: 'JP' });

      expect(await settleOrBlock(app.refreshWeather({ isNewTab: false }))).toBe('rendered');
      expect(document.getElementById('planet').innerText).toBe('TATOOINE');
      expect(document.getElementById('locationLabel').innerText).toContain('Tokyo');

      // The abandoned check answers late, from another city: no fetch, no cache write.
      const weatherCalls = fetchMock.calls.filter((url) => url.includes('/v1/weather')).length;
      held[0].success({ coords: { latitude: 32.7767, longitude: -96.797, accuracy: 50 }, timestamp: Date.now() });
      await flushAsync();

      expect(fetchMock.calls.filter((url) => url.includes('/v1/weather'))).toHaveLength(weatherCalls);
      expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.cache)).locationKey).toBe('manual:35.6895,139.6917');
    } finally {
      await releaseHeld(held, chain);
    }
  });

  test('a setting change does not wait for GPS refinement of a rendered reading', async () => {
    const heldHighAccuracy = [];
    installNavigator(globalThis.window, {
      language: 'en-US',
      onLine: true,
      geolocation: {
        getCurrentPosition(success, error, options) {
          if (options.enableHighAccuracy) {
            heldHighAccuracy.push({ success, error });
            return;
          }
          success({
            coords: { latitude: AUSTIN.latitude, longitude: AUSTIN.longitude, accuracy: 2000 },
            timestamp: Date.now()
          });
        }
      }
    });
    installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    const chain = app.refreshWeather();
    try {
      await flushAsync();
      expect(document.getElementById('planet').innerText).toBe('TATOOINE');
      expect(heldHighAccuracy).toHaveLength(1);

      setManualLocation({ name: 'Tokyo', displayName: 'Tokyo, JP', lat: 35.6895, lon: 139.6917, country: 'JP' });

      expect(await settleOrBlock(app.refreshWeather({ isNewTab: false }))).toBe('rendered');
      expect(document.getElementById('locationLabel').innerText).toContain('Tokyo');
    } finally {
      await releaseHeld(heldHighAccuracy, chain);
    }
  });

  test('an abandoned background check that later fails records nothing and arms no retry', async () => {
    const registered = [];
    const realAddEventListener = globalThis.window.addEventListener.bind(globalThis.window);
    globalThis.window.addEventListener = (type, ...rest) => {
      registered.push(type);
      return realAddEventListener(type, ...rest);
    };
    writeWeatherCache(cachedHoth());
    const held = installHangingFirstFix();
    installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    const chain = app.refreshWeather();
    try {
      await flushAsync();

      // Same settings, so only the abandoned pass's generation tells it apart.
      expect(await settleOrBlock(app.refreshWeather({ isNewTab: false }))).toBe('rendered');
      const errorsBefore = JSON.parse(localStorage.getItem(STORAGE_KEYS.telemetry)).errors;

      held[0].error({ code: 3, message: 'Timeout expired' });
      await flushAsync();

      expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.telemetry)).errors).toBe(errorsBefore);
      expect(registered).not.toContain('online');
    } finally {
      await releaseHeld(held, chain);
    }
  });

  test('a settings refresh over a rendered reading clears it at once and skips hyperspace', async () => {
    const delays = [];
    globalThis.setTimeout = (callback, ms) => {
      delays.push(ms);
      callback();
      return 0;
    };
    writeWeatherCache(cachedHoth());
    const router = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);
    await app.refreshWeather();
    expect(document.getElementById('planet').innerText).toBe('HOTH');

    let releaseWeather;
    const weatherGate = new Promise((resolve) => {
      releaseWeather = resolve;
    });
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('/v1/weather')) {
        await weatherGate;
      }
      return router(input, init);
    };
    setManualLocation({ name: 'Tokyo', displayName: 'Tokyo, JP', lat: 35.6895, lon: 139.6917, country: 'JP' });

    const refresh = app.refreshWeather({ isNewTab: false });
    try {
      await flushAsync();

      expect(document.getElementById('locationLabel').innerText).toContain('Tokyo');
      expect(document.getElementById('planet').innerText).toBe('');
      expect(document.getElementById('message').innerText).toBe('');
      expect(document.querySelector('#test video')).toBeNull();
    } finally {
      releaseWeather();
      await refresh;
    }

    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
    expect(delays.filter((ms) => ms > 0 && ms <= HYPERSPACE_MIN_MS)).toEqual([]);
  });

  test('a cold new tab still plays hyperspace for the minimum time', async () => {
    const delays = [];
    globalThis.setTimeout = (callback, ms) => {
      delays.push(ms);
      callback();
      return 0;
    };
    installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();

    expect(document.querySelector('#test video')).toBeTruthy();
    expect(delays.some((ms) => ms > HYPERSPACE_MIN_MS - 1000 && ms <= HYPERSPACE_MIN_MS)).toBe(true);
    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
  });

  // Regression: a device with full or blocked localStorage saw "Sensors offline" on
  // every new tab even though the fetch had succeeded.
  test('a failing localStorage write cannot demote a successful render to the offline screen', async () => {
    seedLastKnownHoth();
    installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };

    await app.refreshWeather();

    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
    expect(document.getElementById('message').innerText).toContain("It's a Hot");
    expect(document.getElementById('LastUpdated').innerText).not.toContain('Sensors offline');
    expect(document.getElementById('locationLabel').innerText).toContain('Austin');
  });

  test('a successful render survives a failure to record the planet as visited', async () => {
    installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    const realSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (key, value) => {
      if (key === STORAGE_KEYS.visitedPlanets) {
        throw new Error('QuotaExceededError');
      }
      realSetItem(key, value);
    };

    await app.refreshWeather();

    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
    // writes after the failed one still land
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.cache)).planetId).toBe('tatooine');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.lastKnownWeather)).planetId).toBe('tatooine');
  });

  test('a rate limit uses the last-known weather instead of dropping valid traffic', async () => {
    seedLastKnownHoth();
    installFetchRouter([LOCALE_ROUTE, GEOCODE_ROUTE, { match: '/v1/weather', ok: false, status: 429 }]);
    document.getElementById('planet').innerText = 'HOTH';

    await app.refreshWeather();

    expect(document.getElementById('planet').innerText).toBe('HOTH');
    expect(document.getElementById('LastUpdated').innerText).toContain('Sensors offline');

    const telemetry = JSON.parse(localStorage.getItem(STORAGE_KEYS.telemetry));
    expect(telemetry.errors).toBe(1);
    expect(telemetry.offlineFallbacks).toBe(1);
  });

  test('a client error stays visible instead of masking a broken release', async () => {
    seedLastKnownHoth();
    installFetchRouter([LOCALE_ROUTE, GEOCODE_ROUTE, { match: '/v1/weather', ok: false, status: 400 }]);
    document.getElementById('planet').innerText = 'HOTH';

    await app.refreshWeather();

    expect(document.getElementById('LastUpdated').innerText).not.toContain('Sensors offline');
    expect(document.getElementById('message').innerText).toBe('Unable to retrieve weather data right now.');
    const telemetry = JSON.parse(localStorage.getItem(STORAGE_KEYS.telemetry));
    expect(telemetry.errors).toBe(1);
    expect(telemetry.offlineFallbacks).toBe(0);
  });

  test('a network failure with no status keeps the signal-lost experience', async () => {
    seedLastKnownHoth();
    installFetchRouter([LOCALE_ROUTE, GEOCODE_ROUTE, { match: '/v1/weather', error: new TypeError('Failed to fetch') }]);

    await app.refreshWeather();

    expect(document.getElementById('planet').innerText).toBe('HOTH');
    expect(document.getElementById('LastUpdated').innerText).toContain('Sensors offline');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.telemetry)).offlineFallbacks).toBe(1);
  });

  // navigator.onLine reads false on VPNs and virtual adapters, so it can't be the
  // one deciding the network is unreachable.
  test('navigator.onLine === false still attempts the fetch', async () => {
    installNavigator(globalThis.window, {
      language: 'en-US',
      onLine: false,
      geolocation: {
        getCurrentPosition(success) {
          success({ coords: { latitude: AUSTIN.latitude, longitude: AUSTIN.longitude } });
        }
      }
    });
    const fetchMock = installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();

    expect(fetchMock.calls.some((url) => url.includes('/v1/weather'))).toBe(true);
    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
  });

  test('an offline failure arms exactly one online retry, and that retry recovers the page', async () => {
    const registered = [];
    const realAddEventListener = globalThis.window.addEventListener.bind(globalThis.window);
    globalThis.window.addEventListener = (type, ...rest) => {
      registered.push(type);
      return realAddEventListener(type, ...rest);
    };

    installFetchRouter([LOCALE_ROUTE, GEOCODE_ROUTE, { match: '/v1/weather', error: new TypeError('Failed to fetch') }]);

    await app.refreshWeather();
    await app.refreshWeather({ isNewTab: false });

    expect(registered.filter((type) => type === 'online')).toHaveLength(1);
    expect(document.getElementById('LastUpdated').innerText).toContain('Sensors offline');

    installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);
    globalThis.window.dispatchEvent(new globalThis.window.Event('online'));
    await flushAsync();

    expect(document.getElementById('planet').innerText).toBe('TATOOINE');
    expect(document.getElementById('LastUpdated').innerText).not.toContain('Sensors offline');
  });

  // Austin's planet under a Tokyo request is worse than showing nothing known.
  test('last-known weather for one location is not rendered for another', async () => {
    setManualLocation({ name: 'Tokyo', displayName: 'Tokyo, JP', lat: 35.6895, lon: 139.6917, country: 'JP' });
    seedLastKnownHoth({ planetId: 'tatooine', planetName: 'Tatooine', locationKey: 'auto', locationName: 'Austin, TX' });
    installFetchRouter([LOCALE_ROUTE, { match: '/v1/weather', error: new TypeError('Failed to fetch') }]);

    await app.refreshWeather();

    expect(document.getElementById('locationLabel').innerText).not.toContain('Austin');
    expect(document.getElementById('message').innerText)
      .toBe('Sensors offline — signal lost. Displaying a random sector.');
  });

  // The stored message holds the temperature pre-formatted, so reusing it after a unit
  // change showed "90°F" in Celsius mode and left the toggle unrendered.
  test('a stale reading is re-rendered in the unit in force now', async () => {
    seedLastKnownHoth({
      planetId: 'tatooine',
      planetName: 'Tatooine',
      planetClass: 'tatooine',
      message: "90°F, It's a Hot Afternoon",
      tempF: 90,
      tempC: 32
    });
    setPreferredUnit('celsius');
    installFetchRouter([LOCALE_ROUTE, { match: '/v1/weather', error: new TypeError('Failed to fetch') }]);

    await app.refreshWeather();

    const message = document.getElementById('message');
    expect(message.innerText).not.toContain('90°F');
    expect(message.innerText).toContain('32°C');
    expect(document.querySelector('#message .temp-toggle').textContent).toBe('32°C');
  });

  test('toggling units on an offline fallback re-renders at once and is never cached', async () => {
    const localization = createLocalizationMock({
      offline_signal_lost: { message: 'Sensors offline — last known: $1' },
      planet_hoth_summary: { message: "$1, It's a Very Cold $2" },
      temp_toggle_hint: { message: 'Click to switch units' }
    });
    installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    app.applyWeatherToUi({
      planetId: 'hoth',
      planetClass: 'hoth',
      planetName: 'Hoth',
      message: "10°F, It's a Very Cold Afternoon",
      description: 'Ice',
      lastUpdated: new Date().toISOString(),
      lastUpdatedLabel: 'Sensors offline — last known: Hoth',
      locationKey: 'auto',
      language: 'en',
      unit: 'fahrenheit',
      tempF: 10,
      tempC: -12,
      timeOfDayLabel: 'Afternoon',
      offline: true
    }, localization);

    await app.handleTempToggle();

    expect(document.getElementById('message').innerText).toContain('-12°C');
    expect(document.getElementById('message').innerText).not.toContain('10°F');

    // An offline model must never reach the TTL cache, or the next tab gets a cache
    // hit on "Sensors offline" and never refreshes.
    expect(localStorage.getItem(STORAGE_KEYS.cache)).toBeNull();

    // Last-known has to move to the new unit too, or the next offline load renders
    // the unit the user just switched away from.
    const lastKnown = JSON.parse(localStorage.getItem(STORAGE_KEYS.lastKnownWeather));
    expect(lastKnown.unit).toBe('celsius');
    expect(lastKnown.offline).toBeUndefined();
  });

  test('toggling units on a live reading keeps the original fetch time, so the TTL still ends', async () => {
    installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);
    await app.refreshWeather();
    const fetchedAt = JSON.parse(localStorage.getItem(STORAGE_KEYS.cache)).cachedAt;
    expect(fetchedAt).toBeString();

    setSystemTime(new Date(Date.now() + 50 * 60 * 1000));
    try {
      await app.handleTempToggle();
    } finally {
      setSystemTime();
    }

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.cache));
    expect(stored.unit).toBe('celsius');
    expect(stored.cachedAt).toBe(fetchedAt);
  });

  test('toggling units on a live reading moves last-known onto the new unit too', async () => {
    const localization = createLocalizationMock({
      planet_tatooine_summary: { message: "$1, It's a Hot $2" },
      temp_toggle_hint: { message: 'Click to switch units' }
    });

    app.applyWeatherToUi({
      planetId: 'tatooine',
      planetClass: 'tatooine',
      planetName: 'Tatooine',
      message: "90°F, It's a Hot Afternoon",
      description: 'Desert',
      lastUpdated: new Date().toISOString(),
      lastUpdatedLabel: 'Last Updated: now',
      locationKey: 'auto',
      locationName: 'Austin, TX',
      language: 'en',
      unit: 'fahrenheit',
      tempF: 90,
      tempC: 32,
      timeOfDayLabel: 'Afternoon'
    }, localization);

    await app.handleTempToggle();

    const lastKnown = JSON.parse(localStorage.getItem(STORAGE_KEYS.lastKnownWeather));
    expect(lastKnown.unit).toBe('celsius');
    expect(lastKnown.message).toContain('32°C');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.cache)).unit).toBe('celsius');
  });

  // daily_activity.tabs is the denominator of cacheHits/tabs and errors/tabs, so
  // counting a settings change as a tab skews the ratios.
  test('a self-triggered re-render does not count as a new tab', async () => {
    installFetchRouter([LOCALE_ROUTE, WEATHER_OK, GEOCODE_ROUTE]);

    await app.refreshWeather();
    await app.refreshWeather({ isNewTab: false });
    await app.refreshWeather({ isNewTab: false });

    const telemetry = JSON.parse(localStorage.getItem(STORAGE_KEYS.telemetry));
    expect(telemetry.tabs).toBe(1);
    expect(telemetry.cacheHits).toBe(0);
  });
});

describe('time of day labels', () => {
  const localization = createLocalizationMock({
    time_of_day_morning: { message: 'Morning' },
    time_of_day_afternoon: { message: 'Afternoon' },
    time_of_day_evening: { message: 'Evening' },
    time_of_day_night: { message: 'Night' },
    time_of_day_pre_dawn: { message: 'Late Night' }
  });

  // Boston, Dec 21: sunrise 07:13, sunset 16:15 local (UTC-5)
  const BOSTON_WINTER = {
    sunrise: Date.parse('2024-12-21T12:13:00Z') / 1000,
    sunset: Date.parse('2024-12-21T21:15:00Z') / 1000,
    timezoneOffset: -5 * 60 * 60
  };

  // Stockholm, Dec 21: sunrise 08:44, sunset 14:48 local (UTC+1). The evening window
  // alone would open at 11:48 and leave "Afternoon" unreachable all winter.
  const STOCKHOLM_WINTER = {
    sunrise: Date.parse('2024-12-21T07:44:00Z') / 1000,
    sunset: Date.parse('2024-12-21T13:48:00Z') / 1000,
    timezoneOffset: 60 * 60
  };

  test('early afternoon on a short winter day is still Afternoon', () => {
    // 13:45 local in Boston
    const timeOfDay = app.resolveTimeOfDay(new Date('2024-12-21T18:45:00Z'), localization, BOSTON_WINTER);
    expect(timeOfDay.id).toBe('afternoon');
    expect(timeOfDay.isDaytime).toBe(true);
  });

  test('the last of the daylight is Evening even where the sun sets before 15:00', () => {
    // 14:30 local in Stockholm, 18 min before sunset. A bare clock floor on "Afternoon"
    // made "Evening" unreachable here for about two months.
    const timeOfDay = app.resolveTimeOfDay(new Date('2024-12-21T13:30:00Z'), localization, STOCKHOLM_WINTER);
    expect(timeOfDay.id).toBe('evening');
    expect(timeOfDay.isDaytime).toBe(true);
  });

  test('a 14:48 sunset does not make lunchtime Evening', () => {
    // 12:30 local in Stockholm
    const timeOfDay = app.resolveTimeOfDay(new Date('2024-12-21T11:30:00Z'), localization, STOCKHOLM_WINTER);
    expect(timeOfDay.id).toBe('afternoon');
  });

  test('the last stretch of daylight is still Evening', () => {
    // 15:30 local in Boston, 45 min before sunset
    expect(app.resolveTimeOfDay(new Date('2024-12-21T20:30:00Z'), localization, BOSTON_WINTER).id).toBe('evening');
  });

  test('after sunset is Night whatever the hour', () => {
    // 15:00 local in Stockholm, after a 14:48 sunset
    const timeOfDay = app.resolveTimeOfDay(new Date('2024-12-21T14:00:00Z'), localization, STOCKHOLM_WINTER);
    expect(timeOfDay.id).toBe('night');
    expect(timeOfDay.isDaytime).toBe(false);
  });

  test('a long summer day keeps the 17:00 evening rule', () => {
    const summer = {
      sunrise: Date.parse('2024-06-21T04:00:00Z') / 1000,
      sunset: Date.parse('2024-06-21T22:00:00Z') / 1000,
      timezoneOffset: 0
    };

    expect(app.resolveTimeOfDay(new Date('2024-06-21T14:00:00Z'), localization, summer).id).toBe('afternoon');
    expect(app.resolveTimeOfDay(new Date('2024-06-21T17:30:00Z'), localization, summer).id).toBe('evening');
  });
});

// applyWeatherToUi draws the passport and persistSuccessfulWeather draws it again so a
// fresh stamp lands on this tab; together they must not rebuild an unchanged grid.
describe('passport rendering on the success path', () => {
  const PASSPORT_MARKUP = `
    <div id="background"></div>
    <div id="test"></div>
    <div id="planet" tabindex="-1"></div>
    <div id="message"></div>
    <div id="description"></div>
    <div id="LastUpdated"></div>
    <div id="locationLabel"></div>
    <div id="loading"></div>
    <aside id="exploreMenu" class="explore-menu hidden">
      <button type="button" id="exploreMenuButton"></button>
      <div id="exploreMenuPanel" class="explore-menu-panel hidden" role="menu"></div>
    </aside>
    <aside id="passport" class="passport hidden">
      <div id="passportPanel" class="passport-panel hidden" role="dialog">
        <p id="passportCount"></p>
        <div id="passportProgressBar"></div>
        <ul id="passportGrid"></ul>
      </div>
    </aside>
  `;

  function viewModelFor(planetId) {
    return {
      planetClass: planetId,
      planetName: planetId,
      planetId,
      headingPrefix: "IT'S LIKE",
      headingSuffix: 'OUTSIDE',
      message: 'message',
      description: 'description',
      lastUpdated: new Date().toISOString(),
      locationName: 'Ann Arbor',
      locationKey: 'auto',
      language: 'en',
      unit: 'fahrenheit',
      timeOfDay: 'morning',
      timeOfDayLabel: 'Morning',
      matchReason: '',
      tempF: 10,
      tempC: -12
    };
  }

  // renderPassportGrid only wipes the grid when it can't reuse the existing tiles, so
  // counting resets counts teardowns. Redraws are asserted against the tiles.
  function countGridRebuilds() {
    const grid = document.getElementById('passportGrid');
    const counter = { rebuilds: 0 };
    let store = '';
    Object.defineProperty(grid, 'innerHTML', {
      get: () => store,
      set: (value) => {
        if (value === '') {
          counter.rebuilds += 1;
        }
        store = value;
      },
      configurable: true
    });
    return counter;
  }

  test('a newly visited planet redraws the passport so the stamp appears on this tab', () => {
    installDom(PASSPORT_MARKUP);
    const localization = createLocalizationMock({});
    const counter = countGridRebuilds();
    const grid = document.getElementById('passportGrid');
    const count = document.getElementById('passportCount');

    // The weather render happens before the visit is recorded, so the stamp is still locked.
    app.applyWeatherToUi(viewModelFor('hoth'), localization);
    const stamp = grid.querySelector('[data-planet="hoth"]');
    expect(stamp).not.toBeNull();
    expect(stamp.classList.contains('visited')).toBe(false);
    expect(count.textContent).toContain('0/13');

    app.persistSuccessfulWeather(viewModelFor('hoth'), localization);
    expect(grid.querySelector('[data-planet="hoth"]')).toBe(stamp);
    expect(stamp.classList.contains('visited')).toBe(true);
    expect(count.textContent).toContain('1/13');

    expect(counter.rebuilds).toBe(1);
  });

  test('an unreadable stamp list cannot undo a render that already succeeded', () => {
    installDom(PASSPORT_MARKUP);
    const localization = createLocalizationMock({});

    // applyWeatherToUi runs inside refreshWeather's try, so a throwing read here used
    // to repaint an already-successful fetch as the offline fallback.
    const realGetItem = localStorage.getItem.bind(localStorage);
    localStorage.getItem = (key) => {
      if (key === STORAGE_KEYS.visitedPlanets) {
        throw new Error('SecurityError');
      }
      return realGetItem(key);
    };

    try {
      expect(() => app.applyWeatherToUi(viewModelFor('hoth'), localization)).not.toThrow();
      expect(() => app.persistSuccessfulWeather(viewModelFor('hoth'), localization)).not.toThrow();
    } finally {
      localStorage.getItem = realGetItem;
    }

    expect(document.getElementById('planet').innerText).toBe('HOTH');
  });
});
