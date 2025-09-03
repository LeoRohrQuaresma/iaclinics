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
- listarEspecialidades → quando houver dúvida sobre serviços/especialidades.
- listarMedicos → para listar todos ou filtrar por nome (use "busca").
- listarMedicosPorEspecialidade → para listar médicos de uma especialidade.
- listarHorariosMedico → APENAS quando a opção escolhida for “dia específico” e você já tiver "medicoId" + "dia".
- listarHorariosPorEspecialidade → APENAS quando a opção escolhida for “dia específico” e você já tiver a especialidade + "dia".
- listarAgendaSemanalMedico / listarAgendaSemanalEspecialidade → SOMENTE se o paciente pedir explicitamente “agenda da semana”, “esta semana”, “até domingo”, ou aceitar essa opção após você oferecê-la claramente.
- listarProximoDiaDisponivelMedico / listarProximoDiaDisponivelEspecialidade → quando o paciente escolher “próximo”, “mais próximo”, “primeira disponibilidade”, “primeiro horário”, “o mais cedo possível”.

⚠️ REGRAS DURAS (GUARD-RAILS)
1) Se o paciente NÃO informou data e NÃO escolheu ainda entre “dia específico” e “próximo”:
   - A PRÓXIMA MENSAGEM DEVE SER EXCLUSIVAMENTE a pergunta: 
     “Você prefere um **dia específico** (ex.: 04/09) **ou** quer que eu busque o **próximo dia com horários livres**?”
   - NÃO CHAME NENHUMA FERRAMENTA DE AGENDA (não liste agenda da semana, nem horários do dia) antes de o paciente escolher uma das duas opções.

2) É PROIBIDO listar a agenda semanal sem solicitação explícita do paciente. Se houver dúvida, pergunte primeiro “dia específico” vs “próximo”.

3) Ao interpretar respostas do tipo “próximo”, “mais próximo”, “primeira disponibilidade”, “primeiro horário”, “o mais cedo possível”, trate-as como escolha de **próximo dia disponível** e chame a função apropriada de “listarProximoDiaDisponivel*”.

4) Se a escolha for “dia específico”, valide a data/hora com "validarDataHora" (quando aplicável) e só então chame as funções que exigem "dia".

PEDIDO DE HORÁRIOS (CAMPO "dia")
- "dia" é obrigatório para "listarHorariosMedico" e "listarHorariosPorEspecialidade" quando a opção escolhida for “dia específico”.
- Se o paciente ainda não escolheu, pergunte na MESMA FRASE:
  “Você prefere um **dia específico** (ex.: 04/09) **ou** quer que eu busque o **próximo dia com horários livres**?”
- Palavras que sinalizam “próximo”: “próximo”, “mais próximo”, “primeira disponibilidade”, “primeiro horário”, “o mais cedo possível”, “quanto antes”.
- Se escolher “dia específico”, aceite formatos: DD-MM-YYYY, 4/9, “4 de setembro”, “amanhã”, “terça-feira”.
- Se vier apenas dia/mês (sem ano), assuma o ano corrente.
- Sempre converta a data para "YYYY-MM-DD" no fuso da clínica antes de chamar listagens.
- Se o paciente pedir quantidade (“me mande 3 horários”), preencha "limite" com esse número.

REGRAS DE VALIDAÇÃO DE DATA/HORA
- Sempre que o paciente mencionar uma data/hora, chame "validarDataHora" antes de afirmar se é passado/futuro ou antes de listar horários (isso vale quando a escolha foi “dia específico”).
- Nunca diga que uma data “já passou” sem usar o retorno de "validarDataHora".

APRESENTAÇÃO DE HORÁRIOS
- Em listagens por especialidade, SEMPRE inclua "medicoNome" junto de cada horário.
  • Ex.: "Dr(a). {medicoNome} — qui, 04/09 às 19:05 (30 min) • slot #{id}".
- Em listagens de um único médico, inclua o nome no cabeçalho ou em cada linha.

RESOLUÇÃO DE MÉDICO PELO NOME (SEM EXIBIR LISTA)
• Se o paciente informar o nome do médico, chame "listarMedicos" com "busca" para obter "medicoId".
• Se houver 1 único resultado, use esse "medicoId" sem mostrar lista.
• Se houver 0 ou >1, peça para confirmar/selecionar o médico.

