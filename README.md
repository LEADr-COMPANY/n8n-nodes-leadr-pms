# LEADr PMS Memory

Pacote `n8n-nodes-leadr-pms`: sub-node de memória para agentes n8n que lê e grava
mensagens pela API da LEADr PMS. Usa `BufferWindowMemory` com `chat_history`,
`input`, `output` e `returnMessages: true`.

O código do node é independente do projeto da API PMS. Este repositório contém
somente o pacote, seus testes e ferramentas de build.

## Requisitos

- Node.js 22.13.0 ou superior.
- n8n com `n8n-workflow >=2.28.0 <3` disponível no ambiente do pacote.
- Credencial PMS com `conversations:read`, `conversations:write` e `guests:contact`.

O pacote foi compilado com `n8n-workflow 2.28.0`, `@langchain/classic 1.0.32`
e `@langchain/core 1.2.8`. A versão do SDK `n8n-workflow` difere da versão do
aplicativo n8n; confira a compatibilidade do ambiente antes da instalação.

## Configuração no n8n

1. Instale `n8n-nodes-leadr-pms` no ambiente do n8n.
2. Adicione **LEADr PMS Memory** e conecte sua saída **Memory** à entrada de
   memória do agente.
3. Selecione uma credencial **Header Auth** que envie
   `Authorization: Bearer <chave PMS>`. Não coloque o segredo no campo de telefone.
4. Informe o telefone do cliente com DDI e DDD, por exemplo `5511999990000` ou
   `+5511999990000`. O campo aceita expressões do n8n.
5. Ajuste **Opções → Janela de Contexto** se necessário. O padrão é 15 interações,
   equivalente às últimas 30 mensagens.

A empresa é determinada pela credencial, mantendo históricos separados entre
empresas. Como em outros sub-nodes n8n, expressões podem resolver apenas o primeiro
item; não misture telefones em um lote do agente.

O node usa `https://pms.leadr.company/api/v1`, com TLS validado, redirecionamentos
desativados e o helper autenticado do n8n. Não requer acesso SQL ou parâmetros de
empresa, tabela e endpoints.

## Comportamento

| Ação | API e resultado |
| --- | --- |
| Abrir memória | `GET /contacts?phone=...`; cria somente o contato mínimo com `POST /contacts` quando ausente. Preserva campos existentes. |
| Ler | `GET /message-history?phone=...&limit=100&after=...`, percorrendo páginas em ordem crescente. |
| Gravar | `POST /message-history`, com telefone e mensagem LangChain completa; usuário e resposta são gravados em sequência. |
| Limpar memória | Lista o histórico e executa `DELETE /message-history/{id}` com a versão de cada registro. Preserva contato e outros telefones. |

O histórico completo permanece disponível ao Chat Memory Manager. A janela afeta
somente o contexto do agente, sem expiração, resumo automático ou exclusão por
limite de contexto.

Os serializadores LangChain preservam mensagens humanas, IA, sistema, ferramentas,
multimídia e metadados. São aceitos `{type,data}`, o legado `{type,text}` e o formato
plano `{type,content,...}`. A leitura normaliza o formato plano sem regravar o
histórico. Novas mensagens são gravadas em `{type,data}`. Registros incompatíveis
geram erro explícito, sem descartar mensagens silenciosamente.

Cada escrita recebe uma chave de idempotência. Falhas transitórias de rede ou
HTTP 500/502/503/504 permitem uma repetição com a mesma chave e corpo. Reexecutar
um workflow cria novas operações; mensagens iguais em eventos distintos continuam
sendo mensagens distintas.

## Compatibilidade de telefones — 1.15.6

Entrada e respostas com ou sem um único `+` inicial identificam o mesmo telefone.
As quatro validações de identidade de `GET /contacts`, `POST /contacts`,
`GET /message-history` e `POST /message-history` comparam uma representação
normalizada comum. Telefones diferentes continuam sendo rejeitados.

O telefone deve ter 8–15 dígitos, sem zero inicial. A entrada também aceita
espaços, parênteses, pontos e hífens; os campos de identidade das respostas da API
aceitam somente dígitos e um `+` opcional no início.

A representação interna e os telefones enviados pelo node continuam sem `+`,
preservando as chaves existentes. Parâmetros de telefone usam `encodeURIComponent`
nas URLs (`+` seria `%2B`); corpos JSON não usam essa codificação. A correção não
migra contatos ou históricos nem altera autenticação, isolamento, IDs, versões,
ordenação, serialização ou idempotência.

## Desenvolvimento e testes

```sh
git clone https://github.com/LEADr-COMPANY/n8n-nodes-leadr-pms.git
cd n8n-nodes-leadr-pms
npm ci --ignore-scripts
npm test
npm pack
```

