import { describe, it, expect } from 'vitest';
import { API_SCOPES } from '../services/api-key.service.js';

// MCP spec v1.0 §3: five scopes added for the connector. Scopes are only ever
// added, never renamed, so keys made before keep working.
describe('API scopes', () => {
  it('keeps the original five and adds the five MCP scopes', () => {
    expect(API_SCOPES.slice(0, 5)).toEqual(['clients:read', 'ad_accounts:write', 'creatives:read', 'creatives:write', 'landing_pages:write']);
    expect(API_SCOPES.slice(5)).toEqual(['campaigns:read', 'ad_accounts:read', 'uploads:write', 'ad_links:write', 'creatives:archive']);
  });
});
