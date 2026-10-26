import { Rpc } from "@opencode/plugin/rpc";

export const OpenAIWeekly = Rpc.define({
  id: "openai-weekly",
  events: {},
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [
              "ok",
              "disconnected",
              "unsupported",
              "auth_required",
              "rate_limited",
              "unavailable",
            ] as const,
          },
          checkedAt: { type: "number" },
          weekly: {
            oneOf: [
              { type: "null" },
              {
                type: "object",
                properties: {
                  usedPercent: { type: "number" },
                  remainingPercent: { type: "number" },
                  resetAt: { oneOf: [{ type: "number" }, { type: "null" }] },
                },
                required: ["usedPercent", "remainingPercent", "resetAt"],
                additionalProperties: false,
              },
            ],
          },
          message: { oneOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["status", "checkedAt", "weekly", "message"],
        additionalProperties: false,
      },
    },
  },
});
