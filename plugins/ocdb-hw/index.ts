import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { OcdbProfiles } from "./rpc.ts"
import { assignments, effectiveProfile, modelRef, parseRef, profileStatus } from "./profiles.mjs"

// Rendered by `ocdb install` for the installed profile; see lib/model-profiles.mjs.
const catalog = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8"))
const SELECTED_KEY = "profile"

// The server part routes OCDB's agents to the selected model profile and switches
// it live. Plugin transforms run before config, so a model the user sets for an
// agent in opencode.json still wins. Hardware sampling belongs to the TUI part.
export default Plugin.define({
  id: "ocdb.hardware",
  async setup(ctx) {
    const stored = async () => effectiveProfile(catalog, await ctx.storage.get(SELECTED_KEY))
    let selected = await stored()

    const agents = await ctx.agent.transform((editor) => {
      for (const [id, ref] of Object.entries(assignments(catalog, selected))) {
        editor.update(id, (agent) => {
          agent.model = parseRef(ref)
        })
      }
    })

    const apply = async (profile: string) => {
      selected = profile
      await ctx.agent.reload()
    }
    const available = async () => {
      const response: unknown = await ctx.model.list()
      const list = Array.isArray(response) ? response : ((response as { data?: unknown[] })?.data ?? [])
      return new Set(list.map((model) => modelRef(model as Parameters<typeof modelRef>[0])!.split("#")[0]))
    }

    const registration = await ctx.rpc.register(OcdbProfiles, {
      status: async () => {
        // Another project's instance may have switched; follow the stored choice.
        const latest = await stored()
        if (latest !== selected) await apply(latest)
        return profileStatus(catalog, selected, await available())
      },
      select: async (input, context) => {
        const { profile } = input as { profile: string }
        const target = profileStatus(catalog, selected, await available()).profiles.find((candidate) => candidate.id === profile)
        // The installed profile is the baseline, so returning to it is always allowed.
        if (!target || (!target.available && profile !== catalog.installed)) {
          return context.error("unavailable", `Profile ${profile} is not available`, { profile, missing: target?.missing ?? [] })
        }
        await ctx.storage.set(SELECTED_KEY, { profile, installed: catalog.installed })
        if (profile !== selected) await apply(profile)
        return profileStatus(catalog, selected, await available())
      },
    })

    return async () => {
      await registration.dispose()
      await agents.dispose()
    }
  },
})
