const { readFileSync, appendFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

function stableVersion(value) {
  if (typeof value !== 'string' || value !== value.trim() || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function planRelease(localVersion, registry, sourceSha, isAncestor = () => false) {
  const local = stableVersion(localVersion);
  if (!local) throw new Error('A versão local deve ser estável, no formato major.minor.patch.');
  if (!registry || typeof registry.versions !== 'object' || registry.versions === null || Array.isArray(registry.versions)) {
    throw new Error('O npm retornou metadados de versões inválidos.');
  }
  if (typeof sourceSha !== 'string' || sourceSha !== sourceSha.trim() || !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Commit de origem inválido.');
  const published = Object.entries(registry.versions)
    .map(([version, metadata]) => ({ version, parts: stableVersion(version), metadata }))
    .filter(entry => entry.parts);
  if (published.length === 0) throw new Error('O pacote deve ter uma versão estável publicada antes de ativar esta automação.');
  // A rerun after a successful (or uncertain) publish must not create another version.
  const existing = published.find(entry => entry.metadata?.gitHead === sourceSha);
  if (existing) return { publish: false, version: existing.version };
  const highest = published.reduce((a, b) => compare(a.parts, b.parts) > 0 ? a : b);
  const publishedSha = highest.metadata?.gitHead;
  // Never let an old queued/failed run replace newer code already published.
  if (typeof publishedSha === 'string' && publishedSha === publishedSha.trim() &&
      /^[a-f0-9]{40}$/.test(publishedSha) && isAncestor(sourceSha, publishedSha)) {
    return { publish: false, version: highest.version };
  }
  if (compare(local, highest.parts) > 0) return { publish: true, version: localVersion };
  const next = [...highest.parts];
  next[2]++;
  if (!next.every(Number.isSafeInteger)) throw new Error('A próxima versão excede o limite de inteiros seguros.');
  return { publish: true, version: next.join('.') };
}

async function main() {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));
  const sourceSha = process.env.GITHUB_SHA;
  const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(manifest.name), {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Consulta ao npm falhou: HTTP ${response.status}. Nenhuma publicação foi preparada.`);
  const registry = await response.json();
  if (registry.name !== manifest.name) throw new Error('O npm retornou outro pacote.');
  const isAncestor = (source, published) => {
    // Older manual releases may belong to a different repository.
    const known = spawnSync('git', ['cat-file', '-e', published + '^{commit}']);
    if (known.error) throw known.error;
    if (known.status !== 0) return false;
    const result = spawnSync('git', ['merge-base', '--is-ancestor', source, published]);
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) throw new Error('Não foi possível verificar a ordem dos commits.');
    return result.status === 0;
  };
  const plan = planRelease(manifest.version, registry, sourceSha, isAncestor);
  if (!process.env.GITHUB_OUTPUT) throw new Error('Este comando deve ser executado pelo GitHub Actions.');
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${plan.publish}\nversion=${plan.version}\n`);
  console.log(plan.publish ? `Próxima publicação: ${manifest.name}@${plan.version}` : `Commit já publicado ou substituído por ${plan.version}; publicação ignorada.`);
}

module.exports = { planRelease };
if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
