import { HttpError } from './errors.js';
import {
  REVERSE_COORDINATE_PRECISION,
  WEATHER_COORDINATE_PRECISION
} from './coordinates.js';

const ROUTES = Object.freeze({
  '/v1/weather': 'Weather',
  '/v1/locations/reverse': 'Reverse',
  '/v1/locations/search': 'Search'
});

// ZWNJ/ZWJ (U+200C/U+200D) are format characters that Persian, Urdu and several
// Indic scripts need inside place names, so they are the only \p{Cf} allowed.
const SEARCH_CHARACTERS = /^[\p{L}\p{M}\p{N}\p{Zs}\p{Pd}'’.,()/&+\u200C\u200D]+$/u;
const SEARCH_CONTROLS = /[\p{Cc}\p{Cs}]|(?![\u200C\u200D])\p{Cf}/u;

// An 80-character query in a 3-byte UTF-8 script percent-encodes to ~720 characters.
const MAX_QUERY_STRING_LENGTH = 1024;

function singleParameters(rawQueryString) {
  if (rawQueryString.length > MAX_QUERY_STRING_LENGTH) throw new HttpError(414, 'request_too_large');
  const parameters = new URLSearchParams(rawQueryString);
  const result = new Map();
  for (const [name, value] of parameters) {
    if (result.has(name)) throw new HttpError(400, 'invalid_request');
    result.set(name, value);
  }
  return result;
}

function requireOnly(parameters, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const name of parameters.keys()) {
    if (!allowed.has(name)) throw new HttpError(400, 'invalid_request');
  }
  for (const name of required) {
    if (!parameters.has(name)) throw new HttpError(400, 'invalid_request');
  }
}

function coordinate(raw, min, max, precision) {
  // Browser geolocation values are serialized with String(number), which may use
  // more than eight decimals or scientific notation for small coordinates.
  if (raw.length > 40 || !/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d{1,3})?$/.test(raw)) {
    throw new HttpError(400, 'invalid_coordinates');
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new HttpError(400, 'invalid_coordinates');
  }
  const factor = 10 ** precision;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function parseCoordinates(parameters, precision) {
  return {
    lat: coordinate(parameters.get('lat'), -90, 90, precision),
    lon: coordinate(parameters.get('lon'), -180, 180, precision)
  };
}

function parseSearch(parameters) {
  const normalizedUnicode = parameters.get('q').normalize('NFKC');
  if (SEARCH_CONTROLS.test(normalizedUnicode)) throw new HttpError(400, 'invalid_query');
  const original = normalizedUnicode.trim().replace(/\p{Zs}+/gu, ' ');
  const length = [...original].length;
  if (length < 2 || length > 80 || !SEARCH_CHARACTERS.test(original)) {
    throw new HttpError(400, 'invalid_query');
  }

  let limit = 5;
  if (parameters.has('limit')) {
    const raw = parameters.get('limit');
    if (!/^[1-5]$/.test(raw)) throw new HttpError(400, 'invalid_limit');
    limit = Number(raw);
  }

  return { query: original, normalizedQuery: original.toLocaleLowerCase('und'), limit };
}

export function parseRequest(event) {
  const method = event?.requestContext?.http?.method ?? event?.httpMethod ?? '';
  const path = event?.rawPath ?? event?.path ?? '';
  const route = ROUTES[path] ?? 'Unknown';

  if (method === 'OPTIONS') {
    if (!ROUTES[path]) throw new HttpError(404, 'not_found');
    return { method, route, path, kind: 'preflight' };
  }
  if (method !== 'GET') {
    throw new HttpError(405, 'method_not_allowed', { headers: { Allow: 'GET, OPTIONS' } });
  }
  if (!ROUTES[path]) throw new HttpError(404, 'not_found');

  const parameters = singleParameters(event?.rawQueryString ?? '');
  if (route === 'Weather' || route === 'Reverse') {
    requireOnly(parameters, ['lat', 'lon']);
    const precision = route === 'Weather'
      ? WEATHER_COORDINATE_PRECISION
      : REVERSE_COORDINATE_PRECISION;
    return { method, route, path, kind: route.toLowerCase(), ...parseCoordinates(parameters, precision) };
  }

  requireOnly(parameters, ['q'], ['limit']);
  return { method, route, path, kind: 'search', ...parseSearch(parameters) };
}

export function routeName(event) {
  return ROUTES[event?.rawPath ?? event?.path ?? ''] ?? 'Unknown';
}
