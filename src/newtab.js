import { getPreferredLanguage, getShowSearchBar, getShowShortcuts, getShowExtrasInHyperspace, STORAGE_KEYS } from './storage.js';
import { loadLocalization } from './i18n.js';
import { MAX_SHORTCUTS, FAVICON_SIZE } from './config.js';

const SHOULD_INIT = !(typeof globalThis !== 'undefined' && globalThis.__SWW_SKIP_INIT__ === true);

export function getFaviconUrl(siteUrl, size = FAVICON_SIZE) {
  try {
    const { hostname } = new URL(siteUrl);
    return `https://www.google.com/s2/favicons?sz=${size}&domain_url=${encodeURIComponent(hostname)}`;
  } catch {
    return '';
  }
}

export function getShortcutLabel(site) {
  if (site.title && site.title.trim()) {
    const label = site.title.trim();
    return label.length > 12 ? label.slice(0, 12) : label;
  }

  try {
    const { hostname } = new URL(site.url);
    return hostname.replace(/^www\./, '');
  } catch {
    return site.url || '';
  }
}

export function getInitial(site) {
  if (site.title && site.title.trim()) {
    return site.title.trim()[0].toUpperCase();
  }

  try {
    const { hostname } = new URL(site.url);
    const name = hostname.replace(/^www\./, '');
    return name[0] ? name[0].toUpperCase() : '?';
  } catch {
    return '?';
  }
}

export function renderShortcuts(sites, container) {
  if (!container || !Array.isArray(sites)) {
    return;
  }

  container.innerHTML = '';
  const limited = sites.slice(0, MAX_SHORTCUTS);

  for (const site of limited) {
    if (!site.url) continue;

    const tile = document.createElement('a');
    tile.href = site.url;
    tile.className = 'shortcut-tile';
    tile.title = site.title || site.url;

    const iconWrapper = document.createElement('div');
    iconWrapper.className = 'shortcut-icon';

    const faviconUrl = getFaviconUrl(site.url);
    if (faviconUrl) {
      const img = document.createElement('img');
      img.src = faviconUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        img.remove();
        const initial = document.createElement('span');
        initial.className = 'shortcut-initial';
        initial.textContent = getInitial(site);
        iconWrapper.appendChild(initial);
      });
      iconWrapper.appendChild(img);
    } else {
      const initial = document.createElement('span');
      initial.className = 'shortcut-initial';
      initial.textContent = getInitial(site);
      iconWrapper.appendChild(initial);
    }

    const label = document.createElement('span');
    label.className = 'shortcut-label';
    label.textContent = getShortcutLabel(site);

    tile.appendChild(iconWrapper);
    tile.appendChild(label);
    container.appendChild(tile);
  }
}

export function applySearchPlaceholder(input, localization) {
  if (!input || !localization) {
    return;
  }

  const placeholder = localization.getMessage('search_placeholder');
  if (placeholder) {
    input.placeholder = placeholder;
  }
}

export function applyHyperspaceHidden(newtabExtras, background) {
  if (!newtabExtras) {
    return;
  }

  if (getShowExtrasInHyperspace()) {
    newtabExtras.classList.remove('hyperspace-hidden');
    return;
  }

  if (background && background.classList.contains('hyperspace')) {
    newtabExtras.classList.add('hyperspace-hidden');

    const observer = new MutationObserver(() => {
      if (!background.classList.contains('hyperspace')) {
        newtabExtras.classList.remove('hyperspace-hidden');
        observer.disconnect();
      }
    });

    observer.observe(background, { attributes: true, attributeFilter: ['class'] });
  } else {
    newtabExtras.classList.remove('hyperspace-hidden');
  }
}

export function applyVisibility({ searchForm, shortcutsGrid, newtabExtras, showSearch, showShortcuts }) {
  if (searchForm) {
    searchForm.classList.toggle('hidden', !showSearch);
  }
  if (shortcutsGrid) {
    shortcutsGrid.classList.toggle('hidden', !showShortcuts);
  }
  if (newtabExtras) {
    newtabExtras.classList.toggle('hidden', !showSearch && !showShortcuts);
  }
}

async function getTopSites() {
  try {
    if (typeof browser !== 'undefined' && browser.topSites) {
      return await browser.topSites.get();
    }
    if (typeof chrome !== 'undefined' && chrome.topSites) {
      return await chrome.topSites.get();
    }
  } catch (error) {
    console.warn('[StarWarsWeather] topSites unavailable', error);
  }
  return [];
}

if (SHOULD_INIT) {
  (async function initNewtab() {
    const preferredLanguage = getPreferredLanguage();
    const localization = await loadLocalization(preferredLanguage);

    const showSearch = getShowSearchBar();
    const showShortcuts = getShowShortcuts();

    const searchForm = document.getElementById('searchForm');
    const searchInput = document.getElementById('searchInput');
    const shortcutsGrid = document.getElementById('shortcutsGrid');
    const newtabExtras = document.querySelector('.newtab-extras');

    const background = document.getElementById('background');

    applyVisibility({ searchForm, shortcutsGrid, newtabExtras, showSearch, showShortcuts });
    applyHyperspaceHidden(newtabExtras, background);
    applySearchPlaceholder(searchInput, localization);

    if (showShortcuts) {
      const sites = await getTopSites();
      renderShortcuts(sites, shortcutsGrid);
    }

    let shortcutsLoaded = showShortcuts;

    window.addEventListener('storage', async (event) => {
      if (event.key === STORAGE_KEYS.showSearchBar || event.key === STORAGE_KEYS.showShortcuts) {
        const updatedShowSearch = getShowSearchBar();
        const updatedShowShortcuts = getShowShortcuts();
        applyVisibility({ searchForm, shortcutsGrid, newtabExtras, showSearch: updatedShowSearch, showShortcuts: updatedShowShortcuts });

        if (updatedShowShortcuts && !shortcutsLoaded) {
          const sites = await getTopSites();
          renderShortcuts(sites, shortcutsGrid);
          shortcutsLoaded = true;
        }
      }

      if (event.key === STORAGE_KEYS.showExtrasInHyperspace) {
        applyHyperspaceHidden(newtabExtras, background);
      }

      if (event.key === STORAGE_KEYS.language) {
        const updatedLocalization = await loadLocalization(getPreferredLanguage());
        applySearchPlaceholder(searchInput, updatedLocalization);
      }
    });
  })();
}
