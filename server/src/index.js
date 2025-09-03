import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { VertexAI } from '@google-cloud/vertexai';
import { z, ZodError } from 'zod';
import { supabase } from './supabase.js';
import crypto from 'crypto';
import { getHistory, saveHistory, alreadyProcessed } from './session.js';
import cron from 'node-cron';
import { nextDayRangeUTC, dayRangeUTCFromYYYYMMDD } from './helpers/datetime.js';
import { isValidCPF, isValidEmail, normalizeWhatsNumber, isValidWhatsNumber } from './helpers/validators.js';
import { normalizeDateTimeToUTC, normalizeBirthDate } from './helpers/ai-normalize.js';
import { vertexAI } from './libs/vertex.js';
import { createWhatsAppRouter, sendWhatsAppTemplate } from './whatsapp.js';
import {
    validarDataHora,
    criarAgendamentoDB,
    listarEspecialidadesDB,
    listarMedicosDB,
    listarMedicosPorEspecialidadeDB,
    listarHorariosMedicoDB,
    listarHorariosPorEspecialidadeDB,
    listarProximoDiaDisponivelMedicoDB,
    listarAgendaSemanalMedicoDB,
    listarAgendaSemanalEspecialidadeDB,
    listarProximoDiaDisponivelEspecialidadeDB

} from './tools/llm-tools.js';



const app = express();
app.use(cors());

app.use('/whatsapp', createWhatsAppRouter({
    runChatTurn,
    getHistory,
    saveHistory,
    alreadyProcessed
}));

app.use(express.json());

const CLINIC_TZ = process.env.CLINIC_TZ || 'America/Sao_Paulo';

// cron job → roda todo dia às 06:00
cron.schedule('5 16 * * *', async () => {
    console.log('⏰ Rodando job de lembretes...');

    const { start, end } = nextDayRangeUTC(CLINIC_TZ);

    const { data: appointments, error } = await supabase
        .from('appointments')
        .select('id, datetime, phone, name')
        .eq('status', 'confirmado')
        .gte('datetime', start.toISOString())
        .lt('datetime', end.toISOString());


    if (error) {
        console.error('❌ Erro ao buscar consultas:', error);
        return;
    }

    for (const appt of appointments) {
        const userId = appt.phone; // WhatsApp ID salvo no campo `contact`
        const dataConsulta = new Date(appt.datetime).toLocaleString('pt-BR', { timeZone: CLINIC_TZ });
        await sendWhatsAppTemplate(userId, 'appointment_reminder', [appt.name, dataConsulta]);
    }
}, { timezone: CLINIC_TZ });


