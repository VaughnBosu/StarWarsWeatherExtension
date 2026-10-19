import {
  BACKEND_REQUEST_TIMEOUT_MS,
  GEOCODE_CACHE_PRECISION,
  GEOCODING_RESULT_LIMIT,
  WEATHER_COORDINATE_PRECISION
} from './config.js';
import { roundCoordinate } from './coordinates.js';

const WEATHER_PATH = '/v1/weather';
const REVERSE_LOCATION_PATH = '/v1/locations/reverse';
const SEARCH_LOCATION_PATH = '/v1/locations/search';

const inFlightRequests = new Map();

export class BackendRequestError extends Error {
  constructor(message, { code = 'request_failed', status = null, retryable = false, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'BackendRequestError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateCoordinate(value, label, minimum, maximum, precision) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new BackendRequestError(`Invalid ${label}`, { code: 'invalid_request' });
  }
  // Canonicalising here bounds location precision and prevents browser number
  // formatting (long decimals or exponent notation) from changing cache keys.
  return roundCoordinate(value, precision);
}

function normalizeCoordinates(latitude, longitude, precision) {
  return {
    latitude: validateCoordinate(latitude, 'latitude', -90, 90, precision),
    longitude: validateCoordinate(longitude, 'longitude', -180, 180, precision)
  };
}

export function buildWeatherCoordinateKey(latitude, longitude) {
  const coordinates = normalizeCoordinates(latitude, longitude, WEATHER_COORDINATE_PRECISION);
  return `${coordinates.latitude.toFixed(WEATHER_COORDINATE_PRECISION)},${coordinates.longitude.toFixed(WEATHER_COORDINATE_PRECISION)}`;
}

function getBackendBaseUrl() {
  const configured = typeof globalThis.BACKEND_BASE_URL === 'string'
    ? globalThis.BACKEND_BASE_URL.trim()
    : '';

  if (!configured) {
    throw new BackendRequestError('Weather service is not configured', {
      code: 'backend_not_configured'
    });
  }

  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new BackendRequestError('Weather service configuration is invalid', {
      code: 'backend_not_configured'
    });
  }

  const isLocalDevelopment = url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !isLocalDevelopment) {
    throw new BackendRequestError('Weather service must use HTTPS', {
      code: 'backend_not_configured'
    });
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new BackendRequestError('Weather service configuration is invalid', {
      code: 'backend_not_configured'
    });
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function buildBackendUrl(path, parameters) {
  const url = new URL(`${getBackendBaseUrl()}${path}`);
  Object.entries(parameters).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });
  return url;
}

/** Retry-After as delta seconds or an HTTP date; null when absent or unreadable. */
function parseRetryAfter(response) {
  const raw = response?.headers?.get?.('Retry-After');
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  if (/^\d+$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

function makeBackendError(response) {
  const status = Number(response?.status);
  const validStatus = Number.isFinite(status) ? status : null;
  return new BackendRequestError('Weather service request failed', {
    code: 'http_error',
    status: validStatus,
    retryable: validStatus === 429 || (validStatus !== null && validStatus >= 500),
    retryAfterSeconds: parseRetryAfter(response)
  });
}

async function requestJsonOnce(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      signal: controller.signal
    });

    if (!response.ok) {
      throw makeBackendError(response);
    }

    try {
      return await response.json();
    } catch {
      throw new BackendRequestError('Weather service returned invalid JSON', {
        code: 'invalid_response'
      });
    }
  } catch (error) {
    if (error instanceof BackendRequestError) {
      throw error;
    }

    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new BackendRequestError('Weather service request timed out', {
        code: 'timeout',
        retryable: true
      });
    }

    throw new BackendRequestError('Weather service could not be reached', {
      code: 'network_error',
      retryable: true
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Coalesces identical requests within an extension page while one is in flight. */
function requestJson(url, timeoutMs = BACKEND_REQUEST_TIMEOUT_MS) {
  const requestKey = url.toString();
  const existing = inFlightRequests.get(requestKey);
  if (existing) {
    return existing;
  }

  const request = requestJsonOnce(url, timeoutMs).finally(() => {
    if (inFlightRequests.get(requestKey) === request) {
      inFlightRequests.delete(requestKey);
    }
  });
  inFlightRequests.set(requestKey, request);
  return request;
}

function parseIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new BackendRequestError(`Weather service returned an invalid ${label}`, {
      code: 'invalid_response'
    });
  }
  return new Date(value).toISOString();
}

