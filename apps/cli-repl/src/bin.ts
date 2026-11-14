#!/usr/bin/env node
import { startRepl } from './repl.ts';

function parseDaemonArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--daemon' && argv[i + 1]) {
      return argv[i + 1];
    }
  }
  return undefined;
}

const daemonEntry = parseDaemonArg(process.argv.slice(2));
const exitCode = await startRepl(daemonEntry !== undefined ? { daemonEntry } : {});
process.exit(exitCode);
