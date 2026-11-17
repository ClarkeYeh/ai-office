import { expect, test } from 'vitest';
import { createServer } from './main.js';

test('creates the server without opening a listener', async () => {
  const server = createServer();
  try {
    const response = await server.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);
  } finally {
    await server.close();
  }
});
