import {
  clearWeatherCache,
  getManualLocation,
  getPreferredLanguage,
  getPreferredUnit,
  getShowGoogleApps,
  getShowSearchBar,
  getShowShortcuts,
  isOnboardingComplete,
  markOnboardingComplete,
  readGeocodeQueryCache,
  setManualLocation,
  setPreferredLanguage,
  setPreferredUnit,
  setShowGoogleApps,
  setShowSearchBar,
  setShowShortcuts,
  writeGeocodeQueryCache
} from './storage.js';
import { loadLocalization, invalidateLocalizationCache } from './i18n.js';
import { stateToAbbreviation } from './geo.js';
import { GEOLOCATION_OPTIONS } from './config.js';
import { searchLocations } from './backend-client.js';
import { fetchLocationDetails } from './location-details.js';
import { recordGeocodeCall, track } from './telemetry.js';

let currentLocalization = null;
let locationMode = null; // 'auto' or 'manual'
let locationDisplayName = '';
let geolocating = false;
let onboardingStartedAt = 0;

const SHOULD_INIT = !(typeof globalThis !== 'undefined' && globalThis.__SWW_SKIP_INIT__ === true);

if (SHOULD_INIT && typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initialize);
}

async function initialize() {
  onboardingStartedAt = Date.now();
  const language = getPreferredLanguage();
  currentLocalization = await loadLocalization(language);
  applyTranslations(currentLocalization);
  syncLanguageRadio(language);

  if (isOnboardingComplete()) {
    renderSummary();
    showStep(4);
  }

  attachEventListeners();
}

function showStep(n) {
  document.querySelectorAll('.onboarding-step').forEach((step) => {
    step.classList.remove('step--active');
  });
  const target = document.querySelector(`[data-step="${n}"]`);
  if (target) {
    target.classList.add('step--active');
  }

  document.querySelectorAll('.dot').forEach((dot) => {
    const dotStep = Number(dot.getAttribute('data-dot'));
    dot.classList.toggle('dot--active', dotStep <= n);
  });
}

function applyTranslations(localization) {
  if (!localization) return;

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) {
      el.textContent = localization.getMessage(key) || '';
    }
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) {
      el.setAttribute('placeholder', localization.getMessage(key) || '');
    }
  });

  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    if (key) {
      el.innerHTML = localization.getMessage(key) || '';
    }
  });
}

function syncLanguageRadio(language) {
  const radios = document.querySelectorAll('input[name="onboarding-lang"]');
  radios.forEach((radio) => {
    radio.checked = radio.value === language;
  });
}

