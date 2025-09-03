// tools/llm-tools.js
import { z, ZodError } from 'zod';
import { supabase } from '../supabase.js';
import {
  nextDayRangeUTC,
  dayRangeUTCFromYYYYMMDD
} from '../helpers/datetime.js';
import {
  isValidCPF,
  isValidEmail,
  normalizeWhatsNumber,
  isValidWhatsNumber
} from '../helpers/validators.js';
import {
  normalizeDateTimeToUTC,
  normalizeBirthDate
} from '../helpers/ai-normalize.js';

const CLINIC_TZ = process.env.CLINIC_TZ || 'America/Sao_Paulo';

/* -------------------------------------------------------------------------- */
/* validarDataHora                                                            */
/* -------------------------------------------------------------------------- */
export async function validarDataHora(args) {
  const tz = CLINIC_TZ;
  const raw = String(args?.dataText || '');

  // IA primeiro
  const isoUTC = await normalizeDateTimeToUTC(raw, tz);
  console.log('[validarDataHora] via LLM →', isoUTC);

  if (!isoUTC) {
    console.warn('[validarDataHora] FAIL for:', raw);
    return {
      ok: false,
      message:
        'Data/hora inválida. Informe com dia/mês/ANO e hora (ex.: 08/10/2025 14:00 ou "8 de outubro de 2025 às 14:00").'
    };
  }

  // não permitir datas passadas
  const date = new Date(isoUTC);
  if (date.getTime() <= Date.now()) {
    return {
      ok: false,
      message: 'A data/hora deve ser no futuro. Informe um horário válido.'
    };
  }

  return { ok: true, isoUTC };
}

/* -------------------------------------------------------------------------- */
/* helpers internos                                                            */
/* -------------------------------------------------------------------------- */
async function _reservarSlot({ slotId, isoUTC, medicoId }) {
  try {
    if (slotId) {
      const idNum = Number(slotId);
      const { data: upd, error: upErr, status } = await supabase
        .from('agenda_slots')
        .update({ status: 'agendado' })
        .eq('id', idNum)
        .eq('status', 'livre')
        .select('id, medico_id, datetime, status')
        .maybeSingle();

      console.log('[reservarSlot] try reserve by id:', { slotId: idNum, status, upErr, upd });

      if (upErr) {
        console.error('[reservarSlot] update error:', upErr);
        return { ok: false, message: 'Erro ao reservar o horário (permissão/RLS?).' };
      }
      if (!upd) {
        return { ok: false, message: 'Horário indisponível (não estava livre ou ID inválido).' };
      }
      return { ok: true, slot: upd };
    }

    // Sem slotId: tenta localizar um slot livre pelo datetime (+ médico opcional)
    let q = supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, status')
      .eq('datetime', isoUTC)
      .eq('status', 'livre')
      .order('id', { ascending: true })
      .limit(1);

    if (medicoId) q = q.eq('medico_id', String(medicoId));

    const { data: found, error: fErr } = await q;
    if (fErr) return { ok: false, message: 'Erro ao verificar disponibilidade.' };
    if (!found?.length) return { ok: false, message: 'Horário indisponível.' };

    const candidate = found[0];

    // Tenta reservar efetivamente (condicional ao status ainda estar "livre")
    const { data: locked, error: uErr } = await supabase
      .from('agenda_slots')
      .update({ status: 'agendado' })
      .eq('id', candidate.id)
      .eq('status', 'livre')
      .select('id, medico_id, datetime')
      .single();

    if (uErr || !locked) {
      return { ok: false, message: 'Horário indisponível.' };
    }
    return { ok: true, slot: locked };
  } catch (e) {
    console.error('[_reservarSlot] erro:', e);
    return { ok: false, message: 'Falha ao reservar o horário.' };
  }
}

async function _resolveEspecialidadeIds({ especialidadeId, especialidadeNome }) {
  if (especialidadeId) return [especialidadeId];
  if (!especialidadeNome) return [];
  const { data, error } = await supabase
    .from('especialidades')
    .select('id')
    .ilike('nome', `%${especialidadeNome}%`);

  if (error) return [];
  return (data || []).map(r => r.id);
}

