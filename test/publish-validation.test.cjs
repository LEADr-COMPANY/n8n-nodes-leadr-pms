const assert = require('node:assert/strict');
const { test } = require('node:test');
const { waitForRelease } = require('../scripts/wait-for-release.cjs');
const name = 'n8n-nodes-leadr-pms', version = '1.15.6', sourceSha = 'a'.repeat(40);

test('waits for npm validation before confirming the published commit', async () => {
  let calls = 0, elapsed = 0;
  await waitForRelease({ name, version, sourceSha,
    fetchMetadata: async () => ({ name, versions: ++calls < 3 ? {} : { [version]: { version, gitHead: sourceSha } } }),
    delay: async ms => { elapsed += ms; }, now: () => elapsed,
  });
  assert.equal(calls, 3);
  assert.equal(elapsed, 30000);
});

test('a pending validation times out without resending the package', async () => {
  let calls = 0, elapsed = 0;
  await assert.rejects(waitForRelease({ name, version, sourceSha, timeoutMs: 30000,
    fetchMetadata: async () => { calls++; return { name, versions: {} }; },
    delay: async ms => { elapsed += ms; }, now: () => elapsed,
  }), /não repita a publicação/);
  assert.equal(calls, 2);
});

test('wrong commit, malformed metadata and registry failures never announce success', async () => {
  for (const metadata of [
    { name: 'another-package', versions: {} },
    { name },
    { name, versions: { [version]: { version, gitHead: 'b'.repeat(40) } } },
    { name, versions: { [version]: { version: '1.15.7', gitHead: sourceSha } } },
  ]) {
    await assert.rejects(waitForRelease({ name, version, sourceSha, fetchMetadata: async () => metadata }));
  }
  await assert.rejects(waitForRelease({ name, version, sourceSha,
    fetchMetadata: async () => { throw new Error('registry unavailable'); },
  }), /registry unavailable/);
});