function attachEventListeners() {
  document.querySelectorAll('input[name="onboarding-lang"]').forEach((radio) => {
    radio.addEventListener('change', (e) => handleLanguageChange(e.target.value));
  });

  const startBtn = document.getElementById('startSetup');
  if (startBtn) {
    startBtn.addEventListener('click', () => showStep(2));
  }

  const autoBtn = document.getElementById('chooseAutoLocation');
  if (autoBtn) {
    autoBtn.addEventListener('click', handleAutoLocation);
  }

  const manualBtn = document.getElementById('chooseManualLocation');
  if (manualBtn) {
    manualBtn.addEventListener('click', showManualSearch);
  }

  const searchBtn = document.getElementById('manualSearchBtn');
  const searchInput = document.getElementById('manualLocationInput');
  if (searchBtn && searchInput) {
    searchBtn.addEventListener('click', () => handleManualSearch(searchInput.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleManualSearch(searchInput.value);
      }
    });
  }

  const autoBack = document.getElementById('autoBackToChoices');
  if (autoBack) {
    autoBack.addEventListener('click', resetLocationStep);
  }
  const manualBack = document.getElementById('manualBackToChoices');
  if (manualBack) {
    manualBack.addEventListener('click', resetLocationStep);
  }

  const troubleshootToggle = document.getElementById('troubleshootToggle');
  if (troubleshootToggle) {
    troubleshootToggle.addEventListener('click', () => {
      const container = document.getElementById('troubleshoot');
      if (container) {
        container.classList.toggle('troubleshoot--open');
      }
    });
  }

  document.querySelectorAll('input[name="onboarding-unit"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      setPreferredUnit(e.target.value);
      clearWeatherCache();
      track('setting_changed', { setting: 'unit', value: e.target.value, surface: 'onboarding' });
    });
  });

  const searchBarCheckbox = document.getElementById('onboardingSearchBar');
  if (searchBarCheckbox) {
    searchBarCheckbox.addEventListener('change', (e) => handleSearchBarToggle(e.target));
  }

  const shortcutsCheckbox = document.getElementById('onboardingShortcuts');
  if (shortcutsCheckbox) {
    shortcutsCheckbox.addEventListener('change', (e) => handleShortcutsToggle(e.target));
  }

  const googleAppsCheckbox = document.getElementById('onboardingGoogleApps');
  if (googleAppsCheckbox) {
    googleAppsCheckbox.checked = getShowGoogleApps();
    googleAppsCheckbox.addEventListener('change', (e) => handleGoogleAppsToggle(e.target));
  }

  const prefsNext = document.getElementById('prefsNext');
  if (prefsNext) {
    prefsNext.addEventListener('click', () => {
      markOnboardingComplete();
      // Pairs with the SDK's __install for the activation funnel; settings show which defaults stick.
      track('onboarding_completed', {
        durationMs: onboardingStartedAt ? Date.now() - onboardingStartedAt : 0,
        unit: getPreferredUnit(),
        language: getPreferredLanguage(),
        searchBar: getShowSearchBar(),
        shortcuts: getShowShortcuts(),
        googleApps: getShowGoogleApps()
      });
      renderSummary();
      showStep(4);
    });
  }

  const openTab = document.getElementById('openNewTab');
  if (openTab) {
    openTab.addEventListener('click', () => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        window.location.href = chrome.runtime.getURL('public/index.html');
      }
    });
  }
}

async function handleLanguageChange(lang) {
  setPreferredLanguage(lang);
  track('setting_changed', { setting: 'language', value: lang, surface: 'onboarding' });
  invalidateLocalizationCache(lang);
  currentLocalization = await loadLocalization(lang);
  applyTranslations(currentLocalization);
}

function handleAutoLocation() {
  if (geolocating) return;
  geolocating = true;

  const choices = document.getElementById('locationChoices');
  const status = document.getElementById('autoLocationStatus');
  const spinner = document.getElementById('autoSpinner');
  const message = document.getElementById('autoLocationMessage');
  const actions = document.getElementById('autoLocationActions');
  const backBtn = document.getElementById('autoBackToChoices');

  if (choices) choices.classList.add('hidden');
  if (status) status.classList.remove('hidden');
  if (spinner) spinner.classList.remove('hidden');
  if (actions) actions.classList.add('hidden');
  if (backBtn) backBtn.classList.remove('hidden');

  const troubleshoot = document.getElementById('troubleshoot');
  if (troubleshoot) troubleshoot.classList.add('hidden');

  if (message) {
    message.textContent = currentLocalization?.getMessage('onboarding_auto_detecting') || 'Detecting your location...';
    message.className = 'status-message';
  }

  if (!('geolocation' in navigator)) {
    geolocating = false;
    showAutoError();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      geolocating = false;
      if (spinner) spinner.classList.add('hidden');

      const { latitude, longitude } = position.coords;
      let cityName = '';

      try {
        cityName = await reverseGeocode(latitude, longitude);
      } catch {
        // location is usable without a city name
      }

      locationMode = 'auto';
      locationDisplayName = cityName;
      setManualLocation(null);
      clearWeatherCache();

      const successText = currentLocalization?.getMessage('onboarding_auto_success', [cityName]) || `Location found: ${cityName}`;
      if (message) {
        message.textContent = successText;
        message.className = 'status-message status-message--success';
      }

      if (actions) {
        actions.innerHTML = '';
        actions.classList.remove('hidden');
        const continueBtn = document.createElement('button');
        continueBtn.type = 'button';
        continueBtn.className = 'onboarding__btn onboarding__btn--primary';
        continueBtn.textContent = currentLocalization?.getMessage('onboarding_prefs_continue') || 'Continue';
        continueBtn.addEventListener('click', () => showStep(3));
        actions.appendChild(continueBtn);
      }
    },
    () => {
      geolocating = false;
      showAutoError();
    },
    GEOLOCATION_OPTIONS
  );
}

