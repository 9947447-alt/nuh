#!/usr/bin/env node
import { BackendKindSchema } from '@nuh/protocol';
import { type ReplOptions, startRepl } from './repl.ts';

function parseCliArgs(argv: readonly string[]): ReplOptions {
  let daemonEntry: string | undefined;
  let defaultBackend: ReplOptions['defaultBackend'];
  let defaultModel: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--daemon' && next) {
      daemonEntry = next;
      i += 1;
    } else if (arg === '--backend' && next) {
      defaultBackend = BackendKindSchema.parse(next);
      i += 1;
    } else if (arg === '--model' && next) {
      defaultModel = next;
      i += 1;
    }
  }

  return {
    ...(daemonEntry !== undefined ? { daemonEntry } : {}),
    ...(defaultBackend !== undefined ? { defaultBackend } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
  };
}

const exitCode = await startRepl(parseCliArgs(process.argv.slice(2)));
process.exit(exitCode);
