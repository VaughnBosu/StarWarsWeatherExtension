import { expect, test } from 'bun:test';
import { createSecretLoader } from '../src/aws-runtime.js';

class GetSecretValueCommand {
  constructor(input) { this.input = input; }
}

test('a rejected cached secret is fetched again without poisoning the warm container', async () => {
  let stored = JSON.stringify({ apiKey: 'old-key' });
  let reads = 0;
  const loader = createSecretLoader({
    client: { send: async () => { reads += 1; return { SecretString: stored }; } },
    GetSecretValueCommand,
    secretId: 'provider-key',
    jsonField: 'apiKey'
  });

  expect(await loader()).toBe('old-key');
  stored = JSON.stringify({ apiKey: 'new-key' });
  expect(await loader()).toBe('old-key');
  loader.invalidate('old-key');
  expect(await loader()).toBe('new-key');
  expect(reads).toBe(2);

  // A late response made with the old key cannot evict the newly fetched key.
  loader.invalidate('old-key');
  expect(await loader()).toBe('new-key');
  expect(reads).toBe(2);
});
