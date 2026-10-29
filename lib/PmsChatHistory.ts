import { randomUUID } from 'node:crypto';
import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import { mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } from '@langchain/core/messages';
import type { BaseMessage, StoredMessage } from '@langchain/core/messages';
import type { IHttpRequestOptions } from 'n8n-workflow';

export const PMS_URL = 'https://pms.leadr.company/api/v1';
export type Transport = (options: IHttpRequestOptions) => Promise<unknown>;
type RecordValue = Record<string, unknown>;
type HistoryRow = { id: string; phone: string; version: string; message: unknown };
const object = (v: unknown): v is RecordValue => typeof v === 'object' && v !== null && !Array.isArray(v);
const idPattern = /^[1-9][0-9]{0,18}$/;
const validId = (v: unknown): v is string =>
  typeof v === 'string' && idPattern.test(v) && BigInt(v) <= 9223372036854775807n;

export class PmsMemoryError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = 'PmsMemoryError';
  }
}

/** Empty and missing settings preserve the endpoint used by existing workflows. */
export function normalizeEndpoint(value: unknown): string {
  if (value === undefined || value === null || value === '') return PMS_URL;
  if (typeof value === 'string') {
    if (!value.trim()) return PMS_URL;
    const endpoint = value.trim().replace(/\/+$/, '');
    try {
      const url = new URL(endpoint);
      if (url.protocol === 'https:' && url.hostname && !url.username && !url.password &&
          !url.search && !url.hash && !endpoint.includes('?') && !endpoint.includes('#')) return endpoint;
    } catch { /* Report a safe configuration error without exposing the URL. */ }
  }
  throw new PmsMemoryError('invalid_endpoint', 'Informe um endpoint HTTPS válido, sem credenciais, query string ou fragmento.');
}

export function normalizePhone(value: unknown): string {
  // Do not silently turn arbitrary text, JIDs or expressions into a different session.
  if (typeof value !== 'string' || !/^\+?[0-9\s().-]+$/.test(value.trim())) {
    throw new PmsMemoryError('invalid_phone', 'Informe o telefone com DDI e DDD.');
  }
  const phone = value.replace(/[\s()+.-]/g, '');
  if (!/^[1-9][0-9]{7,14}$/.test(phone)) {
    throw new PmsMemoryError('invalid_phone', 'Informe o telefone com DDI e DDD, de 8 a 15 dígitos.');
  }
  return phone;
}

function invalidResponse(): never {
  throw new PmsMemoryError('invalid_response', 'A PMS retornou um histórico incompatível. Confira o contrato da API.');
}

function matchesPhone(value: unknown, phone: string): boolean {
  // API identity fields allow only digits and one optional leading '+'.
  // Keep the canonical session/requests unchanged and reject malformed responses.
  return typeof value === 'string' && value === value.trim() && /^\+?[1-9][0-9]{7,14}$/.test(value) &&
    normalizePhone(value) === phone;
}

function apiError(status: number, body: unknown): PmsMemoryError {
  const rawCode = object(body) ? body.code : undefined;
  const code = typeof rawCode === 'string' && /^[a-z_]{1,64}$/.test(rawCode) ? rawCode : 'http_error';
  const hints: Record<string, string> = {
    scope_missing: 'A credencial precisa de conversations:read, conversations:write e guests:contact.',
    contact_not_found: 'O contato foi removido durante o atendimento. Reinicie a conversa antes de gravar.',
    version_conflict: 'Uma mensagem foi alterada durante a limpeza. A versão nova foi preservada.',
  };
  const hint = hints[code] ?? (status === 401 ? 'Confira a credencial PMS.'
    : status === 413 ? 'Mensagem maior que o limite de 64 KiB da API.'
    : status === 429 ? 'Limite de requisições da PMS atingido; tente novamente mais tarde.'
    : 'Confira a disponibilidade e as permissões da API.');
  return new PmsMemoryError(code, `PMS HTTP ${status} (${code}). ${hint}`, status);
}

/** One instance per memory supply; no global cache or company identifier supplied by callers. */
export class PmsChatHistory extends BaseListChatMessageHistory {
  lc_namespace = ['leadr', 'pms', 'chat_history'];
  readonly phone: string;
  private initialized?: Promise<void>;

  private readonly endpoint: string;

