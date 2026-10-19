const STORAGE_KEYS = Object.freeze({
  cache: 'sww.cache',
  lastKnownWeather: 'sww.lastKnownWeather',
  language: 'language',
  unit: 'unit',
  geolocationAlerted: 'alerted',
  manualLocation: 'manualLocation',
  showSearchBar: 'showSearchBar',
  showShortcuts: 'showShortcuts',
  showExtrasInHyperspace: 'showExtrasInHyperspace',
  showGoogleApps: 'showGoogleApps',
  onboardingComplete: 'onboardingComplete',
  visitedPlanets: 'sww.visitedPlanets',
  geocodeCache: 'sww.geocodeCache',
  geocodeQueryCache: 'sww.geocodeQueryCache',
  telemetry: 'sww.telemetry',
  backendRetryAt: 'sww.backendRetryAt'
});

const LEGACY_CACHE_KEYS = Object.freeze([
  'planet',
  'message',
  'description',
  'planetName',
  'date'
]);

import {
  CACHE_TTL_MS,
  GEOCODE_CACHE_MAX_ENTRIES,
  GEOCODE_CACHE_PRECISION,
  GEOCODE_CACHE_TTL_MS,
  GEOCODE_NEGATIVE_CACHE_TTL_MS,
  GEOCODE_QUERY_CACHE_MAX_ENTRIES,
  GEOCODING_RESULT_LIMIT
} from './config.js';
import { roundCoordinate } from './coordinates.js';

// re-exported so callers read the cap off the store that applies it
export { GEOCODE_QUERY_CACHE_MAX_ENTRIES };

/**
 * localStorage writes throw on quota/blocked storage. Everything here is a cache or
 * preference, and a throw once escaped fetchLocationDetails and lost a fetched place name.
 */
function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`Failed to persist ${key}`, error);
    return false;
  }
}

function safeRemoveItem(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (error) {
    console.warn(`Failed to remove ${key}`, error);
    return false;
  }
}

function isWithinTtl(timestamp, ttlMs = CACHE_TTL_MS) {
  if (!timestamp) {
    return false;
  }

  const updatedAt = new Date(timestamp);
  return Number.isFinite(updatedAt.getTime()) && (Date.now() - updatedAt.getTime()) < ttlMs;
}

export function readWeatherCache({ language, unit, locationKey } = {}) {
  const raw = localStorage.getItem(STORAGE_KEYS.cache);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    // `lastUpdated` is the provider observation time (it can lag by an hour or more
    // when the backend serves stale data); the local TTL counts from the write.
    if (!isWithinTtl(parsed.cachedAt ?? parsed.lastUpdated)) {
      clearWeatherCache();
      return null;
    }

    // serving an offline fallback as a hit would show "Sensors offline" to a user
    // who is back online, and suppress the refresh that would fix it
    if (parsed.offline) {
      clearWeatherCache();
      return null;
    }

    if (language) {
      if (!parsed.language || parsed.language !== language) {
        return null;
      }
    }

    if (unit && parsed.unit && parsed.unit !== unit) {
      return null;
    }

    if (locationKey) {
      if (locationKey === 'auto') {
        if (parsed.locationKey && parsed.locationKey !== 'auto') {
          return null;
        }
      } else if (!parsed.locationKey || parsed.locationKey !== locationKey) {
        return null;
      }
    }

    // Pre-2.5 records have no cachedAt; their lastUpdated was the fetch time.
    return parsed.cachedAt ? parsed : { ...parsed, cachedAt: parsed.lastUpdated };
  } catch (error) {
    console.warn('Failed to parse cached weather payload', error);
    clearWeatherCache();
    return null;
  }
}

export function writeWeatherCache(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Weather cache payload must be an object');
  }

  const now = new Date().toISOString();
  const record = {
    ...payload,
    locationKey: payload.locationKey ?? 'auto',
    lastUpdated: payload.lastUpdated ?? now,
    // Re-persisting a cached reading (location metadata, unit toggle) keeps its
    // original fetch time, or the TTL would never expire and nothing would refetch.
    cachedAt: payload.cachedAt ?? now
  };

  localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify(record));
  clearLegacyCache();
}

export function clearWeatherCache() {
  safeRemoveItem(STORAGE_KEYS.cache);
  clearLegacyCache();
}

/** Buckets coordinates so nearby positions share one reverse-geocode entry. */
export function buildGeocodeCacheKey(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const rounded = (value) => roundCoordinate(value, GEOCODE_CACHE_PRECISION);
  return `${rounded(lat)},${rounded(lon)}`;
}

