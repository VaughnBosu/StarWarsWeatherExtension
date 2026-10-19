import { getReverseLocation } from './backend-client.js';
import { readGeocodeCache, writeGeocodeCache } from './storage.js';
import { recordGeocodeCall } from './telemetry.js';

/**
 * Reverse-geocodes through the shared local cache. Empty results are cached with a
 * shorter TTL; failed requests are not cached.
 */
export async function fetchLocationDetails(latitude, longitude) {
  const cached = readGeocodeCache(latitude, longitude);
  if (cached) return cached.details;

  recordGeocodeCall();
  const details = await getReverseLocation(latitude, longitude);
  writeGeocodeCache(latitude, longitude, details);
  return details;
}