function showAutoError() {
  const spinner = document.getElementById('autoSpinner');
  const message = document.getElementById('autoLocationMessage');
  const actions = document.getElementById('autoLocationActions');
  const troubleshoot = document.getElementById('troubleshoot');

  if (spinner) spinner.classList.add('hidden');

  if (message) {
    message.textContent = currentLocalization?.getMessage('onboarding_auto_error') || "We couldn't access your location.";
    message.className = 'status-message status-message--error';
  }

  if (troubleshoot) troubleshoot.classList.remove('hidden');

  if (actions) {
    actions.innerHTML = '';
    actions.classList.remove('hidden');

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'onboarding__btn';
    retryBtn.textContent = currentLocalization?.getMessage('onboarding_auto_retry') || 'Try Again';
    retryBtn.addEventListener('click', handleAutoLocation);

    const switchBtn = document.createElement('button');
    switchBtn.type = 'button';
    switchBtn.className = 'onboarding__btn--link';
    switchBtn.textContent = currentLocalization?.getMessage('onboarding_auto_switch_manual') || 'Choose a city instead';
    switchBtn.addEventListener('click', () => {
      const status = document.getElementById('autoLocationStatus');
      if (status) status.classList.add('hidden');
      showManualSearch();
    });

    actions.appendChild(retryBtn);
    actions.appendChild(switchBtn);
  }
}

async function reverseGeocode(lat, lon) {
  let details;
  try {
    details = await fetchLocationDetails(lat, lon);
  } catch {
    return '';
  }
  return details ? formatLocationDisplay(details) : '';
}

function showManualSearch() {
  const choices = document.getElementById('locationChoices');
  const manual = document.getElementById('manualSearchArea');
  if (choices) choices.classList.add('hidden');
  if (manual) manual.classList.remove('hidden');

  const input = document.getElementById('manualLocationInput');
  if (input) input.focus();
}

async function handleManualSearch(query) {
  const trimmed = (query || '').trim();
  if (!trimmed) return;

  const results = document.getElementById('manualSearchResults');
  if (results) {
    results.innerHTML = '';
    const searching = document.createElement('p');
    searching.className = 'selection-message';
    searching.textContent = currentLocalization?.getMessage('onboarding_manual_searching') || 'Searching...';
    results.appendChild(searching);
  }

  try {
    const suggestions = await fetchGeocodingSuggestions(trimmed);
    renderManualResults(suggestions);
  } catch {
    if (results) {
      results.innerHTML = '';
      const errorMsg = document.createElement('p');
      errorMsg.className = 'selection-message';
      errorMsg.textContent = currentLocalization?.getMessage('onboarding_manual_error') || 'Could not search for cities.';
      results.appendChild(errorMsg);
    }
  }
}

/**
 * Own query-keyed store (shared with the settings popup) because the cache above
 * is keyed by coordinates, which a city-name search lacks until it returns.
 */
async function fetchGeocodingSuggestions(query) {
  const cached = readGeocodeQueryCache(query);
  if (cached) {
    // an empty stored entry is a remembered "no such city", so don't re-request it
    return cached.results;
  }

  recordGeocodeCall();
  const results = await searchLocations(query);
  // Cache empty lists too (shorter negative TTL) so a typo doesn't re-request on every retry.
  writeGeocodeQueryCache(query, results);
  return results;
}

