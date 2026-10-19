/**
 * Rounds a coordinate to a cache-grid cell. Shared by the request canonicaliser
 * and the local geocode cache so both bucket a tie value the same way; the
 * backend applies the identical formula (backend/src/validation.js).
 */
export function roundCoordinate(value, precision) {
  const factor = 10 ** precision;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}
