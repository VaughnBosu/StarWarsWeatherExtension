import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildGeocodeCacheKey,
  buildGeocodeQueryKey,
  clearGeolocationAlerted,
  GEOCODE_QUERY_CACHE_MAX_ENTRIES,
  readGeocodeQueryCache,
  writeGeocodeQueryCache,
  clearWeatherCache,
  getManualLocation,
  getPreferredLanguage,
  getPreferredUnit,
  getShowGoogleApps,
  getShowSearchBar,
  getShowShortcuts,
  getVisitedPlanets,
  hasShownGeolocationError,
  setShowGoogleApps,
  markGeolocationAlerted,
  markPlanetVisited,
  readGeocodeCache,
  readLastKnownWeather,
  readWeatherCache,
  readBackendRetryAt,
  writeBackendRetryAt,
  clearBackendRetryAt,
  setManualLocation,
  writeGeocodeCache,
  setPreferredLanguage,
  setPreferredUnit,
  writeLastKnownWeather,
  writeWeatherCache,
  STORAGE_KEYS
} from '../storage.js';
import { GEOCODE_CACHE_MAX_ENTRIES, GEOCODING_RESULT_LIMIT } from '../config.js';
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

  // Pre-2.5 records have no cachedAt; lastUpdated stands in as the fetch time.
  test('returns cached data when filters match, with a v2.4 fetch time surfaced as cachedAt', () => {
    const record = {
      lastUpdated: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
      language: 'en',
      unit: 'fahrenheit',
      locationKey: 'auto',
      planetName: 'Test'
    };
    localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify(record));
    expect(readWeatherCache({ language: 'en', unit: 'fahrenheit', locationKey: 'auto' }))
      .toEqual({ ...record, cachedAt: record.lastUpdated });
  });

  test('clears cache on invalid JSON', () => {
    localStorage.setItem(STORAGE_KEYS.cache, '{not-json}');
    expect(readWeatherCache()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.cache)).toBeNull();
  });

  // A fallback written into the cache would be served as a hit: "Sensors offline"
  // and a stale planet for a user who is back online, with no refresh attempted.
  test('never serves a stored offline fallback as a cache hit', () => {
    localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify({
      lastUpdated: new Date().toISOString(),
      language: 'en',
      unit: 'fahrenheit',
      locationKey: 'auto',
      planetId: 'hoth',
      offline: true
    }));

    expect(readWeatherCache({ language: 'en', unit: 'fahrenheit', locationKey: 'auto' })).toBeNull();
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

describe('geocode cache', () => {
  const ANN_ARBOR = { name: 'Ann Arbor', state: 'Michigan', country: 'US' };

  function seedGeocodeCache(latitude, longitude, details, ageMs) {
    localStorage.setItem(STORAGE_KEYS.geocodeCache, JSON.stringify([{
      key: buildGeocodeCacheKey(latitude, longitude),
      details,
      lastUpdated: new Date(Date.now() - ageMs).toISOString()
    }]));
  }

  test('buildGeocodeCacheKey rounds to two decimals', () => {
    expect(buildGeocodeCacheKey(42.28083, -83.74304)).toBe('42.28,-83.74');
    expect(buildGeocodeCacheKey(42.3, -83.7)).toBe('42.3,-83.7');
  });

  test('buildGeocodeCacheKey returns null for invalid coordinates', () => {
    expect(buildGeocodeCacheKey(undefined, 10)).toBeNull();
    expect(buildGeocodeCacheKey(10, Number.NaN)).toBeNull();
  });

  test('round-trips a geocode record', () => {
    writeGeocodeCache(42.2808, -83.7430, ANN_ARBOR);
    const cached = readGeocodeCache(42.2808, -83.7430);
    expect(cached).not.toBeNull();
    expect(cached.details).toEqual(ANN_ARBOR);
    expect(cached.key).toBe('42.28,-83.74');
  });

  test('nearby coordinates share one cache entry', () => {
    writeGeocodeCache(42.2808, -83.7430, ANN_ARBOR);
    // ~40m away, same 2-decimal bucket
    const cached = readGeocodeCache(42.2812, -83.7434);
    expect(cached?.details).toEqual(ANN_ARBOR);
  });

  test('distant coordinates miss the cache', () => {
    writeGeocodeCache(42.2808, -83.7430, ANN_ARBOR);
    expect(readGeocodeCache(42.35, -83.74)).toBeNull();
  });

  test('remembers several locations at once', () => {
    const DETROIT = { name: 'Detroit', state: 'Michigan', country: 'US' };
    writeGeocodeCache(42.2808, -83.7430, ANN_ARBOR);
    writeGeocodeCache(42.3314, -83.0458, DETROIT);

    // commute case: the second write must not evict the first
    expect(readGeocodeCache(42.2808, -83.7430)?.details).toEqual(ANN_ARBOR);
    expect(readGeocodeCache(42.3314, -83.0458)?.details).toEqual(DETROIT);
  });

  test('re-writing a location updates it in place rather than duplicating', () => {
    writeGeocodeCache(42.2808, -83.7430, ANN_ARBOR);
    writeGeocodeCache(42.2808, -83.7430, { ...ANN_ARBOR, name: 'Ann Arbor Renamed' });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.geocodeCache));
    expect(stored).toHaveLength(1);
    expect(readGeocodeCache(42.2808, -83.7430)?.details.name).toBe('Ann Arbor Renamed');
  });

  test('caps the entry list, evicting the least recently written', () => {
    for (let i = 0; i < GEOCODE_CACHE_MAX_ENTRIES + 2; i += 1) {
      writeGeocodeCache(40 + i, -83.74, { name: `City ${i}`, country: 'US' });
    }

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.geocodeCache));
    expect(stored).toHaveLength(GEOCODE_CACHE_MAX_ENTRIES);

    expect(readGeocodeCache(40, -83.74)).toBeNull();
    expect(readGeocodeCache(41, -83.74)).toBeNull();
    expect(readGeocodeCache(42, -83.74)?.details.name).toBe('City 2');
    expect(readGeocodeCache(40 + GEOCODE_CACHE_MAX_ENTRIES + 1, -83.74)).not.toBeNull();
  });

  test('one expired location does not evict a live one', () => {
    localStorage.setItem(STORAGE_KEYS.geocodeCache, JSON.stringify([
      {
        key: buildGeocodeCacheKey(42.28, -83.74),
        details: ANN_ARBOR,
        lastUpdated: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
      },
      {
        key: buildGeocodeCacheKey(42.33, -83.04),
        details: { name: 'Detroit', country: 'US' },
        lastUpdated: new Date().toISOString()
      }
    ]));

    expect(readGeocodeCache(42.28, -83.74)).toBeNull();
    expect(readGeocodeCache(42.33, -83.04)?.details.name).toBe('Detroit');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.geocodeCache))).toHaveLength(1);
  });

  test('discards a malformed payload instead of throwing', () => {
    localStorage.setItem(STORAGE_KEYS.geocodeCache, '{"key":"legacy","details":null}');
    expect(readGeocodeCache(42.28, -83.74)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.geocodeCache)).toBeNull();
  });

  test('expires positive entries after the long TTL', () => {
    seedGeocodeCache(42.28, -83.74, ANN_ARBOR, 31 * 24 * 60 * 60 * 1000);
    expect(readGeocodeCache(42.28, -83.74)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.geocodeCache)).toBeNull();
  });

  test('keeps positive entries within the long TTL', () => {
    seedGeocodeCache(42.28, -83.74, ANN_ARBOR, 29 * 24 * 60 * 60 * 1000);
    expect(readGeocodeCache(42.28, -83.74)?.details).toEqual(ANN_ARBOR);
  });

  test('negative entries survive briefly then expire on the short TTL', () => {
    seedGeocodeCache(0, 0, null, 60 * 60 * 1000);
    const fresh = readGeocodeCache(0, 0);
    expect(fresh).not.toBeNull();
    expect(fresh.details).toBeNull();

    seedGeocodeCache(0, 0, null, 25 * 60 * 60 * 1000);
    expect(readGeocodeCache(0, 0)).toBeNull();
  });

  test('writeGeocodeCache normalises missing details to null', () => {
    const record = writeGeocodeCache(42.28, -83.74, undefined);
    expect(record.details).toBeNull();
    expect(readGeocodeCache(42.28, -83.74).details).toBeNull();
  });

  test('writeGeocodeCache ignores invalid coordinates', () => {
    expect(writeGeocodeCache(Number.NaN, -83.74, ANN_ARBOR)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.geocodeCache)).toBeNull();
  });

  test('clears cache on invalid JSON', () => {
    localStorage.setItem(STORAGE_KEYS.geocodeCache, '{not-json}');
    expect(readGeocodeCache(42.28, -83.74)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.geocodeCache)).toBeNull();
  });

  // A read that prunes must not fail for the write it chose to do: this threw
  // QuotaExceededError out of fetchLocationDetails, discarding a fetched place name.
  test('a full disk during the prune write does not fail the read', () => {
    localStorage.setItem(STORAGE_KEYS.geocodeCache, JSON.stringify([
      {
        key: buildGeocodeCacheKey(42.28, -83.74),
        details: ANN_ARBOR,
        lastUpdated: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
      },
      {
        key: buildGeocodeCacheKey(42.33, -83.04),
        details: { name: 'Detroit', country: 'US' },
        lastUpdated: new Date().toISOString()
      }
    ]));

    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };

    expect(readGeocodeCache(42.33, -83.04)?.details.name).toBe('Detroit');
  });

  test('a full disk during writeGeocodeCache does not throw', () => {
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };

    let record;
    expect(() => {
      record = writeGeocodeCache(42.28, -83.74, ANN_ARBOR);
    }).not.toThrow();
    expect(record.details).toEqual(ANN_ARBOR);
  });

  test('a failing removeItem does not fail an expired weather cache read', () => {
    localStorage.setItem(
      STORAGE_KEYS.cache,
      JSON.stringify({ lastUpdated: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() })
    );

    localStorage.removeItem = () => {
      throw new Error('SecurityError');
    };

    expect(readWeatherCache()).toBeNull();
  });
});

