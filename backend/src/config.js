const integer = (env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

export function loadConfig(env = process.env) {
  const tableName = env.CACHE_TABLE_NAME?.trim();
  if (!tableName) throw new Error('CACHE_TABLE_NAME is required');

  const inlineApiKey = env.PROVIDER_API_KEY?.trim() || null;
  const secretId = env.PROVIDER_SECRET_ID?.trim() || null;
  if (!inlineApiKey && !secretId) {
    throw new Error('PROVIDER_SECRET_ID or PROVIDER_API_KEY is required');
  }

  const clientUpstreamLimit = integer(env, 'CLIENT_UPSTREAM_LIMIT', 0, { min: 0, max: 10000 });
  const clientRatePepper = env.CLIENT_RATE_PEPPER?.trim() || null;
  if (clientUpstreamLimit > 0 && (!clientRatePepper || clientRatePepper.length < 32)) {
    throw new Error('CLIENT_RATE_PEPPER must contain at least 32 characters when client limiting is enabled');
  }

  return Object.freeze({
    tableName,
    inlineApiKey,
    secretId,
    secretJsonField: env.PROVIDER_SECRET_JSON_FIELD?.trim() || 'apiKey',
    providerBaseUrl: env.PROVIDER_BASE_URL?.trim() || 'https://api.openweathermap.org',
    upstreamTimeoutMs: integer(env, 'UPSTREAM_TIMEOUT_MS', 3000, { min: 250, max: 10000 }),
    upstreamMaxBytes: integer(env, 'UPSTREAM_MAX_BYTES', 65536, { min: 1024, max: 1048576 }),
    weatherFreshSeconds: integer(env, 'WEATHER_FRESH_SECONDS', 20 * 60, { min: 60, max: 3600 }),
    weatherStaleSeconds: integer(env, 'WEATHER_STALE_SECONDS', 6 * 60 * 60, { min: 300, max: 86400 }),
    placePositiveSeconds: integer(env, 'PLACE_POSITIVE_SECONDS', 30 * 86400, { min: 3600 }),
    placeNegativeSeconds: integer(env, 'PLACE_NEGATIVE_SECONDS', 86400, { min: 60 }),
    leaseSeconds: integer(env, 'CACHE_LEASE_SECONDS', 5, { min: 2, max: 30 }),
    // Together these cover a typical provider round trip, so a miss that loses the
    // lease race gets the refreshed item instead of a 503.
    leaseWaitMs: integer(env, 'CACHE_LEASE_WAIT_MS', 250, { min: 10, max: 1000 }),
    leaseWaitAttempts: integer(env, 'CACHE_LEASE_WAIT_ATTEMPTS', 8, { min: 0, max: 20 }),
    quotaLimits: Object.freeze({
      minute: integer(env, 'PROVIDER_MINUTE_LIMIT', 48, { min: 0 }),
      burst: integer(env, 'PROVIDER_BURST_LIMIT', 6, { min: 1, max: 60 }),
      day: integer(env, 'PROVIDER_DAILY_LIMIT', 25000, { min: 0 }),
      month: integer(env, 'PROVIDER_MONTHLY_LIMIT', 800000, { min: 0 })
    }),
    providerCooldownSeconds: integer(env, 'PROVIDER_429_COOLDOWN_SECONDS', 60, { min: 5, max: 900 }),
    clientUpstreamLimit,
    clientUpstreamWindowSeconds: integer(env, 'CLIENT_UPSTREAM_WINDOW_SECONDS', 300, { min: 60, max: 3600 }),
    // Daily bucket per source address; the short window alone still allows one
    // address most of the shared daily budget.
    clientUpstreamDailyLimit: integer(env, 'CLIENT_UPSTREAM_DAILY_LIMIT', 0, { min: 0, max: 100000 }),
    clientRatePepper,
    namespace: env.METRIC_NAMESPACE?.trim() || 'StarWarsWeather/Backend'
  });
}
