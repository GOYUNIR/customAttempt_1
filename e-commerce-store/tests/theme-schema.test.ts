import assert from 'node:assert/strict';
import test from 'node:test';
import { validateThemeSections, sortSections, defaultConfigFor, DEFAULT_THEME_SECTIONS, SECTION_TYPES } from '../lib/theme-schema.ts';

test('validateThemeSections: the shipped default sections are valid', () => {
  const result = validateThemeSections(DEFAULT_THEME_SECTIONS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateThemeSections: rejects a non-array', () => {
  assert.equal(validateThemeSections(null).ok, false);
  assert.equal(validateThemeSections({}).ok, false);
  assert.equal(validateThemeSections('sections').ok, false);
});

test('validateThemeSections: rejects an unknown section type', () => {
  const result = validateThemeSections([{ id: 'a', type: 'video_wall', order: 0, config: {} }]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('unknown type')));
});

test('validateThemeSections: rejects duplicate ids', () => {
  const result = validateThemeSections([
    { id: 'dup', type: 'hero', order: 0, config: {} },
    { id: 'dup', type: 'footer', order: 1, config: {} },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate id')));
});

test('validateThemeSections: rejects a missing/non-numeric order and a non-object config', () => {
  const result = validateThemeSections([{ id: 'a', type: 'hero', order: 'first', config: null }]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('order must be')));
  assert.ok(result.errors.some((e) => e.includes('config must be')));
});

test('validateThemeSections: an empty array is valid (a tenant can start with zero sections)', () => {
  assert.equal(validateThemeSections([]).ok, true);
});

test('sortSections: orders by the order field, stable for ties', () => {
  const sections = [
    { id: 'c', type: 'footer' as const, order: 2, config: {} },
    { id: 'a', type: 'hero' as const, order: 0, config: {} },
    { id: 'b', type: 'product_grid' as const, order: 1, config: {} },
  ];
  assert.deepEqual(sortSections(sections).map((s) => s.id), ['a', 'b', 'c']);
});

test('defaultConfigFor: returns a real default object for every section type in the palette', () => {
  for (const type of SECTION_TYPES) {
    const config = defaultConfigFor(type);
    assert.equal(typeof config, 'object');
    assert.notEqual(config, null);
  }
});
