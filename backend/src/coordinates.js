// ~1.1 km cells. Finer cells fragment the shared cache and turn geolocation
// jitter into cache misses.
export const WEATHER_COORDINATE_PRECISION = 2;
export const REVERSE_COORDINATE_PRECISION = 2;

export function coordinateCacheKey(latitude, longitude, precision) {
  return `${latitude.toFixed(precision)}#${longitude.toFixed(precision)}`;
}