describe('forward geocode query cache', () => {
  const ANN_ARBOR_RESULTS = [
    { name: 'Ann Arbor', state: 'Michigan', country: 'US', lat: 42.2808, lon: -83.743 },
    { name: 'Ann Arbor Charter Township', state: 'Michigan', country: 'US', lat: 42.3, lon: -83.7 }
  ];

  function seedQueryCache(key, results, ageMs) {
    localStorage.setItem(STORAGE_KEYS.geocodeQueryCache, JSON.stringify([{
      key,
      results,
      lastUpdated: new Date(Date.now() - ageMs).toISOString()
    }]));
  }

  test('buildGeocodeQueryKey trims, collapses whitespace and case-folds', () => {
    expect(buildGeocodeQueryKey('  Ann   Arbor, MI ')).toBe('ann arbor, mi');
    expect(buildGeocodeQueryKey('ANN ARBOR')).toBe('ann arbor');
  });

  test('buildGeocodeQueryKey returns null for an empty query', () => {
    expect(buildGeocodeQueryKey('')).toBeNull();
    expect(buildGeocodeQueryKey('   ')).toBeNull();
    expect(buildGeocodeQueryKey(undefined)).toBeNull();
    expect(buildGeocodeQueryKey(42)).toBeNull();
  });

  test('round-trips a suggestion list', () => {
    writeGeocodeQueryCache('Ann Arbor', ANN_ARBOR_RESULTS);
    const cached = readGeocodeQueryCache('Ann Arbor');
    expect(cached).not.toBeNull();
    expect(cached.results).toEqual(ANN_ARBOR_RESULTS);
    expect(cached.key).toBe('ann arbor');
  });

  // The popup dies on blur, so the second search only avoids a /geo call if the
  // answer outlived the page, and typing it differently must still hit.
  test('a differently spelled repeat of the same search hits the cache', () => {
    writeGeocodeQueryCache('Ann Arbor', ANN_ARBOR_RESULTS);
    expect(readGeocodeQueryCache('  ann   arbor  ')?.results).toHaveLength(2);
    expect(readGeocodeQueryCache('ANN ARBOR')?.results).toHaveLength(2);
    expect(readGeocodeQueryCache('Ypsilanti')).toBeNull();
  });

  test('stores only the fields the suggestion UI reads', () => {
    writeGeocodeQueryCache('Paris', [{
      name: 'Paris',
      state: 'Ile-de-France',
      country: 'FR',
      lat: 48.8566,
      lon: 2.3522,
      local_names: { en: 'Paris', ja: 'パリ', zh: '巴黎' }
    }]);

    const [result] = readGeocodeQueryCache('Paris').results;
    expect(result).toEqual({
      name: 'Paris',
      state: 'Ile-de-France',
      country: 'FR',
      lat: 48.8566,
      lon: 2.3522
    });
    // consumers gate on typeof lat === 'number'
    expect(typeof result.lat).toBe('number');
  });

  test('caps the stored suggestions at the geocoding result limit', () => {
    const many = Array.from({ length: GEOCODING_RESULT_LIMIT + 3 }, (_, index) => ({
      name: `Springfield ${index}`,
      country: 'US',
      lat: 40 + index,
      lon: -80
    }));

    writeGeocodeQueryCache('Springfield', many);
    expect(readGeocodeQueryCache('Springfield').results).toHaveLength(GEOCODING_RESULT_LIMIT);
  });

  test('drops results without usable coordinates', () => {
    writeGeocodeQueryCache('Nowhere', [
      { name: 'Good', country: 'US', lat: 1, lon: 2 },
      { name: 'Bad', country: 'US', lat: 'nope', lon: null },
      null
    ]);

    const { results } = readGeocodeQueryCache('Nowhere');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Good');
  });

  test('caps the entry list, evicting the least recently written', () => {
    for (let i = 0; i < GEOCODE_QUERY_CACHE_MAX_ENTRIES + 2; i += 1) {
      writeGeocodeQueryCache(`city ${i}`, [{ name: `City ${i}`, country: 'US', lat: 40 + i, lon: -80 }]);
    }

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.geocodeQueryCache));
    expect(stored).toHaveLength(GEOCODE_QUERY_CACHE_MAX_ENTRIES);
    expect(readGeocodeQueryCache('city 0')).toBeNull();
    expect(readGeocodeQueryCache('city 1')).toBeNull();
    expect(readGeocodeQueryCache('city 2').results[0].name).toBe('City 2');
    expect(readGeocodeQueryCache(`city ${GEOCODE_QUERY_CACHE_MAX_ENTRIES + 1}`)).not.toBeNull();
  });

  test('re-searching a query updates it in place rather than duplicating', () => {
    writeGeocodeQueryCache('Ann Arbor', ANN_ARBOR_RESULTS);
    writeGeocodeQueryCache('ann arbor', [ANN_ARBOR_RESULTS[0]]);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.geocodeQueryCache));
    expect(stored).toHaveLength(1);
    expect(readGeocodeQueryCache('Ann Arbor').results).toHaveLength(1);
  });

  test('keeps positive entries within the long TTL', () => {
    seedQueryCache('ann arbor', ANN_ARBOR_RESULTS, 29 * 24 * 60 * 60 * 1000);
    expect(readGeocodeQueryCache('Ann Arbor').results).toHaveLength(2);
  });

  test('expires positive entries after the long TTL', () => {
    seedQueryCache('ann arbor', ANN_ARBOR_RESULTS, 31 * 24 * 60 * 60 * 1000);
    expect(readGeocodeQueryCache('Ann Arbor')).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.geocodeQueryCache)).toBeNull();
  });

  // "No such city" is worth remembering briefly (a typo would otherwise re-request on
  // every search), though not for a month, since the answer can change.
  test('negatively caches an empty result list on the short TTL', () => {
    writeGeocodeQueryCache('Nonexistent Town', []);
    const cached = readGeocodeQueryCache('Nonexistent Town');
    expect(cached).not.toBeNull();
    expect(cached.results).toEqual([]);

    seedQueryCache('nonexistent town', [], 25 * 60 * 60 * 1000);
    expect(readGeocodeQueryCache('Nonexistent Town')).toBeNull();
  });

  test('one expired query does not evict a live one', () => {
    localStorage.setItem(STORAGE_KEYS.geocodeQueryCache, JSON.stringify([
      {
        key: 'ann arbor',
        results: ANN_ARBOR_RESULTS,
        lastUpdated: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
      },
      {
        key: 'detroit',
        results: [{ name: 'Detroit', state: 'Michigan', country: 'US', lat: 42.3314, lon: -83.0458 }],
        lastUpdated: new Date().toISOString()
      }
    ]));

    expect(readGeocodeQueryCache('Ann Arbor')).toBeNull();
    expect(readGeocodeQueryCache('Detroit').results[0].name).toBe('Detroit');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.geocodeQueryCache))).toHaveLength(1);
  });

  test('discards invalid JSON instead of throwing', () => {
    localStorage.setItem(STORAGE_KEYS.geocodeQueryCache, '{not-json}');
    expect(readGeocodeQueryCache('Ann Arbor')).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.geocodeQueryCache)).toBeNull();
  });

  test('discards a payload that is not an array', () => {
    localStorage.setItem(STORAGE_KEYS.geocodeQueryCache, '{"key":"ann arbor","results":[]}');
    expect(readGeocodeQueryCache('Ann Arbor')).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.geocodeQueryCache)).toBeNull();
  });

  test('drops entries whose results are malformed', () => {
    localStorage.setItem(STORAGE_KEYS.geocodeQueryCache, JSON.stringify([
      { key: 'ann arbor', results: 'not-a-list', lastUpdated: new Date().toISOString() }
    ]));

    expect(readGeocodeQueryCache('Ann Arbor')).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.geocodeQueryCache)).toBeNull();
  });

  test('ignores an empty query on write', () => {
    expect(writeGeocodeQueryCache('   ', ANN_ARBOR_RESULTS)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.geocodeQueryCache)).toBeNull();
  });

  test('a full disk during the write does not throw', () => {
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };

    let record;
    expect(() => {
      record = writeGeocodeQueryCache('Ann Arbor', ANN_ARBOR_RESULTS);
    }).not.toThrow();
    expect(record.results).toHaveLength(2);
  });

  test('a full disk during the prune write does not fail the read', () => {
    localStorage.setItem(STORAGE_KEYS.geocodeQueryCache, JSON.stringify([
      {
        key: 'ann arbor',
        results: ANN_ARBOR_RESULTS,
        lastUpdated: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
      },
      {
        key: 'detroit',
        results: [{ name: 'Detroit', state: 'Michigan', country: 'US', lat: 42.3314, lon: -83.0458 }],
        lastUpdated: new Date().toISOString()
      }
    ]));

    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };

    expect(readGeocodeQueryCache('Detroit').results[0].name).toBe('Detroit');
  });
});

