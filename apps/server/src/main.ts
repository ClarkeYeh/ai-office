import Fastify from 'fastify';

// The only composition root. Routes and adapters will be wired here.
export function createServer() {
  return Fastify();
}
