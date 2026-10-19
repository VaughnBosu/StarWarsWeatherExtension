/** Abort a backend request before a stalled connection strands a new-tab render. */
export const BACKEND_REQUEST_TIMEOUT_MS = 8000;

export const GEOLOCATION_OPTIONS = Object.freeze({
  enableHighAccuracy: false,
  timeout: 5000,
  maximumAge: 600000
});

export const GEOLOCATION_POSITION_MAX_AGE_MS = 2 * 60 * 1000;

/**
 * Standard fix used only after content is visible, so travel is detected promptly.
 * A position younger than the staleness cutoff is reused rather than forcing a
 * network positioning request on every new tab.
 */
export const BACKGROUND_GEOLOCATION_OPTIONS = Object.freeze({
  enableHighAccuracy: false,
  timeout: 5000,
  maximumAge: GEOLOCATION_POSITION_MAX_AGE_MS
});

/**
 * A slow GPS-quality fix must never delay the new-tab render. When the fast position
 * reports a wide uncertainty radius, one best-effort refinement may run afterward.
 */
export const HIGH_ACCURACY_GEOLOCATION_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  timeout: 8000,
  maximumAge: 0
});

export const GEOLOCATION_REFINEMENT_THRESHOLD_METERS = 250;
export const GEOLOCATION_REFINEMENT_COOLDOWN_MS = 60 * 60 * 1000;

/** About a 1.1 km cell at the equator. Must match backend/src/coordinates.js. */
export const WEATHER_COORDINATE_PRECISION = 2;

/**
 * How far past the cached cell's edge a position must land to count as travel,
 * scaled by the fix's reported accuracy within these bounds.
 */
export const TRAVEL_MARGIN_MIN_METERS = 500;
export const TRAVEL_MARGIN_MAX_METERS = 2000;

export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** How long a reading the backend served stale is shown before a background re-check. */
export const STALE_WEATHER_RETRY_MS = 15 * 60 * 1000;

/**
 * Shared wait after a retryable backend failure (429, 5xx, timeout, network), during
 * which new tabs use the last-known reading. Retry-After is honoured within these bounds.
 */
export const BACKEND_BACKOFF_DEFAULT_MS = 2 * 60 * 1000;
export const BACKEND_BACKOFF_MIN_MS = 30 * 1000;
export const BACKEND_BACKOFF_MAX_MS = 30 * 60 * 1000;

/** A coordinate's city/state/country effectively never changes, hence the long TTL. */
export const GEOCODE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Shorter TTL for empty geocode results so they get retried eventually. */
export const GEOCODE_NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

/** Decimal places used to bucket coordinates in the geocode cache (~1.1km at the equator). */
export const GEOCODE_CACHE_PRECISION = 2;

/** Enough for home, work and a trip's stops without growing unbounded. */
export const GEOCODE_CACHE_MAX_ENTRIES = 8;

/** Larger than the coordinate cache: typed searches get mistyped and retried a lot. */
export const GEOCODE_QUERY_CACHE_MAX_ENTRIES = 12;

/** Hyperspace hold before revealing a planet (non-cache loads only). */
export const HYPERSPACE_MIN_MS = 3000;

export const DEGREE_SYMBOL = '\u00B0';

export const MAX_SHORTCUTS = 8;
export const SHORTCUT_ROW_MAX_WIDTH = 560;
export const SHORTCUT_TILE_WIDTH = 64;
export const SHORTCUT_GAP = 16;
export const FAVICON_SIZE = 32;

export const SUGGESTION_LIMIT = 5;
export const DEBOUNCE_MS = 200;

export const GEOCODING_RESULT_LIMIT = 5;
