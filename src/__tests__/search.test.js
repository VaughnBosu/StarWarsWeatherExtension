import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createSpy, installDom, teardownDom } from './testUtils.js';

globalThis.__SWW_SKIP_INIT__ = true;

let search = null;

beforeAll(async () => {
  search = await import('../search.js');
});

beforeEach(() => {
  installDom();
  globalThis.chrome = {
    runtime: { sendMessage: createSpy(() => Promise.resolve([])) }
  };
});

afterEach(() => {
  teardownDom();
  delete globalThis.chrome;
});

describe('looksLikeUrl', () => {
  test('detects https URLs', () => {
    expect(search.looksLikeUrl('https://example.com')).toBe(true);
  });

  test('detects http URLs', () => {
    expect(search.looksLikeUrl('http://example.com')).toBe(true);
  });

  test('detects www prefix', () => {
    expect(search.looksLikeUrl('www.example.com')).toBe(true);
  });

  test('detects bare domains', () => {
    expect(search.looksLikeUrl('github.com')).toBe(true);
    expect(search.looksLikeUrl('example.co.uk')).toBe(true);
  });

  test('rejects plain text', () => {
    expect(search.looksLikeUrl('weather forecast')).toBe(false);
    expect(search.looksLikeUrl('hello world')).toBe(false);
  });

  test('rejects empty/null input', () => {
    expect(search.looksLikeUrl('')).toBe(false);
    expect(search.looksLikeUrl(null)).toBe(false);
    expect(search.looksLikeUrl(undefined)).toBe(false);
  });

  test('detects domains with paths', () => {
    expect(search.looksLikeUrl('github.com/user/repo')).toBe(true);
  });
});

describe('normalizeUrl', () => {
  test('returns URL unchanged if it has protocol', () => {
    expect(search.normalizeUrl('https://example.com')).toBe('https://example.com');
    expect(search.normalizeUrl('http://example.com')).toBe('http://example.com');
  });

  test('prepends https:// when no protocol', () => {
    expect(search.normalizeUrl('example.com')).toBe('https://example.com');
    expect(search.normalizeUrl('www.example.com')).toBe('https://www.example.com');
  });

  test('handles empty input', () => {
    expect(search.normalizeUrl('')).toBe('https://');
    expect(search.normalizeUrl(null)).toBe('https://');
  });
});

describe('debounce', () => {
  test('delays execution', async () => {
    const spy = createSpy();
    const debounced = search.debounce(spy, 50);
    debounced('a');
    expect(spy.calls.length).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0][0]).toBe('a');
  });

  test('deduplicates rapid calls', async () => {
    const spy = createSpy();
    const debounced = search.debounce(spy, 50);
    debounced('a');
    debounced('b');
    debounced('c');
    await new Promise((r) => setTimeout(r, 80));
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0][0]).toBe('c');
  });

  test('cancel prevents execution', async () => {
    const spy = createSpy();
    const debounced = search.debounce(spy, 50);
    debounced('a');
    debounced.cancel();
    await new Promise((r) => setTimeout(r, 80));
    expect(spy.calls.length).toBe(0);
  });
});

