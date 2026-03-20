import { getFaviconUrl } from './newtab.js';
import { SUGGESTION_LIMIT, DEBOUNCE_MS } from './config.js';

const SHOULD_INIT = !(typeof globalThis !== 'undefined' && globalThis.__SWW_SKIP_INIT__ === true);

export function looksLikeUrl(input) {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^www\./i.test(trimmed)) return true;
  // Bare domain: at least one dot, no spaces, valid-looking TLD
  if (/^[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(trimmed)) return true;
  return false;
}

export function normalizeUrl(input) {
  const trimmed = (input || '').trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function debounce(fn, ms) {
  let timer = null;
  const debounced = (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}

export async function fetchHistorySuggestions(query) {
  if (!query || query.length < 2) return [];
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return [];

  let results;
  try {
    results = await chrome.runtime.sendMessage({ type: 'history-search', query });
  } catch {
    return [];
  }
  if (!Array.isArray(results)) return [];

  // Deduplicate by hostname+pathname
  const seen = new Set();
  const unique = [];
  for (const item of results) {
    if (!item.url) continue;
    try {
      const { hostname, pathname } = new URL(item.url);
      const key = hostname + pathname;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ title: item.title || '', url: item.url, visitCount: item.visitCount || 0 });
    } catch {
      continue;
    }
  }

  // Sort by visit count descending, return top 5
  unique.sort((a, b) => b.visitCount - a.visitCount);
  return unique.slice(0, SUGGESTION_LIMIT);
}

export function renderSuggestions(suggestions, container, { onSelect } = {}) {
  if (!container) return;
  container.innerHTML = '';

  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    container.classList.add('hidden');
    return;
  }

  for (const suggestion of suggestions) {
    const li = document.createElement('li');
    li.className = 'search-suggestion-item';
    li.setAttribute('role', 'option');
    li.dataset.url = suggestion.url;

    const faviconUrl = getFaviconUrl(suggestion.url, 16);
    if (faviconUrl) {
      const img = document.createElement('img');
      img.src = faviconUrl;
      img.alt = '';
      img.width = 16;
      img.height = 16;
      img.className = 'suggestion-favicon';
      li.appendChild(img);
    }

    const textWrapper = document.createElement('div');
    textWrapper.className = 'suggestion-text';

    const titleEl = document.createElement('span');
    titleEl.className = 'suggestion-title';
    titleEl.textContent = suggestion.title || suggestion.url;
    textWrapper.appendChild(titleEl);

    const urlEl = document.createElement('span');
    urlEl.className = 'suggestion-url';
    urlEl.textContent = suggestion.url;
    textWrapper.appendChild(urlEl);

    li.appendChild(textWrapper);

    // Use mousedown + preventDefault so blur doesn't hide dropdown before click fires
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (onSelect) onSelect(suggestion.url);
    });

    container.appendChild(li);
  }

  container.classList.remove('hidden');
}

export function handleKeyboardNavigation(event, { suggestionsContainer, searchInput, onSelect }) {
  if (!suggestionsContainer) return;

  const items = suggestionsContainer.querySelectorAll('.search-suggestion-item');
  if (items.length === 0) return;

  const activeItem = suggestionsContainer.querySelector('.search-suggestion-item.active');
  let activeIndex = -1;
  if (activeItem) {
    activeIndex = Array.from(items).indexOf(activeItem);
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (activeItem) activeItem.classList.remove('active');
    const next = activeIndex + 1 < items.length ? activeIndex + 1 : 0;
    items[next].classList.add('active');
    if (searchInput) searchInput.value = items[next].dataset.url;
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (activeItem) activeItem.classList.remove('active');
    const prev = activeIndex - 1 >= 0 ? activeIndex - 1 : items.length - 1;
    items[prev].classList.add('active');
    if (searchInput) searchInput.value = items[prev].dataset.url;
    return;
  }

  if (event.key === 'Escape') {
    suggestionsContainer.classList.add('hidden');
    if (activeItem) activeItem.classList.remove('active');
    return;
  }

  if (event.key === 'Enter' && activeItem) {
    event.preventDefault();
    if (onSelect) onSelect(activeItem.dataset.url);
  }
}

export function handleSearchSubmit(event, { searchInput, selectedUrl }) {
  if (event) event.preventDefault();
  if (!searchInput) return;

  if (selectedUrl) {
    window.location.href = selectedUrl;
    return;
  }

  const query = searchInput.value.trim();
  if (!query) return;

  if (looksLikeUrl(query)) {
    window.location.href = normalizeUrl(query);
    return;
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      chrome.runtime.sendMessage({ type: 'search-query', text: query, disposition: 'CURRENT_TAB' });
    } catch {
      window.location.href = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    }
  }
}

if (SHOULD_INIT && typeof document !== 'undefined') {
  const form = document.getElementById('searchForm');
  const searchInput = document.getElementById('searchInput');
  const suggestionsContainer = document.getElementById('searchSuggestions');

  if (form && searchInput && suggestionsContainer) {
    let selectedSuggestion = null;

    function selectSuggestion(url) {
      selectedSuggestion = url;
      window.location.href = url;
    }

    form.addEventListener('submit', (e) => {
      handleSearchSubmit(e, { searchInput, selectedUrl: selectedSuggestion });
    });

    const debouncedFetch = debounce(async (query) => {
      const suggestions = await fetchHistorySuggestions(query);
      renderSuggestions(suggestions, suggestionsContainer, { onSelect: selectSuggestion });
    }, DEBOUNCE_MS);

    searchInput.addEventListener('input', () => {
      selectedSuggestion = null;
      const query = searchInput.value.trim();
      if (query.length < 2) {
        suggestionsContainer.classList.add('hidden');
        suggestionsContainer.innerHTML = '';
        debouncedFetch.cancel();
        return;
      }
      debouncedFetch(query);
    });

    searchInput.addEventListener('keydown', (e) => {
      handleKeyboardNavigation(e, {
        suggestionsContainer,
        searchInput,
        onSelect: selectSuggestion
      });
    });

    let blurTimer = null;
    searchInput.addEventListener('blur', () => {
      blurTimer = setTimeout(() => {
        suggestionsContainer.classList.add('hidden');
      }, 150);
    });

    searchInput.addEventListener('focus', () => {
      if (blurTimer) {
        clearTimeout(blurTimer);
        blurTimer = null;
      }
      if (searchInput.value.trim().length >= 2 && suggestionsContainer.children.length > 0) {
        suggestionsContainer.classList.remove('hidden');
      }
    });
  }
}