// Modelo sugerido: 2.5 Flash (rápido e com JSON/function calling)
const model = vertexAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: {
        role: 'system',
        parts: [{
            text: `
Você é um assistente para clínicas no Brasil.

TOM E CONDUTA
- Seja cordial, objetivo e propositivo. Responda sempre em pt-BR.
- NUNCA faça diagnóstico. Em urgência/emergência, oriente ligar 192 ou buscar pronto atendimento.

DADOS OBRIGATÓRIOS PARA AGENDAR
Coletar e confirmar, antes de chamar "criarAgendamento":
• nome completo
• CPF
• data de nascimento
• especialidade
• região (bairro/cidade)
• telefone (WhatsApp, com DDI e DDD — ex.: 55 11 91234-5678)
• e-mail
• data e horário desejados para a consulta

QUANDO CHAMAR CADA FERRAMENTA (TOOLS)
- Para listar especialidades: chame "listarEspecialidades".
- Para listar médicos (todos ou por nome): chame "listarMedicos".
- Para médicos de uma especialidade: chame "listarMedicosPorEspecialidade".
- Para horários de um médico: chame "listarHorariosMedico".
  • Se o usuário pedir uma quantidade específica (“me mande 3 horários”), passe "limite" com esse número.
- Para horários por especialidade: chame "listarHorariosPorEspecialidade".
  • Se souber o ID da especialidade, passe "especialidadeId"; senão, passe "especialidadeNome".
  • Use "limite" se o usuário pedir quantidade.

PEDIDO DE HORÁRIOS (CAMPO "dia")
- "dia" é obrigatório para "listarHorariosMedico" e "listarHorariosPorEspecialidade". Nunca chame essas funções sem "dia".
- Se o usuário não informar a data, pergunte: “Para qual dia?” (aceite entradas como DD-MM-YYYY, 4/9, 4 de setembro, amanhã, terça-feira).
- Se vier apenas dia/mês (sem ano), assuma o ano corrente.
- Sempre converta a data para "YYYY-MM-DD" no fuso da clínica antes de chamar a listagem.
- Se o usuário solicitar uma quantidade de horários (ex.: “me mande 3 horários”), preencha o parâmetro "limite" com esse número.


REGRAS DE VALIDAÇÃO DE DATA/HORA
- Sempre que o usuário mencionar uma data/hora (ex.: “5 de setembro”, “amanhã”, “terça”), chame SEMPRE a função "validarDataHora" antes de afirmar se é passado ou futuro, ou antes de listar horários.
- Nunca responda que uma data “já passou” sem antes chamar "validarDataHora" e usar o retorno dela.


APRESENTAÇÃO DE HORÁRIOS
- Ao listar horários por especialidade, SEMPRE mostre o nome do médico junto do horário retornado pelo tool (campo "medicoNome").
  • Formato sugerido por item: "Dr(a). {medicoNome} — qui, 04/09 às 19:05 (30 min) • slot #{id}".
- Se estiver listando horários de um único médico, também inclua o nome no cabeçalho ou em cada linha.

Resolução de médico pelo nome (sem exibir lista):
• Quando o paciente informar o nome do médico, chame "listarMedicos" com "busca" para obter o medicoId.
• Se houver 1 único resultado, use esse medicoId sem mostrar lista.
• Se houver 0 ou mais de 1, peça para o paciente confirmar/selecionar o médico.

Regra de reserva do horário (slot):
• Se o paciente escolher um horário exibido em lista, chame "criarAgendamento" passando o slotId.
• Se o paciente informar data/hora digitada e também o nome do médico, valide a data/hora e use "criarAgendamento" com dataISO + medicoId (medicoId obtido via "listarMedicos").
• Se o paciente não informar o nome do médico, não use dataISO + medicoId; em vez disso, mostre horários por especialidade (para selecionar um slot) ou peça para escolher o médico.

FLUXO DE CONVERSA
1) Dúvida geral sobre serviços/especialidades → "listarEspecialidades" e responda com uma lista sucinta (bullets).
2) Pedido de médico específico (por nome) → "listarMedicos" com "busca" (parte do nome). Se houver múltiplos, peça para escolher.
3) Pedido “médicos de X” → "listarMedicosPorEspecialidade" (por ID ou nome da especialidade). Liste opções e peça para escolher o médico.
4) Pedido de horários:
   • Se já houver médico definido → "listarHorariosMedico".
   • Se for por especialidade (sem médico) → "listarHorariosPorEspecialidade".
   • Se não vier a data, peça uma data. Se não houver horários, proponha alternativa.
   • Se o usuário pedir “agenda da semana”, (de hoje até domingo, no fuso da clínica), chame listarAgendaSemanalMedico apenas com medicoId.
   • Se o usuário não informar data e pedir “próximo horário/dia disponível”, chame listarProximoDiaDisponivelMedico.
   • Se listarHorariosMedico retornar vazio para o dia solicitado, ofereça automaticamente o próximo dia disponível (chame listarProximoDiaDisponivelMedico) ou a agenda da semana.
   • Se o usuário pedir a agenda da semana por **especialidade** (sem médico definido), chame "listarAgendaSemanalEspecialidade" com "especialidadeNome" ou "especialidadeId".
   • Se o usuário pedir o **próximo dia disponível por especialidade**, chame "listarProximoDiaDisponivelEspecialidade".
   • Se "listarHorariosPorEspecialidade" retornar vazio para o dia solicitado, OFEREÇA SEMPRE duas opções:
    (a) “ver o próximo dia disponível por especialidade” (chame listarProximoDiaDisponivelEspecialidade), e
    (b) “ver a agenda desta semana por especialidade (hoje até domingo)” (chame listarAgendaSemanalEspecialidade).
    Não escolha por conta própria: apresente as duas alternativas na mesma mensagem.

   5) Seleção do horário pelo paciente:
   • Se o horário foi escolhido a partir de uma lista, chame "criarAgendamento" com slotId.
   • Se o horário foi digitado livremente e o paciente citou o nome do médico, resolva o medicoId via "listarMedicos", valide a data/hora e então use "criarAgendamento" com dataISO + medicoId. Se 0 ou >1 médicos, peça para escolher.
   • Se o paciente não informou o médico, liste horários por especialidade para que ele selecione um slot (e então use slotId).
   • Reenvie o resumo dos DADOS OBRIGATÓRIOS e peça confirmação final.

6) Só chame "criarAgendamento" quando TODOS os dados obrigatórios estiverem presentes e a data/hora tiver sido validada.

ESTILO DE RESPOSTA
- Liste opções com no máx. 5–8 itens por resposta; se houver mais, ofereça “ver mais”.
- Quando faltar algum campo obrigatório, pergunte SOMENTE aquele campo.
- Ao propor horários, formate como “qua, 02/10 às 14:00 (45 min)”.
- Antes de agendar, mostre um resumo e pergunte: “Posso confirmar?”

O QUE EVITAR
- Não avance sem data/hora válida.
`.trim()
        }]
    },
    tools: [{
        functionDeclarations: [

            {
                name: 'validarDataHora',
                description: 'Valida/normaliza data e hora fornecidas pelo paciente.',
                parameters: {
                    type: 'OBJECT',
                    properties: { dataText: { type: 'STRING', description: 'Texto de data/hora em pt-BR' } },
                    required: ['dataText']
                }
            },
            {
                name: 'criarAgendamento',
                description: 'Cria um agendamento de consulta.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        nome: { type: 'STRING' },
                        cpf: { type: 'STRING' },
                        nascimento: { type: 'STRING' },
                        especialidade: { type: 'STRING' },
                        regiao: { type: 'STRING' },
                        telefone: { type: 'STRING' },
                        email: { type: 'STRING' },
                        motivo: { type: 'STRING' },
                        dataISO: { type: 'STRING' },
                        slotId: { type: 'STRING', description: 'ID do slot em agenda_slots (recomendado quando o paciente escolhe um horário listado)' },
                        medicoId: { type: 'STRING', description: 'ID do médico (ajuda a localizar o slot quando não vier slotId)' }
                    },
                    required: ['nome', 'cpf', 'nascimento', 'especialidade', 'regiao', 'telefone', 'email', 'dataISO']
                }
            },

            {
                name: 'listarEspecialidades',
                description: 'Retorna a lista de especialidades.',
                parameters: { type: 'OBJECT', properties: {}, required: [] }
            },





            {
                name: 'listarMedicos',
                description: 'Lista médicos cadastrados.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        busca: { type: 'STRING', description: 'Filtro por parte do nome (opcional)' },
                        limite: { type: 'NUMBER', description: 'Máximo de médicos a retornar (padrão 50)' }
                    }
                }
            },
            {
                name: 'listarMedicosPorEspecialidade',
                description: 'Lista médicos de uma especialidade.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        especialidadeId: { type: 'STRING', description: 'ID da especialidade (opcional)' },
                        especialidadeNome: { type: 'STRING', description: 'Nome da especialidade (opcional, usa ilike)' },
                        limite: { type: 'NUMBER', description: 'Máximo de médicos a retornar (padrão 50)' }
                    }
                }
            },
            {
                name: 'listarHorariosMedico',
                description: 'Lista horários livres de um médico em um dia.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        medicoId: { type: 'STRING', description: 'ID do médico' },
                        dia: { type: 'STRING', description: 'YYYY-MM-DD no fuso da clínica (padrão = amanhã)' },
                        limite: { type: 'NUMBER', description: 'Máximo de slots (padrão 12)' }
                    },
                    required: ['medicoId']
                }
            },

            {
                name: 'listarAgendaSemanalMedico',
                description: 'Lista os horários livres do médico **da semana atual** (de hoje até domingo, no fuso da clínica).',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        medicoId: { type: 'STRING', description: 'ID do médico' }
                    },
                    required: ['medicoId']
                }
            },
            {
                name: 'listarProximoDiaDisponivelMedico',
                description: 'Encontra o próximo dia com horários livres de um médico e retorna os slots desse dia.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        medicoId: { type: 'STRING', description: 'ID do médico' },
                        aPartirDe: { type: 'STRING', description: 'YYYY-MM-DD (opcional, padrão = hoje/agora no fuso da clínica)' }
                    },
                    required: ['medicoId']
                }
            },

            {
                name: 'listarHorariosPorEspecialidade',
                description: 'Lista horários livres dos médicos de uma especialidade em um dia.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        especialidadeId: { type: 'STRING', description: 'ID da especialidade (opcional)' },
                        especialidadeNome: { type: 'STRING', description: 'Nome da especialidade (opcional, usa ilike)' },
                        dia: { type: 'STRING', description: 'YYYY-MM-DD no fuso da clínica (padrão = amanhã)' },
                        limite: { type: 'NUMBER', description: 'Máximo de slots (padrão 12)' }
                    }
                }
            },

            {
                name: 'listarAgendaSemanalEspecialidade',
                description: 'Lista horários livres da ESPECIALIDADE na semana atual (de hoje até domingo, no fuso da clínica).',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        especialidadeId: { type: 'STRING', description: 'ID da especialidade (opcional)' },
                        especialidadeNome: { type: 'STRING', description: 'Nome da especialidade (opcional, usa ilike)' }
                    }
                }
            },
            {
                name: 'listarProximoDiaDisponivelEspecialidade',
                description: 'Encontra o próximo dia com horários livres para a especialidade e retorna os slots desse dia.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        especialidadeId: { type: 'STRING', description: 'ID da especialidade (opcional)' },
                        especialidadeNome: { type: 'STRING', description: 'Nome da especialidade (opcional, usa ilike)' },
                        aPartirDe: { type: 'STRING', description: 'YYYY-MM-DD (opcional, padrão = hoje/agora no fuso da clínica)' }
                    }
                }
            }

        ]
    }],
    generationConfig: { temperature: 0.5, responseMimeType: 'application/json' }
});


