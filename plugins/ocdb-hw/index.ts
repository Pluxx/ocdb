import { Plugin } from "@opencode/plugin"

// The server entrypoint is intentionally inert. Hardware sampling belongs to
// the local TUI entrypoint, not the connected OpenCode server.
export default Plugin.define({
  id: "ocdb.hardware",
  setup() {},
})