describe('fetchHistorySuggestions', () => {
  test('returns empty for short queries', async () => {
    const result = await search.fetchHistorySuggestions('a');
    expect(result).toEqual([]);
  });

  test('returns empty when chrome.runtime unavailable', async () => {
    delete globalThis.chrome;
    const result = await search.fetchHistorySuggestions('test');
    expect(result).toEqual([]);
  });

  test('deduplicates by hostname+pathname', async () => {
    globalThis.chrome.runtime.sendMessage = createSpy(() =>
      Promise.resolve([
        { url: 'https://github.com/user', title: 'GitHub 1', visitCount: 10 },
        { url: 'https://github.com/user', title: 'GitHub 2', visitCount: 5 },
        { url: 'https://google.com/', title: 'Google', visitCount: 8 }
      ])
    );
    const result = await search.fetchHistorySuggestions('gi');
    expect(result.length).toBe(2);
    expect(result[0].title).toBe('GitHub 1');
    expect(result[1].title).toBe('Google');
  });

  test('returns max 5 results sorted by visitCount', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      url: `https://site${i}.com/`,
      title: `Site ${i}`,
      visitCount: i
    }));
    globalThis.chrome.runtime.sendMessage = createSpy(() => Promise.resolve(items));
    const result = await search.fetchHistorySuggestions('site');
    expect(result.length).toBe(5);
    expect(result[0].visitCount).toBe(9);
    expect(result[4].visitCount).toBe(5);
  });

  test('returns empty when sendMessage rejects', async () => {
    globalThis.chrome.runtime.sendMessage = createSpy(() =>
      Promise.reject(new Error('Extension context invalidated'))
    );
    const result = await search.fetchHistorySuggestions('test');
    expect(result).toEqual([]);
  });
});

describe('renderSuggestions', () => {
  test('creates list items with favicon, title, url', () => {
    const container = document.createElement('ul');
    container.classList.add('hidden');
    document.body.appendChild(container);

    search.renderSuggestions(
      [{ title: 'GitHub', url: 'https://github.com', visitCount: 10 }],
      container,
      { onSelect: () => {} }
    );

    expect(container.classList.contains('hidden')).toBe(false);
    const items = container.querySelectorAll('.search-suggestion-item');
    expect(items.length).toBe(1);
    expect(items[0].querySelector('.suggestion-title').textContent).toBe('GitHub');
    expect(items[0].querySelector('.suggestion-url').textContent).toBe('https://github.com');
    expect(items[0].querySelector('.suggestion-favicon')).not.toBe(null);
  });

  test('adds hidden class on empty suggestions', () => {
    const container = document.createElement('ul');
    document.body.appendChild(container);

    search.renderSuggestions([], container);
    expect(container.classList.contains('hidden')).toBe(true);
  });

  test('handles null container gracefully', () => {
    expect(() => search.renderSuggestions([], null)).not.toThrow();
  });

  test('calls onSelect on mousedown', () => {
    const container = document.createElement('ul');
    document.body.appendChild(container);
    const spy = createSpy();

    search.renderSuggestions(
      [{ title: 'Test', url: 'https://test.com', visitCount: 1 }],
      container,
      { onSelect: spy }
    );

    const item = container.querySelector('.search-suggestion-item');
    const mousedown = new Event('mousedown', { bubbles: true });
    item.dispatchEvent(mousedown);
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0][0]).toBe('https://test.com');
  });
});

