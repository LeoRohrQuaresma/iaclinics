import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { VertexAI } from '@google-cloud/vertexai';
import { z, ZodError } from 'zod';
import { supabase } from './supabase.js';
import { normalizeToUTCISO } from './datetime.js';
import crypto from 'crypto';
import { getHistory, saveHistory, alreadyProcessed } from './session.js';
import cron from 'node-cron';






const app = express();
app.use(cors());

// --- 2.2 Webhook de mensagens (POST) ---
// ⚠️ Precisamos do RAW body para validar a assinatura.
app.post('/whatsapp/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        try {
            const rawBody = req.body; // Buffer
            const signature = req.headers['x-hub-signature-256'];
            const isValid = await verifyWebhookSignature(rawBody, signature);

            const body = JSON.parse(rawBody.toString('utf8'));
            console.log('📦 WhatsApp webhook body:', JSON.stringify(body, null, 2), '| signature ok?', isValid);

            if (body?.object === 'whatsapp_business_account') {
                const entry = body.entry || [];
                for (const e of entry) {
                    const changes = e.changes || [];
                    for (const change of changes) {
                        const value = change.value;
                        const messages = value?.messages || [];
                        for (const m of messages) {
                            await processWhatsAppMessage(m, value);
                        }
                    }
                }
            }

            // WhatsApp espera 200 sempre (mesmo com erro interno)
            return res.status(200).send('OK');
        } catch (err) {
            console.error('❌ Erro no webhook POST:', err);
            return res.status(200).send('OK');
        }
    }
);


app.use(express.json());







