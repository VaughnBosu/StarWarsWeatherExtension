import { UpstreamError } from './errors.js';

const cleanText = (value, maxLength = 100) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
};

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

async function boundedJson(response, maximumBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new UpstreamError('invalid_response');
  }

  let bytes;
  if (response.body?.getReader) {
    const chunks = [];
    const reader = response.body.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new UpstreamError('invalid_response');
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximumBytes) throw new UpstreamError('invalid_response');
    bytes = new Uint8Array(buffer);
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new UpstreamError('invalid_response');
  }
}

function weatherShape(payload) {
  const temperature = finite(payload?.main?.temp);
  const condition = cleanText(payload?.weather?.[0]?.main, 40);
  if (temperature === null || !condition) throw new UpstreamError('invalid_response');

  const description = cleanText(payload.weather[0].description, 120);
  const humidity = finite(payload.main.humidity);
  const windSpeed = finite(payload?.wind?.speed);
  const sunrise = finite(payload?.sys?.sunrise);
  const sunset = finite(payload?.sys?.sunset);
  const timezone = finite(payload?.timezone);
  const name = cleanText(payload?.name, 100);
  const country = cleanText(payload?.sys?.country, 8).toUpperCase();
  const state = cleanText(payload?.sys?.state, 100);

  const weather = {
    weather: [{ main: condition, ...(description ? { description } : {}) }],
    main: {
      temp: temperature,
      ...(humidity !== null && humidity >= 0 && humidity <= 100 ? { humidity } : {})
    },
    wind: windSpeed !== null && windSpeed >= 0 ? { speed: windSpeed } : {},
    sys: {
      ...(sunrise !== null ? { sunrise: Math.trunc(sunrise) } : {}),
      ...(sunset !== null ? { sunset: Math.trunc(sunset) } : {}),
      ...(country ? { country } : {}),
      ...(state ? { state } : {})
    },
    ...(timezone !== null ? { timezone: Math.trunc(timezone) } : {}),
    ...(name ? { name } : {})
  };

  const location = name
    ? { name, state, country }
    : null;

  return { weather, location };
}

function locationShape(candidate) {
  const name = cleanText(candidate?.name, 100);
  const lat = finite(candidate?.lat);
  const lon = finite(candidate?.lon);
  if (!name || lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new UpstreamError('invalid_response');
  }
  return {
    name,
    state: cleanText(candidate?.state, 100),
    country: cleanText(candidate?.country, 8).toUpperCase(),
    lat,
    lon
  };
}

function observedAt(payload, nowMs) {
  const seconds = finite(payload?.dt);
  const milliseconds = seconds === null ? NaN : seconds * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds < 946684800000 || milliseconds > nowMs + 86400000) {
    return new Date(nowMs).toISOString();
  }
  return new Date(milliseconds).toISOString();
}

export class ProviderClient {
  constructor({
    fetchImpl = globalThis.fetch,
    apiKeyProvider,
    baseUrl,
    timeoutMs = 3000,
    maximumBytes = 65536,
    now = () => Date.now()
  }) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    if (typeof apiKeyProvider !== 'function') throw new Error('apiKeyProvider is required');
    this.fetchImpl = fetchImpl;
    this.apiKeyProvider = apiKeyProvider;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.maximumBytes = maximumBytes;
    this.now = now;
  }

  async request(path, parameters) {
    let apiKey;
    try {
      apiKey = await this.apiKeyProvider();
    } catch {
      throw new UpstreamError('configuration');
    }
    if (!apiKey) throw new UpstreamError('configuration');
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, String(value));
    url.searchParams.set('appid', apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal
        });
      } catch {
        throw new UpstreamError(controller.signal.aborted ? 'timeout' : 'network_error');
      }
      if (response.status === 429) throw new UpstreamError('rate_limited', 429);
      if (response.status >= 500) throw new UpstreamError('server_error', response.status);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.apiKeyProvider.invalidate?.(apiKey);
        }
        throw new UpstreamError('client_error', response.status);
      }
      try {
        return await boundedJson(response, this.maximumBytes);
      } catch (error) {
        if (controller.signal.aborted && !(error instanceof UpstreamError)) {
          throw new UpstreamError('timeout');
        }
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async weather({ lat, lon }) {
    const payload = await this.request('/data/2.5/weather', { lat, lon, units: 'imperial' });
    return { ...weatherShape(payload), observedAt: observedAt(payload, this.now()) };
  }

  async reverse({ lat, lon }) {
    const payload = await this.request('/geo/1.0/reverse', { lat, lon, limit: 1 });
    if (!Array.isArray(payload)) throw new UpstreamError('invalid_response');
    return payload.length === 0 ? null : locationShape(payload[0]);
  }

  async search({ query, limit }) {
    const payload = await this.request('/geo/1.0/direct', { q: query, limit });
    if (!Array.isArray(payload)) throw new UpstreamError('invalid_response');
    // A single malformed candidate is dropped rather than failing (and never caching) the query.
    return payload.slice(0, limit).flatMap((candidate) => {
      try {
        return [locationShape(candidate)];
      } catch {
        return [];
      }
    });
  }
}
