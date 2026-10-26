import { Plugin } from "@opencode/plugin";
import { OpenAIWeekly } from "./rpc.ts";
import { NativeCodexQuotaService } from "./src/backend/native-codex.ts";

const OpenAIWeeklyPlugin = Plugin.define({
  id: "openai-weekly.server",
  async setup(context) {
    const service = new NativeCodexQuotaService();
    const registration = await context.rpc.register(OpenAIWeekly, {
      status: async () => service.status(),
    });
    return async () => {
      service.cleanup();
      await registration.dispose();
    };
  },
});

export default OpenAIWeeklyPlugin;
