// session.js
import { redis } from './redis.js';

const SESSION_TTL_SEC = 26 * 60 * 60;  // 26h (cobre janela de 24h do WhatsApp)
const IDEMP_TTL_SEC = 36 * 60 * 60;  // 36h (evita reprocessar mesma msg)

const keyHistory = (phone) => `wa:ctx:${phone}`;
const keySeen = (msgId) => `wa:seen:${msgId}`;

export async function getHistory(phone) {
  const raw = await redis.get(keyHistory(phone));
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

export async function saveHistory(phone, history) {
  await redis.set(keyHistory(phone), JSON.stringify(history), 'EX', SESSION_TTL_SEC);
}

export async function alreadyProcessed(messageId) {
  if (!messageId) return false;
  const ok = await redis.set(keySeen(messageId), '1', 'NX', 'EX', IDEMP_TTL_SEC);
  return ok === null; // null => já existia => duplicada
}



const keyLastSlotsAny = (phone) => `wa:lastslots:any:${phone}`;

export async function saveLastSlotsAny(phone, slots) {
  await redis.set(keyLastSlotsAny(phone), JSON.stringify(slots), 'EX', 1800); // 30 min
}

export async function getLastSlotsAny(phone) {
  const raw = await redis.get(keyLastSlotsAny(phone));
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}