/* -------------------------------------------------------------------------- */
/* criarAgendamentoDB (mantém o mesmo nome que você usa no runChatTurn)       */
/* -------------------------------------------------------------------------- */
export const criarAgendamentoDB = async (payload) => {
  const schema = z.object({
    nome: z.string().min(3, 'Informe o nome completo'),
    cpf: z.string().min(11, 'CPF obrigatório'),
    nascimento: z.string().min(6, 'Data de nascimento obrigatória'),
    especialidade: z.string().min(2, 'Especialidade obrigatória'),
    regiao: z.string().min(2, 'Região obrigatória'),
    telefone: z.string().min(8, 'Telefone obrigatório'),
    email: z.string().email('E-mail inválido'),
    motivo: z.string().max(500).optional(),
    dataISO: z.string().min(5, 'Data/hora da consulta obrigatória'),
    slotId: z.string().optional(),
    medicoId: z.string().optional()
  });

  let reservedSlot = null;

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

    // E-mail
    const emailNorm = String(data.email || '').trim().toLowerCase();
    if (!isValidEmail(emailNorm)) {
      return { ok: false, message: 'E-mail inválido. Verifique e envie novamente.' };
    }

    // Telefone → E.164 sem '+'
    const waPhone = normalizeWhatsNumber(data.telefone);
    if (!isValidWhatsNumber(waPhone)) {
      return { ok: false, message: 'Telefone inválido. Envie com DDI + DDD (ex.: 55 11 91234-5678).' };
    }

    // Data/hora desejada → UTC ISO
    const isoUTC = await normalizeDateTimeToUTC(data.dataISO, CLINIC_TZ);
    if (!isoUTC) {
      return { ok: false, message: 'Data/hora da consulta inválida. Use 25/08/2025 18:00 ou "25 de agosto de 2025 às 18:00".' };
    }

    // 1) RESERVA do slot (livre -> agendado)
    const res = await _reservarSlot({ slotId: data.slotId, isoUTC, medicoId: data.medicoId });
    if (!res.ok) return res;
    reservedSlot = res.slot; // { id, medico_id, datetime }

    // 2) INSERT
    const insertRow = {
      name: data.nome,
      cpf: cpfNum,
      birthdate: birthISO,
      specialty: data.especialidade,
      region: data.regiao,
      phone: waPhone,
      email: emailNorm,
      reason: data.motivo ?? null,
      datetime: reservedSlot.datetime,
      consent: true,
      status: 'pendente',
      source: 'chatbot',
      slot_id: reservedSlot.id,
      medico_id: reservedSlot.medico_id,
      meta: null
    };

    const { data: created, error } = await supabase
      .from('appointments')
      .insert(insertRow)
      .select('id, datetime')
      .single();

    if (error) {
      console.error('[appointments.insert] error:', error, '| payload:', insertRow);
      // rollback
      try {
        await supabase
          .from('agenda_slots')
          .update({ status: 'livre' })
          .eq('id', reservedSlot.id)
          .eq('status', 'agendado');
      } catch (rollbackErr) {
        console.error('[criarAgendamentoDB] rollback falhou:', rollbackErr);
      }
      return { ok: false, message: 'Erro ao salvar o agendamento.' };
    }

    return {
      ok: true,
      id: created.id,
      resumo: {
        ...data,
        cpf: cpfNum,
        nascimento: birthISO,
        telefone: waPhone,
        email: emailNorm,
        dataISO: created.datetime,
        slotId: reservedSlot.id,
        medicoId: reservedSlot.medico_id
      }
    };
  } catch (e) {
    // rollback se reservou e estourou exceção
    if (reservedSlot?.id) {
      try {
        await supabase
          .from('agenda_slots')
          .update({ status: 'livre' })
          .eq('id', reservedSlot.id)
          .eq('status', 'agendado');
      } catch (rbErr) {
        console.error('[criarAgendamentoDB] rollback pós-exception falhou:', rbErr);
      }
    }
    if (e instanceof ZodError) {
      return { ok: false, message: e.issues[0]?.message || 'Dados inválidos.' };
    }
    console.error('[criarAgendamentoDB] erro inesperado:', e);
    return { ok: false, message: 'Erro inesperado ao agendar.' };
  }
};

