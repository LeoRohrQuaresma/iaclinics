// helpers/validators.js

// CPF: validação simples (dígitos verificadores)
export function isValidCPF(input) {
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

export function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

// Normalização e validação de WhatsApp (E.164 sem '+')
export function normalizeWhatsNumber(input, defaultDDI = process.env.DEFAULT_COUNTRY_CODE || '55') {
  let digits = String(input || '').replace(/\D/g, '');
  if (!digits) return '';

  // Remove "00" (discagem internacional)
  if (digits.startsWith('00')) digits = digits.slice(2);

  // BR: remove "0" tronco antes do DDD (ex.: 0 51 9....)
  if (defaultDDI === '55' && (digits.length === 11 || digits.length === 12) && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  // Se veio só DDD + número (10 ou 11 dígitos), prefixa DDI padrão
  if (!digits.startsWith(defaultDDI) && (digits.length === 10 || digits.length === 11)) {
    digits = defaultDDI + digits;
  }

  // Corrige "0" imediatamente após o DDI (ex.: 55011... -> 5511...)
  if (digits.startsWith(defaultDDI + '0')) {
    digits = defaultDDI + digits.slice(defaultDDI.length + 1);
  }

  return digits;
}

export function isValidWhatsNumber(n, defaultDDI = process.env.DEFAULT_COUNTRY_CODE || '55') {
  const s = String(n || '').replace(/\D/g, '');
  if (!/^\d{11,15}$/.test(s)) return false;

  if (s.startsWith(defaultDDI)) {
    const national = s.slice(defaultDDI.length);
    if (defaultDDI === '55') {
      // Brasil: DDD(2) + número (8 ou 9) => 10 ou 11 dígitos
      return /^\d{10,11}$/.test(national);
    }
    // Outros países: aceitamos se já veio E.164 completo
    return true;
  }

  // E.164 de outro país (com DDI diferente do default) também é aceito
  return true;
}
