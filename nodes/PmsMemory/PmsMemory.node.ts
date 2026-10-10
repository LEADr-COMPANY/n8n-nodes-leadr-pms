import { BufferWindowMemory } from '@langchain/classic/memory';
import type { IDataObject, INodeType, INodeTypeDescription, ISupplyDataFunctions, SupplyData } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { normalizePhone, PmsChatHistory, PmsMemoryError } from '../../lib/PmsChatHistory';

export class PmsMemory implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'LEADr PMS Memory',
    name: 'pmsMemory',
    icon: 'file:pms.svg',
    group: ['transform'],
    version: 1,
    description: 'Lê e grava a memória do agente no histórico da PMS pelo telefone',
    defaults: { name: 'LEADr PMS Memory' },
    inputs: [],
    outputs: [NodeConnectionTypes.AiMemory],
    outputNames: ['Memory'],
    credentials: [{ name: 'httpHeaderAuth', required: true }],
    codex: { categories: ['AI'], subcategories: { AI: ['Memory'] } },
    properties: [
      { displayName: 'Selecione a credencial Header Auth da PMS (Authorization: Bearer). Conecte este node à entrada Memory do agente.', name: 'notice', type: 'notice', default: '' },
      { displayName: 'Telefone do Cliente', name: 'phone', type: 'string', default: '', required: true,
        placeholder: '5511999990000', description: 'Telefone com DDI e DDD. Aceita expressão. A empresa é definida pela credencial PMS.' },
      { displayName: 'Opções', name: 'options', type: 'collection', placeholder: 'Adicionar opção', default: {},
        options: [
          { displayName: 'Janela de Contexto', name: 'contextWindowLength', type: 'number', default: 15,
            typeOptions: { minValue: 1, numberPrecision: 0 },
            description: 'Quantidade de interações no contexto, como no Postgres Chat Memory. Cada interação equivale a duas mensagens; o histórico completo permanece salvo.' },
        ] },
    ],
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    let phone: string;
    let k: number;
    try {
      phone = normalizePhone(this.getNodeParameter('phone', itemIndex));
      const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
      k = options.contextWindowLength === undefined ? 15 : Number(options.contextWindowLength);
      if (!Number.isSafeInteger(k) || k < 1) throw new PmsMemoryError('invalid_window', 'A janela de contexto deve ser um inteiro maior que zero.');
    } catch (error) {
      throw new NodeOperationError(this.getNode(), error instanceof PmsMemoryError ? error.message : 'Configuração de memória inválida.', { itemIndex });
    }
    const history = new PmsChatHistory(
      options => this.helpers.httpRequestWithAuthentication.call(this, 'httpHeaderAuth', options),
      phone,
    );
    const memory = new BufferWindowMemory({
      chatHistory: history, memoryKey: 'chat_history', inputKey: 'input',
      outputKey: 'output', returnMessages: true, k,
    });
    // Show operations in the n8n execution without logging credentials or duplicating API reads.
    const observe = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
      const { index } = this.addInputData(NodeConnectionTypes.AiMemory, [[{ json: { operation } }]]);
      try {
        const result = await run();
        this.addOutputData(NodeConnectionTypes.AiMemory, index, [[{ json: { operation, success: true } }]]);
        return result;
      } catch (error) {
        const safe = new NodeOperationError(this.getNode(),
          error instanceof PmsMemoryError ? error.message : 'Falha na memória PMS. Confira o formato das mensagens e a configuração.', { itemIndex });
        this.addOutputData(NodeConnectionTypes.AiMemory, index, safe);
        throw safe;
      }
    };
    const load = memory.loadMemoryVariables.bind(memory);
    const save = memory.saveContext.bind(memory);
    const clear = memory.clear.bind(memory);
    memory.loadMemoryVariables = values => observe('loadMemoryVariables', () => load(values));
    memory.saveContext = (input, output) => observe('saveContext', () => save(input, output));
    memory.clear = () => observe('clear', clear);
    return { response: memory };
  }
}