// ===========================================================
//  🔁 Core de chat reaproveitável (REST e WhatsApp)
// ===========================================================
async function runChatTurn(history, message) {
    console.log('[CHAT] user:', message, '| historyLen:', history.length);

    let contents = [...history, { role: 'user', parts: [{ text: message }] }];
    const ctxDelta = [];

    for (let i = 0; i < 4; i++) {
        console.log(`[LOOP ${i + 1}] sending to model | contentsLen:`, contents.length);
        const r = await model.generateContent({ contents });
        const cand = r.response?.candidates?.[0];
        const parts = cand?.content?.parts || [];
        const fc = parts.find(p => p.functionCall)?.functionCall;

        console.log(`[LOOP ${i + 1}] partsKinds:`, parts.map(p => Object.keys(p)));
        console.log(`[LOOP ${i + 1}] fc:`, fc?.name, fc?.args);

        if (!fc) {
            const text = parts.map(p => p.text).filter(Boolean).join('') ?? '';
            console.log(`[LOOP ${i + 1}] final text:`, text);
            ctxDelta.push({ role: 'model', parts: [{ text }] });
            return { text, ctxDelta };
        }

        let toolResult;
        if (fc.name === 'validarDataHora') {
            toolResult = await validarDataHora(fc.args || {});
        } else if (fc.name === 'criarAgendamento') {
            toolResult = await criarAgendamentoDB(fc.args || {});
        } else if (fc.name === 'listarEspecialidades') {
            toolResult = await listarEspecialidadesDB();
        } else if (fc.name === 'listarMedicos') {
            toolResult = await listarMedicosDB(fc.args || {});
        } else if (fc.name === 'listarMedicosPorEspecialidade') {
            toolResult = await listarMedicosPorEspecialidadeDB(fc.args || {});
        } else if (fc.name === 'listarHorariosMedico') {
            toolResult = await listarHorariosMedicoDB(fc.args || {});

        } else if (fc.name === 'listarAgendaSemanalMedico') {
            toolResult = await listarAgendaSemanalMedicoDB(fc.args || {});
        } else if (fc.name === 'listarProximoDiaDisponivelMedico') {
            toolResult = await listarProximoDiaDisponivelMedicoDB(fc.args || {});
        }
        else if (fc.name === 'listarHorariosPorEspecialidade') {
            toolResult = await listarHorariosPorEspecialidadeDB(fc.args || {});
        } else if (fc.name === 'listarAgendaSemanalEspecialidade') {
            toolResult = await listarAgendaSemanalEspecialidadeDB(fc.args || {});
        } else if (fc.name === 'listarProximoDiaDisponivelEspecialidade') {
            toolResult = await listarProximoDiaDisponivelEspecialidadeDB(fc.args || {});
        } else {
            toolResult = { ok: false, message: `Função desconhecida: ${fc.name}` };
        }



        console.log('[TOOL] result for', fc.name, ':', toolResult);

        const echoCall = { role: 'model', parts: [{ functionCall: fc }] };
        const echoReply = { role: 'tool', parts: [{ functionResponse: { name: fc.name, response: toolResult } }] };

        contents = [...contents, echoCall, echoReply];
        ctxDelta.push(echoCall, echoReply);
    }

    return {
        text: 'Não consegui concluir agora. Vamos tentar novamente?',
        ctxDelta
    };
}


app.listen(process.env.PORT || 8080, () => {
    console.log('API on http://localhost:8080');
});