async function sendWhatsAppTemplate(to, templateName, params = []) {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.PHONE_NUMBER_ID;
    const url = `https://graph.facebook.com/v22.0/${phoneId}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
            name: templateName,
            language: { code: 'pt_BR' },
            components: params.length ? [{
                type: 'body',
                parameters: params.map(t => ({ type: 'text', text: String(t) }))
            }] : []
        }
    };
    const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok || data.error) console.error('❌ Falha template:', data);
    else console.log('✅ Template enviado', data?.messages?.[0]?.id);
}


function offsetMinutesAt(date, tz) {
    // Ex.: "UTC-03:00", "GMT-3"
    const part = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'shortOffset',
        hour: '2-digit'
    }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value || 'UTC+00:00';

    const m = part.match(/([+-])(\d{1,2})(?::?(\d{2}))?/); // pega +HH[:MM] ou -H
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    const hh = parseInt(m[2], 10);
    const mm = parseInt(m[3] || '0', 10);
    return sign * (hh * 60 + mm);
}

// Constrói o instante UTC correspondente a um "wall time" no fuso tz (robusto em DST)
function utcFromTZComponents(tz, y, M, d, h = 0, m = 0, s = 0, ms = 0) {
    // começa com uma suposição
    const naive = Date.UTC(y, M - 1, d, h, m, s, ms);
    const off1 = offsetMinutesAt(new Date(naive), tz);
    const guess = naive - off1 * 60000;
    const off2 = offsetMinutesAt(new Date(guess), tz);
    return new Date(naive - off2 * 60000);
}

// Retorna { start, end } em UTC para o dia de AMANHÃ no fuso tz
function nextDayRangeUTC(tz, base = new Date()) {
    // pega Y/M/D "hoje" no fuso tz
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(base);
    const y = +parts.find(p => p.type === 'year').value;
    const M = +parts.find(p => p.type === 'month').value;
    const d = +parts.find(p => p.type === 'day').value;

    // meia-noite de HOJE no tz (em UTC)
    const todayStartUTC = utcFromTZComponents(tz, y, M, d, 0, 0, 0, 0);
    // meia-noite de AMANHÃ e DEPOIS DE AMANHÃ (UTC)
    const tomorrowStartUTC = new Date(todayStartUTC.getTime() + 24 * 3600 * 1000);
    const dayAfterStartUTC = new Date(tomorrowStartUTC.getTime() + 24 * 3600 * 1000);

    return { start: tomorrowStartUTC, end: dayAfterStartUTC }; // [start, end)
}


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

// ---- Vertex config
const vertexAI = new VertexAI({
    project: process.env.GCLOUD_PROJECT,
    location: process.env.VERTEX_LOCATION || 'southamerica-east1',
});


const normalizerModel = vertexAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json'
    }
});

async function normalizeWithLLM(raw, tz = 'America/Sao_Paulo') {
    try {
        const prompt = `
Converta a expressão de data/hora abaixo para ISO-8601 COM OFFSET no fuso "${tz}".
- Se houver apenas as horas (sem minutos), considere ":00".
- Saída STRICT: JSON no formato {"iso":"YYYY-MM-DDTHH:mm:ss±hh:mm"}.
- Se não entender, retorne {"iso":null}.

Texto: """${String(raw)}"""
`;
        const r = await normalizerModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        });

        const txt = r.response?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
        const parsed = JSON.parse(txt);
        if (!parsed?.iso) return null;

        const d = new Date(parsed.iso);
        if (Number.isNaN(+d)) return null;
        return d.toISOString(); // UTC para salvar no banco
    } catch (e) {
        console.error('[normalizeWithLLM] erro:', e?.message || e);
        return null;
    }
}


async function validarDataHora(args) {
    const tz = process.env.CLINIC_TZ || 'America/Sao_Paulo';
    const raw = String(args?.dataText || '');

    // IA primeiro
    let isoUTC = await normalizeWithLLM(raw, tz);
    console.log('[validarDataHora] via LLM →', isoUTC); // 👈


    // // (opcional) parser local como backup, se você quiser
    // if (!isoUTC && typeof normalizeToUTCISO === 'function') {
    //     console.log('[validarDataHora] LLM fail, trying local parser...'); // 👈
    //     isoUTC = normalizeToUTCISO(raw, tz);
    //     console.log('[validarDataHoraLocal] via local →', isoUTC); // 👈
    // }

    if (!isoUTC) {
        console.warn('[validarDataHora] FAIL for:', raw); // 👈
        return {
            ok: false,
            message: 'Data/hora inválida. Informe com dia/mês/ANO e hora (ex.: 08/10/2025 14:00 ou "8 de outubro de 2025 às 14:00").'
        };
    }

    // 🚫 NOVO: não permitir datas passadas
    const date = new Date(isoUTC);
    if (date.getTime() <= Date.now()) {
        return {
            ok: false,
            message: 'A data/hora deve ser no futuro. Informe um horário válido.'
        };
    }

    return { ok: true, isoUTC };
}




// Modelo sugerido: 2.5 Flash (rápido e com JSON/function calling)
const model = vertexAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: {
        role: 'system',
        parts: [{
            text: `
Você é um assistente para clínicas no Brasil.


Regras:
- NUNCA faça diagnóstico. Em urgência/emergência, oriente ligar 192 ou buscar pronto atendimento.
- Coletar e confirmar estes DADOS OBRIGATÓRIOS antes de agendar:
  • nome completo
  • CPF
  • data de nascimento
  • especialidade
  • região (bairro/cidade)
  • telefone (WhatsApp, com DDI)
  • e-mail
  • data e horário desejados para a consulta
- Valide data/hora assim que o paciente enviar:
  - Chame primeiro "validarDataHora" com o texto informado.
  - Se houver erro, peça correção da data antes de prosseguir.
- Só chame "criarAgendamento" quando TUDO estiver presente e válido.
- Se algum dado obrigatório faltar, pergunte exatamente aquele campo faltante. Não avance sem preencher todos.
- Seja objetivo e confirmativo: confirme dados e proponha alternativas quando necessário.
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
                    properties: {
                        dataText: { type: 'STRING', description: 'Texto de data/hora em pt-BR' }
                    },
                    required: ['dataText']
                }
            },
            {
                name: 'criarAgendamento',
                description: 'Cria um agendamento de consulta.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        nome: { type: 'STRING', description: 'Nome completo' },
                        cpf: { type: 'STRING', description: 'CPF com ou sem máscara' },
                        nascimento: { type: 'STRING', description: 'Data de nascimento (pt-BR, ex.: 31/01/1990)' },
                        especialidade: { type: 'STRING' },
                        regiao: { type: 'STRING', description: 'Bairro/cidade/região do paciente' },
                        telefone: { type: 'STRING', description: 'Telefone/WhatsApp com DDI (ex.: 55...).' },
                        email: { type: 'STRING', description: 'E-mail válido do paciente' },
                        motivo: { type: 'STRING' },
                        dataISO: { type: 'STRING', description: 'Data/hora desejada no fuso da clínica (pt-BR ou ISO com offset).' }
                    },
                    // tudo obrigatório para agendar:
                    required: ['nome', 'cpf', 'nascimento', 'especialidade', 'regiao', 'telefone', 'email', 'dataISO']
                }
            }
        ]
    }],
    generationConfig: {
        temperature: 0.5,
        responseMimeType: 'application/json'
    }
});


// --- Helpers ---
// CPF: validação simples (dígitos verificadores)
function isValidCPF(input) {
    const s = String(input || '').replace(/\D/g, '');
    if (s.length !== 11 || /^(\d)\1{10}$/.test(s)) return false;
    const calc = (base) => {
        let sum = 0;
        for (let i = 0; i < base.length; i++) sum += Number(base[i]) * (base.length + 1 - i);
        const mod = (sum * 10) % 11;
        return mod === 10 ? 0 : mod;
    };
    const d1 = calc(s.slice(0, 9));
    const d2 = calc(s.slice(0, 9) + d1);
    return s === (s.slice(0, 9) + d1 + d2);
}

