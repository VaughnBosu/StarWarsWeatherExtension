import { Window } from 'happy-dom';

export function createSpy(impl = () => {}) {
  const spy = (...args) => {
    spy.calls.push(args);
    return impl(...args);
  };
  spy.calls = [];
  return spy;
}

export function createStorageMock(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    _store: store
  };
}

export function installStorageMock(initial = {}) {
  const storage = createStorageMock(initial);
  globalThis.localStorage = storage;
  return storage;
}

export function installDom(html = '') {
  const window = new Window();
  const { document } = window;
  document.body.innerHTML = html;
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;
  globalThis.KeyboardEvent = window.KeyboardEvent;
  globalThis.MutationObserver = window.MutationObserver;
  return window;
}

export function teardownDom() {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.HTMLElement;
  delete globalThis.Event;
  delete globalThis.KeyboardEvent;
  delete globalThis.MutationObserver;
}

export function installNavigator(window, overrides = {}) {
  const base = window?.navigator ?? {};
  globalThis.navigator = { ...base, ...overrides };
  return globalThis.navigator;
}

export function createFetchMock(responses = []) {
  const calls = [];
  const fetchMock = async (input) => {
    calls.push(String(input));
    if (responses.length === 0) {
      throw new Error('Unexpected fetch call');
    }
    const response = responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    const { ok = true, status = 200 } = response;
    const body = response.json ?? response.body ?? {};
    return {
      ok,
      status,
      json: async () => (typeof body === 'function' ? body() : body)
    };
  };
  fetchMock.calls = calls;
  return fetchMock;
}

export function createLocalizationMock(messages = {}, language = 'en') {
  return {
    language,
    getMessage(key, substitutions = []) {
      const entry = messages[key];
      if (!entry) {
        return '';
      }
      const template = entry.message ?? entry;
      const values = Array.isArray(substitutions) ? substitutions : [substitutions];
      return values.reduce((result, value, index) => {
        const placeholder = new RegExp(`\\$${index + 1}`, 'g');
        return result.replace(placeholder, value);
      }, template);
    }
  };
}

export function installRuntimeMock({ useBrowser = true, getURL } = {}) {
  const runtime = {
    getURL: getURL || ((path) => `chrome-extension://test/${path}`)
  };

  if (useBrowser) {
    globalThis.browser = { runtime };
    delete globalThis.chrome;
  } else {
    globalThis.chrome = { runtime };
    delete globalThis.browser;
  }

  return runtime;
}
