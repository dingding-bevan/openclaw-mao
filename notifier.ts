import { spawnSync } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export const Notifier = {
  /**
   * Best-effort Discord push via `openclaw message send`. Silently no-op when
   * config.discordChannel is unset. Failures are logged as warn but never throw.
   */
  sendDiscord(api: OpenClawPluginApi, message: string): void {
    const channel = ((api.pluginConfig as Record<string, unknown> | undefined)?.discordChannel as string | undefined) ?? "";
    if (!channel) return;
    const result = spawnSync(
      "openclaw",
      ["message", "send", "--channel", "discord", "--target", channel, "--message", message],
      { encoding: "utf8", timeout: 15_000 },
    );
    if (result.status !== 0) {
      api.logger.warn(`openclaw-mao: notifier discord send failed: ${result.stderr ?? `exit ${result.status}`}`);
    }
  },
};
