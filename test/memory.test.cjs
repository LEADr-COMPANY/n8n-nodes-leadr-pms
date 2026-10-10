const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BufferWindowMemory } = require('@langchain/classic/memory');
const { HumanMessage, AIMessage, ToolMessage, SystemMessage, mapChatMessagesToStoredMessages } = require('@langchain/core/messages');
const { PmsChatHistory, PMS_URL, normalizePhone } = require('../dist/lib/PmsChatHistory.js');
const { PmsMemory } = require('../dist/nodes/PmsMemory/PmsMemory.node.js');
const phone = '5511999990000', other = '5511888880000', version = 'a'.repeat(64);

function fixture(responsePhones = {}) {
  const contacts = new Map(), rows = new Map(), calls = [], replay = new Map();
  let nextId = 9007199254740993n, hook;
  const transport = async options => {
    calls.push(structuredClone(options));
    const url = new URL(options.url), path = url.pathname.replace('/api/v1', '');
    assert.equal(url.origin, 'https://pms.leadr.company');
    assert.equal(options.disableFollowRedirect, true);
    assert.equal(options.returnFullResponse, true);
    const injected = hook && await hook(options, path);
    if (injected) return injected;
    const key = options.headers['Idempotency-Key'];
    if (key && replay.has(key)) return replay.get(key);
    const ok = (data, statusCode = 200) => {
      const response = { statusCode, body: { data } };
      if (key) replay.set(key, response);
      return response;
    };
    const fail = (statusCode, code) => ({ statusCode, body: { type: 'about:blank', title: code, status: statusCode, code } });
    if (path === '/contacts' && options.method === 'GET') {
      const entry = contacts.get(url.searchParams.get('phone'));
      return ok({ items: entry ? [entry] : [], next_cursor: null });
    }
    if (path === '/contacts' && options.method === 'POST') {
      if (contacts.has(options.body.phone)) return fail(409, 'record_exists');
      contacts.set(options.body.phone, { phone: options.body.phone, name: null });
      return ok(contacts.get(options.body.phone), 201);
    }
    if (path === '/message-history' && options.method === 'POST') {
      if (!contacts.has(options.body.phone)) return fail(409, 'contact_not_found');
      const row = { id: String(nextId++), ...options.body, version };
      rows.set(row.id, row);
      return ok(row, 201);
    }
    if (path === '/message-history' && options.method === 'GET') {
      const selected = [...rows.values()].filter(row => row.phone === url.searchParams.get('phone') &&
        BigInt(row.id) > BigInt(url.searchParams.get('after') || 0)).sort((a,b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
      const items = selected.slice(0, 100);
      return ok({ items, next_cursor: selected.length > 100 ? items.at(-1).id : null });
    }
    if (path.startsWith('/message-history/') && options.method === 'DELETE') {
      const id = path.split('/').at(-1), row = rows.get(id);
      if (!row) return fail(404, 'record_not_found');
      if (row.version !== options.body.version) return fail(409, 'version_conflict');
      rows.delete(id);
      return ok({ deleted: true });
    }
    throw new Error('Unexpected route');
  };
  const http = async options => {
    const response = structuredClone(await transport(options));
    const route = new URL(options.url).pathname.replace('/api/v1/', '');
    const data = response.body.data;
    if (data && responsePhones[options.method + ' ' + route]) {
      for (const row of data.items ?? [data]) {
        if (typeof row.phone === 'string') row.phone = '+' + row.phone;
      }
    }
    return response;
  };
  return { contacts, rows, calls, replay, transport: http,
    hook: fn => { hook = fn; },
    history: () => new PmsChatHistory(http, phone),
    seed: (count, target = phone) => {
      contacts.set(target, { phone: target, name: 'Preserved', flag: true });
      for (let i = 0; i < count; i++) {
        const id = String(nextId++);
        rows.set(id, { id, phone: target, version, message: mapChatMessagesToStoredMessages([new HumanMessage('m' + i)])[0] });
      }
    },
  };
}
function memory(history, k = 15) {
  return new BufferWindowMemory({ chatHistory: history, k, memoryKey: 'chat_history', inputKey: 'input', outputKey: 'output', returnMessages: true });
}

test('phone accepts formatting without merging arbitrary identifiers', () => {
  assert.equal(normalizePhone('+55 (11) 99999-0000'), phone);
  for (const value of ['', 'abc5511999990000', '5511999990000@s.whatsapp.net', '001234567', 5511999990000]) {
    assert.throws(() => normalizePhone(value), /telefone/i);
  }
});

test('real BufferWindowMemory reads previous turn, saves human and AI and reloads in another instance', async () => {
  const f = fixture(), first = memory(f.history());
  assert.deepEqual(await first.loadMemoryVariables({ input: 'Oi' }), { chat_history: [] });
  await first.saveContext({ input: 'Oi' }, { output: 'Olá!' });
  const second = memory(f.history());
  const context = await second.loadMemoryVariables({ input: 'Lembra de mim?' });
  assert.deepEqual(context.chat_history.map(m => [m._getType(), m.content]), [['human', 'Oi'], ['ai', 'Olá!']]);
  assert.equal(f.contacts.size, 1);
});

test('all pages and bigint IDs survive; default window returns last30 without deleting history', async () => {
  const f = fixture(); f.seed(205); f.seed(3, other);
  const context = await memory(f.history()).loadMemoryVariables({});
  assert.equal(context.chat_history.length, 30);
  assert.equal(context.chat_history[0].content, 'm175');
  assert.equal(context.chat_history.at(-1).content, 'm204');
  assert.equal((await f.history().getMessages()).length, 205);
  assert.equal(f.rows.size, 208);
  assert.ok(f.calls.some(c => c.url.includes('after=9007199254741092')));
});

test('round-trip preserves tool calls, multimodal content, names and metadata', async () => {
  const f = fixture();
  const messages = [
    new SystemMessage('system'),
    new HumanMessage({ content: [{ type: 'text', text: 'Foto' }, { type: 'image_url', image_url: 'https://example.test/photo.jpg' }], name: 'guest' }),
    new AIMessage({ content: '', id: 'ai-1', tool_calls: [{ name: 'availability', args: { adults: 2 }, id: 'call-1', type: 'tool_call' }], response_metadata: { model_name: 'fixture' } }),
    new ToolMessage({ content: 'available', tool_call_id: 'call-1', name: 'availability' }),
  ];
  await f.history().addMessages(messages);
  assert.deepEqual(mapChatMessagesToStoredMessages(await f.history().getMessages()), mapChatMessagesToStoredMessages(messages));
});

test('native legacy StoredMessageV1 remains readable', async () => {
  const f = fixture(); f.seed(1);
  [...f.rows.values()][0].message = { type: 'human', text: 'Histórico antigo' };
  assert.equal((await f.history().getMessages())[0].content, 'Histórico antigo');
});

test('existing contact fields preserved; same text remains two distinct messages', async () => {
  const f = fixture(); f.seed(0);
  const before = structuredClone(f.contacts.get(phone)), history = f.history();
  await history.addMessages([new HumanMessage('Oi'), new HumanMessage('Oi')]);
  assert.deepEqual(f.contacts.get(phone), before);
  const writes = f.calls.filter(c => c.method === 'POST');
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0].headers['Idempotency-Key'], writes[1].headers['Idempotency-Key']);
});

