import { describe, expect, it } from 'vitest';

import {
  normalizeLCTTelemetryRelayUrl,
  LCT_TELEMETRY_RELAY_URLS,
} from '../../src/integrations/telemetry-relay.js';

describe('LCT telemetry relay URLs', () => {
  it('keeps production on telemetry.lct.ai', () => {
    expect(LCT_TELEMETRY_RELAY_URLS.prod).toBe(
      'https://telemetry.lct.ai/api/langfuse',
    );
    expect(normalizeLCTTelemetryRelayUrl(
      'https://telemetry.lct.ai/api/langfuse//',
    )).toBe(LCT_TELEMETRY_RELAY_URLS.prod);
  });

  it('moves legacy self-host test URLs to telemetry-test.lct.ai', () => {
    expect(normalizeLCTTelemetryRelayUrl(
      'https://telemetry-selfhost.lct.ai/api/langfuse/',
    )).toBe(LCT_TELEMETRY_RELAY_URLS.test);
  });

  it('leaves custom relay URLs unchanged', () => {
    expect(normalizeLCTTelemetryRelayUrl(
      'https://telemetry.example.test/api/langfuse/',
    )).toBe('https://telemetry.example.test/api/langfuse');
  });
});
