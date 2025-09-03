// helpers/signature.js
import crypto from 'crypto';

export async function verifyWebhookSignature(rawBody, signatureHeader, appSecret = process.env.WHATSAPP_APP_SECRET) {
    if (!signatureHeader || !appSecret) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const ok = expected === signatureHeader;
    if (!ok) console.warn('⚠️ Assinatura inválida');
    return ok;
}
