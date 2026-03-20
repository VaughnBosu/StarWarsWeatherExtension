import {
  clearWeatherCache,
  getManualLocation,
  getPreferredLanguage,
  getPreferredUnit,
  getShowExtrasInHyperspace,
  getShowSearchBar,
  getShowShortcuts,
  setManualLocation,
  setPreferredLanguage,
  setPreferredUnit,
  setShowExtrasInHyperspace,
  setShowSearchBar,
  setShowShortcuts
} from './storage.js';
import { loadLocalization, invalidateLocalizationCache } from './i18n.js';
import { stateToAbbreviation } from './geo.js';
import { GEOCODING_DIRECT_ENDPOINT, GEOCODING_RESULT_LIMIT } from './config.js';

let currentLocalization = null;
let manualLocationStatus = null;

const SHOULD_INIT = !(typeof globalThis !== 'undefined' && globalThis.__SWW_SKIP_INIT__ === true);

if (SHOULD_INIT && typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initialize);
}

async function initialize() {
  attachUnitHandlers();
  attachLanguageHandlers();
  attachNewtabHandlers();
  attachManualLocationHandlers();
  await refreshLocalization(getPreferredLanguage());
}

function attachUnitHandlers() {
  const unitRadios = document.querySelectorAll('input[name="temp"]');
  unitRadios.forEach((radio) => {
    radio.addEventListener('change', (event) => {
      const value = event.target.value === 'celsius' ? 'celsius' : 'fahrenheit';
      setPreferredUnit(value);
      clearWeatherCache();
    });
  });
}

function attachLanguageHandlers() {
  const languageRadios = document.querySelectorAll('input[name="lang"]');
  languageRadios.forEach((radio) => {
    radio.addEventListener('change', async (event) => {
      const selected = event.target.value.toLowerCase();
      const language = selected.startsWith('spanish') || selected === 'español' ? 'es' : 'en';
      setPreferredLanguage(language);
      clearWeatherCache();
      invalidateLocalizationCache(language);
      await refreshLocalization(language);
    });
  });
}

async function refreshLocalization(language) {
  currentLocalization = await loadLocalization(language);
  applyTranslations(currentLocalization);
  synchroniseControls();
  populateManualLocationInput();
}

function synchroniseControls() {
  const preferredUnit = getPreferredUnit();
  const preferredLanguage = getPreferredLanguage();

  const fahrenheitRadio = document.querySelector('input[name="temp"][value="fahrenheit"]');
  const celsiusRadio = document.querySelector('input[name="temp"][value="celsius"]');

  if (fahrenheitRadio && celsiusRadio) {
    if (preferredUnit === 'celsius') {
      celsiusRadio.checked = true;
      fahrenheitRadio.checked = false;
    } else {
      celsiusRadio.checked = false;
      fahrenheitRadio.checked = true;
    }
  }

  const englishRadio = document.querySelector('input[name="lang"][value="English"]');
  const spanishRadio = document.querySelector('input[name="lang"][value="Spanish"]');

  if (englishRadio && spanishRadio) {
    if (preferredLanguage === 'es') {
      englishRadio.checked = false;
      spanishRadio.checked = true;
    } else {
      englishRadio.checked = true;
      spanishRadio.checked = false;
    }
  }

  const showSearch = getShowSearchBar();
  const showShortcutsVal = getShowShortcuts();

  const searchBarCheckbox = document.getElementById('showSearchBar');
  const shortcutsCheckbox = document.getElementById('showShortcuts');

  if (searchBarCheckbox) {
    searchBarCheckbox.checked = showSearch;
  }
  if (shortcutsCheckbox) {
    shortcutsCheckbox.checked = showShortcutsVal;
  }

  syncHyperspaceCheckboxUi(showSearch || showShortcutsVal);
}

