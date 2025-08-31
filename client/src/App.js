import { useState } from 'react';

function App() {
  const initialBot = 'Olá! Posso ajudar com informações e agendamentos. Como posso ajudar hoje?';

  const [msgs, setMsgs] = useState([{ role: 'assistant', text: initialBot }]);
  const [ctx, setCtx]   = useState([
    { role: 'model', parts: [{ text: initialBot }] }  // <- contexto técnico
  ]);
  const [input, setInput] = useState('');

  const send = async () => {
    const userText = input.trim();
    if (!userText) return;

    // UI primeiro
    setMsgs(prev => [...prev, { role: 'user', text: userText }]);

    // chama API passando o contexto técnico
    const r = await fetch('http://localhost:8080/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: ctx, message: userText })
    });

    const data = await r.json();

    // UI: resposta do bot
    setMsgs(prev => [...prev, { role: 'assistant', text: data.text }]);

    // CONTEXTO: adiciona user + ctxDelta do backend
    setCtx(prev => [
      ...prev,
      { role: 'user', parts: [{ text: userText }] },      // este turno do usuário
      ...(data.ctxDelta || [])                            // eco da função + tool + texto do bot
    ]);

    setInput('');
  };

  return (
    <div className="max-w-xl mx-auto p-4 space-y-3">
      <div className="border rounded-xl p-3 h-[60vh] overflow-y-auto space-y-2">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'assistant' ? 'text-left' : 'text-right'}>
            <span className={`inline-block px-3 py-2 rounded-2xl ${m.role === 'assistant' ? 'bg-gray-100' : 'bg-blue-100'}`}>{m.text}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input className="flex-1 border rounded-lg px-3 py-2" value={input} onChange={e => setInput(e.target.value)} placeholder="Escreva sua mensagem..." />
        <button className="px-4 py-2 rounded-lg bg-blue-600 text-white" onClick={send}>Enviar</button>
      </div>
    </div>
  );
}

export default App;