test('one retry after lost committed response reuses key and does not duplicate', async () => {
  const f = fixture(), h = f.history();
  await h.getMessages();
  let lose = true;
  const transport = async options => {
    const response = await f.transport(options);
    if (options.method === 'POST' && lose) { lose = false; throw Object.assign(new Error('private secret'), { code: 'ETIMEDOUT' }); }
    return response;
  };
  await new PmsChatHistory(transport, phone).addUserMessage('hello');
  const writes = f.calls.filter(c => c.url.endsWith('/message-history') && c.method === 'POST');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(f.rows.size, 1);
});

test('contact creation race rereads winner instead of overwriting', async () => {
  const f = fixture();
  f.hook((options, path) => {
    if (path === '/contacts' && options.method === 'POST') {
      f.contacts.set(phone, { phone, name: 'Concurrent contact', flag: true });
      return { statusCode: 409, body: { status: 409, code: 'record_exists' } };
    }
  });
  await f.history().addUserMessage('Oi');
  assert.equal(f.contacts.get(phone).name, 'Concurrent contact');
});

test('reset after load does not recreate deleted contact during save', async () => {
  const f = fixture(), m = memory(f.history());
  await m.loadMemoryVariables({});
  f.contacts.delete(phone);
  await assert.rejects(m.saveContext({ input: 'Oi' }, { output: 'Olá' }), error => error.code === 'contact_not_found');
  assert.equal(f.contacts.size, 0);
  assert.equal(f.rows.size, 0);
});

