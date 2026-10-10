const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validatePackageName } = require('../scripts/validate-package.cjs');
const manifest = require('../package.json');
const { PmsMemory } = require('../dist/nodes/PmsMemory/PmsMemory.node.js');

test('published identity can be resolved by the n8n package.node protocol', () => {
  assert.doesNotThrow(() => validatePackageName(manifest.name));
  const node = new PmsMemory();
  const registered = manifest.name + '.' + node.description.name;
  // This is the external n8n loader protocol, not a parser owned by this package.
  const [packageName, nodeName] = registered.split('.');
  assert.equal(packageName, manifest.name);
  assert.equal(nodeName, 'pmsMemory');
});

test('build rejects dotted npm scopes that install but fail in the n8n runtime', () => {
  assert.throws(() => validatePackageName('@th.rossetto/n8n-nodes-leadr-pms'), /escopo sem pontos/);
  assert.doesNotThrow(() => validatePackageName('@leadr/n8n-nodes-leadr-pms'));
});
