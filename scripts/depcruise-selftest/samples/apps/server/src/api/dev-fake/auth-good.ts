import { auth } from '../auth/index.js';
import { errors } from '../errors.js';
import { value } from '@fastify/cookie';
export const allowed = [auth, errors, value];
