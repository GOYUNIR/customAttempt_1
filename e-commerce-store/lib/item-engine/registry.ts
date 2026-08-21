/**
 * ─────────────────────────────────────────────────────────────────────────────
 * UNIVERSAL ITEM ENGINE — item type registry (schemas + capabilities).
 *
 * This is the "limitless business-type extension" point: each entry below is a
 * JSON Schema for that type's `rules` blob plus its capabilities. To add a new
 * vertical, add ONE entry to `ITEM_TYPES` — the validator (json-schema.ts) and
 * the business-owner item editor render from it automatically. No database
 * rewrite is required because `rules` is a JSONB column.
 *
 * ZERO runtime imports (types are type-only and erased).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type ItemCapability, type ItemType, type ItemTypeMeta, type JsonSchema } from './types.ts';

/** Shared schedule block reused by appointment + table booking. */
const AVAILABILITY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    daysOfWeek: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
    startTime: { type: 'string', description: 'HH:mm store-local open' },
    endTime: { type: 'string', description: 'HH:mm store-local close' },
  },
};

/** FCFS retail — charge at checkout, track inventory. */
const FCFS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    priceCents: { type: 'integer', minimum: 0 },
    inventory: { type: 'integer', minimum: 0 },
    maxPerCustomer: { type: 'integer', minimum: 1 },
  },
  required: ['priceCents'],
};

/** Raffle / drop allocation — enter a pool, draw winners. */
const RAFFLE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    priceCents: { type: 'integer', minimum: 0 },
    winnerTiers: { type: 'array', items: { type: 'integer', minimum: 1 } },
    releaseEndsAt: { type: 'string' },
    recurring: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { enum: ['hourly', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'custom'] },
        customIntervalHours: { type: 'integer', minimum: 1 },
      },
    },
  },
  required: ['winnerTiers'],
};

/** Appointment / time-slot reservation (salons, healthcare, services). */
const APPOINTMENT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    priceCents: { type: 'integer', minimum: 0 },
    durationMinutes: { type: 'integer', minimum: 5 },
    bufferMinutes: { type: 'integer', minimum: 0 },
    availability: AVAILABILITY_SCHEMA,
    staffIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['durationMinutes'],
};

/** Table booking / order pre-allocation (restaurants, cafes, hospitality). */
const TABLE_BOOKING_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    depositCents: { type: 'integer', minimum: 0 },
    partySizeMin: { type: 'integer', minimum: 1 },
    partySizeMax: { type: 'integer', minimum: 1 },
    turnTimeMinutes: { type: 'integer', minimum: 0 },
    availability: AVAILABILITY_SCHEMA,
  },
  required: ['partySizeMax'],
};

/** Ticketed access / event scheduling (entertainment, venues). */
const TICKETED_ACCESS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    priceCents: { type: 'integer', minimum: 0 },
    capacity: { type: 'integer', minimum: 1 },
    eventStartsAt: { type: 'string' },
    eventEndsAt: { type: 'string' },
    venue: { type: 'string' },
    ticketTiers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          priceCents: { type: 'integer', minimum: 0 },
          capacity: { type: 'integer', minimum: 1 },
        },
        required: ['name', 'priceCents'],
      },
    },
  },
  required: ['eventStartsAt'],
};

/** Subscription / recurring membership allocation (fitness, SaaS). */
const SUBSCRIPTION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    priceCents: { type: 'integer', minimum: 0 },
    interval: { enum: ['day', 'week', 'month', 'year'] },
    intervalCount: { type: 'integer', minimum: 1 },
    trialDays: { type: 'integer', minimum: 0 },
    cancelAtPeriodEnd: { type: 'boolean' },
    allocationsPerCycle: { type: 'integer', minimum: 1 },
  },
  required: ['priceCents', 'interval'],
};

/** The full item-type registry — the single source of truth for item behaviour. */
export const ITEM_TYPES: Record<ItemType, ItemTypeMeta> = {
  fcfs: {
    id: 'fcfs',
    label: 'Instant Buy (FCFS)',
    description: 'First-come, first-served retail — charges at checkout.',
    capabilities: ['instant_checkout', 'inventory'],
    jsonSchema: FCFS_SCHEMA,
  },
  raffle: {
    id: 'raffle',
    label: 'Raffle / Drop',
    description: 'Enter an allocation pool; winners are drawn and charged.',
    capabilities: ['raffle_draw', 'inventory'],
    jsonSchema: RAFFLE_SCHEMA,
  },
  appointment: {
    id: 'appointment',
    label: 'Appointment',
    description: 'Time-slot reservations for salons, healthcare and services.',
    capabilities: ['schedule', 'booking'],
    jsonSchema: APPOINTMENT_SCHEMA,
  },
  table_booking: {
    id: 'table_booking',
    label: 'Table Booking',
    description: 'Table / order pre-allocation for restaurants and hospitality.',
    capabilities: ['schedule', 'booking', 'seating'],
    jsonSchema: TABLE_BOOKING_SCHEMA,
  },
  ticketed_access: {
    id: 'ticketed_access',
    label: 'Ticketed Access',
    description: 'Ticketed access and event scheduling for venues and entertainment.',
    capabilities: ['ticketing', 'schedule', 'booking', 'inventory'],
    jsonSchema: TICKETED_ACCESS_SCHEMA,
  },
  subscription: {
    id: 'subscription',
    label: 'Subscription',
    description: 'Recurring membership allocations for fitness and SaaS.',
    capabilities: ['recurring', 'digital_delivery'],
    jsonSchema: SUBSCRIPTION_SCHEMA,
  },
};

/** Look up a type's metadata (undefined for unknown ids). */
export function getItemTypeMeta(itemType: ItemType): ItemTypeMeta {
  return ITEM_TYPES[itemType];
}

/** Whether a value is a known item type. */
export function isItemType(value: unknown): value is ItemType {
  if (typeof value !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(ITEM_TYPES, value);
}

/** Whether a type exposes a given capability. */
export function itemTypeHasCapability(itemType: ItemType, capability: ItemCapability): boolean {
  return ITEM_TYPES[itemType]?.capabilities.includes(capability) ?? false;
}

/** All registry entries in a stable order (for the /b item editor + tests). */
export function listItemTypes(): ItemTypeMeta[] {
  return Object.values(ITEM_TYPES);
}
