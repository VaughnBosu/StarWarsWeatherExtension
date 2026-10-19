// Copy to env.js for local development. env.js is ignored and generated in CI.
const BACKEND_BASE_URL = 'https://q2a9oetm2h.execute-api.us-east-1.amazonaws.com';
const MODEROK_APP_KEY = '';

globalThis.BACKEND_BASE_URL = BACKEND_BASE_URL;
globalThis.MODEROK_APP_KEY = MODEROK_APP_KEY;

export { BACKEND_BASE_URL, MODEROK_APP_KEY };
