import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pmsApiFixture } from '../../LEADr_pms/scripts/lib/pms-api-fixture'
import { conversationRecordHandlers } from '../../LEADr_pms/src/lib/api/conversation-records'
import { ApiError } from '../../LEADr_pms/src/lib/api/http'
import { PmsChatHistory, type Transport } from '../dist/lib/PmsChatHistory'

/** Integration against real PMS handlers/SQL with an isolated PGlite tenant database. */
async function main() {
  process.chdir(fileURLToPath(new URL('../../LEADr_pms/', import.meta.url)))
  process.env.META_TOKEN_ENCRYPTION_KEY = 'ef'.repeat(32)
  process.env.MESSAGING_MODE = 'gateway'
  const { pg, db } = await pmsApiFixture()
  try {
    await pg.exec("ALTER TABLE tenant_database_identity ADD COLUMN mode text DEFAULT 'shared', ADD COLUMN dedicated_company_id text")
    await pg.query("SELECT set_config('app.migration_mode','shared',false)")
    await pg.exec(readFileSync('drizzle/manual/085_tenant_hybrid_isolation.sql', 'utf8'))
    await pg.exec('CREATE ROLE memory_runtime; GRANT USAGE ON SCHEMA public TO memory_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO memory_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO memory_runtime; SET ROLE memory_runtime')
    let company = 'a', scopes = ['conversations:read', 'conversations:write', 'guests:contact']
    const authorize = async (_request: Request, required: readonly string[]) => {
      if (!required.every(scope => scopes.includes(scope))) throw new ApiError(403, 'scope_missing', 'Permissão ausente')
      await pg.query("SELECT set_config('app.company_id',$1,false)", [company])
      return { companyId: company, companySlug: 'fixture', keyId: 'fixture', actor: 'api:fixture', environment: 'test' as const, scopes, db }
    }
    const contacts = conversationRecordHandlers('contacts', authorize)
    const history = conversationRecordHandlers('history', authorize)
    let loseResponse = false, deleteBeforeRequest = false, changeBeforeRequest = false, raceCreate = false
    const transport: Transport = async options => {
      const url = new URL(options.url), path = url.pathname.split('/').filter(Boolean).slice(2)
      assert.equal(url.origin, 'https://pms.leadr.company')
      assert.equal(options.disableFollowRedirect, true)
      const request = new Request(url, {
        method: options.method, headers: options.headers as Record<string, string>,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      })
      const handler = path[0] === 'contacts' ? contacts : history
      if (raceCreate && path[0] === 'contacts' && options.method === 'POST') {
        raceCreate = false
        await pg.query('INSERT INTO hospedes(company_id,numero_hospede,nome) VALUES($1,$2,$3)', [company, (options.body as {phone:string}).phone, 'Concurrent'])
      }
      if (options.method === 'DELETE' && deleteBeforeRequest) {
        deleteBeforeRequest = false
        await pg.query('DELETE FROM historico_mensagens WHERE company_id=$1 AND id=$2', [company, path[1]])
      }
      if (options.method === 'DELETE' && changeBeforeRequest) {
        changeBeforeRequest = false
        await pg.query("UPDATE historico_mensagens SET message=jsonb_build_object('type','human','data',jsonb_build_object('content','Changed')) WHERE company_id=$1 AND id=$2", [company, path[1]])
      }
      const response = options.method === 'GET' ? await handler.list(request)
        : options.method === 'POST' ? await handler.create(request)
        : await handler.delete(request, { params: Promise.resolve({ id: path[1], phone: path[1] }) })
      const body = await response.json()
      if (loseResponse && path[0] === 'message-history' && options.method === 'POST') {
        loseResponse = false
        throw Object.assign(new Error('Response lost after actual SQL commit'), { code: 'ECONNRESET' })
      }
      return { statusCode: response.status, body }
    }
    const phone = '5511999990000', other = '5511888880000'
    const first = new PmsChatHistory(transport, phone)
    assert.equal((await first.getMessages()).length, 0)
    loseResponse = true
    await first.addUserMessage('Oi, sou Ana')
    await first.addAIMessage('Olá, Ana')
    assert.deepEqual((await new PmsChatHistory(transport, phone).getMessages()).map(m => m.content), ['Oi, sou Ana', 'Olá, Ana'])
    const count = await pg.query('SELECT count(*)::int AS n FROM historico_mensagens WHERE company_id=$1 AND session_id=$2', ['a', phone])
    assert.equal(count.rows[0].n, 2, 'lost HTTP response must not duplicate committed history')
    const contact = await pg.query('SELECT "analiseFollowUp" FROM hospedes WHERE company_id=$1 AND numero_hospede=$2', ['a', phone])
    assert.equal(contact.rows[0].analiseFollowUp, true, 'existing follow-up trigger is preserved')
    await pg.query("INSERT INTO historico_mensagens(company_id,session_id,message) SELECT $1,$2,jsonb_build_object('type','human','data',jsonb_build_object('content','page ' || i)) FROM generate_series(1,105) AS i", ['a', phone])
    assert.equal((await first.getMessages()).length, 107, 'real API pagination')
    const flatPayment = { type: 'ai', content: 'Sua pré-reserva aguarda o sinal.',
      tool_calls: [], additional_kwargs: {}, response_metadata: {}, invalid_tool_calls: [] }
    const paymentWrite = await transport({ method: 'POST', url: 'https://pms.leadr.company/api/v1/message-history',
      disableFollowRedirect: true, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-payment-history' },
      body: { phone, message: flatPayment } }) as { statusCode: number }
    assert.equal(paymentWrite.statusCode, 201)
    const resumed = await new PmsChatHistory(transport, phone).getMessages()
    assert.equal(resumed.length, 108)
    assert.equal(resumed.at(-1)?._getType(), 'ai')
    assert.equal(resumed.at(-1)?.content, flatPayment.content, 'real API flat payment message survives agent resume')
    const preserved = await pg.query('SELECT message FROM historico_mensagens WHERE company_id=$1 AND session_id=$2 ORDER BY id DESC LIMIT 1', ['a', phone])
    assert.deepEqual(preserved.rows[0].message, flatPayment, 'normalization never rewrites the stored record')
    raceCreate = true
    await new PmsChatHistory(transport, other).addUserMessage('Outro telefone')
    assert.equal((await pg.query('SELECT nome FROM hospedes WHERE company_id=$1 AND numero_hospede=$2', ['a', other])).rows[0].nome, 'Concurrent')

    company = 'b'
    const otherCompany = new PmsChatHistory(transport, phone)
    assert.equal((await otherCompany.getMessages()).length, 0, 'same phone in another company remains isolated')
    await otherCompany.addUserMessage('Outra pousada')
    company = 'a'
    deleteBeforeRequest = true
    await first.clear()
    assert.equal((await first.getMessages()).length, 0)
    assert.equal((await new PmsChatHistory(transport, other).getMessages()).length, 1)
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM hospedes WHERE company_id=$1', ['a'])).rows[0].n, 2, 'clear preserves contacts')
    company = 'b'
    assert.deepEqual((await otherCompany.getMessages()).map(m => m.content), ['Outra pousada'])
    changeBeforeRequest = true
    await assert.rejects(otherCompany.clear(), error => error instanceof Error && /version_conflict/.test(error.message))
    assert.equal((await otherCompany.getMessages())[0].content, 'Changed')
    await pg.query('DELETE FROM historico_mensagens WHERE company_id=$1', ['b'])
    await pg.query('DELETE FROM hospedes WHERE company_id=$1', ['b'])
    await assert.rejects(otherCompany.addUserMessage('Late after reset'), error => error instanceof Error && /contact_not_found/.test(error.message))
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM hospedes WHERE company_id=$1', ['b'])).rows[0].n, 0)
    scopes = ['conversations:read']
    await assert.rejects(new PmsChatHistory(transport, phone).getMessages(), error => error instanceof Error && /scope_missing/.test(error.message))
    console.log('PMS memory integration: SQL persistence, replay, pagination, RLS/phone isolation, clear and scopes passed.')
  } finally {
    await pg.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
