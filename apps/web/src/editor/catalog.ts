import type { NodeManifest } from '@sflow/domain';

export const ALL_CATEGORY_ID = 'all';

export interface CatalogCategory {
  id: string;
  label: string;
  count: number;
}

/** Stable category id derived from the Manifest-declared category label. */
export function categoryId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds the Node Library navigation from Manifest metadata. Counts are
 * catalog totals computed from the loaded Manifests, never hard-coded.
 */
export function buildCatalog(manifests: readonly NodeManifest[]): CatalogCategory[] {
  const categories = new Map<string, CatalogCategory>();

  for (const manifest of manifests) {
    const id = categoryId(manifest.category);
    const existing = categories.get(id);
    if (existing) {
      existing.count += 1;
    } else {
      categories.set(id, { id, label: manifest.category, count: 1 });
    }
  }

  return [{ id: ALL_CATEGORY_ID, label: 'All nodes', count: manifests.length }, ...categories.values()];
}

/**
 * Applies the category filter and live query to the catalog. Search matches
 * Node name, description, type, category, and Manifest id; a category and a
 * query combine with AND.
 */
export function filterCatalog(
  manifests: readonly NodeManifest[],
  category: string,
  query: string,
): NodeManifest[] {
  const needle = query.trim().toLowerCase();

  return manifests.filter((manifest) => {
    if (category !== ALL_CATEGORY_ID && categoryId(manifest.category) !== category) {
      return false;
    }
    if (!needle) return true;

    const haystack = [
      manifest.name,
      manifest.description,
      manifest.type,
      manifest.category,
      manifest.id,
    ]
      .join(' ')
      .toLowerCase();

    return haystack.includes(needle);
  });
}
