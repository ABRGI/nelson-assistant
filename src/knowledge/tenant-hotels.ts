import { getLeafContent, type KnowledgeBundle } from './loader.js';
import type { TenantHotel } from '../agent/classifier.js';
import { logger } from '../observability/logger.js';

export interface TenantHotelRoster {
  hotels: TenantHotel[];
  ambiguousCities: string[];
}

// The leaf is hand-curated yaml (see knowledge/nelson/tenant-hotels.yaml).
// Full YAML parser is overkill for this small shape; we pull the two sections
// we need with line-oriented parsing. If the leaf shape drifts (new sections,
// nested re-ordering), update both this parser and the leaf together.
export function loadTenantHotelsFromBundle(bundle: KnowledgeBundle): TenantHotelRoster {
  const raw = getLeafContent(bundle, 'nelson/tenant-hotels.yaml');
  if (!raw) {
    logger.warn('tenant-hotels.yaml not found in bundle — classifier will ask generically');
    return { hotels: [], ambiguousCities: [] };
  }

  const hotels: TenantHotel[] = [];
  const ambiguousCities: string[] = [];
  const lines = raw.split('\n');

  let section: 'hotels' | 'ambiguous' | null = null;
  let current: Partial<TenantHotel> = {};
  for (const line of lines) {
    if (/^hotels:\s*$/.test(line)) { section = 'hotels'; continue; }
    if (/^ambiguous_cities:\s*$/.test(line)) { section = 'ambiguous'; continue; }
    if (/^[a-z_]+:\s*/.test(line) && section !== null) {
      section = null;
      if (current.label && current.city) hotels.push(current as TenantHotel);
      current = {};
      continue;
    }
    if (section === 'hotels') {
      const labelMatch = line.match(/^\s*-\s+label:\s*(\S+)/);
      if (labelMatch?.[1]) {
        if (current.label && current.city) hotels.push(current as TenantHotel);
        current = { label: labelMatch[1] };
        continue;
      }
      const cityMatch = line.match(/^\s+city:\s*(.+?)\s*$/);
      if (cityMatch?.[1]) current.city = cityMatch[1];
    } else if (section === 'ambiguous') {
      const itemMatch = line.match(/^\s*-\s+(\S.*?)\s*$/);
      if (itemMatch?.[1]) ambiguousCities.push(itemMatch[1]);
    }
  }
  if (current.label && current.city) hotels.push(current as TenantHotel);
  return { hotels, ambiguousCities };
}
