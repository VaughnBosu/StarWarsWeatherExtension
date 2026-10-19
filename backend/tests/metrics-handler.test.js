import { describe, expect, test } from 'bun:test';
import { createHandler } from '../src/handler.js';
import { RequestMetrics } from '../src/metrics.js';

const config = { namespace: 'Test/Backend' };
const event = (query, overrides = {}) => ({
  rawPath: '/v1/weather',
  rawQueryString: query,
  requestContext: { http: { method: 'GET', sourceIp: '203.0.113.10' } },
  ...overrides
});

function harness(service) {
  const logs = [];
  const handler = createHandler({
    configProvider: () => config,
    serviceProvider: async () => service,
    metricsFactory: (options) => new RequestMetrics({ ...options, logger: (line) => logs.push(line), now: () => 1234 })
  });
  return { handler, logs };
}

describe('Lambda handler and EMF telemetry', () => {
  test('emits exact low-cardinality counters for an accepted response', async () => {
    const { handler, logs } = harness(async (_request, metrics) => {
      metrics.add('CacheFreshHit');
      return { statusCode: 200, body: { weather: {} }, headers: { 'Cache-Control': 'public, s-maxage=1' } };
    });
    const result = await handler(event('lat=42.33&lon=-83.05'));
    const emf = JSON.parse(logs[0]);

    expect(result.statusCode).toBe(200);
    expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(emf).toMatchObject({
      Service: 'WeatherApi',
      Route: 'Weather',
      BackendRequest: 1,
      AcceptedRequest: 1,
      SuccessfulResponse: 1,
      CacheFreshHit: 1
    });
    expect(emf._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Service']]);
  });

  test('invalid requests are counted as backend denials and logs contain no request data', async () => {
    const sensitiveQuery = 'lat=42.33123456&lon=-83.05123456&private=secret-city';
    const { handler, logs } = harness(() => { throw new Error('service must not run'); });
    const result = await handler(event(sensitiveQuery));
    const emf = JSON.parse(logs[0]);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ code: 'invalid_request' });
    expect(emf).toMatchObject({ BackendRequest: 1, BackendRejectedRequest: 1, ClientErrorResponse: 1 });
    expect(logs[0]).not.toContain('42.33');
    expect(logs[0]).not.toContain('secret-city');
    expect(logs[0]).not.toContain('203.0.113.10');
  });

  test('unexpected failures return a sanitized error and still emit metrics', async () => {
    const { handler, logs } = harness(async () => { throw new Error('coordinates 42.33 and provider key abc'); });
    const result = await handler(event('lat=42.33&lon=-83.05'));
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ code: 'internal_error' });
    expect(logs[0]).not.toContain('provider key');
    expect(JSON.parse(logs[0])).toMatchObject({ UnhandledError: 1, ServerErrorResponse: 1 });
  });

  test('handles preflight without constructing the backend runtime', async () => {
    let calls = 0;
    const { handler } = harness(async () => { calls += 1; });
    const result = await handler(event('', {
      requestContext: { http: { method: 'OPTIONS' } }
    }));
    expect(result.statusCode).toBe(204);
    expect(result.body).toBe('');
    expect(calls).toBe(0);
  });

  test('passes only validated gateway source addresses to the service', async () => {
    const seen = [];
    const { handler } = harness(async (_request, _metrics, context) => {
      seen.push(context.clientIp);
      return { statusCode: 200, body: { weather: {} }, headers: {} };
    });

    await handler(event('lat=42.33&lon=-83.05'));
    await handler(event('lat=42.33&lon=-83.05', {
      requestContext: { http: { method: 'GET', sourceIp: 'not-an-ip' } }
    }));
    expect(seen).toEqual(['203.0.113.10', null]);
  });

  test('limits billed custom metrics while retaining exact structured fields', () => {
    const logs = [];
    const metrics = new RequestMetrics({ logger: (line) => logs.push(line), now: () => 1 });
    metrics.add('UpstreamAttempt');
    metrics.add('UpstreamLatency', 23);
    metrics.emit();
    const document = JSON.parse(logs[0]);
    const definitions = document._aws.CloudWatchMetrics[0].Metrics;
    expect(definitions).toContainEqual({ Name: 'UpstreamAttempt', Unit: 'Count' });
    expect(definitions.some(({ Name }) => Name === 'UpstreamLatency')).toBe(false);
    expect(document.UpstreamLatency).toBe(23);
  });
});
