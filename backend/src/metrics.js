// Only a few fields become CloudWatch metrics; the rest stay in the EMF log
// document for Logs Insights queries.
const CUSTOM_METRICS = new Set([
  'BackendRequest',
  'CacheFreshHit',
  'CacheStaleServed',
  'UpstreamAttempt',
  'UpstreamSuccess',
  'UpstreamResponse429',
  'UpstreamAuthDenied',
  'UpstreamResponse5xx',
  'UpstreamTimeout',
  'ProviderBudgetRefused'
]);

/** One low-cardinality EMF document per request. Values and dimensions never contain request data. */
export class RequestMetrics {
  constructor({ namespace = 'StarWarsWeather/Backend', route = 'Unknown', logger = console.log, now = () => Date.now() } = {}) {
    this.namespace = namespace;
    this.route = route;
    this.logger = logger;
    this.now = now;
    this.values = Object.create(null);
  }

  add(name, value = 1) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Metric values must be finite and non-negative');
    this.values[name] = (this.values[name] ?? 0) + value;
  }

  emit() {
    const names = Object.keys(this.values);
    if (names.length === 0) return;
    const metricNames = names.filter((name) => CUSTOM_METRICS.has(name));
    this.logger(JSON.stringify({
      _aws: {
        Timestamp: this.now(),
        CloudWatchMetrics: [{
          Namespace: this.namespace,
          Dimensions: [['Service']],
          Metrics: metricNames.map((Name) => ({ Name, Unit: 'Count' }))
        }]
      },
      Service: 'WeatherApi',
      Route: this.route,
      ...this.values
    }));
  }
}

export function recordUpstreamError(metrics, error) {
  if (error?.kind === 'client_error' && (error.statusCode === 401 || error.statusCode === 403)) {
    metrics.add('UpstreamAuthDenied');
    return;
  }
  const metric = {
    rate_limited: 'UpstreamResponse429',
    server_error: 'UpstreamResponse5xx',
    timeout: 'UpstreamTimeout',
    network_error: 'UpstreamNetworkError',
    invalid_response: 'UpstreamInvalidResponse',
    client_error: 'UpstreamResponse4xx',
    configuration: 'UpstreamConfigurationError'
  }[error?.kind] ?? 'UpstreamUnknownError';
  metrics.add(metric);
}
