import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createFetchMock,
  createLocalizationMock,
  createSpy,
  installDom,
  installNavigator,
  installStorageMock,
  teardownDom
} from './testUtils.js';
import {
  readGeocodeCache,
  STORAGE_KEYS
} from '../storage.js';

globalThis.__SWW_SKIP_INIT__ = true;

const ANN_ARBOR = { name: 'Ann Arbor', state: 'Michigan', country: 'US', lat: 42.2808, lon: -83.743 };
const BACKEND_BASE_URL = 'https://weather.example.test';
const WEATHER_RESPONSE = {
  weather: {
    weather: [{ main: 'Clear', description: 'clear sky' }],
    main: { temp: 72, humidity: 45 },
    wind: { speed: 4 }
  },
  observedAt: '2026-08-29T12:00:00.000Z',
  freshUntil: '2026-08-29T12:20:00.000Z',
  stale: false,
  cacheStatus: 'miss'
};

let app = null;

const realFetch = globalThis.fetch;
const realAlert = globalThis.alert;
const realNavigator = globalThis.navigator;
const realBackendBaseUrl = globalThis.BACKEND_BASE_URL;

beforeAll(async () => {
  app = await import('../app.js');
});

beforeEach(() => {
  installStorageMock();
  installDom();
  installNavigator(globalThis.window, { language: 'en-US' });
  globalThis.BACKEND_BASE_URL = BACKEND_BASE_URL;
});

