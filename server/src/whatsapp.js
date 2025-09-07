// whatsapp.js
import express from 'express';
import crypto from 'crypto';
import { verifyWebhookSignature } from './helpers/signature.js';

/* ========= Envio de mensagens ========= */
export async function sendWhatsAppText(to, body) {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.PHONE_NUMBER_ID;

    if (!token || !phoneId) {
        console.log('⚠️ Tokens do WhatsApp não configurados - simulando envio:', { to, body });
        return;
    }

    const url = `https://graph.facebook.com/v22.0/${phoneId}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body }
    };

    const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok || data.error) console.error('❌ Falha ao enviar WhatsApp:', data);
    else console.log('✅ WhatsApp enviado para', to, '| id:', data?.messages?.[0]?.id);
}

export async function sendWhatsAppTemplate(to, templateName, params = []) {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.PHONE_NUMBER_ID;

    if (!token || !phoneId) {
        console.log('⚠️ Tokens do WhatsApp não configurados - simulando envio de template:', { to, templateName, params });
        return;
    }

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


/* ========= Router (GET verificação + POST mensagens) ========= */
export function createWhatsAppRouter({ runChatTurn, getHistory, saveHistory, alreadyProcessed }) {
    const router = express.Router();

    // GET /whatsapp/webhook — verificação
    router.get('/webhook', (req, res) => {
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

    // POST /whatsapp/webhook — precisa de RAW body para validar assinatura
    router.post(
        '/webhook',
        express.raw({ type: 'application/json' }),
        async (req, res) => {
            try {
                const rawBody = req.body; // Buffer
                const signature = req.headers['x-hub-signature-256'];
                const isValid = await verifyWebhookSignature(rawBody, signature);

                const body = JSON.parse(rawBody.toString('utf8'));

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

                // WhatsApp sempre espera 200 (mesmo em erro interno)
                return res.status(200).send('OK');
            } catch (err) {
                console.error('❌ Erro no webhook POST:', err);
                return res.status(200).send('OK');
            }
        }
    );

    // handler interno
    async function processWhatsAppMessage(message, value) {
        const userId = value?.contacts?.[0]?.wa_id || message.from;
        const text = message?.text?.body || '';
        const msgId = message?.id;

        console.log(`💬 WhatsApp de ${userId}: "${text}"`);

        if (await alreadyProcessed(msgId)) {
            console.log('↩️ mensagem duplicada ignorada:', msgId);
            return;
        }

        const history = await getHistory(userId);
        const { text: reply, ctxDelta } = await runChatTurn(history, text)

        const newHistory = [
            ...history,
            { role: 'user', parts: [{ text }] },
            ...(ctxDelta || [])
        ];

        const MAX_TURNS = 12;
        await saveHistory(userId, newHistory.slice(-(MAX_TURNS * 5)));

        await sendWhatsAppText(userId, reply || '...');
    }

    return router;
}
