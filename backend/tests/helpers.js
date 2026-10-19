export const baseConfig = Object.freeze({
  weatherFreshSeconds: 1200,
  weatherStaleSeconds: 21600,
  placePositiveSeconds: 2592000,
  placeNegativeSeconds: 86400,
  leaseSeconds: 5,
  leaseWaitMs: 1,
  leaseWaitAttempts: 2,
  quotaLimits: { minute: 48, burst: 6, day: 25000, month: 800000 },
  providerCooldownSeconds: 60,
  clientUpstreamLimit: 0,
  clientUpstreamWindowSeconds: 300,
  clientUpstreamDailyLimit: 0,
  clientRatePepper: null,
  namespace: 'Test/Backend'
});

export class MetricCollector {
  constructor() {
    this.values = {};
  }

  add(name, value = 1) {
    this.values[name] = (this.values[name] ?? 0) + value;
  }
}

export class MemoryStore {
  constructor() {
    this.items = new Map();
    this.acquire = true;
    this.reservation = { allowed: true };
    this.calls = [];
    this.readSequence = [];
  }

  async getCache(key, consistent = false) {
    this.calls.push(['get', key, consistent]);
    if (this.readError) throw this.readError;
    if (this.readSequence.length) return this.readSequence.shift();
    return this.items.get(key) ?? null;
  }

  async tryAcquireLease(input) {
    this.calls.push(['lease', input]);
    if (this.leaseError) throw this.leaseError;
    return this.acquire;
  }

  async reserveQuota(input) {
    this.calls.push(['quota', input]);
    if (this.quotaError) throw this.quotaError;
    return this.reservation;
  }

  async reserveClientUpstream(input) {
    this.calls.push(['clientQuota', input]);
    if (this.clientQuotaError) throw this.clientQuotaError;
    return this.clientReservation ?? { allowed: true, retryAfterSeconds: 0 };
  }

  async startProviderCooldown(input) {
    this.calls.push(['cooldown', input]);
    if (this.cooldownError) throw this.cooldownError;
    return true;
  }

  async putCache(input) {
    this.calls.push(['put', input]);
    if (this.putError) throw this.putError;
    if (this.putResult === false) return false;
    this.items.set(input.key, { ...input });
    return true;
  }

  async releaseLease(input) {
    this.calls.push(['release', input]);
    if (this.releaseError) throw this.releaseError;
  }
}

export const weatherPayload = Object.freeze({
  weather: {
    weather: [{ main: 'Clear', description: 'clear sky' }],
    main: { temp: 72, humidity: 45 },
    wind: { speed: 4.2 },
    sys: { sunrise: 1700000000, sunset: 1700040000, country: 'US' },
    timezone: -14400,
    name: 'Detroit'
  },
  observedAt: '2026-08-29T16:00:00.000Z',
  location: { name: 'Detroit', state: '', country: 'US' }
});