test('clear deletes entire paginated history only for this phone; contact and later arrivals survive', async () => {
  const f = fixture(); f.seed(205); f.seed(2, other);
  let inserted = false;
  f.hook(options => {
    if (options.method === 'DELETE' && !inserted) { inserted = true; f.seed(1); }
  });
  await f.history().clear();
  assert.equal([...f.rows.values()].filter(r => r.phone === phone).length, 1);
  assert.equal([...f.rows.values()].filter(r => r.phone === other).length, 2);
  assert.equal(f.contacts.size, 2);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 205);
});

test('clear tolerates already deleted records but does not overwrite a changed version', async () => {
  const f = fixture(); f.seed(2);
  const ids = [...f.rows.keys()];
  f.hook(options => {
    if (options.method === 'DELETE' && options.url.endsWith(ids[0])) f.rows.delete(ids[0]);
    if (options.method === 'DELETE' && options.url.endsWith(ids[1])) f.rows.get(ids[1]).version = 'b'.repeat(64);
  });
  await assert.rejects(f.history().clear(), error => error.code === 'version_conflict');
  assert.equal(f.rows.size, 1);
});

test('cross-phone response, non-advancing cursor and malformed messages fail instead of supplying partial context', async () => {
  for (const mutate of [
    data => { data.items[0].phone = other; },
    data => { data.next_cursor = '1'; },
    data => { data.items[0].message = { role: 'user', content: 'unconverted' }; },
  ]) {
    const f = fixture(); f.seed(1);
    const transport = async options => {
      const response = await f.transport(options);
      if (options.url.includes('/message-history?')) mutate(response.body.data);
      return response;
    };
    await assert.rejects(new PmsChatHistory(transport, phone).getMessages(), /incompatível|incompatíveis/);
  }
});

test('oversized messages fail before POST, without truncation', async () => {
  const f = fixture(); f.seed(0);
  await assert.rejects(f.history().addUserMessage('á'.repeat(40000)), error => error.code === 'payload_too_large');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});

test('auth, rate limit and redirects never become empty context or retry loops', async () => {
  for (const statusCode of [401, 403, 429, 302]) {
    const f = fixture();
    f.hook(() => ({ statusCode, body: { status: statusCode, code: statusCode === 403 ? 'scope_missing' : 'test_error', detail: 'secret body' } }));
    await assert.rejects(f.history().getMessages(), error => error.status === statusCode && !error.message.includes('secret body'));
    assert.equal(f.calls.length, 1);
  }
});

test('supplyData exposes only AiMemory, uses existing credential, and logs no message contents', async () => {
  const f = fixture(), events = [], node = new PmsMemory();
  const context = {
    getNodeParameter: name => name === 'phone' ? phone : {},
    getNode: () => ({ name: 'LEADr PMS Memory', typeVersion: 1 }),
    addInputData: (type, data) => { events.push(data); return { index: events.length }; },
    addOutputData: (type, index, data) => events.push(data),
    helpers: { httpRequestWithAuthentication: async function(credential, options) {
      assert.equal(this, context); assert.equal(credential, 'httpHeaderAuth'); return f.transport(options);
    } },
  };
  const { response } = await node.supplyData.call(context, 0);
  assert.deepEqual(node.description.inputs, []);
  assert.deepEqual(node.description.outputs, ['ai_memory']);
  await response.loadMemoryVariables({});
  await response.saveContext({ input: 'private input' }, { output: 'private output' });
  assert.equal(response.k, 15);
  assert.ok(!JSON.stringify(events).includes('private'));
  assert.equal(f.calls.filter(c => c.url.includes('/message-history?')).length, 1, 'logging must not reread history');
});

