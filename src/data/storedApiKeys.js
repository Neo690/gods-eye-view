// src/data/storedApiKeys.js

const STORAGE_KEY = 'gev:provider-api-keys';

const DEFAULT_KEYS = Object.freeze({
  AISSTREAM_API_KEY: 'b13504076b28b22035291257176edc65cd0ed6c4',
  WINDY_API_KEY: '3Z8AiagNSo2KgCDX3qZcwqRKqLpQcv9I',
  TOMTOM_API_KEY: 'wXoT3pXh2bF9KKdGBJ6U0R3tH7m8x4wQ',
});

/** Read only the keys saved from Provider Settings (no built-in defaults). */
export function getStoredApiKeys() {
  let stored = {};
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) stored = JSON.parse(raw);
    }
  } catch {}
  return stored && typeof stored === 'object' ? stored : {};
}

/** Read all user-configured API keys combined with defaults. */
export function getAllApiKeys() {
  return {
    ...DEFAULT_KEYS,
    ...getStoredApiKeys(),
  };
}

/** Get one specific API key by env var name. */
export function getApiKey(name, fallback = '') {
  const all = getAllApiKeys();
  return all[name] || fallback;
}

/** Save one or more API keys to localStorage. A null, undefined or blank
 * value REMOVES the entry, returning that key to its built-in default. */
export function saveApiKeys(updates) {
  if (!updates || typeof updates !== 'object') return;
  const stored = { ...getStoredApiKeys() };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || String(value).trim() === '') {
      delete stored[key];
    } else {
      stored[key] = String(value).trim();
    }
  }

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    }
  } catch {}
}