function normalizeLocation(value, { requireCoordinates = false } = {}) {
  if (!isPlainObject(value)) {
    return null;
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const state = typeof value.state === 'string' ? value.state.trim() : '';
  const country = typeof value.country === 'string' ? value.country.trim() : '';
  const lat = value.lat;
  const lon = value.lon;
  const hasCoordinates = typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90
    && typeof lon === 'number' && Number.isFinite(lon) && lon >= -180 && lon <= 180;

  if (!name || (requireCoordinates && !hasCoordinates)) {
    return null;
  }

  return {
    name,
    state,
    country,
    ...(hasCoordinates ? { lat, lon } : {})
  };
}

function validateWeatherPayload(weather) {
  if (!isPlainObject(weather)) {
    throw new BackendRequestError('Weather service returned an invalid weather payload', {
      code: 'invalid_response'
    });
  }

  const temperature = weather.main?.temp;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
    throw new BackendRequestError('Weather service returned no valid temperature', {
      code: 'invalid_response'
    });
  }

  const condition = weather.weather?.[0]?.main;
  if (typeof condition !== 'string' || !condition.trim()) {
    throw new BackendRequestError('Weather service returned no valid condition', {
      code: 'invalid_response'
    });
  }

  return weather;
}

export async function getWeather(latitude, longitude) {
  const coordinates = normalizeCoordinates(latitude, longitude, WEATHER_COORDINATE_PRECISION);
  const url = buildBackendUrl(WEATHER_PATH, {
    lat: coordinates.latitude,
    lon: coordinates.longitude
  });
  const payload = await requestJson(url);

  if (!isPlainObject(payload)) {
    throw new BackendRequestError('Weather service returned an invalid response', {
      code: 'invalid_response'
    });
  }

  return {
    weather: validateWeatherPayload(payload.weather),
    observedAt: parseIsoTimestamp(payload.observedAt, 'observation time'),
    freshUntil: parseIsoTimestamp(payload.freshUntil, 'freshness time'),
    stale: payload.stale === true,
    cacheStatus: typeof payload.cacheStatus === 'string' ? payload.cacheStatus : 'unknown',
    location: normalizeLocation(payload.location)
  };
}

export async function getReverseLocation(latitude, longitude) {
  const coordinates = normalizeCoordinates(latitude, longitude, GEOCODE_CACHE_PRECISION);
  const url = buildBackendUrl(REVERSE_LOCATION_PATH, {
    lat: coordinates.latitude,
    lon: coordinates.longitude
  });
  const payload = await requestJson(url);

  if (!isPlainObject(payload) || !Object.hasOwn(payload, 'location')) {
    throw new BackendRequestError('Weather service returned an invalid location response', {
      code: 'invalid_response'
    });
  }

  if (payload.location === null) {
    return null;
  }

  const location = normalizeLocation(payload.location);
  if (!location) {
    throw new BackendRequestError('Weather service returned an invalid location', {
      code: 'invalid_response'
    });
  }
  return location;
}

// Mirrors backend/src/validation.js parseSearch so a query the extension sends is
// never answered 400; ZWNJ/ZWJ are the only format characters place names need.
const SEARCH_CHARACTERS = /^[\p{L}\p{M}\p{N}\p{Zs}\p{Pd}'’.,()/&+\u200C\u200D]+$/u;
const SEARCH_CONTROLS = /[\p{Cc}\p{Cs}]|(?![\u200C\u200D])\p{Cf}/u;

export function normalizeLocationQuery(query) {
  const unicode = typeof query === 'string' ? query.normalize('NFKC') : '';
  const normalized = SEARCH_CONTROLS.test(unicode) ? '' : unicode.trim().replace(/\p{Zs}+/gu, ' ');
  const length = [...normalized].length;
  if (length < 2 || length > 80 || !SEARCH_CHARACTERS.test(normalized)) {
    throw new BackendRequestError('Location query must contain 2 to 80 place-name characters', {
      code: 'invalid_request'
    });
  }
  return normalized;
}

export async function searchLocations(query) {
  let normalizedQuery;
  try {
    normalizedQuery = normalizeLocationQuery(query);
  } catch (error) {
    // A one-letter or unsupported query cannot match any place; that is "no results",
    // not a service failure, so the popup/onboarding do not show an outage message.
    if (error instanceof BackendRequestError && error.code === 'invalid_request') {
      return [];
    }
    throw error;
  }
  const url = buildBackendUrl(SEARCH_LOCATION_PATH, {
    q: normalizedQuery,
    limit: GEOCODING_RESULT_LIMIT
  });
  const payload = await requestJson(url);

  if (!isPlainObject(payload) || !Array.isArray(payload.locations)) {
    throw new BackendRequestError('Weather service returned an invalid location search response', {
      code: 'invalid_response'
    });
  }

  const locations = payload.locations
    .map((location) => normalizeLocation(location, { requireCoordinates: true }))
    .filter(Boolean)
    .slice(0, GEOCODING_RESULT_LIMIT);
  if (payload.locations.length > 0 && locations.length === 0) {
    throw new BackendRequestError('Weather service returned invalid locations', {
      code: 'invalid_response'
    });
  }
  return locations;
}

export const __testing = Object.freeze({
  getBackendBaseUrl,
  requestJson,
  validateWeatherPayload
});