function renderManualResults(results) {
  const container = document.getElementById('manualSearchResults');
  if (!container) return;

  container.innerHTML = '';

  if (!Array.isArray(results) || results.length === 0) {
    const noResults = document.createElement('p');
    noResults.className = 'selection-message';
    noResults.textContent = currentLocalization?.getMessage('onboarding_manual_no_results') || 'No matching cities found.';
    container.appendChild(noResults);
    return;
  }

  results.forEach((result) => {
    if (typeof result.lat !== 'number' || typeof result.lon !== 'number') return;

    const displayName = formatLocationDisplay(result);
    if (!displayName) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'selection-option';
    button.setAttribute('role', 'option');
    button.textContent = displayName;
    button.addEventListener('click', () => {
      setManualLocation({
        name: result.name ?? '',
        state: result.state ?? '',
        country: result.country ?? '',
        lat: Number(result.lat),
        lon: Number(result.lon),
        displayName
      });
      clearWeatherCache();
      locationMode = 'manual';
      locationDisplayName = displayName;
      showStep(3);
    });

    container.appendChild(button);
  });

  if (!container.childElementCount) {
    const noResults = document.createElement('p');
    noResults.className = 'selection-message';
    noResults.textContent = currentLocalization?.getMessage('onboarding_manual_no_results') || 'No matching cities found.';
    container.appendChild(noResults);
  }
}

function formatLocationDisplay(result) {
  const name = (result.name ?? '').trim();
  const state = (result.state ?? '').trim();
  const country = (result.country ?? '').trim();

  if (!name) return '';

  const parts = [name];

  if (country.toUpperCase() === 'US') {
    if (state) {
      parts.push(stateToAbbreviation(state));
    }
  } else {
    if (state && state.toLowerCase() !== name.toLowerCase()) {
      parts.push(state);
    }
    if (country) {
      parts.push(country);
    }
  }

  return parts.join(', ');
}

function resetLocationStep() {
  const choices = document.getElementById('locationChoices');
  const autoStatus = document.getElementById('autoLocationStatus');
  const manual = document.getElementById('manualSearchArea');

  if (choices) choices.classList.remove('hidden');
  if (autoStatus) autoStatus.classList.add('hidden');
  if (manual) manual.classList.add('hidden');

  const results = document.getElementById('manualSearchResults');
  if (results) results.innerHTML = '';
}

async function handleSearchBarToggle(checkbox) {
  clearPermissionHint(checkbox);

  if (checkbox.checked && typeof chrome !== 'undefined' && chrome.permissions) {
    try {
      const granted = await chrome.permissions.request({ permissions: ['search', 'history'] });
      if (!granted) {
        checkbox.checked = false;
        showPermissionHint(checkbox);
        return;
      }
    } catch {
      checkbox.checked = false;
      showPermissionHint(checkbox);
      return;
    }
  }
  setShowSearchBar(checkbox.checked);
  track('setting_changed', { setting: 'searchBar', enabled: checkbox.checked, surface: 'onboarding' });
}

async function handleShortcutsToggle(checkbox) {
  clearPermissionHint(checkbox);

  if (checkbox.checked && typeof chrome !== 'undefined' && chrome.permissions) {
    try {
      const granted = await chrome.permissions.request({ permissions: ['topSites'] });
      if (!granted) {
        checkbox.checked = false;
        showPermissionHint(checkbox);
        return;
      }
    } catch {
      checkbox.checked = false;
      showPermissionHint(checkbox);
      return;
    }
  }
  setShowShortcuts(checkbox.checked);
  track('setting_changed', { setting: 'shortcuts', enabled: checkbox.checked, surface: 'onboarding' });
}

