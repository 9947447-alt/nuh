import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include';
import { listMnemonReadOnlyTools, MNEMON_READONLY_TOOL_NAMES } from '@nuh/dsh-shims';
import '@deepseek-ai/cordis-plugin-loader';
import {
  boot,
  createRuntimeResolution,
  initProfile,
  loadProfileDirectory,
  PluginPackages,
  type ProfileContext,
  resolveProfileDir,
  resolveTelemetryPatch,
} from '@deepseek-ai/dsh-app-boot';

const FIBER_STATE_ACTIVE = 2;

export interface DshHeadlessBootOptions {
  readonly binName?: string;
  readonly profileName?: string;
  readonly dshHome?: string;
  readonly cwd?: string;
  readonly disableTelemetry?: boolean;
  readonly extraPatches?: readonly PatchOptions[];
}

export interface DshActiveEntrySummary {
  readonly id: string;
  readonly name: string;
}

export interface DshHeadlessRuntime {
  readonly ctx: Context;
  readonly dshHome: string;
  readonly profileDir: string;
  readonly loadedPluginIds: readonly string[];
  readonly settingsActive: boolean;
  readonly hmrDisabled: boolean;
  isDisposed(): boolean;
  dispose(): Promise<void>;
}

function resolveDefaultDshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return path.join(homedir(), '.nuh', 'dsh-home');
}

function collectActiveEntries(ctx: Context): DshActiveEntrySummary[] {
  const loader = ctx.get('loader');
  if (!loader) {
    return [];
  }
  const active: DshActiveEntrySummary[] = [];
  for (const entry of loader.entries()) {
    if (!entry.disabled && entry.fiber?.state === FIBER_STATE_ACTIVE) {
      active.push({
        id: entry.options.id ?? entry.options.name ?? '(unknown)',
        name: entry.options.name ?? '(unknown)',
      });
    }
  }
  return active;
}

function isEntryDisabled(ctx: Context, entryId: string): boolean {
  const loader = ctx.get('loader');
  if (!loader) {
    return false;
  }
  for (const entry of loader.entries()) {
    if (entry.options.id === entryId) {
      return Boolean(entry.disabled);
    }
  }
  return false;
}

/**
 * 以纯无头方式组装并启动 `@deepseek-ai/dsh-base` 运行时。
 * 遵循 Spike 02 / ADR-0003：
 * - 通过 `dsh-app-boot` 自组装 Profile，将 `cordis.yml` 置于 `$DSH_HOME/profiles/<name>/`
 * - 注入最小 `profileContext` 与启用 `settings`
 * - 显式禁用 `hmr`（避免缺少应用就绪信号报错）
 * - 等待 `loader.await()` 完全就绪
 */
export async function bootDshHeadlessRuntime(
  options: DshHeadlessBootOptions = {},
): Promise<DshHeadlessRuntime> {
  const binName = options.binName ?? 'nuh-daemon';
  const profileName = options.profileName ?? 'nuh-daemon';
  const dshHome = options.dshHome ? path.resolve(options.dshHome) : resolveDefaultDshHome();
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const disableTelemetry = options.disableTelemetry ?? true;

  process.env.DSH_HOME = dshHome;
  if (disableTelemetry) {
    process.env.DSH_TELEMETRY_DISABLED = '1';
  }

  const profileDir = resolveProfileDir(profileName, dshHome);
  mkdirSync(profileDir, { recursive: true });

  const bundles = ['@deepseek-ai/dsh-base', 'dsh-mnemon'] as const;
  initProfile(profileDir, bundles);
  ensureProfileBundles(profileDir, bundles);

  const installAnchor = path.resolve(import.meta.dirname, '../package.json');
  const profile = loadProfileDirectory(binName, profileDir, installAnchor);

  const resolution = await createRuntimeResolution({
    installAnchor,
    profile,
    home: dshHome,
  });

  const rootConfigPath = path.join(profileDir, 'cordis.yml');
  if (!existsSync(rootConfigPath)) {
    writeFileSync(rootConfigPath, '[]\n', 'utf8');
  }

  const headlessPatches: PatchOptions[] = [
    { id: 'settings', disabled: false },
    { id: 'hmr', disabled: true },
  ];
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, true);
  if (telemetryPatch) {
    headlessPatches.push(telemetryPatch);
  }

  const patches: PatchOptions[] = [
    ...profile.layers.flatMap((layer) => layer.patches),
    ...profile.patches,
    ...headlessPatches,
    ...(options.extraPatches ?? []),
  ];

  const profileContext: ProfileContext = {
    name: profileName,
    dir: profileDir,
    patchPath: profile.patchPath,
    installAnchor,
    cwd,
    home: dshHome,
    startedBundles: [...bundles],
    overlays: headlessPatches,
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
  };

  const ctx = await boot(binName, rootConfigPath, patches, async (rootCtx) => {
    await rootCtx.plugin(PluginPackages, { resolution });
    rootCtx.provide('profileContext', profileContext);
  });

  await ctx.get('loader')?.await();
  await settleMnemonCatalog(ctx);

  const activeEntries = collectActiveEntries(ctx);
  const loadedPluginIds = activeEntries.map((entry) => entry.id);
  const settingsActive = ctx.get('settings') !== undefined;
  const hmrDisabled = isEntryDisabled(ctx, 'hmr');

  let disposePromise: Promise<void> | null = null;
  let disposed = false;

  return {
    ctx,
    dshHome,
    profileDir,
    loadedPluginIds,
    settingsActive,
    hmrDisabled,
    isDisposed() {
      return disposed;
    },
    async dispose() {
      if (!disposePromise) {
        disposePromise = (async () => {
          try {
            await ctx.get('loader')?.await();
          } catch {
            // 释放阶段优先继续销毁根 Fiber
          }
          await ctx.fiber.dispose();
          disposed = true;
        })();
      }
      await disposePromise;
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureProfileBundles(profileDir: string, requiredBundles: readonly string[]): void {
  const pkgPath = path.join(profileDir, 'package.json');
  if (!existsSync(pkgPath)) {
    return;
  }
  const raw: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (!isPlainObject(raw)) {
    return;
  }
  const dsh = isPlainObject(raw.dsh) ? raw.dsh : {};
  const profile = isPlainObject(dsh.profile) ? dsh.profile : {};
  const currentBundles = Array.isArray(profile.bundles)
    ? profile.bundles.filter((item): item is string => typeof item === 'string')
    : [];
  const nextBundles = [...currentBundles];
  let changed = false;
  for (const bundle of requiredBundles) {
    if (!nextBundles.includes(bundle)) {
      nextBundles.push(bundle);
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  const updated = {
    ...raw,
    dsh: {
      ...dsh,
      profile: {
        ...profile,
        bundles: nextBundles,
      },
    },
  };
  writeFileSync(pkgPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}

/**
 * dsh-mnemon schedules async `memoryPlugins.catalog()` in a `loader.await()`
 * continuation. Waiting briefly for its read-only tools plus one short settle
 * turn prevents teardown races when callers shut down right after boot.
 */
async function settleMnemonCatalog(ctx: Context): Promise<void> {
  const deadlineMs = Date.now() + 500;
  while (Date.now() < deadlineMs) {
    if (listMnemonReadOnlyTools(ctx).length >= MNEMON_READONLY_TOOL_NAMES.length) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 80);
      });
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
  }
}
