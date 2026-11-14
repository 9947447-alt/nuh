#!/usr/bin/env node
import { createNuhDaemon, type NuhDaemon } from './daemon.ts';

interface CliOptions {
  readonly dshHome?: string;
  readonly nuhHome?: string;
  readonly profileName?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let dshHome: string | undefined;
  let nuhHome: string | undefined;
  let profileName: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--dsh-home' && next) {
      dshHome = next;
      i += 1;
    } else if (arg === '--nuh-home' && next) {
      nuhHome = next;
      i += 1;
    } else if (arg === '--profile' && next) {
      profileName = next;
      i += 1;
    }
  }

  return {
    ...(dshHome !== undefined ? { dshHome } : {}),
    ...(nuhHome !== undefined ? { nuhHome } : {}),
    ...(profileName !== undefined ? { profileName } : {}),
  };
}

function writeStderrJson(payload: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  let daemon: NuhDaemon | null = null;
  let pendingSignal: NodeJS.Signals | null = null;
  let exiting = false;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (exiting) {
      return;
    }
    if (!daemon) {
      pendingSignal = signal;
      return;
    }
    exiting = true;
    void (async () => {
      try {
        await daemon.shutdown(signal);
        writeStderrJson({
          source: 'nuh-daemon',
          event: 'daemon_disposed',
          reason: signal,
          fiberDisposed: daemon.runtime.isDisposed(),
        });
      } finally {
        process.exit(0);
      }
    })();
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  daemon = await createNuhDaemon({
    dshOptions: {
      ...(cli.dshHome !== undefined ? { dshHome: cli.dshHome } : {}),
      ...(cli.profileName !== undefined ? { profileName: cli.profileName } : {}),
    },
    ...(cli.nuhHome !== undefined ? { nuhHome: cli.nuhHome } : {}),
  });

  if (pendingSignal) {
    handleSignal(pendingSignal);
    return;
  }

  writeStderrJson({
    source: 'nuh-daemon',
    event: 'daemon_ready',
    profileDir: daemon.runtime.profileDir,
    loadedPluginCount: daemon.runtime.loadedPluginIds.length,
    settingsActive: daemon.runtime.settingsActive,
    hmrDisabled: daemon.runtime.hmrDisabled,
  });

  await daemon.serveStdio(process.stdin, process.stdout);
  if (!exiting) {
    exiting = true;
    await daemon.shutdown('stdin-eof');
    writeStderrJson({
      source: 'nuh-daemon',
      event: 'daemon_disposed',
      reason: 'stdin-eof',
      fiberDisposed: daemon.runtime.isDisposed(),
    });
  }
}

main().catch((cause: unknown) => {
  const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  writeStderrJson({
    source: 'nuh-daemon',
    event: 'daemon_fatal',
    error: detail,
  });
  process.exit(1);
});
