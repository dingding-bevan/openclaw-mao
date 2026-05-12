import { describe, it, expect } from "vitest";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { logger, pluginConfig } from "openclaw/plugin-sdk";

describe("test shims", () => {
  it("plugin-entry shim resolves", () => {
    const entry = definePluginEntry({
      id: "test",
      name: "test-plugin",
      register: () => {},
    });
    expect(entry.name).toBe("test-plugin");
  });

  it("plugin-sdk stub logger resolves", () => {
    expect(typeof logger.info).toBe("function");
    expect(() => logger.info("test")).not.toThrow();
  });

  it("plugin-sdk stub pluginConfig resolves", () => {
    expect(pluginConfig).toEqual({});
  });
});
