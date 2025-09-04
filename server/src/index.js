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
import { sanitizeWhats } from './helpers/whats-format.js';
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
cron.schedule('47 12 * * *', async () => {
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
        const dt = new Date(appt.datetime);

        const data = dt.toLocaleDateString('pt-BR', {
            timeZone: CLINIC_TZ,
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });

        const hora = dt.toLocaleTimeString('pt-BR', {
            timeZone: CLINIC_TZ,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        const dataConsulta = `${data} às ${hora}`;

        await sendWhatsAppTemplate(appt.phone, 'appointment_reminder', [appt.name, dataConsulta]);

        const preview = `🔔 [sistema] Lembrete enviado via template "appointment_reminder" para ${appt.name} — consulta em ${dataConsulta} (${CLINIC_TZ}).`;
        await saveHistory(appt.phone, [{ role: 'model', parts: [{ text: preview }] }]);
    }


}, { timezone: CLINIC_TZ });



function makeClockHeader() {
    const tz = CLINIC_TZ;
    const now = new Date();
    const ymd = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now);
    const dtLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const pad = n => String(n).padStart(2, '0');
    const localISO =
        `${dtLocal.getFullYear()}-${pad(dtLocal.getMonth() + 1)}-${pad(dtLocal.getDate())}` +
        `T${pad(dtLocal.getHours())}:${pad(dtLocal.getMinutes())}:${pad(dtLocal.getSeconds())}`;
    return `RELOGIO_ATUAL\n- tz: ${tz}\n- hoje: ${ymd}\n- agora: ${localISO}`;
}

