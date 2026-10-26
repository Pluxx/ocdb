#!/usr/bin/env node
import { runCli } from '../lib/cli.mjs';

try {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
} catch (error) {
  console.error(`vc-ocdb: ${error.message}`);
  process.exitCode = 1;
}
