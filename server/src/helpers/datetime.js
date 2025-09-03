// helpers/datetime.js

// Calcula o offset do fuso (em minutos) p/ uma data
export function offsetMinutesAt(date, tz) {
    const part = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'shortOffset',
        hour: '2-digit'
    }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value || 'UTC+00:00';

    const m = part.match(/([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    const hh = parseInt(m[2], 10);
    const mm = parseInt(m[3] || '0', 10);
    return sign * (hh * 60 + mm);
}

// Constrói o instante UTC correspondente a um "wall time" no fuso tz (robusto em DST)
export function utcFromTZComponents(tz, y, M, d, h = 0, m = 0, s = 0, ms = 0) {
    const naive = Date.UTC(y, M - 1, d, h, m, s, ms);
    const off1 = offsetMinutesAt(new Date(naive), tz);
    const guess = naive - off1 * 60000;
    const off2 = offsetMinutesAt(new Date(guess), tz);
    return new Date(naive - off2 * 60000);
}

// Retorna { start, end } em UTC para o dia de AMANHÃ no fuso tz
export function nextDayRangeUTC(tz, base = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(base);
    const y = +parts.find(p => p.type === 'year').value;
    const M = +parts.find(p => p.type === 'month').value;
    const d = +parts.find(p => p.type === 'day').value;

    const todayStartUTC = utcFromTZComponents(tz, y, M, d, 0, 0, 0, 0);
    const tomorrowStartUTC = new Date(todayStartUTC.getTime() + 24 * 3600 * 1000);
    const dayAfterStartUTC = new Date(tomorrowStartUTC.getTime() + 24 * 3600 * 1000);

    return { start: tomorrowStartUTC, end: dayAfterStartUTC }; // [start, end)
}

// Constrói intervalo UTC para um dia "YYYY-MM-DD" no fuso tz
export function dayRangeUTCFromYYYYMMDD(tz, ymd) {
    const [y, M, d] = ymd.split('-').map(Number);
    const startUTC = utcFromTZComponents(tz, y, M, d, 0, 0, 0, 0);
    const endUTC = new Date(startUTC.getTime() + 24 * 3600 * 1000);
    return { startUTC, endUTC };
}
