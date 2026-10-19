export class HttpError extends Error {
  constructor(statusCode, code, options = {}) {
    super(code);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.headers = options.headers ?? {};
  }
}

/**
 * Deliberately contains only a classification and status. Never attach a provider
 * URL, response body, or request data: Lambda errors can otherwise leak the API
 * key, coordinates, or a city query into CloudWatch Logs.
 */
export class UpstreamError extends Error {
  constructor(kind, statusCode = null) {
    super(kind);
    this.name = 'UpstreamError';
    this.kind = kind;
    this.statusCode = statusCode;
  }
}
