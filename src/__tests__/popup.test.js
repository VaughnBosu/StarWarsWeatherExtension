import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createFetchMock,
  createLocalizationMock,
  createSpy,
  installDom,
  installNavigator,
  installStorageMock,
  teardownDom
} from './testUtils.js';
import { setManualLocation } from '../storage.js';
import { invalidateLocalizationCache } from '../i18n.js';

globalThis.__SWW_SKIP_INIT__ = true;

let popup = null;

const POPUP_LOCALE_MESSAGES = Object.freeze({
  popup_title: { message: 'Star Wars Weather' },
  popup_link_rate: { message: '<strong>Rate</strong>' },
  popup_manual_location_placeholder: { message: 'City or City, Country' },
  popup_manual_location_searching: { message: 'Searching...' },
  popup_manual_location_no_results: { message: 'No matching cities found.' },
  popup_manual_location_error: { message: 'Could not retrieve cities. Please try again.' },
  popup_manual_location_selected: { message: 'Manual location set to $1.' },
  popup_manual_location_auto: { message: 'Using automatic location.' },
  popup_permission_denied_search: { message: 'Permission required. Toggle this on again to re-request.' },
  popup_permission_denied_shortcuts: { message: 'Permission required. Toggle this on again to re-request.' }
});

function createPopupLocalization(overrides = {}) {
  return createLocalizationMock({
    ...POPUP_LOCALE_MESSAGES,
    ...overrides
  });
}

function createPopupLocaleResponse(overrides = {}) {
  return {
    json: {
      ...POPUP_LOCALE_MESSAGES,
      ...overrides
    }
  };
}

const POPUP_DOM = `
    <div data-i18n="popup_title"></div>
    <div data-i18n-html="popup_link_rate"></div>
    <input data-i18n-placeholder="popup_manual_location_placeholder" />
    <input id="manualLocationInput" />
    <button id="manualLocationSearch" type="button">Search</button>
    <button id="manualLocationClear" type="button">Clear</button>
    <div id="manualLocationResults"></div>
    <input type="radio" name="temp" value="fahrenheit" />
    <input type="radio" name="temp" value="celsius" />
    <input type="radio" name="lang" value="English" />
    <input type="radio" name="lang" value="Spanish" />
    <label class="checkbox-option"><input id="showSearchBar" type="checkbox"><span>Search bar</span></label>
    <label class="checkbox-option"><input id="showShortcuts" type="checkbox"><span>Shortcuts</span></label>
    <label class="checkbox-option"><input id="showGoogleApps" type="checkbox"><span>Google apps</span></label>
    <label class="checkbox-option"><input id="showExtrasInHyperspace" type="checkbox"><span>Hyperspace</span></label>
  `;

/**
 * The popup process dies on every blur: DOM and module state go, localStorage
 * survives. Rebuilding around a storage snapshot proves what actually persisted.
 */
function simulatePopupTeardown() {
  const persisted = Object.fromEntries(globalThis.localStorage._store);
  teardownDom();
  installStorageMock(persisted);
  installDom(POPUP_DOM);
  installNavigator(globalThis.window, { language: 'en-US' });
  globalThis.window.open = () => {};
}

function geocodeCallsRecorded() {
  const raw = globalThis.localStorage.getItem('sww.telemetry');
  return raw ? (JSON.parse(raw).geocodeCalls ?? 0) : 0;
}

const realFetch = globalThis.fetch;
const realBrowser = globalThis.browser;
const realChrome = globalThis.chrome;
const realNavigator = globalThis.navigator;
const realBackendBaseUrl = globalThis.BACKEND_BASE_URL;

beforeAll(async () => {
  popup = await import('../popup.js');
});

