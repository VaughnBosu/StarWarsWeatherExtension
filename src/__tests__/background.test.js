import { describe, expect, test } from 'bun:test';
import { createSpy } from './testUtils.js';

describe('background service worker', () => {
  let installHandler = null;
  let messageHandler = null;
  let tabsCreateSpy;
  let uninstallSpy;
  let historySpy;
  let searchQuerySpy;
  let realChrome;

  test('registers listeners on import', async () => {
    realChrome = globalThis.chrome;
    const addListenerSpy = createSpy((handler) => { installHandler = handler; });
    const onMessageSpy = createSpy((handler) => { messageHandler = handler; });
    tabsCreateSpy = createSpy();
    uninstallSpy = createSpy();
    historySpy = createSpy(() => Promise.resolve([]));
    searchQuerySpy = createSpy();

    globalThis.chrome = {
      runtime: {
        OnInstalledReason: { INSTALL: 'install' },
        onInstalled: { addListener: addListenerSpy },
        onMessage: { addListener: onMessageSpy },
        getURL: (path) => `chrome-extension://test/${path}`,
        setUninstallURL: uninstallSpy
      },
      tabs: { create: tabsCreateSpy },
      history: { search: historySpy },
      search: { query: searchQuerySpy }
    };

    await import('../background.js');

    expect(addListenerSpy.calls.length).toBe(1);
    expect(typeof installHandler).toBe('function');
    expect(onMessageSpy.calls.length).toBe(1);
    expect(typeof messageHandler).toBe('function');
    expect(uninstallSpy.calls.length).toBe(1);
  });

  test('opens onboarding on install', () => {
    installHandler({ reason: 'install' });
    expect(tabsCreateSpy.calls.length).toBe(1);
    expect(tabsCreateSpy.calls[0][0].url).toBe('chrome-extension://test/public/onboarding.html');
  });

  test('ignores non-install reasons', () => {
    installHandler({ reason: 'update' });
    expect(tabsCreateSpy.calls.length).toBe(1);
  });

  test('handles history-search message', async () => {
    const mockResults = [
      { url: 'https://example.com', title: 'Example', visitCount: 5 }
    ];
    globalThis.chrome.history.search = createSpy(() => Promise.resolve(mockResults));

    const sendResponse = createSpy();
    const keepOpen = messageHandler({ type: 'history-search', query: 'ex' }, {}, sendResponse);
    expect(keepOpen).toBe(true);

    await new Promise((r) => setTimeout(r, 10));

    expect(globalThis.chrome.history.search.calls.length).toBe(1);
    expect(globalThis.chrome.history.search.calls[0][0]).toEqual({ text: 'ex', maxResults: 10, startTime: 0 });
    expect(sendResponse.calls.length).toBe(1);
    expect(sendResponse.calls[0][0]).toEqual(mockResults);
  });

  test('handles history-search failure gracefully', async () => {
    globalThis.chrome.history.search = createSpy(() => Promise.reject(new Error('fail')));

    const sendResponse = createSpy();
    messageHandler({ type: 'history-search', query: 'fail' }, {}, sendResponse);

    await new Promise((r) => setTimeout(r, 10));
    expect(sendResponse.calls.length).toBe(1);
    expect(sendResponse.calls[0][0]).toEqual([]);
  });

  test('handles search-query message', () => {
    globalThis.chrome.search.query = createSpy();

    const sendResponse = createSpy();
    messageHandler({ type: 'search-query', text: 'weather', disposition: 'CURRENT_TAB' }, {}, sendResponse);

    expect(globalThis.chrome.search.query.calls.length).toBe(1);
    expect(globalThis.chrome.search.query.calls[0][0]).toEqual({ text: 'weather', disposition: 'CURRENT_TAB' });
    expect(sendResponse.calls.length).toBe(1);
    expect(sendResponse.calls[0][0]).toEqual({ ok: true });
  });

  test('handles history-search when chrome.history is unavailable', () => {
    const savedHistory = globalThis.chrome.history;
    delete globalThis.chrome.history;

    const sendResponse = createSpy();
    const keepOpen = messageHandler({ type: 'history-search', query: 'test' }, {}, sendResponse);
    expect(keepOpen).toBe(true);
    expect(sendResponse.calls.length).toBe(1);
    expect(sendResponse.calls[0][0]).toEqual([]);

    globalThis.chrome.history = savedHistory;
  });

  test('handles search-query when chrome.search is unavailable', () => {
    const savedSearch = globalThis.chrome.search;
    delete globalThis.chrome.search;

    const sendResponse = createSpy();
    messageHandler({ type: 'search-query', text: 'weather', disposition: 'CURRENT_TAB' }, {}, sendResponse);

    expect(sendResponse.calls.length).toBe(1);
    expect(sendResponse.calls[0][0]).toEqual({ ok: false });

    globalThis.chrome.search = savedSearch;
  });

  test('ignores messages with no type', () => {
    const sendResponse = createSpy();
    messageHandler({}, {}, sendResponse);
    messageHandler(null, {}, sendResponse);
    expect(sendResponse.calls.length).toBe(0);
  });

  test('cleanup', () => {
    if (realChrome) {
      globalThis.chrome = realChrome;
    } else {
      delete globalThis.chrome;
    }
  });
});