// Normaliza data de nascimento para YYYY-MM-DD usando a mesma IA
async function normalizeBirthDate(raw) {
    try {
        const prompt = `
Converta a data de nascimento abaixo para o formato YYYY-MM-DD.
- Aceite formatos pt-BR como "31/01/1990" ou "31 de janeiro de 1990".
- Saída STRICT: JSON {"date":"YYYY-MM-DD"}.
- Se não entender, retorne {"date":null}.

Texto: """${String(raw)}"""
`;
        const r = await normalizerModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        });
        const out = r.response?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
        const parsed = JSON.parse(out);
        if (!parsed?.date) return null;

        // valida formato básico
        if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) return null;
        // checagem rápida de data válida
        const d = new Date(parsed.date + 'T00:00:00Z');
        if (Number.isNaN(+d)) return null;

        return parsed.date; // YYYY-MM-DD
    } catch {
        return null;
    }
}

// --- Helpers de contato ---
// E.164 "sem +" para WhatsApp: 11–15 dígitos, começa 1–9.
// Brasil: 55 + DDD(2) + número (8 fixo ou 9 móvel) => 55 + 10/11 = 12/13 dígitos.
function normalizeWhatsNumber(input, defaultCountry = process.env.DEFAULT_COUNTRY_CODE || '55') {
    let d = String(input || '').replace(/\D/g, '');
    if (!d) return '';

    if (d.startsWith('00')) d = d.slice(2);     // remove 00
    if (d.startsWith('+')) d = d.slice(1);     // remove +

    // já parece internacional (11–15 dígitos, começa 1–9)
    if (/^[1-9]\d{10,14}$/.test(d)) return d;

    // caso Brasil: local com DDD (10 ou 11 dígitos) → prefixa 55
    if (defaultCountry === '55' && (d.length === 10 || d.length === 11)) {
        return '55' + d;
    }

    // números curtos (8–9) provavelmente faltam DDD → NÃO prefixa
    return d; // vai falhar na validação abaixo e a IA pedirá correção
}

function isValidWhatsNumber(n, defaultCountry = process.env.DEFAULT_COUNTRY_CODE || '55') {
    const s = String(n || '');
    if (!/^[1-9]\d{10,14}$/.test(s)) return false; // regra geral E.164 sem '+'

    if (defaultCountry === '55' && s.startsWith('55')) {
        const nacional = s.slice(2);
        // DDD 2 dígitos + 8 (fixo) ou 9 (móvel)
        return nacional.length === 10 || nacional.length === 11;
    }
    return true;
}


function isValidEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}



const criarAgendamentoDB = async (payload) => {
    const schema = z.object({
        nome: z.string().min(3, 'Informe o nome completo'),
        cpf: z.string().min(11, 'CPF obrigatório'),
        nascimento: z.string().min(6, 'Data de nascimento obrigatória'),
        especialidade: z.string().min(2, 'Especialidade obrigatória'),
        regiao: z.string().min(2, 'Região obrigatória'),
        telefone: z.string().min(8, 'Telefone obrigatório'),
        email: z.string().email('E-mail inválido'),
        motivo: z.string().max(500).optional(),
        dataISO: z.string().min(5, 'Data/hora da consulta obrigatória')
    });
    try {
        const data = schema.parse(payload);

        // CPF
        const cpfNum = String(data.cpf).replace(/\D/g, '');
        if (!isValidCPF(cpfNum)) {
            return { ok: false, message: 'CPF inválido. Verifique e envie novamente.' };
        }

        // Nascimento → YYYY-MM-DD
        const birthISO = await normalizeBirthDate(data.nascimento);
        if (!birthISO) {
            return { ok: false, message: 'Data de nascimento inválida. Use, por exemplo, 31/01/1990.' };
        }


        const emailNorm = String(data.email || '').trim().toLowerCase();
        if (!isValidEmail(emailNorm)) {
            return { ok: false, message: 'E-mail inválido. Verifique e envie novamente.' };
        }

        // Telefone → formato WhatsApp (E.164 sem '+')
        const waPhone = normalizeWhatsNumber(data.telefone);
        if (!isValidWhatsNumber(waPhone)) {
            return { ok: false, message: 'Telefone inválido. Envie com DDI + DDD (ex.: 55 11 91234-5678).' };
        }



        // Data/hora desejada (consulta) → UTC ISO
        const tz = process.env.CLINIC_TZ || 'America/Sao_Paulo';
        let isoUTC = await normalizeWithLLM(data.dataISO, tz);
        if (!isoUTC) {
            return { ok: false, message: 'Data/hora da consulta inválida. Use 25/08/2025 18:00 ou "25 de agosto de 2025 às 18:00".' };
        }

        // conflito no mesmo horário
        const { data: conflict, error: qErr } = await supabase
            .from('appointments')
            .select('id')
            .eq('datetime', isoUTC)
            .in('status', ['pendente', 'confirmado'])
            .limit(1);

        if (qErr) return { ok: false, message: 'Erro ao verificar disponibilidade.' };
        if (conflict?.length) return { ok: false, message: 'Horário indisponível.' };

        // INSERT (requer colunas novas: cpf, region, birthdate)
        const insertRow = {
            name: data.nome,
            cpf: cpfNum,
            birthdate: birthISO,               // DATE
            specialty: data.especialidade,
            region: data.regiao,
            phone: waPhone,                    // <- novo campo normalizado
            email: emailNorm,                  // <- novo campo normalizado
            reason: data.motivo ?? null,
            datetime: isoUTC,
            consent: true,
            status: 'pendente',
            source: 'chatbot',
            meta: null
        };

        const { data: created, error } = await supabase
            .from('appointments')
            .insert(insertRow)
            .select('id, datetime')
            .single();

        if (error) return { ok: false, message: 'Erro ao salvar o agendamento.' };

        return {
            ok: true,
            id: created.id,
            resumo: {
                ...data,
                cpf: cpfNum,
                nascimento: birthISO,
                telefone: waPhone,
                email: emailNorm,
                dataISO: created.datetime
            }
        };
    } catch (e) {
        if (e instanceof ZodError) {
            return { ok: false, message: e.issues[0]?.message || 'Dados inválidos.' };
        }
        return { ok: false, message: 'Erro inesperado ao agendar.' };
    }
};




