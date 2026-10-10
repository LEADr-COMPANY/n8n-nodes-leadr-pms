const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

function validatePackageName(name) {
  // n8n LoadNodesAndCredentials.getNode splits "package.node" at dots.
  if (typeof name !== 'string' || !/^(?:@[a-z0-9_-]+\/)?n8n-nodes-[a-z0-9_-]+$/.test(name)) {
    throw new Error('Nome incompatível com o carregador n8n. Use n8n-nodes-leadr-pms ou um escopo sem pontos; @th.rossetto quebra a identificação do node.');
  }
}
module.exports = { validatePackageName };
if (require.main === module) {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));
  validatePackageName(manifest.name);
}
