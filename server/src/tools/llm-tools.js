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
  normalizeBirthDate,
} from '../helpers/ai-normalize.js';

const CLINIC_TZ = process.env.CLINIC_TZ || 'America/Sao_Paulo';

/* -------------------------------------------------------------------------- */
/* validarDataHora                                                            */
/* -------------------------------------------------------------------------- */
export async function validarDataHora(args) {
  const tz = CLINIC_TZ;
  const raw = String(args?.dataText ?? '').trim();

  const norm = await normalizeDateTimeToUTC(raw, tz); // { isoUTC, hasTime, ymdLocal }
  if (!norm) {
    return {
      ok: false,
      message: 'Data/hora inválida. Informe com dia/mês/ANO e hora (ex.: 08/10/2025 14:00 ou "8 de outubro de 2025 às 14:00").'
    };
  }

  const { isoUTC, hasTime, ymdLocal } = norm;

  // compara por DIA local (sem hora)
  const todayYMD = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());

  if (hasTime === false) {
    // Só data: aceitar HOJE ou futuro
    if (ymdLocal < todayYMD) {
      return { ok: false, message: 'A data deve ser hoje ou no futuro. Informe um dia válido.' };
    }
    return { ok: true, isoUTC: null, ymdLocal, hasTime: false };
  }

  // Com hora: precisa ser estritamente no futuro
  if (!isoUTC) {
    return { ok: false, message: 'Informe também a hora (ex.: 14:00) para eu prosseguir.' };
  }

  const d = new Date(isoUTC);
  if (d.getTime() <= Date.now()) {
    return { ok: false, message: 'A data/hora deve ser no futuro. Informe um horário válido.' };
  }

  return { ok: true, isoUTC, ymdLocal, hasTime: true };
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

    // Sem slotId: tenta localizar um slot livre pelo datetime + médico
    let q = supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, status')
      .eq('datetime', isoUTC)
      .eq('status', 'livre')
      .order('id', { ascending: true });

    if (medicoId) q = q.eq('medico_id', String(medicoId));

    // Se não veio medicoId, buscamos 2 para detectar ambiguidade; com medicoId, 1 já basta
    const { data: found, error: fErr } = await q.limit(medicoId ? 1 : 2);

    if (fErr) return { ok: false, message: 'Erro ao verificar disponibilidade.' };
    if (!found?.length) return { ok: false, message: 'Horário indisponível.' };

    // ⚠️ Se houver mais de um slot no mesmo horário e nenhum médico foi especificado, peça desambiguação
    if (!medicoId && found.length > 1) {
      return {
        ok: false,
        message: 'Há mais de um médico com esse horário. Informe o médico ou escolha um horário da lista.'
      };
    }

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


function normalizeEspecialidadeTerm(s) {
  const strip = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const t = String(s || '').trim().toLowerCase();
  const tn = strip(t);

  // Aliases (pode expandir à vontade)
  const alias = {
    cardiologista: 'cardiologia',
    dermatologista: 'dermatologia',
    ginecologista: 'ginecologia',
    obstetra: 'obstetrícia',
    ortopedista: 'ortopedia',
    pediatra: 'pediatria',
    psiquiatra: 'psiquiatria',
    neurologista: 'neurologia',
    urologista: 'urologia',
    oftalmologista: 'oftalmologia',
    otorrinolaringologista: 'otorrinolaringologia',
    reumatologista: 'reumatologia',
    endocrinologista: 'endocrinologia',
    infectologista: 'infectologia',
    pneumologista: 'pneumologia',
    gastroenterologista: 'gastroenterologia',
    nefrologista: 'nefrologia',
    hematologista: 'hematologia',
    oncologista: 'oncologia',
    alergista: 'alergologia',         // ajuste se no catálogo for "Alergia e Imunologia"
    geriatra: 'geriatria',
    'nutrólogo': 'nutrologia',
    'clínico': 'clínica médica',
    'clínico geral': 'clínica médica',

    // abreviações comuns
    dermato: 'dermatologia',
    cardio: 'cardiologia',
    gineco: 'ginecologia',
    oftalmo: 'oftalmologia',
    otorrino: 'otorrinolaringologia',
    reumato: 'reumatologia',
    orto: 'ortopedia',
    gastro: 'gastroenterologia',
    pneumo: 'pneumologia',
    neuro: 'neurologia',
    endo: 'endocrinologia',
    nutrologo: 'nutrologia',          // sem acento
    clinico: 'clínica médica',        // sem acento
    'clinico geral': 'clínica médica' // sem acento
  };

  // Também permita lookup sem acento
  const aliasNo = Object.fromEntries(Object.entries(alias).map(([k, v]) => [strip(k.toLowerCase()), v]));

  if (alias[t]) return alias[t];
  if (aliasNo[tn]) return aliasNo[tn];

  // Heurísticas morfológicas
  if (tn.endsWith('ologista')) return t.replace(/ologista$/i, 'ologia');
  if (tn.endsWith('logista'))  return t.replace(/logista$/i, 'logia');
  if (tn.endsWith('iatra'))    return t.replace(/iatra$/i, 'iatria');
  if (tn.endsWith('ista'))     return t.replace(/ista$/i, 'ia');

  return s;
}