function handleGoogleAppsToggle(checkbox) {
  setShowGoogleApps(checkbox.checked);
  track('setting_changed', { setting: 'googleApps', enabled: checkbox.checked, surface: 'onboarding' });
}

function showPermissionHint(checkbox) {
  const group = checkbox.closest('.preference-group');
  if (!group) return;
  clearPermissionHint(checkbox);
  const hint = document.createElement('p');
  hint.className = 'permission-hint';
  hint.textContent = currentLocalization?.getMessage('onboarding_permission_denied') || 'Permission required. Toggle this on again to re-request.';
  group.appendChild(hint);
}

function clearPermissionHint(checkbox) {
  const group = checkbox.closest('.preference-group');
  if (!group) return;
  const existing = group.querySelector('.permission-hint');
  if (existing) existing.remove();
}

function renderSummary() {
  const container = document.getElementById('summary');
  if (!container) return;

  container.innerHTML = '';

  const manualLoc = getManualLocation();
  let locationText;
  if (manualLoc) {
    locationText = currentLocalization?.getMessage('onboarding_done_location_manual', [manualLoc.displayName || manualLoc.name]) ||
      `Showing weather for ${manualLoc.displayName || manualLoc.name}`;
  } else if (locationMode === 'auto' && locationDisplayName) {
    const autoText = currentLocalization?.getMessage('onboarding_done_location_auto') || 'Using your current location';
    locationText = `${autoText} (${locationDisplayName})`;
  } else {
    locationText = currentLocalization?.getMessage('onboarding_done_location_auto') || 'Using your current location';
  }
  addSummaryItem(container, locationText);

  const unit = getPreferredUnit();
  const unitLabel = unit === 'celsius'
    ? (currentLocalization?.getMessage('units_celsius_label') || 'Celsius')
    : (currentLocalization?.getMessage('units_fahrenheit_label') || 'Fahrenheit');
  const unitsText = currentLocalization?.getMessage('onboarding_done_units', [unitLabel]) || `Units: ${unitLabel}`;
  addSummaryItem(container, unitsText);

  const searchOn = getShowSearchBar();
  const searchKey = searchOn ? 'onboarding_done_search_on' : 'onboarding_done_search_off';
  const searchText = currentLocalization?.getMessage(searchKey) || (searchOn ? 'Search bar: On' : 'Search bar: Off');
  addSummaryItem(container, searchText);

  const shortcutsOn = getShowShortcuts();
  const shortcutsKey = shortcutsOn ? 'onboarding_done_shortcuts_on' : 'onboarding_done_shortcuts_off';
  const shortcutsText = currentLocalization?.getMessage(shortcutsKey) || (shortcutsOn ? 'Shortcuts: On' : 'Shortcuts: Off');
  addSummaryItem(container, shortcutsText);

  const googleAppsOn = getShowGoogleApps();
  const googleAppsKey = googleAppsOn ? 'onboarding_done_google_apps_on' : 'onboarding_done_google_apps_off';
  const googleAppsText = currentLocalization?.getMessage(googleAppsKey) || (googleAppsOn ? 'Google apps: On' : 'Google apps: Off');
  addSummaryItem(container, googleAppsText);
}

function addSummaryItem(container, text) {
  const p = document.createElement('p');
  p.className = 'summary__item';
  p.textContent = text;
  container.appendChild(p);
}

// exported for tests

export {
  addSummaryItem,
  applyTranslations,
  attachEventListeners,
  clearPermissionHint,
  fetchGeocodingSuggestions,
  formatLocationDisplay,
  handleAutoLocation,
  handleLanguageChange,
  handleManualSearch,
  handleGoogleAppsToggle,
  handleSearchBarToggle,
  handleShortcutsToggle,
  initialize,
  renderManualResults,
  renderSummary,
  resetLocationStep,
  reverseGeocode,
  showAutoError,
  showManualSearch,
  showPermissionHint,
  showStep,
  syncLanguageRadio
};
