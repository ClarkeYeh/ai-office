import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { StartWorkflowRequestSchema } from '@ai-office/contracts/api';
import { expect, test } from 'vitest';

test('Fastify type provider validates and serializes the Zod 4 contracts', async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.withTypeProvider<ZodTypeProvider>().post(
    '/smoke',
    {
      schema: {
        body: StartWorkflowRequestSchema,
        response: { 200: StartWorkflowRequestSchema },
      },
    },
    async (request) => request.body,
  );
  try {
    const payload = {
      templateId: 'test',
      repoId: 'repo',
      requirement: 'Build',
    };
    const valid = await app.inject({ method: 'POST', url: '/smoke', payload });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual(payload);
    const invalid = await app.inject({
      method: 'POST',
      url: '/smoke',
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
  } finally {
    await app.close();
  }
});