describe('handleKeyboardNavigation', () => {
  function setupSuggestions() {
    const container = document.createElement('ul');
    document.body.appendChild(container);
    search.renderSuggestions(
      [
        { title: 'First', url: 'https://first.com', visitCount: 3 },
        { title: 'Second', url: 'https://second.com', visitCount: 2 },
        { title: 'Third', url: 'https://third.com', visitCount: 1 }
      ],
      container,
      { onSelect: () => {} }
    );
    return container;
  }

  test('ArrowDown activates first item', () => {
    const container = setupSuggestions();
    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });

    search.handleKeyboardNavigation(event, {
      suggestionsContainer: container,
      searchInput: input,
      onSelect: () => {}
    });

    const items = container.querySelectorAll('.search-suggestion-item');
    expect(items[0].classList.contains('active')).toBe(true);
    expect(input.value).toBe('https://first.com');
  });

  test('ArrowDown wraps from last to first', () => {
    const container = setupSuggestions();
    const input = document.createElement('input');
    document.body.appendChild(input);
    const items = container.querySelectorAll('.search-suggestion-item');
    items[2].classList.add('active');

    const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
    search.handleKeyboardNavigation(event, {
      suggestionsContainer: container,
      searchInput: input,
      onSelect: () => {}
    });

    expect(items[2].classList.contains('active')).toBe(false);
    expect(items[0].classList.contains('active')).toBe(true);
  });

  test('ArrowUp activates last item from no selection', () => {
    const container = setupSuggestions();
    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });

    search.handleKeyboardNavigation(event, {
      suggestionsContainer: container,
      searchInput: input,
      onSelect: () => {}
    });

    const items = container.querySelectorAll('.search-suggestion-item');
    expect(items[2].classList.contains('active')).toBe(true);
  });

  test('Escape hides suggestions', () => {
    const container = setupSuggestions();
    const items = container.querySelectorAll('.search-suggestion-item');
    items[0].classList.add('active');
    const event = new KeyboardEvent('keydown', { key: 'Escape' });

    search.handleKeyboardNavigation(event, {
      suggestionsContainer: container,
      searchInput: null,
      onSelect: () => {}
    });

    expect(container.classList.contains('hidden')).toBe(true);
    expect(items[0].classList.contains('active')).toBe(false);
  });

  test('Enter selects active item', () => {
    const container = setupSuggestions();
    const items = container.querySelectorAll('.search-suggestion-item');
    items[1].classList.add('active');
    const spy = createSpy();
    const event = new KeyboardEvent('keydown', { key: 'Enter' });

    search.handleKeyboardNavigation(event, {
      suggestionsContainer: container,
      searchInput: null,
      onSelect: spy
    });

    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0][0]).toBe('https://second.com');
  });

  test('does nothing with empty container', () => {
    const container = document.createElement('ul');
    document.body.appendChild(container);
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
    expect(() =>
      search.handleKeyboardNavigation(event, {
        suggestionsContainer: container,
        searchInput: null,
        onSelect: () => {}
      })
    ).not.toThrow();
  });
});

describe('handleSearchSubmit', () => {
  test('navigates to selectedUrl when provided', () => {
    const input = document.createElement('input');
    input.value = 'something';
    document.body.appendChild(input);
    const event = new Event('submit');
    const locationSpy = { href: '' };
    const origLocation = globalThis.window.location;
    Object.defineProperty(globalThis.window, 'location', { value: locationSpy, writable: true, configurable: true });

    search.handleSearchSubmit(event, { searchInput: input, selectedUrl: 'https://github.com' });
    expect(locationSpy.href).toBe('https://github.com');

    Object.defineProperty(globalThis.window, 'location', { value: origLocation, writable: true, configurable: true });
  });

  test('navigates to URL when input looks like a URL', () => {
    const input = document.createElement('input');
    input.value = 'github.com';
    document.body.appendChild(input);
    const event = new Event('submit');
    const locationSpy = { href: '' };
    const origLocation = globalThis.window.location;
    Object.defineProperty(globalThis.window, 'location', { value: locationSpy, writable: true, configurable: true });

    search.handleSearchSubmit(event, { searchInput: input, selectedUrl: null });
    expect(locationSpy.href).toBe('https://github.com');

    Object.defineProperty(globalThis.window, 'location', { value: origLocation, writable: true, configurable: true });
  });

  test('sends search-query message for plain text', () => {
    const input = document.createElement('input');
    input.value = 'weather forecast';
    document.body.appendChild(input);
    const event = new Event('submit');

    search.handleSearchSubmit(event, { searchInput: input, selectedUrl: null });
    expect(globalThis.chrome.runtime.sendMessage.calls.length).toBe(1);
    expect(globalThis.chrome.runtime.sendMessage.calls[0][0]).toEqual({
      type: 'search-query',
      text: 'weather forecast',
      disposition: 'CURRENT_TAB'
    });
  });

  test('does nothing for empty input', () => {
    const input = document.createElement('input');
    input.value = '   ';
    document.body.appendChild(input);
    const event = new Event('submit');

    search.handleSearchSubmit(event, { searchInput: input, selectedUrl: null });
    expect(globalThis.chrome.runtime.sendMessage.calls.length).toBe(0);
  });
});
