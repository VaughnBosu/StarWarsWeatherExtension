import { Moderok } from './vendor/moderok.js';
import { MODEROK_APP_KEY } from './env.js';

try {
  Moderok.init({
    appKey: MODEROK_APP_KEY,
    trackUninstalls: true,
    uninstallUrl: 'https://forms.gle/TMP8XNbPxNZ55U5J9',
  });
} catch (error) {
  console.error('[StarWarsWeather] Moderok initialization failed', error);
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: chrome.runtime.getURL('public/onboarding.html') });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'history-search') {
    if (!chrome.history) {
      sendResponse([]);
      return true;
    }
    chrome.history.search({ text: message.query, maxResults: 10, startTime: 0 })
      .then((results) => sendResponse(results))
      .catch(() => sendResponse([]));
    return true;
  }

  if (message.type === 'search-query') {
    if (!chrome.search) {
      sendResponse({ ok: false });
      return;
    }
    chrome.search.query({ text: message.text, disposition: message.disposition || 'CURRENT_TAB' });
    sendResponse({ ok: true });
  }
});
