import type { ClientConfig } from './types.js';

/**
 * Merge caller-supplied options over a fully populated set of defaults, ignoring
 * every key whose value is `undefined`.
 *
 * A plain spread cannot be used here: `{ ...defaults, ...config }` lets a key
 * that is present but undefined overwrite its default with `undefined`. Building
 * a config straight from optional inputs — `{ adminToken: process.env.TOKEN }` —
 * is ordinary JavaScript, and it has to behave like omitting the key rather than
 * clearing the default. Leaving `undefined` in place would send an `AUTH` with no
 * token, or hand a socket an undefined deadline.
 *
 * @param {Required<ClientConfig>} defaults - Fully populated default config
 * @param {ClientConfig} config - Caller-supplied options
 * @returns {Required<ClientConfig>} Defaults with every defined override applied
 */
export function applyClientDefaults(defaults: Required<ClientConfig>, config: ClientConfig): Required<ClientConfig> {
  const merged: Required<ClientConfig> = { ...defaults };
  Object.entries(config).forEach(([key, value]) => {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  });
  return merged;
}