/** Newest first. Prunes expired entries from storage as a side effect. */
function readGeocodeEntries() {
  const raw = localStorage.getItem(STORAGE_KEYS.geocodeCache);
  if (!raw) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('Failed to parse cached geocode payload', error);
    clearGeocodeCache();
    return [];
  }

  if (!Array.isArray(parsed)) {
    clearGeocodeCache();
    return [];
  }

  const live = parsed.filter((entry) => {
    if (!entry || typeof entry !== 'object' || !entry.key) {
      return false;
    }

    const ttl = entry.details ? GEOCODE_CACHE_TTL_MS : GEOCODE_NEGATIVE_CACHE_TTL_MS;
    return isWithinTtl(entry.lastUpdated, ttl);
  });

  if (live.length !== parsed.length) {
    if (live.length === 0) {
      clearGeocodeCache();
    } else {
      // best-effort; a failed prune still returns the live entries
      safeSetItem(STORAGE_KEYS.geocodeCache, JSON.stringify(live));
    }
  }

  return live;
}

/** null means nothing cached; an entry with null `details` means "cached: no place here". */
export function readGeocodeCache(latitude, longitude) {
  const key = buildGeocodeCacheKey(latitude, longitude);
  if (!key) {
    return null;
  }

  return readGeocodeEntries().find((entry) => entry.key === key) ?? null;
}

/**
 * Null `details` negatively caches a coordinate that geocoded to nothing (shorter TTL).
 * Kept as a capped LRU list so a commute does not evict and re-request the other end.
 */
export function writeGeocodeCache(latitude, longitude, details) {
  const key = buildGeocodeCacheKey(latitude, longitude);
  if (!key) {
    return null;
  }

  const record = {
    key,
    details: details && typeof details === 'object' ? details : null,
    lastUpdated: new Date().toISOString()
  };

  const entries = readGeocodeEntries().filter((entry) => entry.key !== key);
  entries.unshift(record);

  // guarded: a throw here would discard the place name fetchLocationDetails just paid for
  safeSetItem(
    STORAGE_KEYS.geocodeCache,
    JSON.stringify(entries.slice(0, GEOCODE_CACHE_MAX_ENTRIES))
  );

  return record;
}

export function clearGeocodeCache() {
  safeRemoveItem(STORAGE_KEYS.geocodeCache);
}

/**
 * Folds the query the same way backend-client.js normalizeLocationQuery does before
 * sending it, so identical backend requests share one local cache entry.
 */
export function buildGeocodeQueryKey(query) {
  if (typeof query !== 'string') {
    return null;
  }

  const key = query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return key || null;
}

/**
 * Provider results can carry a `local_names` map of hundreds of translations;
 * storing it verbatim costs tens of kilobytes per search for data nothing renders.
 */
function normalizeGeocodeQueryResults(results) {
  if (!Array.isArray(results)) {
    return [];
  }

  return results
    .filter((result) => result && typeof result === 'object')
    .map((result) => ({
      name: typeof result.name === 'string' ? result.name : '',
      state: typeof result.state === 'string' ? result.state : '',
      country: typeof result.country === 'string' ? result.country : '',
      lat: Number(result.lat),
      lon: Number(result.lon)
    }))
    .filter((result) => Number.isFinite(result.lat) && Number.isFinite(result.lon))
    .slice(0, GEOCODING_RESULT_LIMIT);
}

/** Newest first. Prunes expired entries from storage as a side effect. */
function readGeocodeQueryEntries() {
  const raw = localStorage.getItem(STORAGE_KEYS.geocodeQueryCache);
  if (!raw) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('Failed to parse cached geocode query payload', error);
    clearGeocodeQueryCache();
    return [];
  }

  if (!Array.isArray(parsed)) {
    clearGeocodeQueryCache();
    return [];
  }

  const live = parsed.filter((entry) => {
    if (!entry || typeof entry !== 'object' || !entry.key || !Array.isArray(entry.results)) {
      return false;
    }

    const ttl = entry.results.length > 0 ? GEOCODE_CACHE_TTL_MS : GEOCODE_NEGATIVE_CACHE_TTL_MS;
    return isWithinTtl(entry.lastUpdated, ttl);
  });

  if (live.length !== parsed.length) {
    if (live.length === 0) {
      clearGeocodeQueryCache();
    } else {
      safeSetItem(STORAGE_KEYS.geocodeQueryCache, JSON.stringify(live));
    }
  }

  return live;
}

/** null means never searched; an entry with empty `results` means "searched: no such city". */
export function readGeocodeQueryCache(query) {
  const key = buildGeocodeQueryKey(query);
  if (!key) {
    return null;
  }

  return readGeocodeQueryEntries().find((entry) => entry.key === key) ?? null;
}