describe('last known weather', () => {
  test('returns null when empty', () => {
    expect(readLastKnownWeather()).toBeNull();
  });

  test('writeLastKnownWeather requires an object', () => {
    expect(() => writeLastKnownWeather(null)).toThrow();
  });

  test('persists payload without TTL expiry', () => {
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeLastKnownWeather({
      planetId: 'tatooine',
      planetName: 'Tatooine',
      language: 'en',
      unit: 'fahrenheit',
      lastUpdated: stale
    });

    const stored = readLastKnownWeather();
    expect(stored).not.toBeNull();
    expect(stored.planetId).toBe('tatooine');
    expect(stored.lastUpdated).toBe(stale);
    expect(localStorage.getItem(STORAGE_KEYS.lastKnownWeather)).toBeTruthy();
  });

  test('still returns payload when language or unit differs', () => {
    writeLastKnownWeather({
      planetId: 'hoth',
      planetName: 'Hoth',
      language: 'en',
      unit: 'fahrenheit',
      lastUpdated: new Date().toISOString()
    });

    const mismatched = readLastKnownWeather({ language: 'es', unit: 'celsius' });
    expect(mismatched).not.toBeNull();
    expect(mismatched.planetId).toBe('hoth');
  });

  // A language/unit mismatch re-renders from the stored temperatures; a location
  // mismatch cannot be fixed, the payload is another city's weather.
  test('withholds a payload saved for a different location', () => {
    writeLastKnownWeather({
      planetId: 'tatooine',
      planetName: 'Tatooine',
      locationName: 'Austin, TX',
      locationKey: 'auto',
      language: 'en',
      unit: 'fahrenheit',
      lastUpdated: new Date().toISOString()
    });

    expect(readLastKnownWeather({ locationKey: 'manual:35.6895,139.6917' })).toBeNull();
    expect(readLastKnownWeather({ language: 'en', unit: 'fahrenheit', locationKey: 'auto' }).planetId).toBe('tatooine');
    // no locationKey asked for means no location filtering
    expect(readLastKnownWeather({ language: 'en', unit: 'fahrenheit' }).planetId).toBe('tatooine');
  });

  test('returns a manual-location payload only for that same location', () => {
    writeLastKnownWeather({
      planetId: 'kamino',
      locationKey: 'manual:35.6895,139.6917',
      language: 'en',
      unit: 'fahrenheit',
      lastUpdated: new Date().toISOString()
    });

    expect(readLastKnownWeather({ locationKey: 'manual:35.6895,139.6917' }).planetId).toBe('kamino');
    expect(readLastKnownWeather({ locationKey: 'manual:48.8566,2.3522' })).toBeNull();
    expect(readLastKnownWeather({ locationKey: 'auto' })).toBeNull();
  });

  test('treats a record written before locationKey existed as auto-located', () => {
    localStorage.setItem(STORAGE_KEYS.lastKnownWeather, JSON.stringify({
      planetId: 'naboo',
      language: 'en',
      unit: 'fahrenheit',
      lastUpdated: new Date().toISOString()
    }));

    expect(readLastKnownWeather({ locationKey: 'auto' }).planetId).toBe('naboo');
    expect(readLastKnownWeather({ locationKey: 'manual:1.0000,2.0000' })).toBeNull();
  });

  test('clears invalid JSON', () => {
    localStorage.setItem(STORAGE_KEYS.lastKnownWeather, '{bad');
    expect(readLastKnownWeather()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.lastKnownWeather)).toBeNull();
  });

  test('does not clear last known when TTL cache expires', () => {
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify({ lastUpdated: stale, planetId: 'x' }));
    writeLastKnownWeather({ planetId: 'coruscant', lastUpdated: stale });

    expect(readWeatherCache()).toBeNull();
    expect(readLastKnownWeather().planetId).toBe('coruscant');
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

  test('getShowGoogleApps defaults to true when unset', () => {
    expect(getShowGoogleApps()).toBe(true);
  });

  test('getShowGoogleApps returns false when explicitly disabled', () => {
    localStorage.setItem(STORAGE_KEYS.showGoogleApps, 'false');
    expect(getShowGoogleApps()).toBe(false);
  });

  test('getShowGoogleApps returns true when explicitly enabled', () => {
    localStorage.setItem(STORAGE_KEYS.showGoogleApps, 'true');
    expect(getShowGoogleApps()).toBe(true);
  });

  test('setShowGoogleApps persists boolean values', () => {
    setShowGoogleApps(false);
    expect(localStorage.getItem(STORAGE_KEYS.showGoogleApps)).toBe('false');
    setShowGoogleApps(true);
    expect(localStorage.getItem(STORAGE_KEYS.showGoogleApps)).toBe('true');
  });
});

