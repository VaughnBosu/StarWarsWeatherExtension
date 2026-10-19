import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  coordinateCacheKey,
  REVERSE_COORDINATE_PRECISION,
  WEATHER_COORDINATE_PRECISION
} from './coordinates.js';
import { clientWindowStart } from './dynamo-store.js';
import { recordUpstreamError } from './metrics.js';

const DAY_SECONDS = 86400;
const iso = (epochSeconds) => new Date(epochSeconds * 1000).toISOString();
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const searchKey = (query, limit) => createHash('sha256').update(`${query}\n${limit}`).digest('hex');

function success(body, { maxAge = 0, stale = false } = {}) {
  return {
    statusCode: 200,
    body,
    headers: {
      'Cache-Control': stale
        ? 'public, max-age=0, s-maxage=30'
        : `public, max-age=0, s-maxage=${Math.max(0, Math.floor(maxAge))}`,
      ...(stale ? { Warning: '110 - "Response is stale"' } : {})
    }
  };
}

function unavailable(retryAfter = 30) {
  return {
    statusCode: 503,
    body: { code: 'temporarily_unavailable' },
    headers: { 'Cache-Control': 'private, no-store', 'Retry-After': String(retryAfter) }
  };
}

function rateLimited(retryAfter = 60) {
  return {
    statusCode: 429,
    body: { code: 'rate_limited' },
    headers: { 'Cache-Control': 'private, no-store', 'Retry-After': String(retryAfter) }
  };
}

function clientFingerprint(clientIp, pepper, windowStart) {
  if (typeof clientIp !== 'string' || !clientIp || !pepper || !Number.isSafeInteger(windowStart)) {
    return null;
  }
  // Binding the digest to the fixed window prevents otherwise stable client
  // bucket identifiers from being linked across windows.
  return createHmac('sha256', pepper)
    .update(`${windowStart}\n${clientIp}`)
    .digest('base64url');
}

/** Epoch seconds at which the UTC day or month provider budget resets. */
function quotaWindowEnd(nowEpochSeconds, window) {
  const date = new Date(nowEpochSeconds * 1000);
  const end = window === 'month'
    ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
    : Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.floor(end / 1000);
}

/** When a refusal will still hold for every request, or null when it is too short to remember. */
function blockedUntil(reservation, nowEpochSeconds) {
  if (reservation.deniedWindow === 'day' || reservation.deniedWindow === 'month') {
    return quotaWindowEnd(nowEpochSeconds, reservation.deniedWindow);
  }
  if (reservation.deniedWindow === 'cooldown' && Number.isFinite(reservation.cooldownUntil)) {
    return reservation.cooldownUntil;
  }
  return null;
}

function isFresh(item, nowEpochSeconds) {
  return item?.payload !== undefined && item.freshUntil > nowEpochSeconds;
}

function isStaleUsable(item, nowEpochSeconds) {
  return item?.payload !== undefined && !item.negative && item.staleUntil > nowEpochSeconds;
}

function cacheEnvelope(operation, item, cacheStatus, stale = false) {
  if (operation.kind === 'weather') {
    return {
      weather: item.payload.weather,
      observedAt: item.payload.observedAt,
      freshUntil: iso(item.freshUntil),
      stale,
      cacheStatus,
      ...(item.payload.location ? { location: item.payload.location } : {})
    };
  }
  if (operation.kind === 'reverse') return { location: item.payload };
  return { locations: item.payload };
}

function classifyOperation(request, config, provider) {
  if (request.kind === 'weather') {
    return {
      kind: 'weather',
      key: `WX#${coordinateCacheKey(request.lat, request.lon, WEATHER_COORDINATE_PRECISION)}`,
      freshSeconds: config.weatherFreshSeconds,
      staleSeconds: config.weatherStaleSeconds,
      fetch: () => provider.weather(request),
      negative: () => false
    };
  }
  if (request.kind === 'reverse') {
    return {
      kind: 'reverse',
      key: `REV#${coordinateCacheKey(request.lat, request.lon, REVERSE_COORDINATE_PRECISION)}`,
      freshSeconds: config.placePositiveSeconds,
      staleSeconds: config.placePositiveSeconds,
      fetch: () => provider.reverse(request),
      negative: (payload) => payload === null
    };
  }
  return {
    kind: 'search',
    key: `SEARCH#${searchKey(request.normalizedQuery, request.limit)}`,
    freshSeconds: config.placePositiveSeconds,
    staleSeconds: config.placePositiveSeconds,
    fetch: () => provider.search(request),
    negative: (payload) => payload.length === 0
  };
}

