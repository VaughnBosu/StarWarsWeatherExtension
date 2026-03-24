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

let onboarding = null;

const realFetch = globalThis.fetch;
const realBrowser = globalThis.browser;
const realChrome = globalThis.chrome;
const realNavigator = globalThis.navigator;
const realApiKey = globalThis.API_KEY;

const ONBOARDING_DOM = `
  <div class="step-indicator">
    <span class="dot dot--active" data-dot="1"></span>
    <span class="dot" data-dot="2"></span>
    <span class="dot" data-dot="3"></span>
    <span class="dot" data-dot="4"></span>
  </div>
  <section class="onboarding-step step--active" data-step="1">
    <h1 data-i18n="onboarding_welcome_title"></h1>
    <p data-i18n="onboarding_welcome_subtitle"></p>
    <label class="radio-option"><input type="radio" name="onboarding-lang" value="en" checked><span data-i18n="language_english_label"></span></label>
    <label class="radio-option"><input type="radio" name="onboarding-lang" value="es"><span data-i18n="language_spanish_label"></span></label>
    <button id="startSetup" data-i18n="onboarding_welcome_cta"></button>
  </section>
  <section class="onboarding-step" data-step="2">
    <h2 data-i18n="onboarding_location_title"></h2>
    <div class="location-choices" id="locationChoices">
      <button id="chooseAutoLocation"></button>
      <button id="chooseManualLocation"></button>
    </div>
    <div class="auto-location-status hidden" id="autoLocationStatus">
      <div class="spinner" id="autoSpinner"></div>
      <p class="status-message" id="autoLocationMessage"></p>
      <div class="status-actions hidden" id="autoLocationActions"></div>
      <div class="troubleshoot hidden" id="troubleshoot">
        <button class="troubleshoot__toggle" id="troubleshootToggle"></button>
        <div class="troubleshoot__content"></div>
      </div>
      <button class="hidden" id="autoBackToChoices"></button>
    </div>
    <div class="manual-search hidden" id="manualSearchArea">
      <div class="manual-search__input-row">
        <input type="text" id="manualLocationInput" class="text-input" data-i18n-placeholder="onboarding_manual_search_placeholder">
        <button id="manualSearchBtn"></button>
      </div>
      <div id="manualSearchResults" class="selection-list" role="listbox"></div>
      <button id="manualBackToChoices"></button>
    </div>
  </section>
  <section class="onboarding-step" data-step="3">
    <label class="radio-option"><input type="radio" name="onboarding-unit" value="fahrenheit" checked><span></span></label>
    <label class="radio-option"><input type="radio" name="onboarding-unit" value="celsius"><span></span></label>
    <div class="preference-group" id="searchBarGroup">
      <label class="checkbox-row"><input type="checkbox" id="onboardingSearchBar"></label>
    </div>
    <div class="preference-group" id="shortcutsGroup">
      <label class="checkbox-row"><input type="checkbox" id="onboardingShortcuts"></label>
    </div>
    <button id="prefsNext"></button>
  </section>
  <section class="onboarding-step" data-step="4">
    <div class="summary" id="summary"></div>
    <button id="openNewTab"></button>
  </section>
`;

beforeAll(async () => {
  onboarding = await import('../onboarding.js');
});

