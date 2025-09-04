// helpers/ai-normalize.js
import { normalizerModel } from '../libs/vertex.js';

// Data/hora livre → ISO UTC via LLM
export async function normalizeDateTimeToUTC(raw, tz = 'America/Sao_Paulo') {
  try {
    const now = new Date();
    const currentYearInTZ = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(now)
    );

    const prompt = `
Extraia data/hora do texto e converta no contexto do fuso "${tz}".
Regras:
- Interprete relativos (hoje, amanhã, terça) a partir de agora UTC (${now.toISOString()}) no fuso "${tz}".
- Se o ANO não for informado, use exatamente o ano corrente no fuso: ${currentYearInTZ}.
- "hasTime" = true somente se houver hora explícita (14:00, 14h, 14 horas, manhã/tarde/noite também contam).
- Se "hasTime" = false, não preencha "iso"; preencha apenas "ymdLocal" (YYYY-MM-DD no fuso da clínica).
- Saída STRICT: {"hasTime":true|false,"ymdLocal":"YYYY-MM-DD"|null,"iso":"YYYY-MM-DDTHH:mm:ss±hh:mm"|null}.
- Se não entender, retorne {"hasTime":false,"ymdLocal":null,"iso":null}.

Texto: """${String(raw)}"""
`;

    const r = await normalizerModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });
    const txt = r.response?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
    const parsed = JSON.parse(txt);

    if (!parsed?.ymdLocal) return null;

    let isoUTC = null;
    if (parsed.hasTime && parsed.iso) {
      const d = new Date(parsed.iso);
      if (Number.isNaN(+d)) return null;
      isoUTC = d.toISOString();
    }

    return { isoUTC, hasTime: !!parsed.hasTime, ymdLocal: parsed.ymdLocal };
  } catch (e) {
    console.error('[normalizeDateTimeToUTC] erro:', e?.message || e);
    return null;
  }
}


// Nascimento → YYYY-MM-DD via LLM
export async function normalizeBirthDate(raw) {
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

        if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) return null;
        const d = new Date(parsed.date + 'T00:00:00Z');
        if (Number.isNaN(+d)) return null;

        return parsed.date;
    } catch {
        return null;
    }
}
