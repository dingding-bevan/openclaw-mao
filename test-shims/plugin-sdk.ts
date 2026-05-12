// Runtime stub for "openclaw/plugin-sdk" used during unit tests.
// The type declarations are in openclaw-plugin-sdk.d.ts;
// this module provides the actual runtime values that tests can
// import and interact with.

export type { OpenClawPluginApi, MemoryArtifact, PublicArtifactsProvider, MemoryCapabilityConfig } from "../openclaw-plugin-sdk";

/** Minimal logger stub — discards all messages. */
export const logger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
  error: (_msg: string) => {},
  debug: (_msg: string) => {},
};

/** Default mutable plugin config used by tests. */
export const pluginConfig: Record<string, unknown> = {};

/** Path resolver stub — returns input unchanged. */
export function resolvePath(p: string): string {
  return p;
}

export function registerTool(
  _definition: Record<string, unknown>,
  _metadata?: Record<string, unknown>,
): void {}

export function on(_event: string, _handler: (...args: unknown[]) => unknown): void {}

export function registerCli(_handler: (context: { program: unknown }) => void, _options?: Record<string, unknown>): void {}

export function registerCommand(_definition: Record<string, unknown>): void {}

export function registerService(_service: { id: string; start: (...args: unknown[]) => void; stop: () => void }): void {}

export function registerMemoryCapability(_config: Record<string, unknown>): void {}
