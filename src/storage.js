const STORAGE_KEYS = Object.freeze({
  cache: 'sww.cache',
  language: 'language',
  unit: 'unit',
  geolocationAlerted: 'alerted',
  manualLocation: 'manualLocation',
  showSearchBar: 'showSearchBar',
  showShortcuts: 'showShortcuts',
  showExtrasInHyperspace: 'showExtrasInHyperspace',
  onboardingComplete: 'onboardingComplete'
});

const LEGACY_CACHE_KEYS = Object.freeze([
  'planet',
  'message',
  'description',
  'planetName',
  'date'
]);

import { CACHE_TTL_MS } from './config.js';

function isWithinTtl(timestamp) {
  if (!timestamp) {
    return false;
  }

  const updatedAt = new Date(timestamp);
  return Number.isFinite(updatedAt.getTime()) && (Date.now() - updatedAt.getTime()) < CACHE_TTL_MS;
}

export function readWeatherCache({ language, unit, locationKey } = {}) {
  const raw = localStorage.getItem(STORAGE_KEYS.cache);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isWithinTtl(parsed.lastUpdated)) {
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

    return parsed;
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

  const record = {
    ...payload,
    locationKey: payload.locationKey ?? 'auto',
    lastUpdated: payload.lastUpdated ?? new Date().toISOString()
  };

  localStorage.setItem(STORAGE_KEYS.cache, JSON.stringify(record));
  clearLegacyCache();
}

export function clearWeatherCache() {
  localStorage.removeItem(STORAGE_KEYS.cache);
  clearLegacyCache();
}

function clearLegacyCache() {
  LEGACY_CACHE_KEYS.forEach((key) => localStorage.removeItem(key));
}

export function getPreferredLanguage() {
  const stored = localStorage.getItem(STORAGE_KEYS.language);
  if (stored) {
    return stored.toLowerCase();
  }

  const browserLanguage = navigator.language?.slice(0, 2)?.toLowerCase();
  return browserLanguage === 'es' ? 'es' : 'en';
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

  // Maintain backwards compatibility with older typo spelling.
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
    localStorage.removeItem(STORAGE_KEYS.manualLocation);
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

export function isOnboardingComplete() {
  return getBooleanSetting(STORAGE_KEYS.onboardingComplete);
}

export function markOnboardingComplete() {
  setBooleanSetting(STORAGE_KEYS.onboardingComplete, true);
}

export { STORAGE_KEYS };
