const assert = require('node:assert/strict');
const { test } = require('node:test');
const { planRelease } = require('../scripts/prepare-release.cjs');
const sha = 'a'.repeat(40), oldSha = 'b'.repeat(40);
const registry = versions => ({ versions: Object.fromEntries(versions.map(v => [v, { gitHead: oldSha }])) });

test('first automated publish retains an unpublished newer local version', () => {
  assert.deepEqual(planRelease('1.15.6', registry(['1.15.5']), sha), { publish: true, version: '1.15.6' });
});

test('successive updates automatically advance the highest stable patch numerically', () => {
  assert.deepEqual(planRelease('1.15.6', registry(['1.15.5', '1.15.6']), sha), { publish: true, version: '1.15.7' });
  assert.deepEqual(planRelease('1.15.6', registry(['1.15.9', '1.15.10', '1.15.7']), sha), { publish: true, version: '1.15.11' });
  assert.deepEqual(planRelease('1.15.6', registry(['2.0.0', '1.99.0']), sha), { publish: true, version: '2.0.1' });
});

test('explicit minor and major versions are honored when newer than the registry', () => {
  assert.equal(planRelease('1.16.0', registry(['1.15.6']), sha).version, '1.16.0');
  assert.equal(planRelease('2.0.0', registry(['1.15.6']), sha).version, '2.0.0');
});

test('unpublished prereleases and dist-tag ordering do not cause stable version collisions', () => {
  const data = registry(['1.15.10', '1.15.5', '2.0.0-beta.1']);
  data['dist-tags'] = { latest: '1.15.5' };
  assert.equal(planRelease('1.15.6', data, sha).version, '1.15.11');
});

test('reruns of any already published commit do not publish duplicate or stale code', () => {
  const data = registry(['1.15.6', '1.15.7']);
  data.versions['1.15.6'].gitHead = sha;
  assert.deepEqual(planRelease('1.15.6', data, sha), { publish: false, version: '1.15.6' });
});

test('an unpublished older run cannot replace a newer published descendant', () => {
  const data = registry(['1.15.7']);
  let checked = false;
  const plan = planRelease('1.15.6', data, sha, (source, published) => {
    assert.equal(source, sha);
    assert.equal(published, oldSha);
    checked = true;
    return true;
  });
  assert.equal(checked, true);
  assert.deepEqual(plan, { publish: false, version: '1.15.7' });
  assert.deepEqual(planRelease('1.15.6', data, sha, () => false), { publish: true, version: '1.15.8' });
});

test('invalid local versions, registry responses, commits and patch overflow fail closed', () => {
  for (const version of ['1.15.6-beta.1', '01.15.6', '1.15', '1.15.6\n', 'invalid', '9007199254740992.0.0']) {
    assert.throws(() => planRelease(version, registry(['1.15.5']), sha));
  }
  for (const data of [null, {}, { versions: null }, { versions: [] }, { versions: {} }, registry(['2.0.0-beta.1'])]) {
    assert.throws(() => planRelease('1.15.6', data, sha));
  }
  for (const commit of [undefined, '', 'not-a-commit', sha + '\n']) {
    assert.throws(() => planRelease('1.15.6', registry(['1.15.5']), commit));
  }
  assert.throws(() => planRelease('1.15.6', registry(['1.15.9007199254740991']), sha));
});