describe('visited planets', () => {
  test('markPlanetVisited adds unique planet ids', () => {
    expect(markPlanetVisited('hoth')).toEqual(['hoth']);
    expect(markPlanetVisited('hoth')).toEqual(['hoth']);
    expect(markPlanetVisited('bespin')).toEqual(['hoth', 'bespin']);
    expect(getVisitedPlanets()).toEqual(['hoth', 'bespin']);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.visitedPlanets))).toEqual(['hoth', 'bespin']);
  });

  test('markPlanetVisited ignores invalid ids', () => {
    expect(markPlanetVisited('')).toEqual([]);
    expect(markPlanetVisited(null)).toEqual([]);
    expect(markPlanetVisited('  ')).toEqual([]);
  });

  test('getVisitedPlanets clears invalid payloads', () => {
    localStorage.setItem(STORAGE_KEYS.visitedPlanets, '{bad');
    expect(getVisitedPlanets()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEYS.visitedPlanets)).toBeNull();
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

describe('storage cache TTL anchor', () => {
  test('counts the local TTL from the write, not from an older observation time', () => {
    const observedNinetyMinutesAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    writeWeatherCache({ lastUpdated: observedNinetyMinutesAgo, language: 'en', unit: 'fahrenheit' });
    const record = readWeatherCache({ language: 'en', unit: 'fahrenheit' });
    expect(record).not.toBeNull();
    expect(record.lastUpdated).toBe(observedNinetyMinutesAgo);
    expect(Date.now() - Date.parse(record.cachedAt)).toBeLessThan(5000);
  });

  test('re-persisting a cached reading keeps its original fetch time', () => {
    const fetchedFiftyMinutesAgo = new Date(Date.now() - 50 * 60 * 1000).toISOString();
    writeWeatherCache({ cachedAt: fetchedFiftyMinutesAgo, language: 'en', unit: 'fahrenheit' });
    expect(readWeatherCache({ language: 'en', unit: 'fahrenheit' }).cachedAt).toBe(fetchedFiftyMinutesAgo);
  });
});

describe('backend retry time', () => {
  test('round-trips, rejects garbage, and clears', () => {
    expect(readBackendRetryAt()).toBeNull();
    writeBackendRetryAt(1790000000000.4);
    expect(readBackendRetryAt()).toBe(1790000000000);
    localStorage.setItem(STORAGE_KEYS.backendRetryAt, 'soon');
    expect(readBackendRetryAt()).toBeNull();
    writeBackendRetryAt(5);
    clearBackendRetryAt();
    expect(readBackendRetryAt()).toBeNull();
  });
});