afterEach(() => {
  teardownDom();
  delete globalThis.localStorage;
  if (realFetch) {
    globalThis.fetch = realFetch;
  } else {
    delete globalThis.fetch;
  }
  if (realAlert) {
    globalThis.alert = realAlert;
  } else {
    delete globalThis.alert;
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

function withMockedDate(nowIso, fn) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(value) {
      if (value) {
        return new RealDate(value);
      }
      return new RealDate(nowIso);
    }
    static now() {
      return new RealDate(nowIso).getTime();
    }
  };
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

describe('app helpers', () => {
  test('buildManualLocationKey formats coordinates', () => {
    expect(app.buildManualLocationKey(null)).toBe('manual:invalid');
    expect(app.buildManualLocationKey({ lat: 12.34567, lon: -98.7654 })).toBe('manual:12.3457,-98.7654');
  });

  test('selectPlanetRule matches rules and fallback', () => {
    const cases = [
      { context: { tempF: 10, weatherMain: 'Clear', weatherDescription: '', humidity: 10, windSpeedMph: 0 }, id: 'hoth' },
      { context: { tempF: 60, weatherMain: 'Rain', weatherDescription: '', humidity: 10, windSpeedMph: 0 }, id: 'kamino' },
      { context: { tempF: 60, weatherMain: 'Fog', weatherDescription: '', humidity: 10, windSpeedMph: 0 }, id: 'endor' },
      { context: { tempF: 60, weatherMain: 'Clear', weatherDescription: '', humidity: 10, windSpeedMph: 40 }, id: 'bespin' },
      { context: { tempF: 75, weatherMain: 'Clear', weatherDescription: 'few clouds', humidity: 10, windSpeedMph: 0 }, id: 'scarif' },
      { context: { tempF: 80, weatherMain: 'Clouds', weatherDescription: 'overcast clouds', humidity: 95, windSpeedMph: 0 }, id: 'dagobah' },
      { context: { tempF: 40, weatherMain: 'Clear', weatherDescription: '', humidity: 10, windSpeedMph: 0 }, id: 'naboo' },
      { context: { tempF: 60, weatherMain: 'Clear', weatherDescription: '', humidity: 10, windSpeedMph: 0 }, id: 'coruscant' },
      { context: { tempF: 90, weatherMain: 'Clear', weatherDescription: '', humidity: 10, windSpeedMph: 0 }, id: 'tatooine' },
      { context: { tempF: 100, weatherMain: 'Clear', weatherDescription: '', humidity: 10, windSpeedMph: 0 }, id: 'mustafar' }
    ];

    cases.forEach(({ context, id }) => {
      expect(app.selectPlanetRule(context).id).toBe(id);
    });

    expect(app.selectPlanetRule({
      tempF: Number.NaN,
      weatherMain: 'Clear',
      weatherDescription: '',
      humidity: 0,
      windSpeedMph: 0
    }).id).toBe('coruscant');
  });

  test('selectBackground chooses day or night', () => {
    const rule = { backgrounds: { day: 'day', night: 'night' } };
    expect(app.selectBackground(rule, 'morning')).toBe('day');
    expect(app.selectBackground(rule, 'night')).toBe('night');
    expect(app.selectBackground({ backgrounds: { night: 'night' } }, 'morning')).toBe('night');
    expect(app.selectBackground(rule, 'evening', true)).toBe('day');
    expect(app.selectBackground(rule, 'morning', false)).toBe('night');
  });

  test('resolveTimeOfDay uses hour boundaries', () => {
    const localization = createLocalizationMock({
      time_of_day_morning: { message: 'Morning' },
      time_of_day_afternoon: { message: 'Afternoon' },
      time_of_day_evening: { message: 'Evening' },
      time_of_day_pre_dawn: { message: 'Late Night' },
      time_of_day_night: { message: 'Night' }
    });

    expect(app.resolveTimeOfDay(new Date('2024-01-01T05:00:00'), localization).id).toBe('morning');
    expect(app.resolveTimeOfDay(new Date('2024-01-01T12:00:00'), localization).id).toBe('afternoon');
    expect(app.resolveTimeOfDay(new Date('2024-01-01T17:00:00'), localization).id).toBe('evening');
    expect(app.resolveTimeOfDay(new Date('2024-01-01T04:00:00'), localization).id).toBe('night');
    expect(app.resolveTimeOfDay(new Date('2024-01-01T22:00:00'), localization).id).toBe('night');
  });

  test('resolveIsDaytime follows sunrise/sunset seconds-of-day', () => {
    // UTC+0 so the assertions are timezone-independent
    const sunTimes = {
      sunrise: Date.parse('2024-06-15T06:00:00Z') / 1000,
      sunset: Date.parse('2024-06-15T20:00:00Z') / 1000,
      timezoneOffset: 0
    };

    expect(app.resolveIsDaytime(new Date('2024-06-15T05:59:00Z'), sunTimes)).toBe(false);
    expect(app.resolveIsDaytime(new Date('2024-06-15T06:00:00Z'), sunTimes)).toBe(true);
    expect(app.resolveIsDaytime(new Date('2024-06-15T12:00:00Z'), sunTimes)).toBe(true);
    expect(app.resolveIsDaytime(new Date('2024-06-15T19:59:00Z'), sunTimes)).toBe(true);
    expect(app.resolveIsDaytime(new Date('2024-06-15T20:00:00Z'), sunTimes)).toBe(false);
    expect(app.resolveIsDaytime(new Date('2024-06-15T23:00:00Z'), sunTimes)).toBe(false);
    expect(app.resolveIsDaytime(new Date('2024-06-15T12:00:00Z'), null)).toBeNull();
  });

  test('selectBackground uses sunrise/sunset for day and night art', () => {
    const localization = createLocalizationMock({
      time_of_day_morning: { message: 'Morning' },
      time_of_day_afternoon: { message: 'Afternoon' },
      time_of_day_evening: { message: 'Evening' },
      time_of_day_pre_dawn: { message: 'Late Night' },
      time_of_day_night: { message: 'Night' }
    });
    const rule = { backgrounds: { day: 'planetDay', night: 'planetNight' } };
    const sunTimes = {
      sunrise: Date.parse('2024-06-15T06:00:00Z') / 1000,
      sunset: Date.parse('2024-06-15T20:00:00Z') / 1000,
      timezoneOffset: 0
    };

    const beforeSunrise = app.resolveTimeOfDay(new Date('2024-06-15T05:00:00Z'), localization, sunTimes);
    expect(beforeSunrise.isDaytime).toBe(false);
    expect(app.selectBackground(rule, beforeSunrise.id, beforeSunrise.isDaytime)).toBe('planetNight');

    const afterSunrise = app.resolveTimeOfDay(new Date('2024-06-15T09:00:00Z'), localization, sunTimes);
    expect(afterSunrise.isDaytime).toBe(true);
    expect(afterSunrise.id).toBe('morning');
    expect(app.selectBackground(rule, afterSunrise.id, afterSunrise.isDaytime)).toBe('planetDay');

    const beforeSunset = app.resolveTimeOfDay(new Date('2024-06-15T18:30:00Z'), localization, sunTimes);
    expect(beforeSunset.isDaytime).toBe(true);
    expect(beforeSunset.id).toBe('evening');
    expect(app.selectBackground(rule, beforeSunset.id, beforeSunset.isDaytime)).toBe('planetDay');

    const afterSunset = app.resolveTimeOfDay(new Date('2024-06-15T21:00:00Z'), localization, sunTimes);
    expect(afterSunset.isDaytime).toBe(false);
    expect(app.selectBackground(rule, afterSunset.id, afterSunset.isDaytime)).toBe('planetNight');
  });

  test('missing sunrise/sunset falls back to hour-based day/night art', () => {
    const localization = createLocalizationMock({
      time_of_day_morning: { message: 'Morning' },
      time_of_day_afternoon: { message: 'Afternoon' },
      time_of_day_evening: { message: 'Evening' },
      time_of_day_pre_dawn: { message: 'Late Night' },
      time_of_day_night: { message: 'Night' }
    });
    const rule = { backgrounds: { day: 'planetDay', night: 'planetNight' } };

    expect(app.extractSunTimes({ sys: {} })).toBeNull();
    expect(app.extractSunTimes({ sunrise: 1 })).toBeNull();

    const morning = app.resolveTimeOfDay(new Date('2024-01-01T08:00:00'), localization, null);
    expect(morning.isDaytime).toBe(true);
    expect(app.selectBackground(rule, morning.id, morning.isDaytime)).toBe('planetDay');

    const evening = app.resolveTimeOfDay(new Date('2024-01-01T18:00:00'), localization, null);
    expect(evening.isDaytime).toBe(false);
    expect(app.selectBackground(rule, evening.id, evening.isDaytime)).toBe('planetNight');
  });

  test('formatLastUpdated handles placeholder and date/time formats', () => {
    const localization = {
      language: 'en',
      getMessage(key, substitutions = []) {
        if (key === 'last_updated_placeholder') return 'Last Updated: --';
        if (key === 'last_updated_time') return `TIME:${substitutions[0]}`;
        if (key === 'last_updated_date_time') return `DATE:${substitutions[0]}|${substitutions[1]}`;
        return '';
      }
    };

    expect(app.formatLastUpdated(null, localization)).toBe('Last Updated: --');
    expect(app.formatLastUpdated('bad-date', localization)).toBe('Last Updated: --');

    const sameDay = withMockedDate('2024-01-02T12:00:00', () => {
      return app.formatLastUpdated('2024-01-02T08:00:00', localization);
    });
    expect(sameDay.startsWith('TIME:')).toBe(true);

    const differentDay = withMockedDate('2024-01-02T12:00:00', () => {
      return app.formatLastUpdated('2024-01-01T08:00:00', localization);
    });
    expect(differentDay.startsWith('DATE:')).toBe(true);
  });

  test('formatDisplayName handles US abbreviations', () => {
    expect(app.stateToAbbreviation('California')).toBe('CA');
    expect(app.stateToAbbreviation('ca')).toBe('CA');
    expect(app.formatDisplayName('Los Angeles', 'California', 'US')).toBe('Los Angeles, CA');
    expect(app.formatDisplayName('Paris', 'Ile-de-France', 'FR')).toBe('Paris, Ile-de-France, FR');
  });

  test('resolveLocationName prefers fallback', () => {
    expect(app.resolveLocationName({ name: 'X' }, 'Custom Name')).toBe('Custom Name');
    expect(app.resolveLocationName({ name: 'X', sys: { country: 'US', state: 'California' } }, '')).toBe('X, CA');
  });

  test('buildViewModel builds temperature and labels', () => {
    const localization = createLocalizationMock({
      planet_coruscant_summary: { message: 'Summary $1 $2' },
      planet_coruscant_description: { message: 'Desc' },
      planet_coruscant_name: { message: 'Coruscant' },
      center_heading_prefix: { message: "IT'S LIKE" },
      center_heading_suffix: { message: 'OUTSIDE' },
      time_of_day_morning: { message: 'Morning' },
      planet_reason_coruscant_mild: { message: 'Matched: 55–79°F → Coruscant' }
    });

    const viewModel = withMockedDate('2024-01-02T06:00:00', () => {
      return app.buildViewModel({
        weather: {
          weather: [{ main: 'Clear', description: 'clear sky' }],
          main: { temp: 68, humidity: 20 },
          wind: { speed: 5 },
          name: 'Austin',
          sys: { country: 'US', state: 'Texas' }
        },
        localization,
        language: 'en',
        unit: 'celsius',
        locationKey: 'auto',
        fallbackLocationName: ''
      });
    });

    expect(viewModel.planetClass).toBe('coruscant');
    expect(viewModel.planetId).toBe('coruscant');
    expect(viewModel.message.includes('\u00B0C')).toBe(true);
    expect(viewModel.locationName).toBe('Austin, TX');
    expect(viewModel.unit).toBe('celsius');
    expect(viewModel.matchReason).toBe('Matched: 55–79°F → Coruscant');
    expect(viewModel.tempF).toBe(68);
    expect(typeof viewModel.tempC).toBe('number');
    expect(viewModel.sunrise).toBeNull();
    expect(viewModel.sunset).toBeNull();
  });

  test('buildViewModel uses the backend observation time and rejects a missing temperature', () => {
    const localization = createLocalizationMock({
      time_of_day_morning: { message: 'Morning' }
    });
    const weather = {
      weather: [{ main: 'Clear', description: 'clear sky' }],
      main: { temp: 68 }
    };

    const viewModel = app.buildViewModel({
      weather,
      observedAt: '2026-08-29T11:42:00.000Z',
      freshUntil: '2026-08-29T12:02:00.000Z',
      localization,
      language: 'en',
      unit: 'fahrenheit',
      locationKey: 'auto',
      fallbackLocationName: '',
      weatherLocation: {
        cell: '42.33,-83.05',
        accuracyMeters: 75,
        positionAt: '2026-08-29T11:41:59.000Z'
      }
    });
    expect(viewModel.lastUpdated).toBe('2026-08-29T11:42:00.000Z');
    expect(viewModel.freshUntil).toBe('2026-08-29T12:02:00.000Z');
    expect(viewModel.weatherLocation.cell).toBe('42.33,-83.05');

    expect(() => app.buildViewModel({
      weather: { weather: [{ main: 'Clear' }], main: {} },
      localization,
      language: 'en',
      unit: 'fahrenheit',
      locationKey: 'auto',
      fallbackLocationName: ''
    })).toThrow('no valid temperature');
  });

  test('buildViewModel persists sunrise/sunset and selects night art before sunrise', () => {
    const localization = createLocalizationMock({
      planet_coruscant_summary: { message: 'Summary $1 $2' },
      planet_coruscant_description: { message: 'Desc' },
      planet_coruscant_name: { message: 'Coruscant' },
      center_heading_prefix: { message: "IT'S LIKE" },
      center_heading_suffix: { message: 'OUTSIDE' },
      time_of_day_night: { message: 'Night' },
      time_of_day_pre_dawn: { message: 'Late Night' },
      planet_reason_coruscant_mild: { message: 'Matched: 55–79°F → Coruscant' }
    });

    const sunrise = Date.parse('2024-06-15T06:00:00Z') / 1000;
    const sunset = Date.parse('2024-06-15T20:00:00Z') / 1000;

    const viewModel = withMockedDate('2024-06-15T05:00:00Z', () => {
      return app.buildViewModel({
        weather: {
          weather: [{ main: 'Clear', description: 'clear sky' }],
          main: { temp: 68, humidity: 20 },
          wind: { speed: 5 },
          name: 'Austin',
          timezone: 0,
          sys: { country: 'US', state: 'Texas', sunrise, sunset }
        },
        localization,
        language: 'en',
        unit: 'fahrenheit',
        locationKey: 'auto',
        fallbackLocationName: ''
      });
    });

    expect(viewModel.sunrise).toBe(sunrise);
    expect(viewModel.sunset).toBe(sunset);
    expect(viewModel.timezoneOffset).toBe(0);
    expect(viewModel.planetClass).toBe('coruscantNight');
  });

  test('buildViewModel includes match reason for Bespin', () => {
    const localization = createLocalizationMock({
      planet_bespin_summary: { message: 'Windy $1 $2' },
      planet_bespin_description: { message: 'Clouds' },
      planet_bespin_name: { message: 'Bespin' },
      center_heading_prefix: { message: "IT'S LIKE" },
      center_heading_suffix: { message: 'OUTSIDE' },
      time_of_day_morning: { message: 'Morning' },
      planet_reason_bespin_wind: { message: 'Matched: wind ≥ 35 mph → Bespin' }
    });

    const viewModel = withMockedDate('2024-01-02T06:00:00', () => {
      return app.buildViewModel({
        weather: {
          weather: [{ main: 'Clouds', description: 'overcast clouds' }],
          main: { temp: 60, humidity: 20 },
          wind: { speed: 40 },
          name: 'Chicago',
          sys: { country: 'US', state: 'Illinois' }
        },
        localization,
        language: 'en',
        unit: 'fahrenheit',
        locationKey: 'auto',
        fallbackLocationName: ''
      });
    });

    expect(viewModel.planetId).toBe('bespin');
    expect(viewModel.matchReason).toBe('Matched: wind ≥ 35 mph → Bespin');
  });

  test('explainMatch returns predicate-accurate reason keys', () => {
    expect(app.explainMatch({ id: 'hoth' }, { weatherMain: 'Snow', tempF: 20 })).toBe('planet_reason_hoth_snow');
    expect(app.explainMatch({ id: 'hoth' }, { weatherMain: 'Clear', tempF: 20 })).toBe('planet_reason_hoth_cold');
    expect(app.explainMatch({ id: 'bespin' }, { windSpeedMph: 40 })).toBe('planet_reason_bespin_wind');
    expect(app.explainMatch({ id: 'mustafar' }, { tempF: 100 })).toBe('planet_reason_mustafar_scorching');
    expect(app.explainMatch({ id: 'coruscant' }, { tempF: 60 })).toBe('planet_reason_coruscant_mild');
    expect(app.explainMatch({ id: 'coruscant' }, { tempF: Number.NaN })).toBe('planet_reason_coruscant_default');
  });

  test('getOppositeUnit flips fahrenheit and celsius', () => {
    expect(app.getOppositeUnit('fahrenheit')).toBe('celsius');
    expect(app.getOppositeUnit('celsius')).toBe('fahrenheit');
    expect(app.getOppositeUnit('other')).toBe('celsius');
  });

  test('rebuildViewModelForUnit rebuilds message from stored temps', () => {
    const localization = createLocalizationMock({
      planet_coruscant_summary: { message: 'Summary $1 $2' }
    });

    const rebuilt = app.rebuildViewModelForUnit({
      planetId: 'coruscant',
      tempF: 68,
      tempC: 20,
      timeOfDayLabel: 'Morning',
      unit: 'fahrenheit',
      message: 'Summary 68\u00B0F Morning'
    }, 'celsius', localization);

    expect(rebuilt.unit).toBe('celsius');
    expect(rebuilt.message).toBe('Summary 20\u00B0C Morning');
  });
});

describe('network helpers', () => {
  test('fetchWeather builds request and handles response', async () => {
    globalThis.fetch = createFetchMock([
      { json: WEATHER_RESPONSE }
    ]);

    const response = await app.fetchWeather(10, 20);
    const calledUrl = globalThis.fetch.calls[0];
    expect(calledUrl.includes('lat=10')).toBe(true);
    expect(calledUrl.includes('lon=20')).toBe(true);
    expect(calledUrl.includes('/v1/weather')).toBe(true);
    expect(calledUrl.includes('appid=')).toBe(false);
    expect(response.weather.main.temp).toBe(72);
  });

  test('fetchWeather counts a backend weather call', async () => {
    globalThis.fetch = createFetchMock([{ json: WEATHER_RESPONSE }]);

    await app.fetchWeather(10, 20);

    const telemetry = JSON.parse(localStorage.getItem(STORAGE_KEYS.telemetry));
    expect(telemetry.weatherCalls).toBe(1);
    expect(telemetry.geocodeCalls).toBe(0);
  });

  test('fetchLocationDetails counts a geocode call only when it misses the cache', async () => {
    globalThis.fetch = createFetchMock([{ json: { location: ANN_ARBOR } }]);

    await app.fetchLocationDetails(ANN_ARBOR.lat, ANN_ARBOR.lon);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.telemetry)).geocodeCalls).toBe(1);

    // second lookup hits the geocode cache, so no new count
    await app.fetchLocationDetails(ANN_ARBOR.lat, ANN_ARBOR.lon);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.telemetry)).geocodeCalls).toBe(1);
    expect(globalThis.fetch.calls).toHaveLength(1);
  });

  test('fetchLocationDetails caches a successful lookup', async () => {
    globalThis.fetch = createFetchMock([
      { json: { location: ANN_ARBOR } }
    ]);

    const result = await app.fetchLocationDetails(42.2808, -83.743);
    expect(result).toEqual(ANN_ARBOR);
    expect(globalThis.fetch.calls.length).toBe(1);
    expect(readGeocodeCache(42.2808, -83.743).details).toEqual(ANN_ARBOR);
  });

  test('fetchLocationDetails reuses the cache for a nearby coordinate', async () => {
    globalThis.fetch = createFetchMock([
      { json: { location: ANN_ARBOR } }
    ]);

    await app.fetchLocationDetails(42.2808, -83.743);
    const nearby = await app.fetchLocationDetails(42.2812, -83.7434);
    expect(nearby).toEqual(ANN_ARBOR);
    expect(globalThis.fetch.calls.length).toBe(1);
  });

  test('fetchLocationDetails negatively caches an empty lookup', async () => {
    globalThis.fetch = createFetchMock([
      { json: { location: null } }
    ]);

    expect(await app.fetchLocationDetails(0, 0)).toBeNull();
    expect(await app.fetchLocationDetails(0, 0)).toBeNull();
    expect(globalThis.fetch.calls.length).toBe(1);
  });

  test('fetchLocationDetails does not cache a failed lookup', async () => {
    globalThis.fetch = createFetchMock([
      { ok: false, status: 500, json: {} }
    ]);

    await expect(app.fetchLocationDetails(42.2808, -83.743)).rejects.toThrow();
    expect(localStorage.getItem(STORAGE_KEYS.geocodeCache)).toBeNull();
  });
});

