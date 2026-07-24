// Точка входа боевого сервера Polaris. Запуск: `npm start` (или node src/index.js).
// Конфигурация — только из окружения (см. .env.example); секретов в коде нет.

import { createServer } from './server.js';

const PORT = Number(process.env.PORT || 8787);
const groqApiKey = process.env.GROQ_API_KEY;

const server = createServer({ groqApiKey, model: process.env.GROQ_MODEL });

server.listen(PORT, () => {
  const ai = groqApiKey ? 'ON (Groq)' : 'OFF (нет GROQ_API_KEY)';
  // eslint-disable-next-line no-console
  console.log(`Polaris server слушает :${PORT} · рыночные данные: synthetic (demo) · Cosmo AI: ${ai}`);
});
