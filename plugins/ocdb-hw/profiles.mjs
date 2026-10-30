// Model-profile routing, kept free of OpenCode imports so it can be unit-tested.
// The catalog is the catalog.json the installer renders: { installed, agents, profiles }.

/** "provider/model#variant" for an OpenCode model value ({ providerID, id | model | modelID, variant }) or string. */
export function modelRef(model) {
  if (!model) return null
  if (typeof model === "string") return model
  const id = model.id ?? model.model ?? model.modelID
  return `${model.providerID}/${id}${model.variant ? `#${model.variant}` : ""}`
}

/** Splits "provider/model#variant" into { providerID, id, variant? }. */
export function parseRef(ref) {
  const [model, variant] = ref.split("#")
  const slash = model.indexOf("/")
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1), ...(variant ? { variant } : {}) }
}

/** The profile in effect: the stored choice, unless OCDB was reinstalled with another profile since. */
export function effectiveProfile(catalog, stored) {
  const choice = stored && typeof stored === "object" ? stored : {}
  return choice.installed === catalog.installed && catalog.profiles[choice.profile] ? choice.profile : catalog.installed
}

/** The model each managed agent gets under `profileID`: { agentID: "provider/model#variant" }. */
export function assignments(catalog, profileID) {
  const profile = catalog.profiles[profileID]
  return Object.fromEntries(Object.entries(catalog.agents).map(([agentID, role]) => [agentID, profile[role]]))
}

/** Models a profile uses that are not in `available` (a Set of "provider/model"). */
export function missingModels(catalog, profileID, available) {
  const refs = new Set(Object.values(assignments(catalog, profileID)).map((ref) => ref.split("#")[0]))
  return [...refs].filter((ref) => !available.has(ref))
}

/** What the sidebar and picker show for every profile. */
export function profileStatus(catalog, selected, available) {
  return {
    installed: catalog.installed,
    selected,
    profiles: Object.entries(catalog.profiles).map(([id, profile]) => {
      const missing = missingModels(catalog, id, available)
      return { id, label: profile.label, description: profile.description, requires: profile.requires, available: missing.length === 0, missing }
    }),
  }
}