test('supplyData validates phone/window and wraps runtime error with safe node error', async () => {
  const node = new PmsMemory();
  const context = {
    getNodeParameter: name => name === 'phone' ? phone : { contextWindowLength: 0 },
    getNode: () => ({ name: 'LEADr PMS Memory', typeVersion: 1 }),
  };
  await assert.rejects(node.supplyData.call(context, 0), /inteiro/);
  context.getNodeParameter = name => name === 'phone' ? phone : {};
  context.addInputData = () => ({ index: 0 });
  context.addOutputData = () => {};
  context.helpers = { httpRequestWithAuthentication: async () => { throw new Error('Authorization: secret'); } };
  const { response } = await node.supplyData.call(context, 0);
  await assert.rejects(response.loadMemoryVariables({}), error => !error.message.includes('secret') && /PMS/.test(error.message));
});

test('agent resumes after payment workflow appends a flat AI message without rewriting history', async () => {
  const f = fixture(), h = f.history(), m = memory(h);
  await m.saveContext({ input: 'Quero reservar' }, { output: 'Confirma a reserva?' });
  assert.equal((await m.loadMemoryVariables({})).chat_history.length, 2);
  // Same flat message shape appended by a payment workflow.
  const flat = { type: 'ai', content: 'Sua pré-reserva aguarda o sinal. https://example.test/checkout',
    tool_calls: [], additional_kwargs: {}, response_metadata: {}, invalid_tool_calls: [] };
  await f.transport({ method: 'POST', url: PMS_URL + '/message-history', disableFollowRedirect: true,
    returnFullResponse: true, headers: { 'Idempotency-Key': 'payment-workflow' }, body: { phone, message: flat } });
  const before = structuredClone([...f.rows.values()]);
  const context = await memory(f.history()).loadMemoryVariables({ input: 'Ok' });
  assert.deepEqual(context.chat_history.map(x => [x._getType(), x.content]), [
    ['human', 'Quero reservar'], ['ai', 'Confirma a reserva?'], ['ai', flat.content],
  ]);
  assert.deepEqual([...f.rows.values()], before, 'reading must not rewrite or delete legacy records');
  await m.saveContext({ input: 'Ok' }, { output: 'Pagamento confirmado pelo PMS.' });
  assert.equal((await f.history().getMessages()).length, 5);
  assert.equal([...f.rows.values()].at(-1).message.data.content, 'Pagamento confirmado pelo PMS.');
});

test('flat history retains message types, tool call IDs, multimodal content and metadata', async () => {
  const f = fixture(); f.seed(4);
  const messages = [
    new SystemMessage('System context'),
    new HumanMessage({ name: 'guest', content: [{ type: 'text', text: 'Foto' }, { type: 'image_url', image_url: 'https://example.test/photo.jpg' }] }),
    new AIMessage({ content: '', id: 'ai-payment', tool_calls: [{ name: 'payment', args: { reservation_id: 'fixture' }, id: 'call-payment', type: 'tool_call' }], additional_kwargs: { custom: true }, response_metadata: { model_name: 'fixture' } }),
    new ToolMessage({ content: 'confirmed', name: 'payment', tool_call_id: 'call-payment' }),
  ];
  const expected = mapChatMessagesToStoredMessages(messages);
  [...f.rows.values()].forEach((row, i) => { row.message = { type: expected[i].type, ...expected[i].data }; });
  assert.deepEqual(mapChatMessagesToStoredMessages(await f.history().getMessages()), expected);
});