/* -------------------------------------------------------------------------- */
/* listarEspecialidadesDB                                                     */
/* -------------------------------------------------------------------------- */
export async function listarEspecialidadesDB() {
  try {
    const { data, error } = await supabase
      .from('especialidades')
      .select('nome')
      .order('nome', { ascending: true });

    if (error) return { ok: false, message: 'Erro ao buscar especialidades.' };

    const lista = (data || []).map(r => String(r.nome || '').trim()).filter(Boolean);
    const uniq = Array.from(new Set(lista));

    if (!uniq.length) return { ok: false, message: 'Nenhuma especialidade cadastrada.' };

    return { ok: true, especialidades: uniq };
  } catch (e) {
    console.error('[listarEspecialidadesDB] erro inesperado:', e);
    return { ok: false, message: 'Falha inesperada ao listar especialidades.' };
  }
}

/* -------------------------------------------------------------------------- */
/* listarMedicosDB                                                            */
/* -------------------------------------------------------------------------- */
export async function listarMedicosDB(args = {}) {
  try {
    const limite = Math.min(Number(args.limite || 50), 200);
    let q = supabase.from('medicos').select('id, nome, especialidade_id').order('nome', { ascending: true });
    if (args.busca) q = q.ilike('nome', `%${args.busca}%`);
    const { data, error } = await q.limit(limite);
    if (error) return { ok: false, message: 'Erro ao buscar médicos.' };

    const medicos = (data || []).map(m => ({ id: m.id, nome: m.nome, especialidadeId: m.especialidade_id ?? null }));
    if (!medicos.length) return { ok: true, medicos: [] };
    return { ok: true, medicos };
  } catch (e) {
    console.error('[listarMedicosDB]', e);
    return { ok: false, message: 'Falha inesperada ao listar médicos.' };
  }
}

/* -------------------------------------------------------------------------- */
/* listarMedicosPorEspecialidadeDB                                            */
/* -------------------------------------------------------------------------- */
export async function listarMedicosPorEspecialidadeDB(args = {}) {
  try {
    const limite = Math.min(Number(args.limite || 50), 200);
    const espIds = await _resolveEspecialidadeIds(args);
    if (!espIds.length) return { ok: true, medicos: [] };

    // Se seu schema for N:N, troque por join na tabela ponte
    const { data, error } = await supabase
      .from('medicos')
      .select('id, nome, especialidade_id')
      .in('especialidade_id', espIds)
      .order('nome', { ascending: true })
      .limit(limite);

    if (error) return { ok: false, message: 'Erro ao buscar médicos da especialidade.' };

    const medicos = (data || []).map(m => ({ id: m.id, nome: m.nome, especialidadeId: m.especialidade_id ?? null }));
    return { ok: true, medicos };
  } catch (e) {
    console.error('[listarMedicosPorEspecialidadeDB]', e);
    return { ok: false, message: 'Falha inesperada ao listar médicos por especialidade.' };
  }
}

