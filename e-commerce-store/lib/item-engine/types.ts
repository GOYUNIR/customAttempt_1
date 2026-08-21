/**
 * ─────────────────────────────────────────────────────────────────────────────
 * UNIVERSAL ITEM ENGINE — shared types + capabilities.
 *
 * The storefront's historical "product" model only understood retail concepts
 * (FCFS instant-buy + raffle/draw). This module generalises that into a
 * "Universal Item Engine": ONE item record whose behaviour is determined by an
 * `itemType` plus a structured JSON `rules` blob. New business verticals are
 * added by registering a new JSON Schema — never by rewriting the database.
 *
 * Supported item types (each maps to a B2B vertical):
 *   fcfs            — first-come, first-served retail (charges at checkout)
 *   raffle          — drop / draw allocation (enter a pool, winners charged)
 *   appointment     — time-slot reservations (salons, healthcare, services)
 *   table_booking   — table booking / order pre-allocation (hospitality)
 *   ticketed_access — ticketed access + event scheduling (entertainment/venues)
 *   subscription    — recurring membership allocations (fitness, SaaS)
 *
 * DESIGN — this file has ZERO imports so the `node --test` runner loads it with
 * a plain `import … from '../lib/item-engine/types.ts'`, exactly like
 * `lib/drop-timestamps.ts` / `lib/license.ts`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Every supported item type. Add a new one HERE + a schema in registry.ts. */
export type ItemType =
  | 'fcfs'
  | 'raffle'
  | 'appointment'
  | 'table_booking'
  | 'ticketed_access'
  | 'subscription';

export const ITEM_TYPE_IDS: readonly ItemType[] = [
  'fcfs',
  'raffle',
  'appointment',
  'table_booking',
  'ticketed_access',
  'subscription',
];

/** Behavioural capabilities an item type may declare (drives UI + engine). */
export type ItemCapability =
  | 'instant_checkout' // fcfs — charge immediately at checkout
  | 'raffle_draw' // raffle — enter a pool, draw winners
  | 'schedule' // appointment/table/event — has a schedule + time slots
  | 'booking' // appointment/table/event — reserve a slot
  | 'seating' // table_booking — party size / seating
  | 'ticketing' // ticketed_access — capacity + gate
  | 'recurring' // subscription — recurring cycles/billing
  | 'inventory' // physical stock tracking
  | 'digital_delivery'; // subscription/digital fulfilment

/** Runtime lifecycle state of an item (mirrors the SQL check constraint). */
export type ItemStatus = 'draft' | 'live' | 'archived';

export const ITEM_STATUSES: readonly ItemStatus[] = ['draft', 'live', 'archived'];

/** The canonical description of one item type. */
export interface ItemTypeMeta {
  id: ItemType;
  /** Human label surfaced in the /b business-owner item editor. */
  label: string;
  /** One-line explanation of what this type models. */
  description: string;
  /** Which capabilities this type provides (drives conditional UI + engine). */
  capabilities: ItemCapability[];
  /** The structured JSON Schema for the type's `rules` blob. */
  jsonSchema: JsonSchema;
}

/** The (loose) runtime shape of an item record in the Universal Item Engine. */
export interface ItemRecord {
  id?: string;
  tenantId?: string;
  itemType: ItemType;
  name: string;
  slug?: string;
  rules: Record<string, unknown>;
  status?: ItemStatus;
  createdAt?: string;
  updatedAt?: string;
}

/** A lightweight JSON Schema (subset the engine's validator enforces). */
export interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: JsonSchema[];
  description?: string;
}

/** Validate a raw string/unknown against the ItemType union (null when invalid). */
export function sanitizeItemType(value: unknown): ItemType | null {
  const v = String(value || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
  return (ITEM_TYPE_IDS as readonly string[]).includes(v) ? (v as ItemType) : null;
}

/** Validate a raw string/unknown against the ItemStatus union (null when invalid). */
export function sanitizeItemStatus(value: unknown): ItemStatus | null {
  const v = String(value || '').trim().toLowerCase();
  return (ITEM_STATUSES as readonly string[]).includes(v) ? (v as ItemStatus) : null;
}
