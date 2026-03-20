import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  clearGeolocationAlerted,
  clearWeatherCache,
  getManualLocation,
  getPreferredLanguage,
  getPreferredUnit,
  getShowSearchBar,
  getShowShortcuts,
  hasShownGeolocationError,
  markGeolocationAlerted,
  readWeatherCache,
  setManualLocation,
  setPreferredLanguage,
  setPreferredUnit,
  writeWeatherCache,
  STORAGE_KEYS
} from '../storage.js';
import { installStorageMock } from './testUtils.js';

const realNavigator = globalThis.navigator;

beforeEach(() => {
  installStorageMock();
  globalThis.navigator = { language: 'en-US' };
});

afterEach(() => {
  delete globalThis.localStorage;
  if (realNavigator) {
    globalThis.navigator = realNavigator;
  } else {
    delete globalThis.navigator;
  }
});

describe('storage cache', () => {
  test('returns null when cache empty', () => {
    expect(readWeatherCache()).toBeNull();
  });

  test('clears expired cache', () => {
    const expired = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify({ lastUpdated: expired }));
    expect(readWeatherCache()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.cache)).toBeNull();
  });

  test('clears cache with invalid timestamp', () => {
    localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify({ lastUpdated: 'bad-date' }));
    expect(readWeatherCache()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.cache)).toBeNull();
  });

  test('returns null on language mismatch', () => {
    const record = { lastUpdated: new Date().toISOString(), language: 'en' };
    localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify(record));
    expect(readWeatherCache({ language: 'es' })).toBeNull();
  });

  test('returns null on unit mismatch', () => {
    const record = { lastUpdated: new Date().toISOString(), unit: 'celsius' };
    localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify(record));
    expect(readWeatherCache({ unit: 'fahrenheit' })).toBeNull();
  });

  test('returns null on location mismatch', () => {
    const record = { lastUpdated: new Date().toISOString(), locationKey: 'manual:1,2' };
    localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify(record));
    expect(readWeatherCache({ locationKey: 'auto' })).toBeNull();
    expect(readWeatherCache({ locationKey: 'manual:3,4' })).toBeNull();
  });

  test('returns cached data when filters match', () => {
    const record = {
      lastUpdated: new Date().toISOString(),
      language: 'en',
      unit: 'fahrenheit',
      locationKey: 'auto',
      planetName: 'Test'
    };
    localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify(record));
    expect(readWeatherCache({ language: 'en', unit: 'fahrenheit', locationKey: 'auto' })).toEqual(record);
  });

  test('clears cache on invalid JSON', () => {
    localStorage.setItem(STORAGE_KEYS.cache, '{not-json}');
    expect(readWeatherCache()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.cache)).toBeNull();
  });

  test('writeWeatherCache requires an object', () => {
    expect(() => writeWeatherCache(null)).toThrow();
  });

  test('writeWeatherCache fills defaults and clears legacy keys', () => {
    localStorage.setItem('planet', 'old');
    localStorage.setItem('message', 'old');
    writeWeatherCache({ planetName: 'Test' });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.cache));
    expect(stored.locationKey).toBe('auto');
    expect(stored.lastUpdated).toBeTruthy();
    expect(localStorage.getItem('planet')).toBeNull();
    expect(localStorage.getItem('message')).toBeNull();
  });

  test('clearWeatherCache removes cache and legacy entries', () => {
    localStorage.setItem(STORAGE_KEYS.cache, '{}');
    localStorage.setItem('description', 'old');
    clearWeatherCache();
    expect(localStorage.getItem(STORAGE_KEYS.cache)).toBeNull();
    expect(localStorage.getItem('description')).toBeNull();
  });
});

describe('preferences and flags', () => {
  test('getPreferredLanguage uses stored value', () => {
    localStorage.setItem(STORAGE_KEYS.language, 'ES');
    expect(getPreferredLanguage()).toBe('es');
  });

  test('getPreferredLanguage falls back to browser language', () => {
    globalThis.navigator = { language: 'es-MX' };
    expect(getPreferredLanguage()).toBe('es');
    globalThis.navigator = { language: 'fr-FR' };
    expect(getPreferredLanguage()).toBe('en');
  });

  test('setPreferredLanguage clears when empty', () => {
    localStorage.setItem(STORAGE_KEYS.language, 'en');
    setPreferredLanguage('');
    expect(localStorage.getItem(STORAGE_KEYS.language)).toBeNull();
  });

  test('getPreferredUnit handles legacy values', () => {
    expect(getPreferredUnit()).toBe('fahrenheit');
    localStorage.setItem(STORAGE_KEYS.unit, 'celsius');
    expect(getPreferredUnit()).toBe('celsius');
    localStorage.setItem(STORAGE_KEYS.unit, 'farenheit');
    expect(getPreferredUnit()).toBe('fahrenheit');
  });

  test('setPreferredUnit normalizes values', () => {
    setPreferredUnit('celsius');
    expect(localStorage.getItem(STORAGE_KEYS.unit)).toBe('celsius');
    setPreferredUnit('fahrenheit');
    expect(localStorage.getItem(STORAGE_KEYS.unit)).toBe('fahrenheit');
    setPreferredUnit(null);
    expect(localStorage.getItem(STORAGE_KEYS.unit)).toBeNull();
  });

  test('geolocation alert flags', () => {
    expect(hasShownGeolocationError()).toBe(false);
    markGeolocationAlerted();
    expect(hasShownGeolocationError()).toBe(true);
    clearGeolocationAlerted();
    expect(hasShownGeolocationError()).toBe(false);
  });

  test('getShowSearchBar defaults to false when unset', () => {
    expect(getShowSearchBar()).toBe(false);
  });

  test('getShowSearchBar returns true when explicitly enabled', () => {
    localStorage.setItem('showSearchBar', 'true');
    expect(getShowSearchBar()).toBe(true);
  });

  test('getShowSearchBar returns false when explicitly disabled', () => {
    localStorage.setItem('showSearchBar', 'false');
    expect(getShowSearchBar()).toBe(false);
  });

  test('getShowShortcuts defaults to false when unset', () => {
    expect(getShowShortcuts()).toBe(false);
  });

  test('getShowShortcuts returns true when explicitly enabled', () => {
    localStorage.setItem('showShortcuts', 'true');
    expect(getShowShortcuts()).toBe(true);
  });

  test('getShowShortcuts returns false when explicitly disabled', () => {
    localStorage.setItem('showShortcuts', 'false');
    expect(getShowShortcuts()).toBe(false);
  });
});

describe('manual location', () => {
  test('getManualLocation returns null on invalid payload', () => {
    localStorage.setItem(STORAGE_KEYS.manualLocation, 'bad-json');
    expect(getManualLocation()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.manualLocation)).toBeNull();
  });

  test('getManualLocation validates coordinates', () => {
    localStorage.setItem(STORAGE_KEYS.manualLocation, JSON.stringify({ name: 'x' }));
    expect(getManualLocation()).toBeNull();
  });

  test('setManualLocation normalizes and rounds values', () => {
    setManualLocation({ name: 'Paris', lat: 48.85663, lon: 2.35222, country: 'FR' });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.manualLocation));
    expect(stored.lat).toBe(48.8566);
    expect(stored.lon).toBe(2.3522);
  });

  test('setManualLocation clears on invalid coordinates', () => {
    localStorage.setItem(STORAGE_KEYS.manualLocation, '{}');
    setManualLocation({ name: 'bad', lat: 'nope', lon: null });
    expect(localStorage.getItem(STORAGE_KEYS.manualLocation)).toBeNull();
  });
});
