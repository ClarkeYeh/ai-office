#!/usr/bin/env node
import { runCli } from './index.js';

const result = runCli(process.argv.slice(2));
console.log(result.message);
process.exitCode = result.exitCode;
