import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDriver } from '../../services/driver/service.mjs';
import { listen, testDirectory } from '../helpers.mjs';
import { loadContract, validateInteraction } from './contract-kit.mjs';

const contractFile = fileURLToPath(new URL('../../contracts/driver-profile.pact.json', import.meta.url));

test('Provider contract: driver-service responses satisfy every interaction', async t => {
  const directory = testDirectory(t);
  const service = createDriver({ dbPath: path.join(directory, 'driver.sqlite') });
  const base = await listen(service);
  t.after(() => service.close());
  const contract = loadContract(contractFile);
  for (const interaction of contract.interactions) {
    const response = await fetch(base + interaction.request.path, {
      method: interaction.request.method,
      headers: interaction.request.headers,
      signal: AbortSignal.timeout(4000),
    });
    const body = await response.json();
    const failures = validateInteraction(interaction, {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    });
    assert.deepEqual(failures, [], `${interaction.description}: ${failures.join('; ')}`);
  }
});