function syncHyperspaceCheckboxUi(eitherVisible) {
  const extrasInHyperspaceCheckbox = document.getElementById('showExtrasInHyperspace');
  if (!extrasInHyperspaceCheckbox) return;
  extrasInHyperspaceCheckbox.disabled = !eitherVisible;
  extrasInHyperspaceCheckbox.closest('label').style.display = eitherVisible ? '' : 'none';
  if (!eitherVisible) {
    extrasInHyperspaceCheckbox.checked = false;
    setShowExtrasInHyperspace(false);
  } else {
    extrasInHyperspaceCheckbox.checked = getShowExtrasInHyperspace();
  }
}

function attachNewtabHandlers() {
  const searchBarCheckbox = document.getElementById('showSearchBar');
  const shortcutsCheckbox = document.getElementById('showShortcuts');
  const extrasInHyperspaceCheckbox = document.getElementById('showExtrasInHyperspace');

  if (searchBarCheckbox) {
    searchBarCheckbox.addEventListener('change', (event) => {
      setShowSearchBar(event.target.checked);
      syncHyperspaceCheckboxUi(getShowSearchBar() || getShowShortcuts());
      if (event.target.checked && typeof chrome !== 'undefined' && chrome.permissions) {
        chrome.permissions.request({ permissions: ['search', 'history'] }).catch(() => {});
      }
    });
  }

  if (shortcutsCheckbox) {
    shortcutsCheckbox.addEventListener('change', (event) => {
      setShowShortcuts(event.target.checked);
      syncHyperspaceCheckboxUi(getShowSearchBar() || getShowShortcuts());
      if (event.target.checked && typeof chrome !== 'undefined' && chrome.permissions) {
        chrome.permissions.request({ permissions: ['topSites'] }).catch(() => {});
      }
    });
  }

  if (extrasInHyperspaceCheckbox) {
    extrasInHyperspaceCheckbox.addEventListener('change', (event) => {
      setShowExtrasInHyperspace(event.target.checked);
    });
  }
}

function attachManualLocationHandlers() {
  const input = document.getElementById('manualLocationInput');
  const searchButton = document.getElementById('manualLocationSearch');
  const clearButton = document.getElementById('manualLocationClear');

  if (searchButton && input) {
    searchButton.addEventListener('click', () => handleManualLocationSearch(input));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        handleManualLocationSearch(input);
      }
    });
  }

  if (clearButton) {
    clearButton.addEventListener('click', handleManualLocationClear);
  }
}

async function handleManualLocationSearch(input) {
  if (!input) {
    return;
  }

  const query = input.value.trim();
  if (!query) {
    const manualLocation = getManualLocation();
    if (manualLocation) {
      renderManualLocationMessage('selected', manualLocation.displayName || manualLocation.name || '');
    } else {
      renderManualLocationMessage('auto');
    }
    const container = getManualLocationResultsContainer();
    if (container) {
      container.innerHTML = '';
    }
    return;
  }

  renderManualLocationMessage('searching');

  try {
    const results = await fetchManualLocationSuggestions(query);
    renderManualLocationOptions(results);
  } catch (error) {
    console.error('Manual location search failed', error);
    renderManualLocationMessage('error');
  }
}

function handleManualLocationClear() {
  setManualLocation(null);
  clearWeatherCache();
  populateManualLocationInput();
  renderManualLocationMessage('auto');
}

function populateManualLocationInput() {
  const input = document.getElementById('manualLocationInput');
  if (!input) {
    return;
  }

  const manualLocation = getManualLocation();
  if (manualLocation) {
    input.value = manualLocation.displayName || manualLocation.name || '';
    renderManualLocationMessage('selected', manualLocation.displayName || manualLocation.name || '');
  } else {
    input.value = '';
    renderManualLocationMessage('auto');
  }
}

