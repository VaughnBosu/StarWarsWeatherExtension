export const WEATHER_ENDPOINT = 'https://api.openweathermap.org/data/2.5/weather';
export const GEOCODING_DIRECT_ENDPOINT = 'https://api.openweathermap.org/geo/1.0/direct';
export const GEOCODING_REVERSE_ENDPOINT = 'https://api.openweathermap.org/geo/1.0/reverse';

export const GEOLOCATION_OPTIONS = Object.freeze({
  enableHighAccuracy: false,
  timeout: 5000,
  maximumAge: 600000
});

export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export const DEGREE_SYMBOL = '\u00B0';

export const MAX_SHORTCUTS = 8;
export const FAVICON_SIZE = 32;

export const SUGGESTION_LIMIT = 5;
export const DEBOUNCE_MS = 200;

export const GEOCODING_RESULT_LIMIT = 5;