async function safelyRelease(store, key, owner, metrics) {
  try {
    await store.releaseLease({ key, owner });
  } catch {
    metrics.add('CacheLeaseReleaseError');
  }
}

export function createWeatherService({
  store,
  provider,
  config,
  now = () => Date.now(),
  sleep = delay,
  owner = randomUUID
}) {
  // Per-container memory of a refusal that holds for every request (exhausted UTC
  // day or month, or a provider 429 cooldown), so misses skip the table writes
  // until it ends.
  let providerBlockedUntil = 0;

  return async function execute(request, metrics, requestContext = {}) {
    const operation = classifyOperation(request, config, provider);
    let nowEpochSeconds = Math.floor(now() / 1000);
    let cached;
    try {
      cached = await store.getCache(operation.key);
    } catch {
      metrics.add('CacheReadError');
      return unavailable(5);
    }

    if (isFresh(cached, nowEpochSeconds)) {
      metrics.add('CacheFreshHit');
      if (cached.negative) metrics.add('CacheNegativeHit');
      return success(cacheEnvelope(operation, cached, 'fresh-hit'), {
        maxAge: cached.freshUntil - nowEpochSeconds
      });
    }

    metrics.add('CacheMiss');
    const stale = isStaleUsable(cached, nowEpochSeconds) ? cached : null;
    const leaseOwner = owner();
    const serveStale = (cacheStatus) => {
      metrics.add('CacheStaleServed');
      return success(cacheEnvelope(operation, stale, cacheStatus, true), { stale: true });
    };
    if (providerBlockedUntil > nowEpochSeconds) {
      metrics.add('UpstreamSuppressedQuota');
      metrics.add('ProviderBudgetRefused');
      metrics.add('QuotaKnownBlocked');
      return stale
        ? serveStale('stale-quota-limit')
        : unavailable(Math.min(300, providerBlockedUntil - nowEpochSeconds));
    }

    /** Every pre-upstream refusal after the lease is held: release it, then prefer stale data. */
    const degrade = async (cacheStatus, refusal) => {
      await safelyRelease(store, operation.key, leaseOwner, metrics);
      return stale ? serveStale(cacheStatus) : refusal;
    };
    let acquired;
    try {
      acquired = await store.tryAcquireLease({
        key: operation.key,
        owner: leaseOwner,
        nowEpochSeconds,
        leaseSeconds: config.leaseSeconds,
        retainUntilEpochSeconds: cached?.expiresAt
      });
    } catch {
      metrics.add('CacheLeaseError');
      return stale ? serveStale('stale-cache-error') : unavailable(5);
    }

    if (!acquired) {
      metrics.add('CacheLeaseContended');
      if (stale) return serveStale('stale-while-refresh');
      for (let attempt = 0; attempt < config.leaseWaitAttempts; attempt += 1) {
        await sleep(config.leaseWaitMs);
        nowEpochSeconds = Math.floor(now() / 1000);
        let refreshed;
        try {
          refreshed = await store.getCache(operation.key, true);
        } catch {
          metrics.add('CacheReadError');
          break;
        }
        if (isFresh(refreshed, nowEpochSeconds)) {
          metrics.add('CacheWaitHit');
          return success(cacheEnvelope(operation, refreshed, 'coalesced-hit'), {
            maxAge: refreshed.freshUntil - nowEpochSeconds
          });
        }
        // The winner released its lease without writing (refused or failed), so
        // nothing more is coming; polling on would only hold a concurrency slot.
        if (!refreshed?.leaseOwner || !(refreshed.leaseUntil >= nowEpochSeconds)) {
          metrics.add('CacheWaitAbandoned');
          break;
        }
      }
      metrics.add('RefreshInProgressResponse');
      return unavailable(config.leaseSeconds);
    }

    if (config.clientUpstreamLimit > 0) {
      const fingerprint = clientFingerprint(
        requestContext.clientIp,
        config.clientRatePepper,
        clientWindowStart(nowEpochSeconds, config.clientUpstreamWindowSeconds)
      );
      if (!fingerprint) {
        metrics.add('ClientIdentityMissing');
        return degrade('stale-client-identity-error', unavailable(5));
      }

      let clientReservation;
      try {
        clientReservation = await store.reserveClientUpstream({
          fingerprint,
          limit: config.clientUpstreamLimit,
          windowSeconds: config.clientUpstreamWindowSeconds,
          nowEpochSeconds
        });
      } catch {
        metrics.add('ClientRateStoreError');
        return degrade('stale-client-rate-error', unavailable(5));
      }

      if (!clientReservation.allowed) {
        metrics.add('ClientUpstreamRateRefused');
        return degrade('stale-client-rate-limit', rateLimited(clientReservation.retryAfterSeconds));
      }
      metrics.add('ClientUpstreamReservation');

      if (config.clientUpstreamDailyLimit > 0) {
        const dailyFingerprint = clientFingerprint(
          requestContext.clientIp,
          config.clientRatePepper,
          clientWindowStart(nowEpochSeconds, DAY_SECONDS)
        );
        let dailyReservation;
        try {
          dailyReservation = await store.reserveClientUpstream({
            fingerprint: dailyFingerprint,
            limit: config.clientUpstreamDailyLimit,
            windowSeconds: DAY_SECONDS,
            nowEpochSeconds
          });
        } catch {
          metrics.add('ClientRateStoreError');
          return degrade('stale-client-rate-error', unavailable(5));
        }
        if (!dailyReservation.allowed) {
          metrics.add('ClientUpstreamRateRefused');
          metrics.add('ClientUpstreamDailyRefused');
          return degrade('stale-client-rate-limit', rateLimited(Math.min(3600, dailyReservation.retryAfterSeconds)));
        }
      }
    }

    let reservation;
    try {
      reservation = await store.reserveQuota({ limits: config.quotaLimits, nowEpochSeconds });
    } catch {
      metrics.add('QuotaStoreError');
      return degrade('stale-quota-error', unavailable(30));
    }

    if (!reservation.allowed) {
      const until = blockedUntil(reservation, nowEpochSeconds);
      if (until !== null) providerBlockedUntil = Math.max(providerBlockedUntil, until);
      metrics.add('UpstreamSuppressedQuota');
      metrics.add('ProviderBudgetRefused');
      const metric = {
        rate: 'QuotaRateDenied',
        cooldown: 'QuotaCooldownDenied',
        day: 'QuotaDayDenied',
        month: 'QuotaMonthDenied'
      }[reservation.deniedWindow] ?? 'QuotaUnknownDenied';
      metrics.add(metric);
      return degrade('stale-quota-limit', unavailable(reservation.retryAfterSeconds
        ?? (reservation.deniedWindow === 'rate' ? 2 : 300)));
    }

    metrics.add('QuotaReservation');
    metrics.add('UpstreamAttempt');
    const startedAt = now();
    let payload;
    try {
      payload = await operation.fetch();
      metrics.add('UpstreamSuccess');
      metrics.add('UpstreamLatency', Math.max(0, now() - startedAt));
    } catch (error) {
      recordUpstreamError(metrics, error);
      if (error?.kind === 'rate_limited') {
        const cooldownStartedAt = Math.floor(now() / 1000);
        providerBlockedUntil = Math.max(providerBlockedUntil, cooldownStartedAt + config.providerCooldownSeconds);
        try {
          await store.startProviderCooldown({
            nowEpochSeconds: cooldownStartedAt,
            cooldownSeconds: config.providerCooldownSeconds
          });
          metrics.add('ProviderCooldownStarted');
        } catch {
          metrics.add('ProviderCooldownWriteError');
        }
      }
      return degrade('stale-upstream-error', unavailable(error?.kind === 'rate_limited' ? 60 : 30));
    }

    nowEpochSeconds = Math.floor(now() / 1000);
    const negative = operation.negative(payload);
    const freshSeconds = negative ? config.placeNegativeSeconds : operation.freshSeconds;
    const freshUntil = nowEpochSeconds + freshSeconds;
    const staleUntil = negative ? freshUntil : nowEpochSeconds + operation.staleSeconds;
    const item = { payload, negative, freshUntil, staleUntil };
    try {
      const written = await store.putCache({ key: operation.key, owner: leaseOwner, ...item });
      metrics.add(written === false ? 'CacheWriteConflict' : 'CacheWriteSuccess');
    } catch {
      metrics.add('CacheWriteError');
      await safelyRelease(store, operation.key, leaseOwner, metrics);
    }
    return success(cacheEnvelope(operation, item, 'refreshed'), { maxAge: freshSeconds });
  };
}
