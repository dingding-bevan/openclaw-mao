// Runtime stub for "openclaw/plugin-sdk/plugin-entry" used during unit tests.
// The type declarations are in openclaw-plugin-sdk.d.ts.

export type { PluginEntry } from "../openclaw-plugin-sdk";

export function definePluginEntry<T>(entry: T): T {
  return entry;
}