async function fetchManualLocationSuggestions(query) {
  if (typeof API_KEY === 'undefined') {
    throw new Error('API key is not available');
  }

  const url = new URL(GEOCODING_DIRECT_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(GEOCODING_RESULT_LIMIT));
  url.searchParams.set('appid', API_KEY);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Geocoding request failed with status ${response.status}`);
  }

  return response.json();
}

function renderManualLocationOptions(results) {
  const container = getManualLocationResultsContainer();
  if (!container) {
    return;
  }

  container.innerHTML = '';
  manualLocationStatus = null;

  if (!Array.isArray(results) || results.length === 0) {
    renderManualLocationMessage('no_results');
    return;
  }

  results.forEach((result, index) => {
    if (typeof result.lat !== 'number' || typeof result.lon !== 'number') {
      return;
    }

    const displayName = formatManualLocationDisplay(result);
    if (!displayName) {
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'selection-option';
    button.setAttribute('role', 'option');
    button.setAttribute('data-index', String(index));
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
      populateManualLocationInput();
      renderManualLocationMessage('selected', displayName);
    });

    container.appendChild(button);
  });

  if (!container.childElementCount) {
    renderManualLocationMessage('no_results');
  }
}

function getManualLocationResultsContainer() {
  return document.getElementById('manualLocationResults');
}

function applyTranslations(localization) {
  if (!localization) {
    return;
  }

  document.querySelectorAll('[data-i18n]').forEach((element) => {
    const key = element.getAttribute('data-i18n');
    if (!key) {
      return;
    }

    element.innerText = localization.getMessage(key) || '';
  });

  document.querySelectorAll('[data-i18n-html]').forEach((element) => {
    const key = element.getAttribute('data-i18n-html');
    if (!key) {
      return;
    }

    element.innerHTML = localization.getMessage(key) || '';
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
    const key = element.getAttribute('data-i18n-placeholder');
    if (!key) {
      return;
    }

    const message = localization.getMessage(key) || '';
    element.setAttribute('placeholder', message);
  });

  if (manualLocationStatus) {
    renderManualLocationMessage(manualLocationStatus.type, manualLocationStatus.value);
  }
}

function renderManualLocationMessage(type, value) {
  const container = getManualLocationResultsContainer();
  if (!container) {
    return;
  }

  if (type !== 'none') {
    manualLocationStatus = { type, value };
  } else {
    manualLocationStatus = null;
  }

  if (type === 'none') {
    container.innerHTML = '';
    return;
  }

  const messageText = getManualLocationStatusText(type, value);
  container.innerHTML = '';

  if (!messageText) {
    return;
  }

  const messageElement = document.createElement('p');
  messageElement.className = 'selection-message';
  messageElement.textContent = messageText;
  container.appendChild(messageElement);
}

function getManualLocationStatusText(type, value) {
  const localization = currentLocalization;

  switch (type) {
    case 'searching':
      return localization?.getMessage('popup_manual_location_searching') || 'Searching...';
    case 'no_results':
      return localization?.getMessage('popup_manual_location_no_results') || 'No matching cities found.';
    case 'error':
      return localization?.getMessage('popup_manual_location_error') || 'Could not retrieve cities. Please try again.';
    case 'selected': {
      const name = value || '';
      return localization?.getMessage('popup_manual_location_selected', [name]) || `Manual location set to ${name}.`;
    }
    case 'auto':
      return localization?.getMessage('popup_manual_location_auto') || 'Using automatic location.';
    case 'none':
    default:
      return '';
  }
}

function formatManualLocationDisplay(result) {
  const name = (result.name ?? '').trim();
  const state = (result.state ?? '').trim();
  const country = (result.country ?? '').trim();

  if (!name) {
    return ''; 
  }

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

export {
  applyTranslations,
  attachLanguageHandlers,
  attachManualLocationHandlers,
  attachNewtabHandlers,
  attachUnitHandlers,
  fetchManualLocationSuggestions,
  formatManualLocationDisplay,
  getManualLocationResultsContainer,
  getManualLocationStatusText,
  handleManualLocationClear,
  handleManualLocationSearch,
  initialize,
  populateManualLocationInput,
  refreshLocalization,
  renderManualLocationMessage,
  renderManualLocationOptions,
  stateToAbbreviation,
  syncHyperspaceCheckboxUi,
  synchroniseControls
};
