const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

// Exercise the tarball, not the development tree or its lockfile. n8n installs
// dependencies inside the extracted package with this shallow install strategy.
const manifest = require('../package.json');
const archive = path.resolve(process.argv[2] || `${manifest.name}-${manifest.version}.tgz`);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli && fs.existsSync(npmCli), 'Run this check through npm run test:install');
assert.ok(fs.existsSync(archive), 'Prepare the tarball with npm pack first');
const tempParent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempParent, 'pms-install-'));
const installed = path.join(root, manifest.name);
const backup = path.join(root, 'previous-install');
const peer = path.dirname(require.resolve('n8n-workflow/package.json'));

function install() {
  fs.mkdirSync(installed);
  execFileSync('tar', ['-xzf', archive, '-C', installed, '--strip-components=1']);
  const manifestPath = path.join(installed, 'package.json');
  const packaged = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(packaged.name, manifest.name);
  delete packaged.devDependencies;
  delete packaged.peerDependencies;
  delete packaged.optionalDependencies;
  fs.writeFileSync(manifestPath, JSON.stringify(packaged));
  execFileSync(process.execPath, [npmCli, 'install', '--audit=false', '--fund=false',
    '--bin-links=false', '--install-strategy=shallow', '--ignore-scripts=true',
    '--package-lock=false'], { cwd: installed, stdio: 'inherit', timeout: 180000 });
  // Only the n8n peer comes from the host, as in n8n. All runtime dependencies
  // must resolve from the isolated installation.
  fs.symlinkSync(peer, path.join(installed, 'node_modules', 'n8n-workflow'), 'junction');
}

function checkLoaded() {
  const req = createRequire(path.join(installed, 'package.json'));
  for (const entry of ['@langchain/core/messages', '@langchain/classic/memory']) {
    const dependencyReq = createRequire(req.resolve(entry));
    const runTrees = dependencyReq.resolve('langsmith/run_trees');
    assert.ok(runTrees.startsWith(installed + path.sep), 'LangSmith must come from this install');
    assert.ok(fs.existsSync(runTrees), 'The cached CommonJS export must still exist');
    const langsmith = JSON.parse(fs.readFileSync(path.join(path.dirname(runTrees), 'package.json')));
    assert.equal(langsmith.version, manifest.dependencies.langsmith);
    assert.equal(typeof dependencyReq('langsmith/run_trees').RunTree, 'function');
  }
  for (const entry of manifest.n8n.nodes) {
    const className = path.basename(entry).split('.')[0];
    const node = new (req('./' + entry)[className])();
    assert.equal(node.description.name, 'pmsMemory');
    assert.equal(typeof node.supplyData, 'function');
  }
}

function assertTempTarget(target) {
  assert.equal(path.dirname(root), tempParent);
  assert.ok(path.basename(root).startsWith('pms-install-'));
  assert.ok(target === root || target.startsWith(root + path.sep));
}

try {
  install();
  checkLoaded();
  console.log('Fresh n8n installation: passed');
  // Keep Node's internal package.json/export cache alive across the directory
  // replacement. Deleting require.cache alone does not clear that cache.
  assertTempTarget(installed);
  assertTempTarget(backup);
  fs.renameSync(installed, backup);
  install();
  for (const file of Object.keys(require.cache)) {
    if (file.startsWith(installed + path.sep)) delete require.cache[file];
  }
  checkLoaded();
  console.log('n8n update with cached exports: passed');
} finally {
  assertTempTarget(root);
  fs.rmSync(root, { recursive: true, force: true });
}