beforeEach(() => {
  invalidateLocalizationCache();
  installStorageMock();
  installDom(POPUP_DOM);
  installNavigator(globalThis.window, { language: 'en-US' });
  globalThis.browser = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`
    }
  };
  delete globalThis.chrome;
  globalThis.window.open = () => {};
  globalThis.BACKEND_BASE_URL = 'https://weather.example.test';
});

afterEach(() => {
  teardownDom();
  invalidateLocalizationCache();
  delete globalThis.localStorage;
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
  if (realNavigator) {
    globalThis.navigator = realNavigator;
  } else {
    delete globalThis.navigator;
  }
  if (realBackendBaseUrl) {
    globalThis.BACKEND_BASE_URL = realBackendBaseUrl;
  } else {
    delete globalThis.BACKEND_BASE_URL;
  }
});

describe('popup translations', () => {
  test('applyTranslations fills text, html, and placeholders', () => {
    const localization = createPopupLocalization({
      popup_manual_location_placeholder: { message: 'City' }
    });

    popup.applyTranslations(localization);

    expect(document.querySelector('[data-i18n="popup_title"]').innerText).toBe('Star Wars Weather');
    expect(document.title).toBe('Star Wars Weather');
    expect(document.querySelector('[data-i18n-html="popup_link_rate"]').innerHTML).toBe('<strong>Rate</strong>');
    expect(document.querySelector('[data-i18n-placeholder]').getAttribute('placeholder')).toBe('City');
  });

  test('refreshLocalization re-renders manual location status', async () => {
    popup.renderManualLocationMessage('auto');

    globalThis.fetch = createFetchMock([
      createPopupLocaleResponse({
        popup_manual_location_placeholder: { message: 'City' },
        popup_manual_location_auto: { message: 'Auto mode' }
      })
    ]);

    await popup.refreshLocalization('en');

    const message = document.querySelector('#manualLocationResults .selection-message').textContent;
    expect(message).toBe('Auto mode');
  });
});

describe('popup handlers', () => {
  test('attachUnitHandlers stores unit and clears cache', () => {
    localStorage.setItem('sww.cache', JSON.stringify({ planet: 'old' }));
    const celsiusRadio = document.querySelector('input[name="temp"][value="celsius"]');

    popup.attachUnitHandlers();
    celsiusRadio.dispatchEvent(new Event('change'));

    expect(localStorage.getItem('unit')).toBe('celsius');
    expect(localStorage.getItem('sww.cache')).toBeNull();
  });

  test('attachLanguageHandlers stores language and refreshes localization', async () => {
    globalThis.fetch = createFetchMock([
      createPopupLocaleResponse({
        popup_title: { message: 'Titulo' }
      })
    ]);

    const spanishRadio = document.querySelector('input[name="lang"][value="Spanish"]');
    popup.attachLanguageHandlers();
    spanishRadio.dispatchEvent(new Event('change'));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(localStorage.getItem('language')).toBe('es');
    expect(document.querySelector('[data-i18n="popup_title"]').innerText).toBe('Titulo');
  });
});

describe('manual location flow', () => {
  test('handleManualLocationSearch shows selected message when input empty', async () => {
    setManualLocation({ name: 'Paris', lat: 48.8566, lon: 2.3522, country: 'FR' });
    const input = document.getElementById('manualLocationInput');
    input.value = '';

    await popup.handleManualLocationSearch(input);

    expect(document.getElementById('manualLocationResults').innerHTML).toBe('');
  });

  test('handleManualLocationSearch renders options from results', async () => {
    globalThis.fetch = createFetchMock([
      {
        json: { locations: [
          { name: 'Austin', state: 'Texas', country: 'US', lat: 30.2672, lon: -97.7431 },
          { name: 'Paris', country: 'FR', lat: 48.8566, lon: 2.3522 }
        ] }
      }
    ]);

    const input = document.getElementById('manualLocationInput');
    input.value = 'Paris';

    await popup.handleManualLocationSearch(input);

    const options = document.querySelectorAll('button.selection-option');
    expect(options.length).toBe(2);
    expect(options[0].textContent).toBe('Austin, TX');

    options[0].dispatchEvent(new Event('click'));
    const message = document.querySelector('#manualLocationResults .selection-message').textContent;
    expect(message.includes('Manual location set to')).toBe(true);
  });

  test('a repeat search after the popup is torn down issues no second request', async () => {
    globalThis.fetch = createFetchMock([
      {
        json: { locations: [{ name: 'Naboo City', country: 'NB', lat: 10.5, lon: 20.5 }] }
      }
    ]);

    const firstInput = document.getElementById('manualLocationInput');
    firstInput.value = 'Naboo City';
    await popup.handleManualLocationSearch(firstInput);
    expect(document.querySelectorAll('button.selection-option').length).toBe(1);
    expect(geocodeCallsRecorded()).toBe(1);

    simulatePopupTeardown();

    // empty queue, so any fetch throws
    const fetchMock = createFetchMock([]);
    globalThis.fetch = fetchMock;

    const secondInput = document.getElementById('manualLocationInput');
    secondInput.value = 'naboo city';
    await popup.handleManualLocationSearch(secondInput);

    expect(fetchMock.calls.length).toBe(0);
    const options = document.querySelectorAll('button.selection-option');
    expect(options.length).toBe(1);
    expect(options[0].textContent).toBe('Naboo City, NB');
    // telemetry has to keep reflecting real /geo volume
    expect(geocodeCallsRecorded()).toBe(1);
  });

  test('a search that matched nothing is not repeated after teardown', async () => {
    globalThis.fetch = createFetchMock([{ json: { locations: [] } }]);

    const firstInput = document.getElementById('manualLocationInput');
    firstInput.value = 'Alderaan';
    await popup.handleManualLocationSearch(firstInput);

    simulatePopupTeardown();

    const fetchMock = createFetchMock([]);
    globalThis.fetch = fetchMock;

    const secondInput = document.getElementById('manualLocationInput');
    secondInput.value = 'Alderaan';
    await popup.handleManualLocationSearch(secondInput);

    expect(fetchMock.calls.length).toBe(0);
    expect(geocodeCallsRecorded()).toBe(1);
    const message = document.querySelector('#manualLocationResults .selection-message').textContent;
    expect(message.includes('No matching cities')).toBe(true);
  });

  test('a failed search is not cached and retries on the next attempt', async () => {
    const fetchMock = createFetchMock([
      { ok: false, status: 500, json: {} },
      { json: { locations: [{ name: 'Naboo City', country: 'NB', lat: 10.5, lon: 20.5 }] } }
    ]);
    globalThis.fetch = fetchMock;

    const input = document.getElementById('manualLocationInput');
    input.value = 'Naboo City';
    await popup.handleManualLocationSearch(input);

    const failureMessage = document.querySelector('#manualLocationResults .selection-message').textContent;
    expect(failureMessage.includes('Could not retrieve cities')).toBe(true);

    await popup.handleManualLocationSearch(input);

    expect(fetchMock.calls.length).toBe(2);
    expect(document.querySelectorAll('button.selection-option').length).toBe(1);
  });

  test('renderManualLocationOptions ignores invalid entries', () => {
    popup.renderManualLocationOptions([{ name: 'Nowhere' }]);

    const message = document.querySelector('#manualLocationResults .selection-message').textContent;
    expect(message.includes('No matching cities')).toBe(true);
  });

  test('handleManualLocationClear resets manual location', () => {
    setManualLocation({ name: 'Paris', lat: 48.8566, lon: 2.3522, country: 'FR' });
    popup.handleManualLocationClear();

    const message = document.querySelector('#manualLocationResults .selection-message').textContent;
    expect(message.includes('Using automatic location')).toBe(true);
  });
});

describe('newtab handlers', () => {
  test('requests search and history permissions when search bar enabled', async () => {
    const permissionSpy = createSpy(() => Promise.resolve(true));
    globalThis.chrome = {
      permissions: { request: permissionSpy }
    };

    popup.attachNewtabHandlers();
    const checkbox = document.getElementById('showSearchBar');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    await new Promise((r) => setTimeout(r, 0));

    expect(permissionSpy.calls.length).toBe(1);
    expect(permissionSpy.calls[0][0]).toEqual({ permissions: ['search', 'history'] });
    expect(localStorage.getItem('showSearchBar')).toBe('true');
  });

  test('does not request permission when search bar disabled', async () => {
    const permissionSpy = createSpy(() => Promise.resolve(true));
    globalThis.chrome = {
      permissions: { request: permissionSpy }
    };

    popup.attachNewtabHandlers();
    const checkbox = document.getElementById('showSearchBar');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    await new Promise((r) => setTimeout(r, 0));

    expect(permissionSpy.calls.length).toBe(0);
    expect(localStorage.getItem('showSearchBar')).toBe('false');
  });

  test('reverts checkbox and shows hint when permission request fails', async () => {
    const permissionSpy = createSpy(() => Promise.reject(new Error('denied')));
    globalThis.chrome = {
      permissions: { request: permissionSpy }
    };

    popup.attachNewtabHandlers();
    const checkbox = document.getElementById('showSearchBar');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    await new Promise((r) => setTimeout(r, 0));

    expect(checkbox.checked).toBe(false);
    expect(localStorage.getItem('showSearchBar')).toBeNull();
    const hint = checkbox.closest('label').nextElementSibling;
    expect(hint.classList.contains('permission-hint')).toBe(true);
  });

  test('reverts checkbox when permission request returns false', async () => {
    const permissionSpy = createSpy(() => Promise.resolve(false));
    globalThis.chrome = {
      permissions: { request: permissionSpy }
    };

    popup.attachNewtabHandlers();
    const checkbox = document.getElementById('showSearchBar');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    await new Promise((r) => setTimeout(r, 0));

    expect(checkbox.checked).toBe(false);
    expect(localStorage.getItem('showSearchBar')).toBeNull();
  });

  test('requests topSites permission when shortcuts enabled', async () => {
    const permissionSpy = createSpy(() => Promise.resolve(true));
    globalThis.chrome = {
      permissions: { request: permissionSpy }
    };

    popup.attachNewtabHandlers();
    const checkbox = document.getElementById('showShortcuts');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    await new Promise((r) => setTimeout(r, 0));

    expect(permissionSpy.calls.length).toBe(1);
    expect(permissionSpy.calls[0][0]).toEqual({ permissions: ['topSites'] });
    expect(localStorage.getItem('showShortcuts')).toBe('true');
  });

  test('shortcuts toggle does not request permission when disabled', async () => {
    const permissionSpy = createSpy(() => Promise.resolve(true));
    globalThis.chrome = {
      permissions: { request: permissionSpy }
    };

    popup.attachNewtabHandlers();
    const checkbox = document.getElementById('showShortcuts');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    await new Promise((r) => setTimeout(r, 0));

    expect(permissionSpy.calls.length).toBe(0);
    expect(localStorage.getItem('showShortcuts')).toBe('false');
  });

  test('google apps toggle stores preference', () => {
    popup.attachNewtabHandlers();
    const checkbox = document.getElementById('showGoogleApps');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    expect(localStorage.getItem('showGoogleApps')).toBe('false');

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(localStorage.getItem('showGoogleApps')).toBe('true');
  });
});