async function _resolveEspecialidadeIds({ especialidadeId, especialidadeNome }) {
  if (especialidadeId) return [especialidadeId];
  if (!especialidadeNome) return [];

  const original = String(especialidadeNome).trim();
  const normalized = normalizeEspecialidadeTerm(original);

  // 1) tenta com o termo original
  let { data, error } = await supabase
    .from('especialidades')
    .select('id, nome')
    .ilike('nome', `%${original}%`);

  if (error) return [];
  let ids = (data || []).map(r => r.id);

  // 2) se não achou, tenta com o termo normalizado (ex.: cardiologista → cardiologia)
  if (!ids.length && normalized && normalized !== original) {
    const r2 = await supabase
      .from('especialidades')
      .select('id, nome')
      .ilike('nome', `%${normalized}%`);
    if (!r2.error) ids = (r2.data || []).map(r => r.id);
  }

  return ids;
}



/* -------------------------------------------------------------------------- */
/* criarAgendamentoDB                                                         */
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
      return { ok: false, message: 'Telefone inválido. Envie com DDD + número (ex.: 11 91234-5678). O DDI (55) é assumido automaticamente.' };
    }

    // 🔸 Data/hora desejada → usar o novo normalizador (objeto)
    const norm = await normalizeDateTimeToUTC(data.dataISO, CLINIC_TZ); // { isoUTC, hasTime, ymdLocal }
    if (!norm) {
      return { ok: false, message: 'Data/hora da consulta inválida. Use 25/08/2025 18:00 ou "25 de agosto de 2025 às 18:00".' };
    }

    const { isoUTC, hasTime } = norm;

    // 🔒 Agendamento exige HORA explícita
    if (hasTime === false || !isoUTC) {
      return { ok: false, message: 'Para confirmar o agendamento, preciso da HORA (ex.: 14:00). Pode me informar?' };
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
      message: `Agendamento confirmado! ID da consulta: ${created.id}. Guarde este ID — ele será necessário se você quiser cancelar.`,
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
    const busca = (args.busca ?? '').trim();
    const LIMITE_HARD = 200;
    const pageSize = Math.min(Number(args.limite || 8), LIMITE_HARD);

    if (!busca) {
      return { ok: true, medicos: [], needBusca: true, message: 'Envie parte do nome do médico (ex.: "Ana", "Mendes").' };
    }

    const { data, error } = await supabase.rpc('search_medicos_v2', { q: busca, lim: pageSize + 1 });
    if (error) return { ok: false, message: 'Erro ao buscar médicos.' };

    const hasMore = (data?.length || 0) > pageSize;
    const page = (data || []).slice(0, pageSize);

    const candidates = page.map(m => ({
      id: m.id,
      nome: m.nome,
      especialidadeId: m.especialidade_id ?? null,
      score: Math.max(m.sim ?? 0, m.sim_clean ?? 0)
    }));

    const top2 = [...candidates].sort((a, b) => b.score - a.score).slice(0, 2);
    const best = top2[0];
    const second = top2[1];

    let resolvedMedicoId = null, ambiguous = true, resolvedBy = null, confidence = null;

    // único resultado total
    if (!hasMore && candidates.length === 1) {
      resolvedMedicoId = String(candidates[0].id);
      ambiguous = false;
      resolvedBy = 'unique';
      confidence = 1;
    }

    // fuzzy (ranking já é global; ok auto-resolver mesmo com hasMore)
    if (!resolvedMedicoId && best) {
      const TOP_SIM_THRESHOLD = 0.82;
      const MARGIN = 0.12;
      const marginOk = !second || (best.score - second.score) >= MARGIN;

      if (best.score >= TOP_SIM_THRESHOLD && marginOk) {
        resolvedMedicoId = String(best.id);
        ambiguous = false;
        resolvedBy = 'db_fuzzy';
        confidence = Number(best.score.toFixed(3));
      }
    }

    return {
      ok: true,
      medicos: candidates.map(({ score, ...rest }) => rest),
      hasMore,
      ambiguous,
      ...(resolvedMedicoId ? { resolvedMedicoId } : {}),
      ...(resolvedBy ? { resolvedBy, confidence } : {})
    };
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
// listarHorariosMedicoDB
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

    let q = supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, duration_min, status, medicos ( id, nome )')
      .eq('medico_id', String(args.medicoId))
      .gte('datetime', startUTC.toISOString())
      .lt('datetime', endUTC.toISOString())
      .eq('status', 'livre')
      .order('datetime', { ascending: true })
      .limit(limite);

    // Se o dia solicitado for HOJE no fuso, filtre >= agora
    if (args.dia) {
      const todayLocalYMD = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
      if (args.dia === todayLocalYMD) {
        q = q.gte('datetime', new Date().toISOString()); // agora em UTC
      }
    }

    const { data, error } = await q;
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

    // 7) monta a agenda para cada dia de HOJE até DOMINGO (filtrando passados no primeiro dia)
    const nowTs = Date.now();
    const agenda = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(todayStartUTC.getTime() + i * 24 * 60 * 60 * 1000);
      const ymd = ymdFmt.format(d);
      let daySlots = slotsByDay.get(ymd) || [];
      if (i === 0) {
        daySlots = daySlots.filter(s => new Date(s.isoUTC).getTime() >= nowTs);
      }
      agenda.push({ dia: ymd, slots: daySlots });
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

    const { startUTC: s, endUTC: e } = dayRangeUTCFromYYYYMMDD(tz, dia);

    let q = supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, duration_min, status, medicos ( id, nome )')
      .eq('medico_id', medicoId)
      .gte('datetime', s.toISOString())
      .lt('datetime', e.toISOString())
      .eq('status', 'livre')
      .order('datetime', { ascending: true });

    const todayLocalYMD = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    if (dia === todayLocalYMD) {
      q = q.gte('datetime', new Date().toISOString());
    }

    const { data, error } = await q;
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
    let q = supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, duration_min, status, medicos ( id, nome )')
      .in('medico_id', medicoIds)
      .gte('datetime', startUTC.toISOString())
      .lt('datetime', endUTC.toISOString())
      .eq('status', 'livre')
      .order('datetime', { ascending: true })
      .limit(limite);

    if (args.dia) {
      const todayLocalYMD = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
      if (args.dia === todayLocalYMD) {
        q = q.gte('datetime', new Date().toISOString());
      }
    }

    const { data, error } = await q;
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

    const nowTs = Date.now();
    const agenda = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(todayStartUTC.getTime() + i * 86400000);
      const ymd = ymdFmt.format(d);
      let daySlots = slotsByDay.get(ymd) || [];
      if (i === 0) {
        daySlots = daySlots.filter(s => new Date(s.isoUTC).getTime() >= nowTs);
      }
      agenda.push({ dia: ymd, slots: daySlots });
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

    let q = supabase
      .from('agenda_slots')
      .select('id, medico_id, datetime, duration_min, status, medicos ( id, nome )')
      .in('medico_id', medicoIds)
      .gte('datetime', s.toISOString())
      .lt('datetime', e.toISOString())
      .eq('status', 'livre')
      .order('datetime', { ascending: true });

    const todayLocalYMD = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    if (dia === todayLocalYMD) {
      q = q.gte('datetime', new Date().toISOString());
    }

    const { data, error } = await q;
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



/* -------------------------------------------------------------------------- */
/* desmarcarAgendamentoDB                                                     */
/* -------------------------------------------------------------------------- */
export async function desmarcarAgendamentoDB(args = {}) {
  try {
    const CANCEL_STATUS = 'cancelado';
    const { appointmentId } = args || {};
    if (!appointmentId) return { ok: false, message: 'appointmentId é obrigatório.' };

    // 1) Buscar o agendamento
    const { data: appt, error: apptErr } = await supabase
      .from('appointments')
      .select('id, datetime, status, slot_id, medico_id')
      .eq('id', appointmentId)
      .maybeSingle();

    if (apptErr) return { ok: false, message: 'Erro ao buscar agendamento.' };
    if (!appt) return { ok: false, message: 'Agendamento não encontrado.' };

    const prevStatus = String(appt.status || '').toLowerCase();

    // 2) Atualizar status do appointment para "cancelado" (idempotente)
    if (prevStatus !== CANCEL_STATUS) {
      const { error: updErr } = await supabase
        .from('appointments')
        .update({ status: CANCEL_STATUS })
        .eq('id', appt.id);

      if (updErr) return { ok: false, message: 'Falha ao cancelar o agendamento.' };
    }

    // 3) Liberar o slot (se existir)
    let freedSlotId = null;
    if (appt.slot_id) {
      // Deixa o slot como "livre" (sem exigir status anterior; torna a operação idempotente)
      const { error: slotErr } = await supabase
        .from('agenda_slots')
        .update({ status: 'livre' })
        .eq('id', appt.slot_id);

      if (slotErr) {
        // rollback simples do appointment para o status anterior
        try {
          if (prevStatus !== CANCEL_STATUS) {
            await supabase.from('appointments').update({ status: prevStatus }).eq('id', appt.id);
          }
        } catch (rbErr) {
          console.error('[desmarcarAgendamentoDB] rollback falhou:', rbErr);
        }
        return { ok: false, message: 'Falha ao liberar o horário da agenda.' };
      }
      freedSlotId = appt.slot_id;
    }

    // 4) Retorno
    const tz = CLINIC_TZ;
    const dataLocal = new Date(appt.datetime).toLocaleString('pt-BR', {
      timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    return {
      ok: true,
      id: appt.id,
      slotId: freedSlotId,
      resumo: { dataLocal, medicoId: appt.medico_id ?? null }
    };
  } catch (e) {
    console.error('[desmarcarAgendamentoDB] erro:', e);
    return { ok: false, message: 'Erro inesperado ao desmarcar.' };
  }
}