describe('offline fallback and hyperspace', () => {
  test('waitForMinimumHyperspace resolves immediately when elapsed', async () => {
    const startedAt = Date.now() - 5000;
    const before = Date.now();
    await app.waitForMinimumHyperspace(startedAt, 100);
    expect(Date.now() - before).toBeLessThan(50);
  });

  test('waitForMinimumHyperspace waits remaining time', async () => {
    const startedAt = Date.now();
    const before = Date.now();
    await app.waitForMinimumHyperspace(startedAt, 40);
    expect(Date.now() - before).toBeGreaterThanOrEqual(35);
  });

  test('isNavigatorOffline detects navigator.onLine === false', () => {
    installNavigator(globalThis.window, { language: 'en-US', onLine: false });
    expect(app.isNavigatorOffline()).toBe(true);
    installNavigator(globalThis.window, { language: 'en-US', onLine: true });
    expect(app.isNavigatorOffline()).toBe(false);
  });

  test('buildOfflineRandomViewModel returns offline-themed view model', () => {
    const localization = createLocalizationMock({
      offline_random_planet: { message: 'Random offline' },
      offline_signal_lost: { message: 'Sensors offline — last known: $1' },
      center_heading_prefix: { message: "IT'S LIKE" },
      center_heading_suffix: { message: 'OUTSIDE' },
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

    const viewModel = app.buildOfflineRandomViewModel(localization, 'en', 'fahrenheit');
    expect(viewModel.offline).toBe(true);
    expect(viewModel.message).toBe('Random offline');
    expect(viewModel.planetId).toBeTruthy();
    expect(viewModel.lastUpdatedLabel.includes(viewModel.planetName)).toBe(true);
  });

  test('rehydrateLastKnownViewModel marks offline and prefers planetId', () => {
    const localization = createLocalizationMock({
      offline_signal_lost: { message: 'Sensors offline — last known: $1' },
      center_heading_prefix: { message: "IT'S LIKE" },
      center_heading_suffix: { message: 'OUTSIDE' },
      planet_tatooine_name: { message: 'Tatooine' },
      planet_tatooine_description: { message: 'Desert world' },
      time_of_day_morning: { message: 'Morning' },
      time_of_day_afternoon: { message: 'Afternoon' },
      time_of_day_evening: { message: 'Evening' },
      time_of_day_night: { message: 'Night' },
      time_of_day_pre_dawn: { message: 'Late Night' }
    });

    const viewModel = withMockedDate('2024-01-02T06:00:00', () => {
      return app.rehydrateLastKnownViewModel({
        planetId: 'tatooine',
        planetName: 'Old Name',
        planetClass: 'tatooineNight',
        message: 'Hot afternoon',
        description: 'Old desc',
        language: 'en',
        unit: 'fahrenheit',
        lastUpdated: '2024-01-01T00:00:00.000Z'
      }, localization, 'en', 'fahrenheit');
    });

    expect(viewModel.offline).toBe(true);
    expect(viewModel.planetName).toBe('Tatooine');
    expect(viewModel.description).toBe('Desert world');
    expect(viewModel.message).toBe('Hot afternoon');
    expect(viewModel.planetClass).toBe('tatooine');
    expect(viewModel.lastUpdatedLabel).toBe('Sensors offline — last known: Tatooine');
  });

  test('rehydrateLastKnownViewModel uses persisted sunrise/sunset for background', () => {
    const localization = createLocalizationMock({
      offline_signal_lost: { message: 'Sensors offline — last known: $1' },
      center_heading_prefix: { message: "IT'S LIKE" },
      center_heading_suffix: { message: 'OUTSIDE' },
      planet_tatooine_name: { message: 'Tatooine' },
      planet_tatooine_description: { message: 'Desert world' },
      time_of_day_morning: { message: 'Morning' },
      time_of_day_afternoon: { message: 'Afternoon' },
      time_of_day_evening: { message: 'Evening' },
      time_of_day_night: { message: 'Night' },
      time_of_day_pre_dawn: { message: 'Late Night' }
    });

    const sunrise = Date.parse('2024-06-15T06:00:00Z') / 1000;
    const sunset = Date.parse('2024-06-15T20:00:00Z') / 1000;

    const nightView = withMockedDate('2024-06-16T21:00:00Z', () => {
      return app.rehydrateLastKnownViewModel({
        planetId: 'tatooine',
        planetName: 'Tatooine',
        planetClass: 'tatooine',
        message: 'Hot',
        description: 'Desert',
        language: 'en',
        unit: 'fahrenheit',
        sunrise,
        sunset,
        timezoneOffset: 0,
        lastUpdated: '2024-06-15T12:00:00.000Z'
      }, localization, 'en', 'fahrenheit');
    });

    expect(nightView.planetClass).toBe('tatooineNight');
    expect(nightView.sunrise).toBe(sunrise);
    expect(nightView.sunset).toBe(sunset);

    const dayView = withMockedDate('2024-06-16T10:00:00Z', () => {
      return app.rehydrateLastKnownViewModel({
        planetId: 'tatooine',
        planetName: 'Tatooine',
        planetClass: 'tatooineNight',
        message: 'Hot',
        description: 'Desert',
        language: 'en',
        unit: 'fahrenheit',
        sunrise,
        sunset,
        timezoneOffset: 0,
        lastUpdated: '2024-06-15T12:00:00.000Z'
      }, localization, 'en', 'fahrenheit');
    });

    expect(dayView.planetClass).toBe('tatooine');
  });
});

describe('geolocation flow', () => {
  test('resolveLocation rejects without geolocation', async () => {
    globalThis.navigator = { language: 'en-US' };
    const localization = createLocalizationMock({
      alert_geolocation_error: { message: 'Geo error' }
    });
    await expect(app.resolveLocation(localization)).rejects.toThrow();
  });

  test('resolveLocation retries and resolves', async () => {
    const alertSpy = createSpy();
    globalThis.alert = alertSpy;

    let calls = 0;
    globalThis.navigator = {
      language: 'en-US',
      geolocation: {
        getCurrentPosition(success, error) {
          calls += 1;
          if (calls === 1) {
            error(new Error('fail'));
          } else {
            success({ coords: { latitude: 1, longitude: 2 } });
          }
        }
      }
    };

    const localization = createLocalizationMock({
      alert_geolocation_error: { message: 'Geo error' }
    });

    const result = await app.resolveLocation(localization);
    expect(result.coords.latitude).toBe(1);
    expect(alertSpy.calls.length).toBe(1);
  });

  test('resolveLocation rejects when retry fails', async () => {
    const alertSpy = createSpy();
    globalThis.alert = alertSpy;

    globalThis.navigator = {
      language: 'en-US',
      geolocation: {
        getCurrentPosition(_success, error) {
          error(new Error('fail'));
        }
      }
    };

    const localization = createLocalizationMock({
      alert_geolocation_error: { message: 'Geo error' }
    });

    await expect(app.resolveLocation(localization)).rejects.toThrow();
    expect(alertSpy.calls.length).toBe(1);
  });
});
