import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { formatMessage, invalidateLocalizationCache, loadLocalization } from '../i18n.js';
import { createFetchMock } from './testUtils.js';

const realFetch = globalThis.fetch;
const realBrowser = globalThis.browser;
const realChrome = globalThis.chrome;

beforeEach(() => {
  invalidateLocalizationCache();
  globalThis.browser = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`
    }
  };
  delete globalThis.chrome;
});

afterEach(() => {
  invalidateLocalizationCache();
  if (realFetch) {
    globalThis.fetch = realFetch;
  } else {
    delete globalThis.fetch;
  }
  if (realBrowser) {
    globalThis.browser = realBrowser;
  } else {
    delete globalThis.browser;
  }
  if (realChrome) {
    globalThis.chrome = realChrome;
  } else {
    delete globalThis.chrome;
  }
});

describe('formatMessage', () => {
  test('replaces placeholders', () => {
    expect(formatMessage('Hello $1 $1', ['there'])).toBe('Hello there there');
  });

  test('returns template when no substitutions', () => {
    expect(formatMessage('Hello', null)).toBe('Hello');
    expect(formatMessage(null, ['x'])).toBe('');
  });
});

describe('loadLocalization', () => {
  test('loads and caches locale', async () => {
    globalThis.fetch = createFetchMock([
      {
        json: {
          greeting: { message: 'Hello $1' }
        }
      }
    ]);

    const first = await loadLocalization('en');
    const second = await loadLocalization('en');

    expect(first).toBe(second);
    expect(first.getMessage('greeting', ['World'])).toBe('Hello World');
    expect(globalThis.fetch.calls.length).toBe(1);
  });

  test('invalidateLocalizationCache forces reload', async () => {
    globalThis.fetch = createFetchMock([
      { json: { greeting: { message: 'Hi' } } },
      { json: { greeting: { message: 'Hola' } } }
    ]);

    const first = await loadLocalization('en');
    invalidateLocalizationCache('en');
    const second = await loadLocalization('en');

    expect(first).not.toBe(second);
    expect(second.getMessage('greeting')).toBe('Hola');
    expect(globalThis.fetch.calls.length).toBe(2);
  });

  test('falls back to default locale on failure', async () => {
    globalThis.fetch = createFetchMock([
      { ok: false, status: 404, json: {} },
      { json: { greeting: { message: 'Hello' } } }
    ]);

    const localization = await loadLocalization('es');
    expect(localization.language).toBe('en');
    expect(localization.getMessage('greeting')).toBe('Hello');
    expect(globalThis.fetch.calls.length).toBe(2);
  });

  test('returns empty string for missing keys', async () => {
    globalThis.fetch = createFetchMock([
      { json: {} }
    ]);

    const localization = await loadLocalization('en');
    expect(localization.getMessage('missing_key')).toBe('');
  });

  test('throws when runtime missing', async () => {
    delete globalThis.browser;
    delete globalThis.chrome;
    globalThis.fetch = createFetchMock([{ json: {} }]);

    await expect(loadLocalization('en')).rejects.toThrow();
  });
});
