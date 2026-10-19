import { describe, expect, test } from 'bun:test';
import { HttpError } from '../src/errors.js';
import { parseRequest, routeName } from '../src/validation.js';

const event = (path, query = '', method = 'GET') => ({
  rawPath: path,
  rawQueryString: query,
  requestContext: { http: { method } }
});

describe('request validation', () => {
  test('normalizes weather coordinates to a two-decimal shared cell', () => {
    expect(parseRequest(event('/v1/weather', 'lat=42.3319&lon=-83.0458'))).toMatchObject({
      kind: 'weather', route: 'Weather', lat: 42.33, lon: -83.05
    });
  });

  test('keeps reverse geocoding on the two-decimal place-name grid', () => {
    expect(parseRequest(event('/v1/locations/reverse', 'lat=42.3319&lon=-83.0458'))).toMatchObject({
      kind: 'reverse', route: 'Reverse', lat: 42.33, lon: -83.05
    });
  });

  test.each([
    'lat=91&lon=0',
    'lat=0&lon=181',
    'lat=NaN&lon=0',
    'lat=1e999&lon=0',
    'lat=1&lat=2&lon=3',
    'lat=1&lon=2&appid=stolen',
    'lat=&lon=2'
  ])('rejects invalid coordinate request %s', (query) => {
    expect(() => parseRequest(event('/v1/weather', query))).toThrow(HttpError);
  });

  test('normalizes an international place query without losing the display spelling', () => {
    const result = parseRequest(event('/v1/locations/search', 'q=%20%EF%BC%B3%C3%A3o%20%20Paulo%20&limit=3'));
    expect(result).toMatchObject({ query: 'São Paulo', normalizedQuery: 'são paulo', limit: 3 });
  });

  test.each([
    ['lat=42.3319123456789&lon=-83.0458123456789', 42.33, -83.05],
    ['lat=4.23319123456789e1&lon=-8.30458123456789e1', 42.33, -83.05],
    ['lat=1e-7&lon=-2e-7', 0, 0]
  ])('accepts finite browser-number coordinate serialization %s', (query, lat, lon) => {
    expect(parseRequest(event('/v1/weather', query))).toMatchObject({ lat, lon });
  });

  test.each([
    'q=a',
    'q=Detroit%3F',
    'q=Detroit&limit=0',
    'q=Detroit&limit=6',
    'q=Detroit&q=Chicago',
    'q=Detroit&debug=true'
  ])('rejects invalid search request %s', (query) => {
    expect(() => parseRequest(event('/v1/locations/search', query))).toThrow(HttpError);
  });

  test('supports St. Louis and apostrophes', () => {
    expect(parseRequest(event('/v1/locations/search', "q=St.%20John's"))).toMatchObject({
      query: "St. John's", limit: 5
    });
  });

  test.each([
    ['q=10001%2C%20US', '10001, US'],
    ['q=Frankfurt%20(Oder)', 'Frankfurt (Oder)'],
    ['q=District%209', 'District 9']
  ])('allows valid numbered and punctuated place query %s', (query, expected) => {
    expect(parseRequest(event('/v1/locations/search', query)).query).toBe(expected);
  });

  test('accepts an 80-character search in a three-byte UTF-8 script', () => {
    const query = 'ก'.repeat(80);
    const request = parseRequest(event('/v1/locations/search', `q=${encodeURIComponent(query)}&limit=5`));
    expect(request).toMatchObject({ kind: 'search', query, limit: 5 });
  });

  test('rejects control and invisible formatting characters', () => {
    expect(() => parseRequest(event('/v1/locations/search', 'q=Detroit%0AChicago'))).toThrow(HttpError);
    expect(() => parseRequest(event('/v1/locations/search', 'q=De%E2%80%8Btroit'))).toThrow(HttpError);
  });

  test('rejects unknown paths and non-GET methods', () => {
    expect(() => parseRequest(event('/v1/nope'))).toThrow(HttpError);
    expect(() => parseRequest(event('/v1/weather', '', 'POST'))).toThrow(HttpError);
    expect(routeName(event('/v1/nope'))).toBe('Unknown');
  });

  test('accepts CORS preflight without inspecting query data', () => {
    expect(parseRequest(event('/v1/weather', 'anything=ignored', 'OPTIONS')).kind).toBe('preflight');
  });
});

describe('search query format characters', () => {
  test('accepts the zero-width joiners Persian and Indic place names require', () => {
    // U+200C between the two words, as Persian keyboards produce.
    const result = parseRequest(event('/v1/locations/search', 'q=%D8%A8%D9%86%D8%AF%D8%B1%E2%80%8C%D8%B9%D8%A8%D8%A7%D8%B3'));
    expect(result.query).toContain('\u200C');
  });
});