test('malformed nested history is never rescued by a flat fallback or silently skipped', async () => {
  for (const message of [
    { type: 'ai', content: 42 },
    { type: 'unknown', content: 'text' },
    { type: 'ai', data: null, content: 'looks valid' },
    { type: 'ai', data: { content: 42 }, content: 'looks valid' },
  ]) {
    const f = fixture(); f.seed(1);
    [...f.rows.values()][0].message = message;
    await assert.rejects(f.history().getMessages(), error => error.code === 'invalid_history');
    assert.equal(f.rows.size, 1);
  }
});

const phoneRoutes = ['GET contacts', 'POST contacts', 'GET message-history', 'POST message-history'];

test('all input/response plus combinations preserve new/existing contacts and empty/populated memory', async t => {
  // Each of the four endpoints varies independently, including mixed API versions.
  for (let mask = 0; mask < 16; mask++) {
    const formats = Object.fromEntries(phoneRoutes.map((route, i) => [route, Boolean(mask & (1 << i))]));
    for (const input of [phone, '+' + phone]) {
      for (const initial of ['new', 'existing-empty', 'existing-populated']) {
        await t.test(`formats=${mask} input=${input} contact=${initial}`, async () => {
          const f = fixture(formats);
          if (initial !== 'new') f.seed(initial === 'existing-populated' ? 2 : 0);
          f.seed(1, other);
          const before = structuredClone([...f.rows.values()]);
          const contact = structuredClone(f.contacts.get(phone));
          const h = new PmsChatHistory(f.transport, input), m = memory(h);
          assert.equal(h.phone, phone, 'session identity must remain unchanged');
          const loaded = await m.loadMemoryVariables({ input: 'Oi' });
          assert.deepEqual(loaded.chat_history.map(m => m.content), initial === 'existing-populated' ? ['m0', 'm1'] : []);
          assert.deepEqual([...f.rows.values()], before, 'reading does not migrate rows');
          if (contact) assert.deepEqual(f.contacts.get(phone), contact);
          await m.saveContext({ input: 'Oi' }, { output: 'Olá' });
          const reloaded = await memory(new PmsChatHistory(f.transport, input.startsWith('+') ? phone : '+' + phone)).loadMemoryVariables({});
          assert.deepEqual(reloaded.chat_history.map(m => m.content), [...loaded.chat_history.map(m => m.content), 'Oi', 'Olá']);
          assert.equal(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/contacts')).length, initial === 'new' ? 1 : 0);
          for (const call of f.calls) {
            if (call.method === 'GET') {
              const url = new URL(call.url);
              assert.equal(url.searchParams.get('phone'), phone);
              assert.ok(!url.search.includes('+'), 'no literal plus in query strings');
            }
            if (call.method === 'POST') assert.equal(call.body.phone, phone);
          }
          await h.clear();
          assert.equal([...f.rows.values()].filter(row => row.phone === phone).length, 0);
          assert.equal([...f.rows.values()].filter(row => row.phone === other).length, 1);
          assert.equal(f.contacts.size, 2);
        });
      }
    }
  }
});

test('all four identity checks reject different and malformed API phones', async t => {
  for (const route of phoneRoutes) {
    for (const returned of [other, '+' + other, undefined, null, 5511999990000, '', '1234567', '1234567890123456',
      '012345678', '+012345678', '++' + phone, phone + '+', '55+11999990000', '%2B' + phone,
      ' ' + phone, phone + '\n', '+55 (11) 99999-0000', phone + '@s.whatsapp.net']) {
      await t.test(`${route} rejects ${JSON.stringify(returned)}`, async () => {
        const f = fixture();
        if (route !== 'POST contacts') f.seed(1);
        const transport = async options => {
          const response = await f.transport(options);
          if (options.method + ' ' + new URL(options.url).pathname.replace('/api/v1/', '') === route) {
            for (const row of response.body.data.items ?? [response.body.data]) {
              row.phone = returned;
              row.contact_phone = '+' + phone; // Alternate fields cannot rescue a wrong identity.
            }
          }
          return response;
        };
        const h = new PmsChatHistory(transport, '+' + phone);
        await assert.rejects(route.startsWith('POST') ? h.addUserMessage('Oi') : h.getMessages(), e => e.code === 'invalid_response');
        if (route !== 'POST message-history') assert.equal(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/message-history')).length, 0);
        assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0);
      });
    }
  }
});

test('phone boundaries and invalid inputs fail before any HTTP request', () => {
  for (const valid of ['12345678', '123456789012345', phone]) {
    for (const input of [valid, '+' + valid]) assert.equal(normalizePhone(input), valid);
  }
  let calls = 0;
  for (const input of [undefined, null, 5511999990000, '', '+', '1234567', '+1234567', '1234567890123456',
    '+1234567890123456', '012345678', '+012345678', '++' + phone, '+ +' + phone, phone + '+',
    '55+11999990000', '%2B' + phone, phone + '@s.whatsapp.net', '{{ telefone }}']) {
    assert.throws(() => new PmsChatHistory(async () => { calls++; }, input), e => e.code === 'invalid_phone');
  }
  assert.equal(calls, 0);
});

test('prefixed contact creation race and committed write retry preserve keys and bodies', async () => {
  const formats = Object.fromEntries(phoneRoutes.map(route => [route, true]));
  const f = fixture(formats);
  f.hook((options, path) => {
    if (options.method === 'POST' && path === '/contacts') {
      f.contacts.set(phone, { phone, name: 'Concurrent', flag: true });
      return { statusCode: 409, body: { code: 'record_exists' } };
    }
  });
  let lose = true;
  const transport = async options => {
    const response = await f.transport(options);
    if (options.method === 'POST' && options.url.endsWith('/message-history') && lose) {
      lose = false;
      throw Object.assign(new Error('lost committed response'), { code: 'ETIMEDOUT' });
    }
    return response;
  };
  await new PmsChatHistory(transport, '+' + phone).addUserMessage('Oi');
  const writes = f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/message-history'));
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(f.rows.size, 1);
  assert.equal(f.contacts.get(phone).name, 'Concurrent');
});

test('prefixed paginated history preserves IDs, versions and ordering validation', async () => {
  const formats = Object.fromEntries(phoneRoutes.map(route => [route, true]));
  const f = fixture(formats); f.seed(205);
  assert.equal((await new PmsChatHistory(f.transport, '+' + phone).getMessages()).length, 205);
  for (const mutate of [
    row => { row.id = '0'; },
    row => { row.id = '9223372036854775808'; },
    row => { row.version = 'invalid'; },
    row => { delete row.message; },
  ]) {
    const transport = async options => {
      const response = await f.transport(options);
      if (options.url.includes('/message-history?')) mutate(response.body.data.items[0]);
      return response;
    };
    await assert.rejects(new PmsChatHistory(transport, phone).getMessages(), e => e.code === 'invalid_response');
  }
  const transport = async options => {
    const response = await f.transport(options);
    if (options.url.includes('/message-history?')) response.body.data.items.reverse();
    return response;
  };
  await assert.rejects(new PmsChatHistory(transport, phone).getMessages(), e => e.code === 'invalid_response');
});

test('same phone with different prefixes remains isolated by authenticated transport', async () => {
  const formats = Object.fromEntries(phoneRoutes.map(route => [route, true]));
  const companyA = fixture(formats), companyB = fixture(formats);
  const a = new PmsChatHistory(companyA.transport, phone), b = new PmsChatHistory(companyB.transport, '+' + phone);
  await a.addUserMessage('Empresa A');
  assert.deepEqual(await b.getMessages(), []);
  await b.addUserMessage('Empresa B');
  assert.deepEqual((await a.getMessages()).map(m => m.content), ['Empresa A']);
  assert.deepEqual((await b.getMessages()).map(m => m.content), ['Empresa B']);
  await a.clear();
  assert.deepEqual((await b.getMessages()).map(m => m.content), ['Empresa B']);
});