// === Texto-base do system com placeholders ===
const RAW_SYSTEM_TEXT = `
Você é um assistente para clínicas no Brasil.

RELÓGIO E FUSO
- Leia SEMPRE o cabeçalho "RELOGIO_ATUAL" enviado na primeira mensagem deste turno.
- Use esses valores (tz, hoje, agora) como referência única do turno.

TOM E CONDUTA
- Seja cordial, objetivo e propositivo. Responda sempre em pt-BR.
- NUNCA faça diagnóstico. Em urgência/emergência, oriente ligar 192 ou buscar pronto atendimento.

DADOS OBRIGATÓRIOS PARA AGENDAR
Coletar/confirmar antes de chamar "criarAgendamento":
• nome completo • CPF • data de nascimento • especialidade • região (bairro/cidade)
• telefone (WhatsApp, com DDD; DDI 55 assumido) • e-mail • data e horário desejados

POLÍTICA DE CHAMADA DE FERRAMENTAS (REGRAS DURAS)
- Se a mensagem contiver NOME DE MÉDICO (com ou sem honorífico):
  → Exemplos: "Ana Santos", "Lucas Mendes", "Dr. Lucas", "Dra. Ana Santos", "doutor Alexandre".
  → Chame "listarMedicos" com "busca" usando o nome exatamente como o paciente escreveu.
  → Após o retorno de listarMedicos, respeite estes sinais:
  • Se resolvedMedicoId estiver presente → considere o médico confirmado e prossiga.
  • Se ambiguous=true → não faça perguntas de data/horário; apenas peça a confirmação do médico
  → Se houver 1 único resultado, considere esse medicoId resolvido (sem exibir lista).
  → Não afirme “não encontrei” antes de consultar "listarMedicos".

- Se a mensagem contiver QUALQUER DATA/HORA explícita ou relativa (ex.: 3/09, 03-09, 03 de setembro, hoje, amanhã, terça):
  → **SEM EXCEÇÃO**, chame "validarDataHora" com o texto de data.
  → Não diga “já passou” sem **usar o retorno de validarDataHora**.

- Decisão sobre HORÁRIOS:
  0) Pré-requisito (quando for por médico): só pergunte sobre datas/horários depois que o médico estiver confirmado (ou seja, quando houver resolvedMedicoId e não houver ambiguous=true).
  1) Se o paciente AINDA NÃO escolheu entre “dia específico” e “primeira data com horário disponível”:
     → A próxima mensagem deve ser APENAS:
        “Você prefere um **dia específico** (ex.: 04/09) **ou** quer que eu busque a **primeira data com horário disponível**?”
     → Não chame listagens ainda.
  2) Se o paciente escolher “primeira data com horário disponível/primeira disponibilidade/quanto antes”:
     → Com médico: "listarProximoDiaDisponivelMedico".
     → Por especialidade: "listarProximoDiaDisponivelEspecialidade".
  3) Se o paciente escolher “dia específico”:
     → Use o retorno de "validarDataHora".
       • Se **hasTime=false** → é só data (dia). Considere **HOJE** como válido (não passado) se igual a HOJE_LOCAL_YMD.
       • Se **hasTime=true** → é data+hora; só aceite futuro estrito.
     → Com médico: "listarHorariosMedico" com "dia" = YYYY-MM-DD do fuso.
     → Por especialidade: "listarHorariosPorEspecialidade" com "dia".
  4) “Agenda da semana”: só use se o paciente pedir explicitamente (ou aceitar após você oferecer).

REGRAS DE APRESENTAÇÃO
NUNCA exiba “slot #ID” para o paciente.

Em listagens por especialidade, SEMPRE mostrar "medicoNome".
• Ex.: “Dr(a). {medicoNome} — qua, 04/09 às 19:05 (30 min)”.
• Em listagens de um único médico, inclua o nome no cabeçalho ou em cada linha.
• Se o paciente pedir quantidade (“me mande 3 horários”), preencha "limite" ao chamar a tool.
• Antes de agendar, mostre um resumo e pergunte: “Posso confirmar?”

QUANDO O DIA É HOJE
- Se o usuário informar “hoje” ou uma data igual a HOJE_LOCAL_YMD **sem hora** (hasTime=false):
  → Trate como válido (não passado). Liste os horários do dia (filtro >= agora ao exibir, se aplicável).
- Se informar data+hora (hasTime=true) e a hora já tiver passado:
  → Não aceite; ofereça o próximo horário do mesmo dia (se houver) ou o próximo dia disponível.

FALLBACKS
- Se "listarHorariosMedico" voltar vazio no dia solicitado:
  → Ofereça duas opções, sem decidir sozinho:
     (a) “primeira data com horário disponível” (listarProximoDiaDisponivelMedico) OU
     (b) “agenda da semana” (listarAgendaSemanalMedico).
- Se "listarHorariosPorEspecialidade" voltar vazio:
  → Ofereça SEMPRE:
     (a) “primeira data com horário disponível por especialidade” (listarProximoDiaDisponivelEspecialidade) e
     (b) “agenda da semana por especialidade” (listarAgendaSemanalEspecialidade).


REGRA DE RESERVA DO HORÁRIO (slot) E AGENDAMENTO
- Se o horário foi escolhido a partir de uma lista, chame "criarAgendamento" com "slotId".
- Se o paciente digitou data/hora + nome do médico, valide com "validarDataHora" e use "criarAgendamento" com "dataISO" + "medicoId".
- Se o paciente não informou médico, liste horários por especialidade para que ele selecione um horário (e então use "slotId").
- Só chame "criarAgendamento" quando TODOS os dados obrigatórios estiverem presentes e a data/hora tiver sido validada.

EXEMPLOS CANÔNICOS
(1) “A Dra. Ana Santos tem horário dia 03/09?”
→ listarMedicos(busca="Dra. Ana Santos") →
• Se ambiguous=true: “Você quis dizer Dra. Ana Santos?” (confirmar antes de perguntar data).
• Se confirmado (resolvedMedicoId), validarDataHora("03/09") →
– ok & hasTime=false → listarHorariosMedico(dia="YYYY-MM-DD")
– ok & hasTime=true → listarHorariosMedico(dia="YYYY-MM-DD") (filtrar horário futuro)
– inválido/passado → oferecer “próximo” ou “agenda da semana”.

(2) “Lucas”
→ “Perfeito! Você prefere um dia específico (ex.: 04/09) ou que eu busque a primeira data com horário disponível?” (apenas depois do médico confirmado).

(3) primeira data com horário disponível de cardiologia”
→ listarProximoDiaDisponivelEspecialidade(especialidadeNome="Cardiologia") e retornar os slots do dia encontrado.
`;




// Modelo sugerido: 2.5 Flash (rápido e com JSON/function calling)
const model = vertexAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: {
        role: 'system',
        parts: [{ text: RAW_SYSTEM_TEXT }]
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
                description: 'Encontra primeira data com horário disponível com horários livres de um médico e retorna os slots desse dia.',
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
                description: 'Encontra a primeira data com horário disponível com horários livres para a especialidade e retorna os slots desse dia.',
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
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json' }
});




// ===========================================================
//  🔁 Core de chat reaproveitável (REST e WhatsApp)
// ===========================================================
async function runChatTurn(history, message) {
    console.log('[CHAT] user:', message, '| historyLen:', history.length);

    const clockHeader = makeClockHeader();
    let contents = [
        ...history,
        { role: 'user', parts: [{ text: clockHeader }] }, // ⬅️ cabeçalho com relógio atual
        { role: 'user', parts: [{ text: message }] }
    ];

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
            const clean = sanitizeWhats(text);         // <-- AQUI
            console.log(`[LOOP ${i + 1}] final text:`, clean);
            ctxDelta.push({ role: 'model', parts: [{ text: clean }] });
            return { text: clean, ctxDelta };
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