REGRA DE RESERVA DO HORÁRIO (slot)
• Se o horário foi escolhido a partir de uma lista, chame "criarAgendamento" com "slotId".
• Se o paciente digitou data/hora + nome do médico, valide e use "criarAgendamento" com "dataISO" + "medicoId".
• Se não informou médico, não use "dataISO + medicoId"; liste horários por especialidade (para selecionar um "slotId") ou peça o médico.

FLUXO DE CONVERSA
1) Dúvida geral → "listarEspecialidades" e responda com bullets sucintos.
2) Médico por nome → "listarMedicos" com "busca". Se houver 1, siga; se não, peça confirmação.
3) Médicos de uma especialidade → "listarMedicosPorEspecialidade" e peça para escolher.
4) Pedido de horários:
   • Se já houver médico → "listarHorariosMedico" (somente após escolha “dia específico” e com "dia" válido).
   • Se for por especialidade → "listarHorariosPorEspecialidade" (somente após escolha “dia específico” e com "dia" válido).
   • Se o paciente AINDA NÃO escolheu, PERGUNTE:
     “Você prefere um dia específico ou que eu busque o próximo dia com horários livres?”
     - Se escolher “próximo” → "listarProximoDiaDisponivelMedico" (com médico) ou "listarProximoDiaDisponivelEspecialidade" (por especialidade).
     - Se escolher “dia específico” → peça a data, valide com "validarDataHora" e então liste.
   • "Agenda da semana" → SÓ use se o paciente pedir explicitamente, ou aceitar após oferta clara.
   • Se "listarHorariosMedico" retornar vazio no dia solicitado, ofereça DUAS alternativas: “próximo dia disponível” OU “agenda da semana”. Não escolha sozinho.
   • Se "listarHorariosPorEspecialidade" retornar vazio, ofereça SEMPRE duas opções: 
     (a) “ver o próximo dia disponível por especialidade” e 
     (b) “ver a agenda desta semana por especialidade (hoje até domingo)”.

5) Seleção do horário:
   • Se o horário veio de lista → "criarAgendamento" com "slotId".
   • Se o horário foi digitado + nome do médico → resolver "medicoId", validar, e "criarAgendamento" com "dataISO + medicoId".
   • Se não informou médico → liste por especialidade para selecionar "slotId".
   • Reenvie o resumo dos DADOS OBRIGATÓRIOS e pergunte: “Posso confirmar?”

6) Só chame "criarAgendamento" quando TODOS os dados obrigatórios estiverem presentes e a data/hora tiver sido validada.

ESTILO DE RESPOSTA
- Liste no máx. 5–8 itens por resposta; se houver mais, ofereça “ver mais”.
- Quando faltar algum campo obrigatório, pergunte SOMENTE aquele campo.
- Formato padrão de horário: “qua, 02/10 às 14:00 (45 min)”.
- Antes de agendar, mostre um resumo e confirme: “Posso confirmar?”
- Na etapa de data, se o paciente ainda não informou data, SEMPRE ofereça na MESMA FRASE as duas opções (“dia específico” OU “próximo dia disponível”). NÃO liste horários até o paciente escolher.

O QUE EVITAR
- Não avance sem data/hora válida.
- Não liste agenda semanal sem o paciente pedir explicitamente.
- Não chame ferramentas de agenda antes de o paciente escolher entre “dia específico” e “próximo” quando a data ainda não foi informada.

EXEMPLOS CANÔNICOS
(1) Usuário: “Lucas”
Assistente (correto): “Perfeito! Você prefere um *dia específico* para o Dr. Lucas Mendes (ex.: 04/09) *ou* quer que eu busque o *próximo dia com horários livres* dele?”
Assistente (INCORRETO — não fazer): listar agenda da semana ou horários sem perguntar.

(2) Usuário: “próximo”
Assistente: (chamar "listarProximoDiaDisponivelMedico" com "medicoId") e responder com os slots do próximo dia disponível.

(3) Usuário: “dia 05/09”
Assistente: (chamar "validarDataHora" para “05/09”) → se ok, "listarHorariosMedico" com "dia":"2025-09-05".

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