// ===========================================================
//  🔁 Core de chat reaproveitável (REST e WhatsApp)
// ===========================================================
async function runChatTurn(history, message) {
    console.log('[CHAT] user:', message, '| historyLen:', history.length);

    let contents = [...history, { role: 'user', parts: [{ text: message }] }];
    const ctxDelta = [];

    for (let i = 0; i < 3; i++) {
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

// ===========================================================
//  REST plain (continua funcionando)
// ===========================================================
app.post('/api/chat', async (req, res) => {
    const { history = [], message } = req.body || {};
    const { text, ctxDelta } = await runChatTurn(history, message);
    return res.json({ text, ctxDelta });
});


// ===================================================================
//  💬 Integração WhatsApp Cloud API
// ===================================================================



// Enviar texto via WhatsApp
async function sendWhatsAppText(to, body) {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.PHONE_NUMBER_ID;

    if (!token || !phoneId) {
        console.log('⚠️ Tokens do WhatsApp não configurados - simulando envio:', { to, body });
        return;
    }

    const url = `https://graph.facebook.com/v22.0/${phoneId}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to: to, // já vem com DDI do webhook (ex.: 55...)
        type: 'text',
        text: { body }
    };

    const r = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok || data.error) {
        console.error('❌ Falha ao enviar WhatsApp:', data);
    } else {
        console.log('✅ WhatsApp enviado para', to, '| id:', data?.messages?.[0]?.id);
    }
}

// --- 2.1 Verificação do webhook (GET) ---
app.get('/whatsapp/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'meu_token_secreto_123';

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ Webhook verificado!');
        return res.status(200).send(challenge);
    }
    console.log('❌ Falha na verificação do webhook');
    return res.sendStatus(403);
});





// Assinatura do webhook
async function verifyWebhookSignature(rawBody, signatureHeader) {
    if (!signatureHeader) return false;
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) return false;

    const expected = 'sha256=' + crypto
        .createHmac('sha256', appSecret)
        .update(rawBody)
        .digest('hex');

    const ok = expected === signatureHeader;
    if (!ok) console.warn('⚠️ Assinatura inválida');
    return ok;
}

// Processar mensagem recebida
async function processWhatsAppMessage(message, value) {
    // Pega o id do cliente de forma consistente
    const userId = value?.contacts?.[0]?.wa_id || message.from;
    const text = message?.text?.body || '';
    const msgId = message?.id;

    console.log(`💬 WhatsApp de ${userId}: "${text}"`);

    if (await alreadyProcessed(msgId)) {
        console.log('↩️ mensagem duplicada ignorada:', msgId);
        return;
    }

    const history = await getHistory(userId);
    const { text: reply, ctxDelta } = await runChatTurn(history, text);

    const newHistory = [
        ...history,
        { role: 'user', parts: [{ text }] },
        ...(ctxDelta || [])
    ];

    const MAX_TURNS = 12;
    await saveHistory(userId, newHistory.slice(-(MAX_TURNS * 5)));

    await sendWhatsAppText(userId, reply || '...');
}




app.listen(process.env.PORT || 8080, () => {
    console.log('API on http://localhost:8080');
});