  constructor(private readonly transport: Transport, phone: string, endpoint?: string) {
    super();
    this.phone = normalizePhone(phone);
    this.endpoint = normalizeEndpoint(endpoint);
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: RecordValue): Promise<RecordValue> {
    if (body && Buffer.byteLength(JSON.stringify(body), 'utf8') > 65536) {
      throw new PmsMemoryError('payload_too_large', 'Mensagem maior que o limite de 64 KiB da API. Nenhum conteúdo foi truncado.', 413);
    }
    const options: IHttpRequestOptions = {
      method, url: this.endpoint + path, json: true, timeout: 30000,
      disableFollowRedirect: true, returnFullResponse: true, ignoreHttpStatusErrors: true,
      headers: { Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': 'pms-memory-' + randomUUID() } : {}) },
      ...(body ? { body: body as IHttpRequestOptions['body'] } : {}),
    };
    // A lost response may follow a committed write. Keep the SAME key and body on the one retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: unknown;
      try {
        response = await this.transport(options);
      } catch (error) {
        const code = object(error) ? error.code : undefined;
        if (attempt === 0 && ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN'].includes(String(code))) continue;
        // Never attach raw transport errors: they may contain credentials or message contents.
        throw new PmsMemoryError('transport_error', 'Não foi possível acessar a PMS. Confira a conexão e a credencial; a gravação pode ter sido recebida.');
      }
      if (!object(response) || typeof response.statusCode !== 'number') invalidResponse();
      const status = response.statusCode;
      if ([500, 502, 503, 504].includes(status) && attempt === 0) continue;
      if (status < 200 || status >= 300) throw apiError(status, response.body);
      // The PMS returns a root [] for empty reads. Normalize only the two
      // collection GETs; a missing or malformed write response is still an error.
      if (status === 200 && method === 'GET' &&
          (path.startsWith('/contacts?') || path.startsWith('/message-history?')) &&
          Array.isArray(response.body) && response.body.length === 0) {
        return { items: [], next_cursor: null };
      }
      if (!object(response.body) || !object(response.body.data)) invalidResponse();
      return response.body.data;
    }
    return invalidResponse();
  }

  private async ensureContact(): Promise<void> {
    const read = async () => {
      const result = await this.request('GET', '/contacts?phone=' + encodeURIComponent(this.phone) + '&limit=1');
      if (!Array.isArray(result.items) || result.items.length > 1 ||
          result.items.some(row => !object(row) || !matchesPhone(row.phone, this.phone))) invalidResponse();
      return result.items.length === 1;
    };
    if (await read()) return;
    try {
      const contact = await this.request('POST', '/contacts', { phone: this.phone });
      if (!matchesPhone(contact.phone, this.phone)) invalidResponse();
    } catch (error) {
      if (!(error instanceof PmsMemoryError) || error.code !== 'record_exists' || !(await read())) throw error;
    }
  }

  private initialize(): Promise<void> {
    // Do not resurrect a contact deleted by reset after the first read in this execution.
    return this.initialized ??= this.ensureContact();
  }

  private async rows(): Promise<HistoryRow[]> {
    const rows: HistoryRow[] = [];
    let after = '';
    for (let page = 0; page < 1000; page++) {
      const result = await this.request('GET', '/message-history?phone=' + encodeURIComponent(this.phone) + '&limit=100' + (after ? '&after=' + after : ''));
      if (!Array.isArray(result.items) || result.items.length > 100) invalidResponse();
      let previous = after || '0';
      for (const row of result.items) {
        if (!object(row) || !validId(row.id) || BigInt(row.id) <= BigInt(previous) ||
            !matchesPhone(row.phone, this.phone) || typeof row.version !== 'string' || !/^[a-f0-9]{64}$/.test(row.version) ||
            !('message' in row)) invalidResponse();
        rows.push(row as HistoryRow);
        previous = row.id;
      }
      if (result.next_cursor === null) return rows;
      if (!validId(result.next_cursor) || result.items.length === 0 || result.next_cursor !== previous) invalidResponse();
      after = result.next_cursor;
    }
    throw new PmsMemoryError('history_limit', 'Histórico excede 100.000 mensagens. Leitura interrompida sem usar contexto parcial.');
  }

  async getMessages(): Promise<BaseMessage[]> {
    await this.initialize();
    const rows = await this.rows();
    try {
      const stored = rows.map(row => {
        if (!object(row.message) || typeof row.message.type !== 'string') invalidResponse();
        let message: RecordValue = row.message;
        // Existing PMS workflows write flattened LangChain fields. Normalize only
        // on read, keeping the original type and all metadata; never rewrite history.
        if (message.data === undefined && (typeof message.content === 'string' || Array.isArray(message.content))) {
          const { type, ...data } = message;
          message = { type, data };
        }
        const current = object(message.data) && (typeof message.data.content === 'string' || Array.isArray(message.data.content));
        const legacy = message.data === undefined && typeof message.text === 'string';
        if (!current && !legacy) invalidResponse();
        return message as unknown as StoredMessage;
      });
      return mapStoredMessagesToChatMessages(stored);
    } catch {
      throw new PmsMemoryError('invalid_history', 'Há mensagens incompatíveis com o formato LangChain no histórico da PMS. Nenhuma mensagem foi ignorada.');
    }
  }

  async addMessage(message: BaseMessage): Promise<void> {
    await this.initialize();
    const stored = mapChatMessagesToStoredMessages([message])[0];
    const result = await this.request('POST', '/message-history', { phone: this.phone, message: stored });
    if (!validId(result.id) || !matchesPhone(result.phone, this.phone)) invalidResponse();
  }

  async clear(): Promise<void> {
    // Snapshot first; only history records, never the contact, queue or reservations.
    const rows = await this.rows();
    for (const row of rows) {
      try {
        const result = await this.request('DELETE', '/message-history/' + row.id, { version: row.version });
        if (result.deleted !== true) invalidResponse();
      } catch (error) {
        if (!(error instanceof PmsMemoryError) || error.status !== 404 || error.code !== 'record_not_found') throw error;
      }
    }
  }
}
