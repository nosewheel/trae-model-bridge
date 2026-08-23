// Discover the models traecli exposes, by reading its local models cache.
// Falls back to just the default model if the cache is unavailable.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_PATHS = [
  join(homedir(), ".trae", "model-provider", "trae", "models_cache.json"),
  join(homedir(), ".trae", "cli", "models_cache.json"),
];

export async function listModels(defaultModel: string): Promise<string[]> {
  for (const p of CACHE_PATHS) {
    try {
      const raw = await readFile(p, "utf8");
      const data = JSON.parse(raw) as {
        models?: Array<{
          slug?: string;
          visibility?: string;
          supported_in_api?: boolean;
        }>;
      };
      const slugs = (data.models ?? [])
        .filter((m) => m.supported_in_api !== false && m.slug)
        .map((m) => m.slug as string);
      if (slugs.length) {
        // Ensure the configured default is present and first.
        const set = new Set(slugs);
        set.add(defaultModel);
        return [defaultModel, ...[...set].filter((s) => s !== defaultModel)];
      }
    } catch {
      // try next path
    }
  }
  return [defaultModel];
}
