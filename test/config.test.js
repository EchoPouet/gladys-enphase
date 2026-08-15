// -----------------------------------------------------------------------------
// Unit tests for the configuration normalization.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  isConfigured,
  isValidGatewayIp,
  normalizeConfig,
  POLL_FREQUENCY_LIMITS,
} from '../src/config.js';

test('normalizeConfig fills defaults when nothing is given', () => {
  const config = normalizeConfig();
  assert.equal(config.gateway_ip, '');
  assert.equal(config.access_token, '');
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
  assert.equal(config.include_inverters, true);
});

test('normalizeConfig trims the gateway IP and token', () => {
  const config = normalizeConfig({
    gateway_ip: '  192.168.1.42  ',
    access_token: '  eyJhbGciOi...  ',
  });
  assert.equal(config.gateway_ip, '192.168.1.42');
  assert.equal(config.access_token, 'eyJhbGciOi...');
});

test('normalizeConfig clamps the poll frequency to the manifest bounds', () => {
  assert.equal(normalizeConfig({ poll_frequency: '5' }).poll_frequency, POLL_FREQUENCY_LIMITS.min);
  assert.equal(
    normalizeConfig({ poll_frequency: '999999' }).poll_frequency,
    POLL_FREQUENCY_LIMITS.max,
  );
  assert.equal(
    normalizeConfig({ poll_frequency: 'NaN' }).poll_frequency,
    DEFAULT_CONFIG.poll_frequency,
  );
});

test('normalizeConfig treats include_inverters as a boolean, true by default', () => {
  assert.equal(normalizeConfig({}).include_inverters, true);
  assert.equal(normalizeConfig({ include_inverters: false }).include_inverters, false);
  assert.equal(normalizeConfig({ include_inverters: 'false' }).include_inverters, false);
  assert.equal(normalizeConfig({ include_inverters: 'true' }).include_inverters, true);
});

test('isConfigured requires both the IP and the token', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ gateway_ip: '192.168.1.42' })), false);
  assert.equal(isConfigured(normalizeConfig({ access_token: 'token' })), false);
  assert.equal(
    isConfigured(normalizeConfig({ gateway_ip: '192.168.1.42', access_token: 'token' })),
    true,
  );
});

test('isValidGatewayIp accepts private IPv4/IPv6 and rejects the rest', () => {
  assert.equal(isValidGatewayIp('192.168.1.42'), true);
  assert.equal(isValidGatewayIp('10.0.0.1'), true);
  assert.equal(isValidGatewayIp('172.16.5.5'), true);
  assert.equal(isValidGatewayIp('169.254.1.1'), true);
  assert.equal(isValidGatewayIp('127.0.0.1'), true);
  assert.equal(isValidGatewayIp('8.8.8.8'), false); // public
  assert.equal(isValidGatewayIp('50.10.10.10'), false); // public
  assert.equal(isValidGatewayIp('my-gateway.local'), false); // hostname
  assert.equal(isValidGatewayIp('192.168.1.1:443'), false); // port
  assert.equal(isValidGatewayIp('http://192.168.1.1'), false); // scheme
  assert.equal(isValidGatewayIp(''), false);
  assert.equal(isValidGatewayIp('fd12::1'), true); // unique-local
  assert.equal(isValidGatewayIp('fe80::1'), true); // link-local
  assert.equal(isValidGatewayIp('::1'), true); // loopback
  assert.equal(isValidGatewayIp('2001:4860:4860::8888'), false); // public
});

test('normalizeConfig blanks an invalid gateway IP (no arbitrary target)', () => {
  assert.equal(normalizeConfig({ gateway_ip: '8.8.8.8', access_token: 't' }).gateway_ip, '');
  assert.equal(
    normalizeConfig({ gateway_ip: 'evil.example.org', access_token: 't' }).gateway_ip,
    '',
  );
  assert.equal(
    normalizeConfig({ gateway_ip: '192.168.1.42', access_token: 't' }).gateway_ip,
    '192.168.1.42',
  );
});

test('normalizeConfig carries an optional, trimmed cert fingerprint', () => {
  const config = normalizeConfig({
    gateway_ip: '192.168.1.42',
    access_token: 't',
    pinned_cert_fingerprint: '  Ab:CD:12:34  ',
  });
  assert.equal(config.pinned_cert_fingerprint, 'Ab:CD:12:34');
  // Absent by default.
  assert.equal(normalizeConfig({}).pinned_cert_fingerprint, '');
});