/* -------------------------------------------------------------------------- */
/* listarHorariosMedicoDB                                                     */
/* -------------------------------------------------------------------------- */
export async function listarHorariosMedicoDB(args = {}) {
  try {
    const tz = CLINIC_TZ;
    const limite = Math.min(Number(args.limite || 12), 100);

    if (!args.medicoId) return { ok: false, message: 'medicoId é obrigatório.' };

    // intervalo (padrão = amanhã)
    let startUTC, endUTC;
    if (args.dia && /^\d{4}-\d{2}-\d{2}$/.test(args.dia)) {
      ({ startUTC, endUTC } = dayRangeUTCFromYYYYMMDD(tz, args.dia));
    } else {
      const r = nextDayRangeUTC(tz);
      startUTC = r.start; endUTC = r.end;
    }

    const { data, error } = await supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, duration_min, status, medicos ( id, nome )')
      .eq('medico_id', String(args.medicoId))
      .gte('datetime', startUTC.toISOString())
      .lt('datetime', endUTC.toISOString())
      .eq('status', 'livre')
      .order('datetime', { ascending: true })
      .limit(limite);

    if (error) return { ok: false, message: 'Erro ao buscar horários do médico.' };

    const fmtLocal = iso => new Date(iso).toLocaleString('pt-BR', {
      timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const slots = (data || []).map(r => ({
      id: r.id,
      isoUTC: r.datetime,
      local: fmtLocal(r.datetime),
      medicoId: r.medico_id,
      medicoNome: r.medicos?.nome ?? null,
      duracaoMin: r.duration_min ?? null
    }));

    return { ok: true, slots };
  } catch (e) {
    console.error('[listarHorariosMedicoDB]', e);
    return { ok: false, message: 'Falha inesperada ao listar horários do médico.' };
  }
}

/* -------------------------------------------------------------------------- */
/* listarAgendaSemanalMedicoDB                                                     */
/* -------------------------------------------------------------------------- */
export async function listarAgendaSemanalMedicoDB(args = {}) {
  try {
    const tz = CLINIC_TZ;
    const medicoId = String(args.medicoId || '').trim();
    if (!medicoId) return { ok: false, message: 'medicoId é obrigatório.' };

    // 1) "Hoje" no fuso da clínica (YYYY-MM-DD)
    const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const weekFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    const todayLocalYMD = ymdFmt.format(new Date());

    // 2) UTC de hoje (início/fim) para obter o dia e o weekday corretos no fuso
    let { startUTC: todayStartUTC } = dayRangeUTCFromYYYYMMDD(tz, todayLocalYMD);

    // 3) quantos dias faltam para domingo (considerando o fuso)
    const wkMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const wkShort = weekFmt.format(todayStartUTC).toLowerCase().slice(0, 3); // 'tue', 'wed', ...
    const todayIdx = wkMap[wkShort] ?? 0;
    const daysUntilSunday = (7 - todayIdx) % 7;       // se hoje é domingo => 0
    const totalDays = daysUntilSunday + 1;            // incluir HOJE

    // 4) fim do domingo (exclusive) para janela da query
    //    Pegamos o YMD do domingo local e convertemos para [startUTC, endUTC] daquele dia;
    const sundayDate = new Date(todayStartUTC.getTime() + daysUntilSunday * 24 * 60 * 60 * 1000);
    const sundayLocalYMD = ymdFmt.format(sundayDate);
    const { endUTC: endOfSundayUTC } = dayRangeUTCFromYYYYMMDD(tz, sundayLocalYMD);

    // 5) busca slots livres do médico no intervalo [hoje 00:00 local, domingo 23:59:59 local]
    const { data, error } = await supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, duration_min, status, medicos ( id, nome )')
      .eq('medico_id', medicoId)
      .gte('datetime', todayStartUTC.toISOString())
      .lt('datetime', endOfSundayUTC.toISOString())
      .eq('status', 'livre')
      .order('datetime', { ascending: true });

    if (error) return { ok: false, message: 'Erro ao buscar agenda semanal do médico.' };

    // 6) formatação local e agrupamento por dia local
    const toLocalStr = iso => new Date(iso).toLocaleString('pt-BR', {
      timeZone: tz,
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const slotsByDay = new Map(); // YYY-MM-DD -> [slots...]
    const medicoNome = data?.[0]?.medicos?.nome ?? null;

    for (const r of (data || [])) {
      const slotDate = new Date(r.datetime);
      const dayYMD = ymdFmt.format(slotDate); // dia local do slot
      const arr = slotsByDay.get(dayYMD) || [];
      arr.push({
        id: r.id,
        isoUTC: r.datetime,
        local: toLocalStr(r.datetime),
        medicoId: r.medico_id,
        medicoNome: r.medicos?.nome ?? null,
        duracaoMin: r.duration_min ?? null
      });
      slotsByDay.set(dayYMD, arr);
    }

    // 7) monta a agenda para cada dia de HOJE até DOMINGO (mesmo se vazio)
    const agenda = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(todayStartUTC.getTime() + i * 24 * 60 * 60 * 1000);
      const ymd = ymdFmt.format(d);
      agenda.push({ dia: ymd, slots: slotsByDay.get(ymd) || [] });
    }

    return {
      ok: true,
      inicio: todayLocalYMD, // início sempre = hoje (local)
      dias: totalDays,       // hoje...domingo
      medicoNome,
      agenda
    };
  } catch (e) {
    console.error('[listarAgendaSemanalMedico] erro:', e);
    return { ok: false, message: 'Falha inesperada ao listar agenda semanal.' };
  }
}


/* -------------------------------------------------------------------------- */
/* listarProximoDiaDisponivelMedicoDB                                                     */
/* -------------------------------------------------------------------------- */
export async function listarProximoDiaDisponivelMedicoDB(args = {}) {
  try {
    const tz = CLINIC_TZ;
    const medicoId = String(args.medicoId || '');
    if (!medicoId) return { ok: false, message: 'medicoId é obrigatório.' };

    // Ponto de partida: agora (ou um dia informado)
    let startUTC;
    if (args.aPartirDe && /^\d{4}-\d{2}-\d{2}$/.test(args.aPartirDe)) {
      ({ startUTC } = dayRangeUTCFromYYYYMMDD(tz, args.aPartirDe));
    } else {
      // agora
      startUTC = new Date(); // UTC agora
    }

    // Busca o 1º slot livre a partir de startUTC
    const { data: first, error: fErr } = await supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, duration_min, medicos ( id, nome )')
      .eq('medico_id', medicoId)
      .gte('datetime', startUTC.toISOString())
      .eq('status', 'livre')
      .order('datetime', { ascending: true })
      .limit(1);

    if (fErr) return { ok: false, message: 'Erro ao buscar próximo dia disponível.' };
    if (!first?.length) return { ok: true, dia: null, slots: [] };

    // Descobre o dia local desse slot e retorna todos os slots desse dia
    const firstIso = first[0].datetime;
    const dia = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(firstIso));

    // Reaproveita sua função diária para trazer todos os slots do dia encontrado
    const { startUTC: s, endUTC: e } = dayRangeUTCFromYYYYMMDD(tz, dia);
    const { data, error } = await supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, duration_min, status, medicos ( id, nome )')
      .eq('medico_id', medicoId)
      .gte('datetime', s.toISOString())
      .lt('datetime', e.toISOString())
      .eq('status', 'livre')
      .order('datetime', { ascending: true });

    if (error) return { ok: false, message: 'Erro ao buscar slots do próximo dia disponível.' };

    const fmtLocal = iso => new Date(iso).toLocaleString('pt-BR', {
      timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const slots = (data || []).map(r => ({
      id: r.id,
      isoUTC: r.datetime,
      local: fmtLocal(r.datetime),
      medicoId: r.medico_id,
      medicoNome: r.medicos?.nome ?? null,
      duracaoMin: r.duration_min ?? null
    }));

    return { ok: true, dia, slots };
  } catch (e) {
    console.error('[listarProximoDiaDisponivelMedicoDB]', e);
    return { ok: false, message: 'Falha inesperada ao buscar próximo dia disponível.' };
  }
}


/* -------------------------------------------------------------------------- */
/* listarHorariosPorEspecialidadeDB                                           */
/* -------------------------------------------------------------------------- */
export async function listarHorariosPorEspecialidadeDB(args = {}) {
  try {
    const tz = CLINIC_TZ;
    const limite = Math.min(Number(args.limite || 12), 200);

    const espIds = await _resolveEspecialidadeIds(args);
    if (!espIds.length) return { ok: true, slots: [] };

    // 1) médicos da(s) especialidade(s)
    const { data: med, error: medErr } = await supabase
      .from('medicos')
      .select('id')
      .in('especialidade_id', espIds);

    if (medErr) return { ok: false, message: 'Erro ao buscar médicos da especialidade.' };
    const medicoIds = (med || []).map(m => m.id);
    if (!medicoIds.length) return { ok: true, slots: [] };

    // 2) intervalo
    let startUTC, endUTC;
    if (args.dia && /^\d{4}-\d{2}-\d{2}$/.test(args.dia)) {
      ({ startUTC, endUTC } = dayRangeUTCFromYYYYMMDD(tz, args.dia));
    } else {
      const r = nextDayRangeUTC(tz);
      startUTC = r.start; endUTC = r.end;
    }

    // 3) slots livres
    const { data, error } = await supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, duration_min, status, medicos ( id, nome )')
      .in('medico_id', medicoIds)
      .gte('datetime', startUTC.toISOString())
      .lt('datetime', endUTC.toISOString())
      .eq('status', 'livre')
      .order('datetime', { ascending: true })
      .limit(limite);

    if (error) return { ok: false, message: 'Erro ao buscar horários da especialidade.' };

    const fmtLocal = iso => new Date(iso).toLocaleString('pt-BR', {
      timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const slots = (data || []).map(r => ({
      id: r.id,
      isoUTC: r.datetime,
      local: fmtLocal(r.datetime),
      medicoId: r.medico_id,
      medicoNome: r.medicos?.nome ?? null,
      duracaoMin: r.duration_min ?? null
    }));

    return { ok: true, slots };
  } catch (e) {
    console.error('[listarHorariosPorEspecialidadeDB]', e);
    return { ok: false, message: 'Falha inesperada ao listar horários por especialidade.' };
  }
}



/* -------------------------------------------------------------------------- */
/* listarAgendaSemanalEspecialidadeDB                                         */
/* -------------------------------------------------------------------------- */
export async function listarAgendaSemanalEspecialidadeDB(args = {}) {
  try {
    const tz = CLINIC_TZ;

    // 1) resolver ids de especialidade
    const espIds = await _resolveEspecialidadeIds(args);
    if (!espIds.length) return { ok: true, inicio: null, dias: 0, agenda: [] };

    // 2) pegar ids de médicos dessa(s) especialidade(s)
    const { data: med, error: medErr } = await supabase
      .from('medicos')
      .select('id, nome')
      .in('especialidade_id', espIds);
    if (medErr) return { ok: false, message: 'Erro ao buscar médicos da especialidade.' };

    const medicoIds = (med || []).map(m => m.id);
    if (!medicoIds.length) {
      return { ok: true, inicio: null, dias: 0, agenda: [] };
    }

    // 3) hoje local (YMD) e janela até domingo (local)
    const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const weekFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    const todayLocalYMD = ymdFmt.format(new Date());

    let { startUTC: todayStartUTC } = dayRangeUTCFromYYYYMMDD(tz, todayLocalYMD);

    const wkMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const wkShort = weekFmt.format(todayStartUTC).toLowerCase().slice(0, 3);
    const todayIdx = wkMap[wkShort] ?? 0;
    const daysUntilSunday = (7 - todayIdx) % 7;
    const totalDays = daysUntilSunday + 1;

    const sundayDate = new Date(todayStartUTC.getTime() + daysUntilSunday * 86400000);
    const sundayLocalYMD = ymdFmt.format(sundayDate);
    const { endUTC: endOfSundayUTC } = dayRangeUTCFromYYYYMMDD(tz, sundayLocalYMD);

    // 4) slots livres de TODOS os médicos da especialidade
    const { data, error } = await supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, duration_min, status, medicos ( id, nome )')
      .in('medico_id', medicoIds)
      .gte('datetime', todayStartUTC.toISOString())
      .lt('datetime', endOfSundayUTC.toISOString())
      .eq('status', 'livre')
      .order('datetime', { ascending: true });

    if (error) return { ok: false, message: 'Erro ao buscar agenda semanal da especialidade.' };

    const toLocalStr = iso => new Date(iso).toLocaleString('pt-BR', {
      timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const slotsByDay = new Map(); // YMD -> [slots...]
    for (const r of (data || [])) {
      const d = new Date(r.datetime);
      const ymd = ymdFmt.format(d);
      const arr = slotsByDay.get(ymd) || [];
      arr.push({
        id: r.id,
        isoUTC: r.datetime,
        local: toLocalStr(r.datetime),
        medicoId: r.medico_id,
        medicoNome: r.medicos?.nome ?? null,
        duracaoMin: r.duration_min ?? null
      });
      slotsByDay.set(ymd, arr);
    }

    const agenda = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(todayStartUTC.getTime() + i * 86400000);
      const ymd = ymdFmt.format(d);
      agenda.push({ dia: ymd, slots: slotsByDay.get(ymd) || [] });
    }

    return { ok: true, inicio: todayLocalYMD, dias: totalDays, agenda };
  } catch (e) {
    console.error('[listarAgendaSemanalEspecialidadeDB] erro:', e);
    return { ok: false, message: 'Falha inesperada ao listar agenda semanal por especialidade.' };
  }
}

/* -------------------------------------------------------------------------- */
/* listarProximoDiaDisponivelEspecialidadeDB                                  */
/* -------------------------------------------------------------------------- */
export async function listarProximoDiaDisponivelEspecialidadeDB(args = {}) {
  try {
    const tz = CLINIC_TZ;

    // resolver especialidade -> medicos
    const espIds = await _resolveEspecialidadeIds(args);
    if (!espIds.length) return { ok: true, dia: null, slots: [] };

    const { data: med, error: medErr } = await supabase
      .from('medicos')
      .select('id')
      .in('especialidade_id', espIds);
    if (medErr) return { ok: false, message: 'Erro ao buscar médicos da especialidade.' };

    const medicoIds = (med || []).map(m => m.id);
    if (!medicoIds.length) return { ok: true, dia: null, slots: [] };

    // ponto de partida
    let startUTC;
    if (args.aPartirDe && /^\d{4}-\d{2}-\d{2}$/.test(args.aPartirDe)) {
      ({ startUTC } = dayRangeUTCFromYYYYMMDD(tz, args.aPartirDe));
    } else {
      startUTC = new Date();
    }

    // 1º slot livre a partir de startUTC (qualquer médico da especialidade)
    const { data: first, error: fErr } = await supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, duration_min, medicos ( id, nome )')
      .in('medico_id', medicoIds)
      .gte('datetime', startUTC.toISOString())
      .eq('status', 'livre')
      .order('datetime', { ascending: true })
      .limit(1);

    if (fErr) return { ok: false, message: 'Erro ao buscar próximo dia disponível (especialidade).' };
    if (!first?.length) return { ok: true, dia: null, slots: [] };

    // descobrir o dia local e pegar TODOS os slots desse dia (todos os médicos da especialidade)
    const firstIso = first[0].datetime;
    const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const dia = ymdFmt.format(new Date(firstIso));

    const { startUTC: s, endUTC: e } = dayRangeUTCFromYYYYMMDD(tz, dia);
    const { data, error } = await supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, duration_min, status, medicos ( id, nome )')
      .in('medico_id', medicoIds)
      .gte('datetime', s.toISOString())
      .lt('datetime', e.toISOString())
      .eq('status', 'livre')
      .order('datetime', { ascending: true });

    if (error) return { ok: false, message: 'Erro ao buscar slots do próximo dia disponível (especialidade).' };

    const fmtLocal = iso => new Date(iso).toLocaleString('pt-BR', {
      timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const slots = (data || []).map(r => ({
      id: r.id,
      isoUTC: r.datetime,
      local: fmtLocal(r.datetime),
      medicoId: r.medico_id,
      medicoNome: r.medicos?.nome ?? null,
      duracaoMin: r.duration_min ?? null
    }));

    return { ok: true, dia, slots };
  } catch (e) {
    console.error('[listarProximoDiaDisponivelEspecialidadeDB] erro:', e);
    return { ok: false, message: 'Falha inesperada ao buscar próximo dia disponível por especialidade.' };
  }
}
