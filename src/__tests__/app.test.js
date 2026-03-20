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

globalThis.__SWW_SKIP_INIT__ = true;

let app = null;

const realFetch = globalThis.fetch;
const realAlert = globalThis.alert;
const realNavigator = globalThis.navigator;
const realApiKey = globalThis.API_KEY;

beforeAll(async () => {
  app = await import('../app.js');
});

beforeEach(() => {
  installStorageMock();
  installDom();
  installNavigator(globalThis.window, { language: 'en-US' });
  globalThis.API_KEY = 'test-key';
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
  if (realApiKey) {
    globalThis.API_KEY = realApiKey;
  } else {
    delete globalThis.API_KEY;
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
      time_of_day_morning: { message: 'Morning' }
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
    expect(viewModel.message.includes('\u00B0C')).toBe(true);
    expect(viewModel.locationName).toBe('Austin, TX');
    expect(viewModel.unit).toBe('celsius');
  });
});

describe('network helpers', () => {
  test('fetchWeather builds request and handles response', async () => {
    globalThis.fetch = createFetchMock([
      { json: { ok: true } }
    ]);

    await app.fetchWeather(10, 20);
    const calledUrl = globalThis.fetch.calls[0];
    expect(calledUrl.includes('lat=10')).toBe(true);
    expect(calledUrl.includes('lon=20')).toBe(true);
    expect(calledUrl.includes('units=imperial')).toBe(true);
    expect(calledUrl.includes('appid=test-key')).toBe(true);
  });

  test('fetchWeather throws on bad response', async () => {
    globalThis.fetch = createFetchMock([
      { ok: false, status: 500, json: {} }
    ]);

    await expect(app.fetchWeather(10, 20)).rejects.toThrow();
  });

  test('fetchLocationDetails returns null when empty', async () => {
    globalThis.fetch = createFetchMock([
      { json: [] }
    ]);

    const result = await app.fetchLocationDetails(10, 20);
    expect(result).toBeNull();
  });

  test('fetchLocationDetails throws when API key missing', async () => {
    delete globalThis.API_KEY;
    await expect(app.fetchLocationDetails(10, 20)).rejects.toThrow();
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
