// helpers/whats-format.js
export function sanitizeWhats(text) {
  if (!text) return text;
  let t = String(text);

  // 1) Colapsar asteriscos duplicados (ex.: ** -> *)
  while (t.includes('**')) t = t.replaceAll('**', '*');

  // 2) Não destacar conectivos comuns
  const STOP = ['ou','e','de','da','do','das','dos','a','o','as','os'];
  for (const w of STOP) {
    t = t.replaceAll(` *${w}* `, ` ${w} `);
    t = t.replaceAll(` *${w}*`, ` ${w}`);
    t = t.replaceAll(`*${w}* `, `${w} `);
  }

  // 3) Remover asteriscos grudados em parênteses/pontuação
  t = t.replaceAll('* )', ')').replaceAll('(*', '(');
  t = t.replaceAll('* ,', ',').replaceAll(', *', ', ');
  t = t.replaceAll(' * ', ' ');

  return t.trim();
}