/**
 * Empty lists are cached too (short negative TTL) so a typo is not re-requested per keystroke.
 * The popup is torn down on blur, so this has to outlive the page or repeat searches burn quota.
 */
export function writeGeocodeQueryCache(query, results) {
  const key = buildGeocodeQueryKey(query);
  if (!key) {
    return null;
  }

  const record = {
    key,
    results: normalizeGeocodeQueryResults(results),
    lastUpdated: new Date().toISOString()
  };

  const entries = readGeocodeQueryEntries().filter((entry) => entry.key !== key);
  entries.unshift(record);

  safeSetItem(
    STORAGE_KEYS.geocodeQueryCache,
    JSON.stringify(entries.slice(0, GEOCODE_QUERY_CACHE_MAX_ENTRIES))
  );

  return record;
}

export function clearGeocodeQueryCache() {
  safeRemoveItem(STORAGE_KEYS.geocodeQueryCache);
}

/** Epoch milliseconds before which new tabs should not call the backend, or null. */
export function readBackendRetryAt() {
  const raw = localStorage.getItem(STORAGE_KEYS.backendRetryAt);
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function writeBackendRetryAt(epochMs) {
  localStorage.setItem(STORAGE_KEYS.backendRetryAt, String(Math.round(epochMs)));
}

export function clearBackendRetryAt() {
  safeRemoveItem(STORAGE_KEYS.backendRetryAt);
}

/** Offline/stale fallback. Unlike the TTL cache, never expired by age. */
export function writeLastKnownWeather(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Last known weather payload must be an object');
  }

  const record = {
    ...payload,
    locationKey: payload.locationKey ?? 'auto',
    lastUpdated: payload.lastUpdated ?? new Date().toISOString()
  };

  localStorage.setItem(STORAGE_KEYS.lastKnownWeather, JSON.stringify(record));
}

/**
 * No TTL check (stale OK). Language/unit mismatches pass on purpose since the caller
 * re-localizes; a locationKey mismatch describes another city and would mislabel it.
 */
export function readLastKnownWeather({ language, unit, locationKey } = {}) {
  const raw = localStorage.getItem(STORAGE_KEYS.lastKnownWeather);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    // records written before locationKey existed were always auto-located
    if (locationKey && (parsed.locationKey ?? 'auto') !== locationKey) {
      return null;
    }

    return parsed;
  } catch (error) {
    console.warn('Failed to parse last known weather payload', error);
    safeRemoveItem(STORAGE_KEYS.lastKnownWeather);
    return null;
  }
}

function clearLegacyCache() {
  LEGACY_CACHE_KEYS.forEach((key) => safeRemoveItem(key));
}

export function getPreferredLanguage() {
  const stored = localStorage.getItem(STORAGE_KEYS.language);
  if (stored) {
    return stored.toLowerCase();
  }

  const browserLanguage = navigator.language?.slice(0, 2)?.toLowerCase();
  return browserLanguage === 'es' || browserLanguage === 'zh' ? browserLanguage : 'en';
}

export function setPreferredLanguage(language) {
  if (!language) {
    localStorage.removeItem(STORAGE_KEYS.language);
    return;
  }

  localStorage.setItem(STORAGE_KEYS.language, language.toLowerCase());
}

export function getPreferredUnit() {
  const stored = localStorage.getItem(STORAGE_KEYS.unit);
  if (!stored) {
    return 'fahrenheit';
  }

  const normalised = stored.toLowerCase();
  if (normalised === 'celsius') {
    return 'celsius';
  }

  // older builds stored the typo "farenheit"
  if (normalised === 'farenheit' || normalised === 'fahrenheit') {
    return 'fahrenheit';
  }

  return 'fahrenheit';
}

export function setPreferredUnit(unit) {
  if (!unit) {
    localStorage.removeItem(STORAGE_KEYS.unit);
    return;
  }

  const normalised = unit.toLowerCase();
  const value = normalised === 'celsius' ? 'celsius' : 'fahrenheit';
  localStorage.setItem(STORAGE_KEYS.unit, value);
}

export function hasShownGeolocationError() {
  return localStorage.getItem(STORAGE_KEYS.geolocationAlerted) === 'true';
}

export function markGeolocationAlerted() {
  localStorage.setItem(STORAGE_KEYS.geolocationAlerted, 'true');
}

export function clearGeolocationAlerted() {
  localStorage.removeItem(STORAGE_KEYS.geolocationAlerted);
}

