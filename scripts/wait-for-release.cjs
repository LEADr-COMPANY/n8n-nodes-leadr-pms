const { setTimeout: sleep } = require('node:timers/promises');

async function waitForRelease({ name, version, sourceSha, fetchMetadata = async () => {
  const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name) + '?release-check=' + Date.now(), {
    headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Consulta ao npm falhou: HTTP ${response.status}.`);
  return response.json();
}, delay = sleep, now = Date.now, timeoutMs = 600000 }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    // Accepted uploads are not necessarily installable until npm validation finishes.
    const metadata = await fetchMetadata();
    if (metadata.name !== name || !metadata.versions || typeof metadata.versions !== 'object') {
      throw new Error('Metadados inesperados durante a validação da publicação.');
    }
    const release = metadata.versions[version];
    if (release) {
      if (release.version !== version || release.gitHead !== sourceSha) {
        throw new Error('A versão no npm não corresponde ao commit que este workflow publicou.');
      }
      console.log(`${name}@${version} disponível no npm; commit de origem confirmado.`);
      return;
    }
    console.log(`${name}@${version} recebida pelo npm; aguardando validação.`);
    await delay(Math.min(15000, deadline - now()));
  }
  throw new Error('O npm ainda não liberou a versão após 10 minutos. Verifique o status da versão no npm; não repita a publicação enquanto estiver validando.');
}

module.exports = { waitForRelease };
if (require.main === module) {
  const { name, version } = require('../package.json');
  waitForRelease({ name, version, sourceSha: process.env.GITHUB_SHA }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
