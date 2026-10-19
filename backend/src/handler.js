import { isIP } from 'node:net';
import { getRuntime } from './aws-runtime.js';
import { loadConfig } from './config.js';
import { HttpError } from './errors.js';
import { RequestMetrics } from './metrics.js';
import { parseRequest, routeName } from './validation.js';

const BASE_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
});

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { ...BASE_HEADERS, ...headers },
    body: body === null ? '' : JSON.stringify(body),
    isBase64Encoded: false
  };
}

/** process.env is fixed for a container's lifetime, so parse it once and reuse the result. */
let cachedConfig;
const loadConfigOnce = () => (cachedConfig ??= loadConfig());

export function createHandler({
  serviceProvider,
  metricsFactory = (options) => new RequestMetrics(options),
  configProvider = loadConfigOnce
} = {}) {
  return async function lambdaHandler(event) {
    const route = routeName(event);
    let config;
    try {
      config = configProvider();
    } catch {
      // The namespace falls back to the RequestMetrics default because no config could be read.
      const metrics = metricsFactory({ route });
      metrics.add('BackendRequest');
      metrics.add('ConfigurationError');
      metrics.add('ServerErrorResponse');
      metrics.emit();
      return response(500, { code: 'internal_error' }, { 'Cache-Control': 'private, no-store' });
    }
    const metrics = metricsFactory({ namespace: config.namespace, route });
    metrics.add('BackendRequest');
    try {
      const request = parseRequest(event);
      metrics.add('AcceptedRequest');
      if (request.kind === 'preflight') {
        metrics.add('SuccessfulResponse');
        return response(204, null, { 'Cache-Control': 'public, max-age=86400' });
      }

      const service = serviceProvider ? await serviceProvider(config) : await getRuntime(config);
      const sourceIp = event?.requestContext?.http?.sourceIp
        ?? event?.requestContext?.identity?.sourceIp
        ?? null;
      const result = await service(request, metrics, {
        // Used only for a short-lived, one-way abuse-control bucket. It is
        // never included in application logs, metrics, cache values, or provider calls.
        clientIp: typeof sourceIp === 'string' && isIP(sourceIp) !== 0 ? sourceIp : null
      });
      if (result.statusCode < 400) metrics.add('SuccessfulResponse');
      else if (result.statusCode < 500) metrics.add('ClientErrorResponse');
      else metrics.add('ServerErrorResponse');
      return response(result.statusCode, result.body, result.headers);
    } catch (error) {
      if (error instanceof HttpError) {
        metrics.add('BackendRejectedRequest');
        metrics.add('ClientErrorResponse');
        return response(error.statusCode, { code: error.code }, {
          'Cache-Control': 'private, no-store',
          ...error.headers
        });
      }
      metrics.add('UnhandledError');
      metrics.add('ServerErrorResponse');
      return response(500, { code: 'internal_error' }, { 'Cache-Control': 'private, no-store' });
    } finally {
      try {
        metrics.emit();
      } catch {
        // Logging must never change the API response.
      }
    }
  };
}

export const handler = createHandler();
