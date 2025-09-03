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
export function normalizeWhatsNumber(input, defaultCountry = process.env.DEFAULT_COUNTRY_CODE || '55') {
  let d = String(input || '').replace(/\D/g, '');
  if (!d) return '';

  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('+')) d = d.slice(1);

  if (/^[1-9]\d{10,14}$/.test(d)) return d;

  if (defaultCountry === '55' && (d.length === 10 || d.length === 11)) {
    return '55' + d;
  }
  return d;
}

export function isValidWhatsNumber(n, defaultCountry = process.env.DEFAULT_COUNTRY_CODE || '55') {
  const s = String(n || '');
  if (!/^[1-9]\d{10,14}$/.test(s)) return false;

  if (defaultCountry === '55' && s.startsWith('55')) {
    const nacional = s.slice(2);
    return nacional.length === 10 || nacional.length === 11;
  }
  return true;
}