beforeEach(() => {
  invalidateLocalizationCache();
  installStorageMock();
  installDom(ONBOARDING_DOM);
  installNavigator(globalThis.window, { language: 'en-US' });
  globalThis.browser = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`
    }
  };
  delete globalThis.chrome;
  globalThis.API_KEY = 'test-key';
});

afterEach(() => {
  teardownDom();
  invalidateLocalizationCache();
  delete globalThis.localStorage;
  if (realFetch) globalThis.fetch = realFetch; else delete globalThis.fetch;
  if (realBrowser) globalThis.browser = realBrowser; else delete globalThis.browser;
  if (realChrome) globalThis.chrome = realChrome; else delete globalThis.chrome;
  if (realNavigator) globalThis.navigator = realNavigator; else delete globalThis.navigator;
  if (realApiKey) globalThis.API_KEY = realApiKey; else delete globalThis.API_KEY;
});

describe('step navigation', () => {
  test('showStep activates the correct step and dots', () => {
    onboarding.showStep(2);
    const step1 = document.querySelector('[data-step="1"]');
    const step2 = document.querySelector('[data-step="2"]');
    expect(step1.classList.contains('step--active')).toBe(false);
    expect(step2.classList.contains('step--active')).toBe(true);

    const dot1 = document.querySelector('[data-dot="1"]');
    const dot2 = document.querySelector('[data-dot="2"]');
    const dot3 = document.querySelector('[data-dot="3"]');
    expect(dot1.classList.contains('dot--active')).toBe(true);
    expect(dot2.classList.contains('dot--active')).toBe(true);
    expect(dot3.classList.contains('dot--active')).toBe(false);
  });

  test('showStep 4 activates all dots', () => {
    onboarding.showStep(4);
    const dots = document.querySelectorAll('.dot');
    dots.forEach((dot) => {
      expect(dot.classList.contains('dot--active')).toBe(true);
    });
  });
});

describe('translations', () => {
  test('applyTranslations fills text and placeholders', () => {
    const localization = createLocalizationMock({
      onboarding_welcome_title: { message: 'Welcome!' },
      onboarding_manual_search_placeholder: { message: 'City' }
    });

    onboarding.applyTranslations(localization);

    expect(document.querySelector('[data-i18n="onboarding_welcome_title"]').textContent).toBe('Welcome!');
    expect(document.querySelector('[data-i18n-placeholder="onboarding_manual_search_placeholder"]').getAttribute('placeholder')).toBe('City');
  });
});

describe('language selection', () => {
  test('syncLanguageRadio selects the correct radio', () => {
    onboarding.syncLanguageRadio('es');
    const en = document.querySelector('input[name="onboarding-lang"][value="en"]');
    const es = document.querySelector('input[name="onboarding-lang"][value="es"]');
    expect(en.checked).toBe(false);
    expect(es.checked).toBe(true);
  });
});

describe('location step', () => {
  test('showManualSearch hides choices and shows manual area', () => {
    onboarding.showManualSearch();
    expect(document.getElementById('locationChoices').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('manualSearchArea').classList.contains('hidden')).toBe(false);
  });

  test('resetLocationStep restores choices', () => {
    onboarding.showManualSearch();
    onboarding.resetLocationStep();
    expect(document.getElementById('locationChoices').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('manualSearchArea').classList.contains('hidden')).toBe(true);
  });

  test('handleManualSearch renders results', async () => {
    globalThis.fetch = createFetchMock([
      {
        json: [
          { name: 'Austin', state: 'Texas', country: 'US', lat: 30.27, lon: -97.74 },
          { name: 'Paris', country: 'FR', lat: 48.86, lon: 2.35 }
        ]
      }
    ]);

    await onboarding.handleManualSearch('Austin');

    const options = document.querySelectorAll('#manualSearchResults .selection-option');
    expect(options.length).toBe(2);
    expect(options[0].textContent).toBe('Austin, TX');
    expect(options[1].textContent).toBe('Paris, FR');
  });

  test('handleManualSearch shows no results message', async () => {
    globalThis.fetch = createFetchMock([{ json: [] }]);

    await onboarding.handleManualSearch('Nowhere');

    const message = document.querySelector('#manualSearchResults .selection-message');
    expect(message.textContent).toContain('No matching cities');
  });

  test('selecting a manual result stores location', async () => {
    globalThis.fetch = createFetchMock([
      { json: [{ name: 'Tokyo', country: 'JP', lat: 35.68, lon: 139.69 }] }
    ]);

    await onboarding.handleManualSearch('Tokyo');

    const option = document.querySelector('#manualSearchResults .selection-option');
    option.dispatchEvent(new Event('click'));

    const stored = JSON.parse(localStorage.getItem('manualLocation'));
    expect(stored.name).toBe('Tokyo');
    expect(stored.country).toBe('JP');
  });
});

describe('format location display', () => {
  test('formats US locations with state abbreviation', () => {
    expect(onboarding.formatLocationDisplay({ name: 'Austin', state: 'Texas', country: 'US' })).toBe('Austin, TX');
  });

  test('formats non-US locations with country', () => {
    expect(onboarding.formatLocationDisplay({ name: 'Paris', country: 'FR' })).toBe('Paris, FR');
  });

  test('returns empty for missing name', () => {
    expect(onboarding.formatLocationDisplay({ country: 'US' })).toBe('');
  });
});

describe('preferences', () => {
  test('unit radio change stores preference', () => {
    onboarding.attachEventListeners();
    const celsius = document.querySelector('input[name="onboarding-unit"][value="celsius"]');
    celsius.checked = true;
    celsius.dispatchEvent(new Event('change'));

    expect(localStorage.getItem('unit')).toBe('celsius');
  });

  test('search bar toggle requests permissions and reverts on denial', async () => {
    const permissionSpy = createSpy(() => Promise.resolve(false));
    globalThis.chrome = { permissions: { request: permissionSpy } };

    onboarding.attachEventListeners();
    const checkbox = document.getElementById('onboardingSearchBar');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    await new Promise((r) => setTimeout(r, 0));

    expect(checkbox.checked).toBe(false);
    expect(localStorage.getItem('showSearchBar')).toBeNull();
    const hint = document.querySelector('#searchBarGroup .permission-hint');
    expect(hint).not.toBeNull();
  });

  test('shortcuts toggle requests permissions and reverts on error', async () => {
    const permissionSpy = createSpy(() => Promise.reject(new Error('denied')));
    globalThis.chrome = { permissions: { request: permissionSpy } };

    onboarding.attachEventListeners();
    const checkbox = document.getElementById('onboardingShortcuts');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    await new Promise((r) => setTimeout(r, 0));

    expect(checkbox.checked).toBe(false);
    expect(localStorage.getItem('showShortcuts')).toBeNull();
    const hint = document.querySelector('#shortcutsGroup .permission-hint');
    expect(hint).not.toBeNull();
  });

  test('search bar toggle stores true when permissions granted', async () => {
    const permissionSpy = createSpy(() => Promise.resolve(true));
    globalThis.chrome = { permissions: { request: permissionSpy } };

    onboarding.attachEventListeners();
    const checkbox = document.getElementById('onboardingSearchBar');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    await new Promise((r) => setTimeout(r, 0));

    expect(checkbox.checked).toBe(true);
    expect(localStorage.getItem('showSearchBar')).toBe('true');
  });
});

describe('onboarding completion', () => {
  test('prefsNext marks onboarding complete and advances to step 4', () => {
    onboarding.attachEventListeners();
    const btn = document.getElementById('prefsNext');
    btn.dispatchEvent(new Event('click'));

    expect(localStorage.getItem('onboardingComplete')).toBe('true');
    expect(document.querySelector('[data-step="4"]').classList.contains('step--active')).toBe(true);
  });
});

describe('summary', () => {
  test('renders auto location summary', () => {
    onboarding.renderSummary();
    const items = document.querySelectorAll('#summary .summary__item');
    expect(items.length).toBe(4);
    expect(items[0].textContent).toContain('current location');
  });

  test('renders manual location summary', () => {
    setManualLocation({ name: 'Tokyo', country: 'JP', lat: 35.68, lon: 139.69, displayName: 'Tokyo, JP' });
    onboarding.renderSummary();
    const items = document.querySelectorAll('#summary .summary__item');
    expect(items[0].textContent).toContain('Tokyo');
  });
});

describe('troubleshoot toggle', () => {
  test('toggles troubleshoot section open and closed', () => {
    onboarding.attachEventListeners();
    const container = document.getElementById('troubleshoot');
    const toggle = document.getElementById('troubleshootToggle');

    toggle.dispatchEvent(new Event('click'));
    expect(container.classList.contains('troubleshoot--open')).toBe(true);

    toggle.dispatchEvent(new Event('click'));
    expect(container.classList.contains('troubleshoot--open')).toBe(false);
  });
});