`npm test` compila o pacote e executa testes com respostas HTTP simuladas, sem
acessar o n8n ou a API PMS. A suíte cobre contatos novos/existentes, histórico
vazio/preenchido, leitura, gravação e limpeza; combinações independentes de
telefone com/sem `+` nos quatro endpoints; entradas inválidas e identidade
divergente; paginação, IDs, versões, ordenação, isolamento por transporte
autenticado, corrida na criação e repetição após resposta perdida.

O teste integrado opcional (`npm run test:integration`) depende de um checkout
separado da API PMS em `../LEADr_pms`, com suas dependências instaladas. Usa os
handlers reais e PGlite isolado; não é necessário para executar a suíte local.

## Instalação por artefato

`npm pack` gera `n8n-nodes-leadr-pms-<versão>.tgz`. No ambiente do n8n, com o
usuário que executa o serviço:

```sh
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install /caminho/n8n-nodes-leadr-pms-<versão>.tgz
```

Reinicie o n8n após instalar. Em modo fila, disponibilize a mesma versão e suas
dependências no processo principal e nos workers. Em Docker, use a imagem ou um
local persistente de community nodes. Não copie apenas o arquivo `.node.js`.

O tipo do node é `n8n-nodes-leadr-pms.pmsMemory`. O build valida o nome do pacote:
escopos npm com ponto podem impedir que o carregador n8n resolva o tipo do node.

Para publicar no npm, com a conta autorizada para o pacote:

```sh
npm publish --access public
```

Publicar o repositório no GitHub não publica o pacote no npm nem instala o node
no n8n.

## Publicação automática no npm

O workflow `.github/workflows/publish.yml` executa a cada push na branch `main`
e também pode ser iniciado manualmente na aba Actions. Ele instala as dependências,
calcula uma versão inédita, compila, executa os testes e prepara o pacote.
Com a autorização npm ativada, publica automaticamente como `latest`.
Atualizações de outras branches não publicam.

Se a versão do `package.json` for maior que todas as versões estáveis no npm,
essa versão será usada. Caso contrário, o workflow incrementa o patch da maior
versão estável publicada. Para uma mudança major/minor, altere a versão no projeto
antes do push. A versão de publicação é aplicada ao manifesto e lockfile no runner;
a automação não cria commits de versão em `main`. Reexecutar um commit já publicado
não cria uma versão duplicada. Execuções antigas não substituem um commit
descendente já publicado. Publicações são serializadas em uma fila de até
100 execuções pendentes; falhas de testes ou consulta ao registry interrompem o fluxo.
Após enviar o pacote, o workflow aguarda até 10 minutos pela validação assíncrona
do npm e confirma o commit da versão disponibilizada. Se o npm ainda mostrar
`Validating` após esse prazo, confira o status antes de repetir a publicação.

### Autorização inicial

Na conta npm com permissão de manutenção do pacote, abra
https://www.npmjs.com/package/n8n-nodes-leadr-pms/access e cadastre um
**Trusted Publisher → GitHub Actions**:

- Organization or user: `LEADr-COMPANY`
- Repository: `n8n-nodes-leadr-pms`
- Workflow filename: `publish.yml`
- Environment name: deixe vazio
- Allowed actions: permita publicação direta com `npm publish`

Depois, defina a variável de repositório `NPM_PUBLISH_ENABLED` como `true` em
GitHub → Settings → Secrets and variables → Actions → Variables, e inicie
**Publish to npm** manualmente para validar a primeira publicação. Sem essa
variável, o workflow verifica o pacote e informa que a publicação está pendente;
não anuncia que publicou.

A autenticação usa OIDC, sem token npm permanente nos secrets. É necessário
concluir a primeira publicação dentro do prazo da configuração informado pelo npm.
Documentação: https://docs.npmjs.com/trusted-publishers/.

## Limites

- A API lista do mais antigo para o mais novo. A leitura percorre todo o histórico
  e limita-se a 1.000 páginas de 100 registros; exceder esse limite gera erro.
- Corpos de requisição têm limite de 65.536 bytes. Conteúdo maior gera erro sem
  truncamento; binários grandes devem permanecer fora da memória.
- Usuário e resposta são escritas separadas; falha entre elas pode deixar somente
  a primeira mensagem.
- A limpeza usa um DELETE por registro e não é transacional. Conflito de versão
  interrompe a operação, preservando a versão alterada; registros anteriores
  podem já ter sido removidos. Um 404 de registro já removido é tolerado.
- Um contato removido após a inicialização não é recriado durante a gravação.
  Reset e recriação concorrente do mesmo telefone exigem coordenação externa;
  a leitura paginada não é um snapshot transacional.
- A gravação mantém os efeitos previstos pela API, incluindo follow-up.
  Limpar a memória não desfaz esses efeitos.
- A janela recorta as últimas `2 × k` mensagens, inclusive mensagens de ferramentas.

## Referências

- [Postgres Chat Memory — n8n](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memorypostgreschat/)
- [Instalação manual de community nodes](https://docs.n8n.io/integrations/community-nodes/installation/manual/)
- [LangChain.js](https://github.com/langchain-ai/langchainjs)
