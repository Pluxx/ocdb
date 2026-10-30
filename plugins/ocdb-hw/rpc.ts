import { Rpc } from "@opencode/plugin/rpc"

const status = {
  type: "object",
  properties: {
    installed: { type: "string" },
    selected: { type: "string" },
    profiles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          requires: { type: "array", items: { type: "string" } },
          available: { type: "boolean" },
          missing: { type: "array", items: { type: "string" } },
        },
        required: ["id", "label", "description", "requires", "available", "missing"],
        additionalProperties: false,
      },
    },
  },
  required: ["installed", "selected", "profiles"],
  additionalProperties: false,
} as const

export const OcdbProfiles = Rpc.define({
  id: "ocdb-profiles",
  events: {},
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: status,
    },
    select: {
      input: {
        type: "object",
        properties: { profile: { type: "string" } },
        required: ["profile"],
        additionalProperties: false,
      },
      output: status,
      errors: {
        unavailable: {
          type: "object",
          properties: { profile: { type: "string" }, missing: { type: "array", items: { type: "string" } } },
          required: ["profile", "missing"],
          additionalProperties: false,
        },
      },
    },
  },
})