export function getManualLocation() {
  const stored = localStorage.getItem(STORAGE_KEYS.manualLocation);
  if (!stored) {
    return null;
  }

  try {
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Manual location is not an object');
    }

    if (typeof parsed.lat !== 'number' || typeof parsed.lon !== 'number' || Number.isNaN(parsed.lat) || Number.isNaN(parsed.lon)) {
      throw new Error('Manual location missing coordinates');
    }

    return {
      name: parsed.name ?? '',
      state: parsed.state ?? '',
      country: parsed.country ?? '',
      lat: parsed.lat,
      lon: parsed.lon,
      displayName: parsed.displayName ?? parsed.name ?? ''
    };
  } catch (error) {
    console.warn('Failed to parse manual location', error);
    safeRemoveItem(STORAGE_KEYS.manualLocation);
    return null;
  }
}

export function setManualLocation(value) {
  if (!value) {
    localStorage.removeItem(STORAGE_KEYS.manualLocation);
    return;
  }

  const latRaw = Number(value.lat);
  const lonRaw = Number(value.lon);
  if (!Number.isFinite(latRaw) || !Number.isFinite(lonRaw)) {
    console.warn('Manual location requires numeric coordinates');
    localStorage.removeItem(STORAGE_KEYS.manualLocation);
    return;
  }

  const lat = Number(latRaw.toFixed(4));
  const lon = Number(lonRaw.toFixed(4));

  const payload = {
    name: value.name ?? '',
    state: value.state ?? '',
    country: value.country ?? '',
    lat,
    lon,
    displayName: value.displayName ?? value.name ?? ''
  };

  localStorage.setItem(STORAGE_KEYS.manualLocation, JSON.stringify(payload));
}

function getBooleanSetting(key) {
  return localStorage.getItem(key) === 'true';
}

function setBooleanSetting(key, value) {
  localStorage.setItem(key, value ? 'true' : 'false');
}

export function getShowSearchBar() {
  return getBooleanSetting(STORAGE_KEYS.showSearchBar);
}

export function setShowSearchBar(value) {
  setBooleanSetting(STORAGE_KEYS.showSearchBar, value);
}

export function getShowShortcuts() {
  return getBooleanSetting(STORAGE_KEYS.showShortcuts);
}

export function setShowShortcuts(value) {
  setBooleanSetting(STORAGE_KEYS.showShortcuts, value);
}

export function getShowExtrasInHyperspace() {
  return getBooleanSetting(STORAGE_KEYS.showExtrasInHyperspace);
}

export function setShowExtrasInHyperspace(value) {
  setBooleanSetting(STORAGE_KEYS.showExtrasInHyperspace, value);
}

export function getShowGoogleApps() {
  const stored = localStorage.getItem(STORAGE_KEYS.showGoogleApps);
  if (stored === null) {
    return true;
  }
  return stored === 'true';
}

export function setShowGoogleApps(value) {
  setBooleanSetting(STORAGE_KEYS.showGoogleApps, value);
}

export function isOnboardingComplete() {
  return getBooleanSetting(STORAGE_KEYS.onboardingComplete);
}

export function markOnboardingComplete() {
  setBooleanSetting(STORAGE_KEYS.onboardingComplete, true);
}

export function getVisitedPlanets() {
  // getItem itself throws when storage is blocked, and this runs in the new-tab
  // render path, so an unreadable list has to degrade to "nothing visited"
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEYS.visitedPlanets);
  } catch (error) {
    console.warn('Unable to read visited planets', error);
    return [];
  }

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('Visited planets is not an array');
    }

    return [...new Set(parsed.filter((id) => typeof id === 'string' && id.trim()))];
  } catch (error) {
    console.warn('Failed to parse visited planets', error);
    safeRemoveItem(STORAGE_KEYS.visitedPlanets);
    return [];
  }
}

export function markPlanetVisited(planetId) {
  if (!planetId || typeof planetId !== 'string') {
    return getVisitedPlanets();
  }

  const id = planetId.trim();
  if (!id) {
    return getVisitedPlanets();
  }

  const visited = getVisitedPlanets();
  if (!visited.includes(id)) {
    visited.push(id);
    localStorage.setItem(STORAGE_KEYS.visitedPlanets, JSON.stringify(visited));
  }

  return visited;
}

/** Returns {} rather than null so callers can always spread it. */
export function readTelemetryState() {
  const raw = localStorage.getItem(STORAGE_KEYS.telemetry);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn('Failed to parse telemetry state', error);
    safeRemoveItem(STORAGE_KEYS.telemetry);
    return {};
  }
}

export function writeTelemetryState(state) {
  if (!state || typeof state !== 'object') {
    localStorage.removeItem(STORAGE_KEYS.telemetry);
    return;
  }

  localStorage.setItem(STORAGE_KEYS.telemetry, JSON.stringify(state));
}

export { STORAGE_KEYS };
