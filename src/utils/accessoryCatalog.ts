// ─── Accessory catalog helpers ───────────────────────────────────────────────
// shared/accessories.json keys accessories by asset path and carries semantic
// metadata (name, description, labels). UI must always show `name` — raw ids
// like "accessories set 2 item 07" leaking into the product was a launch bug.

import accessoriesData from "../../shared/accessories.json";

type AccessoryMeta = {
  name?: string;
  description?: string;
  labels?: string[];
  isVisible?: boolean;
};

const ITEMS: Record<string, AccessoryMeta> =
  (accessoriesData as any)?.items && typeof (accessoriesData as any).items === "object"
    ? (accessoriesData as any).items
    : {};

export type AccessoryOption = { id: string; name: string; labels: string[] };

let cachedOptions: AccessoryOption[] | null = null;

/** All visible accessories with human names, stable order. */
export function listAccessoryOptions(): AccessoryOption[] {
  if (cachedOptions) return cachedOptions;
  cachedOptions = Object.entries(ITEMS)
    .filter(([, meta]) => meta && meta.isVisible !== false && !!meta.name)
    .map(([id, meta]) => ({ id, name: meta.name as string, labels: meta.labels || [] }));
  return cachedOptions;
}

/** Human name for an accessory id/path; humanized filename as last resort. */
export function getAccessoryName(id: string): string {
  const direct = ITEMS[id]?.name;
  if (direct) return direct;
  // Ids sometimes arrive without the /accessories/ prefix or with .glb.
  const normalized = `/accessories/${id.split("/").pop()?.replace(/\.glb$/, ".png")}`;
  const byPath = ITEMS[normalized]?.name;
  if (byPath) return byPath;
  return (id.split("/").pop() || id).replace(/\.(png|glb)$/, "").replace(/[-_]/g, " ");
}
