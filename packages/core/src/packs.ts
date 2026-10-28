import { BUILTIN_PACKS, EXAMPLE_PACKS, labelRes, registerPack, registeredPacks, resourceType, type CapabilityPack, type Resource } from "@okayed/engine";

/**
 * Which capability packs a deployment approves, from its configuration: example packs by id ("slack,email") and
 * its own as JSON. Registering is idempotent, so every runtime can call this on each request without cost.
 */
export function enablePacks(o: { ids?: string | undefined; json?: string | undefined }): void {
  const have = new Set(registeredPacks().map((p) => p.id));
  const byId = new Map(Object.values(EXAMPLE_PACKS as Record<string, CapabilityPack>).map((p) => [p.id, p]));
  const wanted: CapabilityPack[] = [];
  for (const id of (o.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const p = byId.get(id);
    if (!p) throw new Error(`no capability pack called ${id} (there are: ${[...byId.keys()].join(", ")})`);
    wanted.push(p);
  }
  if (o.json) wanted.push(...(JSON.parse(o.json) as CapabilityPack[]));
  for (const p of wanted) if (!have.has(p.id)) (registerPack(p), have.add(p.id));
}

/** The packs this deployment added beyond the built-in ones: data, so a browser can register the same. */
export function addedPacks(): CapabilityPack[] {
  const builtin = new Set(BUILTIN_PACKS.map((p) => p.id));
  return registeredPacks().filter((p) => !builtin.has(p.id));
}

/** Registers packs a server sent (its snapshot's `packs`), skipping ones already known. For browsers. */
export function adoptPacks(packs: CapabilityPack[] | undefined): void {
  const have = new Set(registeredPacks().map((p) => p.id));
  for (const p of packs ?? []) if (!have.has(p.id)) (registerPack(p), have.add(p.id));
}

/**
 * The words a person might use for a resource of a registered type: its most specific value ("releases"), that value
 * with the label's sigil ("#releases"), and its label. Used to learn named targets from agents' requests.
 */
export function namesFor(res: string, r: Extract<Resource, { kind: "custom" }>): string[] {
  const t = resourceType(r.type);
  const last = [...(t?.template ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).at(-1);
  const value = last ? r.fields[last] : undefined;
  const names = new Set<string>();
  if (value) {
    names.add(value);
    const sigil = t?.label && last ? new RegExp(`([#@~$])\\{${last}(?:\\|\\w+)?\\}`).exec(t.label)?.[1] : undefined;
    if (sigil) names.add(`${sigil}${value}`);
  }
  names.add(labelRes(res));
  return [...names];
}
