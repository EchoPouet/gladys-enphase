// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code registers, nor whether the discovery permissions the
// code relies on are declared — these tests keep both in sync, following the
// rules of https://gladysassistant.com/fr/docs/dev/external-integrations/
// ("Étapes 2 et 3").
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEVICE_BLUEPRINTS } from '../src/devices/index.js';
import { DEFAULT_CONFIG, POLL_FREQUENCY_LIMITS } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

// The `detect_gateway` action is registered at the registry level (see index.js),
// outside the blueprints — same pattern as the template's `identify`.
const REGISTRY_LEVEL_ACTIONS = ['detect_gateway'];

// Widget types the store schema accepts (guide "Le schéma de configuration").
const ALLOWED_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'select',
  'multi_select',
  'secret',
  'oauth2',
  'account_link',
  'section',
];

/** Every field of the manifest, config fields and action fields alike. */
function allFields() {
  return [
    ...manifest.config_schema,
    ...(manifest.actions ?? []).flatMap((action) => action.fields ?? []),
  ];
}

test('manifest_version is 1 and the type is "device"', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
});

test('the catalog name and descriptions fit the store schema', () => {
  assert.ok(
    manifest.name.length >= 3 && manifest.name.length <= 30,
    'name must be 3-30 characters',
  );
  for (const [language, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${language} must be 10-100 characters`,
    );
  }
  assert.equal(typeof manifest.description.en, 'string', 'an English description is mandatory');
});

test('version is semantic and the docker_image carries it', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.docker_image.endsWith(`:${manifest.version}`));
});

test('categories are from the official vocabulary and require >= 4.86.0', () => {
  const vocabulary = [
    'climate',
    'lighting',
    'energy',
    'security',
    'multimedia',
    'appliances',
    'environment',
    'protocols',
    'network',
    'notifications',
    'assistants',
    'services',
  ];
  assert.ok(
    Array.isArray(manifest.categories) &&
      manifest.categories.length >= 1 &&
      manifest.categories.length <= 3,
  );
  for (const category of manifest.categories) {
    assert.ok(vocabulary.includes(category), `unknown category "${category}"`);
  }
  // Declaring categories imposes a gladys_version starting at 4.86.0.
  assert.match(manifest.gladys_version, /^>=4\.86\./);
});

test('transports is a non-empty subset of local/cloud, matching the code', () => {
  assert.ok(
    Array.isArray(manifest.transports) && manifest.transports.length > 0,
    'transports must be declared',
  );
  for (const transport of manifest.transports) {
    assert.ok(['local', 'cloud'].includes(transport), `unknown transport "${transport}"`);
  }
  // Enphase is local-only: the integration never touches the cloud.
  assert.deepEqual(manifest.transports, ['local']);
});

test('the mDNS capture the code scans for is declared', () => {
  // `gladys.scanNetwork('mdns')` would be answered 403 by the core unless the
  // capture is declared in `network_discovery`.
  assert.ok(
    manifest.network_discovery?.some(
      (capture) => capture.type === 'mdns' && capture.service === '_enphase-envoy._tcp',
    ),
    'the manifest must declare the mdns _enphase-envoy._tcp capture',
  );
});

test('every manifest action has a registered handler, and vice versa', () => {
  const handled = new Set([
    ...DEVICE_BLUEPRINTS.flatMap((bp) => Object.keys(bp.actions ?? {})),
    ...REGISTRY_LEVEL_ACTIONS,
  ]);
  for (const action of manifest.actions ?? []) {
    assert.ok(handled.has(action.key), `manifest action "${action.key}" has no handler`);
  }
  for (const key of handled) {
    assert.ok(
      (manifest.actions ?? []).some((action) => action.key === key),
      `handler "${key}" is not declared in the manifest: no button runs it`,
    );
  }
});

test('every action declares a usable timeout_seconds (5-120)', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      Number.isInteger(action.timeout_seconds) &&
        action.timeout_seconds >= 5 &&
        action.timeout_seconds <= 120,
      `action "${action.key}" has an invalid timeout_seconds`,
    );
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('the refresh interval bounds are the ones the code clamps to', () => {
  const pollFrequency = manifest.config_schema.find((f) => f.key === 'poll_frequency');
  assert.equal(pollFrequency.min, POLL_FREQUENCY_LIMITS.min);
  assert.equal(pollFrequency.max, POLL_FREQUENCY_LIMITS.max);
});

test('every field uses a widget type the store accepts', () => {
  for (const field of allFields()) {
    assert.ok(
      ALLOWED_FIELD_TYPES.includes(field.type),
      `field "${field.key}": unsupported type ${field.type}`,
    );
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length >= 1, 'at least one section guides the user');
  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('every label and description is written in both languages', () => {
  const bilingual = (value, path) => {
    assert.equal(typeof value?.en, 'string', `${path}: missing English`);
    assert.equal(typeof value?.fr, 'string', `${path}: missing French`);
  };

  bilingual(manifest.description, 'manifest.description');
  for (const field of allFields()) {
    bilingual(field.label, `field ${field.key}.label`);
    for (const option of field.options ?? []) {
      bilingual(option.label, `option ${field.key}=${option.value}`);
    }
  }
  for (const action of manifest.actions ?? []) {
    bilingual(action.label, `action ${action.key}.label`);
    bilingual(action.description, `action ${action.key}.description`);
  }
});

test('required fields are the ones the code needs to connect', () => {
  const required = manifest.config_schema
    .filter((f) => f.type !== 'section')
    .filter((f) => f.required);
  assert.deepEqual(
    required.map((f) => f.key).sort(),
    ['access_token', 'gateway_ip'],
    'only the gateway IP and the token are required',
  );
});

test('the cover image is an https direct URL', () => {
  assert.match(manifest.cover_image, /^https:\/\//, 'cover_image must be https');
});

test('the secret field is the token, never the IP', () => {
  const secrets = manifest.config_schema.filter((f) => f.type === 'secret');
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].key, 'access_token');
  assert.equal(manifest.config_schema.find((f) => f.key === 'gateway_ip').type, 'string');
});
