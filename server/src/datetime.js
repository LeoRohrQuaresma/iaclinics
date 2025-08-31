// src/datetime.js
import { parse, isValid } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import * as tz from 'date-fns-tz';
const { zonedTimeToUtc } = tz;

// Converte várias formas pt-BR -> ISO UTC (terminando com 'Z').
// Se vier só a HORA, assume minutos = 00.
export function normalizeToUTCISO(raw, tzName = 'America/Sao_Paulo') {
  if (!raw) return null;
  const s = String(raw).trim();

  // Já veio ISO completo? (YYYY-MM-DDTHH:mm[:ss][Z|±hh:mm])
  const isoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
  if (isoLike.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) return d.toISOString();
  }

  // 1) Formatos com HORA E MINUTO
  const withMinutes = [
    // curtos
    "dd/MM/yyyy HH:mm",
    "dd/MM/yyyy 'às' HH:mm",
    "dd/MM/yyyy 'as' HH:mm",            // sem acento
    "d/M/yyyy HH:mm",
    "d/M/yyyy 'às' HH:mm",
    "d/M/yyyy 'as' HH:mm",               // sem acento

    // textuais
    "d 'de' MMMM 'de' yyyy 'às' HH:mm",
    "d 'de' MMMM 'de' yyyy 'as' HH:mm",  // sem acento
    "d 'de' MMMM 'de' yyyy HH:mm",

    // “14h30”
    "dd/MM/yyyy HH'h'mm",
    "d 'de' MMMM 'de' yyyy 'às' HH'h'mm",
    "d 'de' MMMM 'de' yyyy 'as' HH'h'mm", // sem acento

    // “18 horas do dia 25 de agosto de 2025”
    "HH 'horas' 'do' 'dia' d 'de' MMMM 'de' yyyy",
    "HH 'horas' 'do' 'dia' dd/MM/yyyy",
  ];

  for (const fmt of withMinutes) {
    const parsed = parse(s, fmt, new Date(), { locale: ptBR });
    if (isValid(parsed)) {
      const utc = zonedTimeToUtc(parsed, tzName);
      return utc.toISOString();
    }
  }

  // 2) Formatos SÓ COM HORA (assume mm = 00)
  const hourOnly = [
    "dd/MM/yyyy HH",
    "dd/MM/yyyy 'às' HH 'horas'",
    "dd/MM/yyyy 'as' HH 'horas'",         // sem acento
    "d/M/yyyy HH",
    "d/M/yyyy 'às' HH 'horas'",
    "d/M/yyyy 'as' HH 'horas'",           // sem acento
    "d 'de' MMMM 'de' yyyy 'às' HH 'horas'",
    "d 'de' MMMM 'de' yyyy 'as' HH 'horas'", // sem acento
    "d 'de' MMMM 'de' yyyy HH",
    // “14h”
    "dd/MM/yyyy HH'h'",
    "d 'de' MMMM 'de' yyyy 'às' HH'h'",
    "d 'de' MMMM 'de' yyyy 'as' HH'h'",   // sem acento
  ];

  for (const fmt of hourOnly) {
    const parsed = parse(s, fmt, new Date(), { locale: ptBR });
    if (isValid(parsed)) {
      parsed.setMinutes(0, 0, 0); // assume :00
      const utc = zonedTimeToUtc(parsed, tzName);
      return utc.toISOString();
    }
  }

  return null; // não entendi
}
