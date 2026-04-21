import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../index.js';

/**
 * RBAC Matrix Test
 *
 * Verifies that ALL 5 roles (owner, finance_admin, ops_manager, client, readonly)
 * receive the correct HTTP status code for every major API endpoint.
 *
 * This is the single authoritative test for the access-control matrix.
 */

// Credentials for each role
const ROLE_CREDENTIALS = {
  owner: { email: 'owner@stato.app', password: 'owner123' },
  finance_admin: { email: 'finance@stato.app', password: 'finance123' },
  ops_manager: { email: 'ops@stato.app', password: 'ops123' },
  client: { email: 'client@stato.app', password: 'client123' },
  readonly: { email: 'readonly@stato.app', password: 'readonly123' },
} as const;

type RoleName = keyof typeof ROLE_CREDENTIALS;

const ALL_ROLES: RoleName[] = ['owner', 'finance_admin', 'ops_manager', 'client', 'readonly'];

// Tokens populated in beforeAll
const tokens: Record<RoleName, string> = {
  owner: '',
  finance_admin: '',
  ops_manager: '',
  client: '',
  readonly: '',
};

// ---------------------------------------------------------------------------
// Helper: authenticated GET request
// ---------------------------------------------------------------------------
async function authedGet(endpoint: string, role: RoleName) {
  return request(app)
    .get(endpoint)
    .set('Authorization', `Bearer ${tokens[role]}`);
}

// ---------------------------------------------------------------------------
// Setup: login every role once
// ---------------------------------------------------------------------------
beforeAll(async () => {
  const loginPromises = ALL_ROLES.map(async (role) => {
    const creds = ROLE_CREDENTIALS[role];
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: creds.email, password: creds.password });

    expect(res.status).toBe(200);
    expect(res.body.data.tokens.accessToken).toBeDefined();
    tokens[role] = res.body.data.tokens.accessToken;
  });

  await Promise.all(loginPromises);
});

// ---------------------------------------------------------------------------
// Matrix definition
// ---------------------------------------------------------------------------
interface EndpointExpectation {
  endpoint: string;
  expectations: Record<RoleName, number>;
}

const MATRIX: EndpointExpectation[] = [
  {
    endpoint: '/api/v1/campaigns',
    expectations: {
      owner: 200,
      finance_admin: 403,
      ops_manager: 200,
      client: 403,
      readonly: 403,
    },
  },
  {
    endpoint: '/api/v1/invoices',
    expectations: {
      owner: 200,
      finance_admin: 200,
      ops_manager: 403,
      client: 403,
      readonly: 403,
    },
  },
  {
    endpoint: '/api/v1/clients',
    expectations: {
      owner: 200,
      finance_admin: 200,
      ops_manager: 200,
      client: 403,
      readonly: 403,
    },
  },
  {
    endpoint: '/api/v1/portal/dashboard',
    expectations: {
      owner: 403,
      finance_admin: 403,
      ops_manager: 403,
      client: 200,
      readonly: 403,
    },
  },
  {
    endpoint: '/api/v1/workflows',
    expectations: {
      owner: 200,
      finance_admin: 403,
      ops_manager: 200,
      client: 403,
      readonly: 403,
    },
  },
  {
    endpoint: '/api/v1/reports/campaign-performance',
    expectations: {
      owner: 200,
      finance_admin: 200,
      ops_manager: 403,
      client: 403,
      readonly: 403,
    },
  },
  {
    endpoint: '/api/v1/notifications',
    expectations: {
      owner: 200,
      finance_admin: 200,
      ops_manager: 200,
      client: 200,
      readonly: 200,
    },
  },
  {
    endpoint: '/api/v1/users',
    expectations: {
      owner: 200,
      finance_admin: 403,
      ops_manager: 403,
      client: 403,
      readonly: 403,
    },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('RBAC Matrix', () => {
  // Ensure every role actually received a token
  describe('Login sanity check', () => {
    it.each(ALL_ROLES)('%s has a valid access token', (role) => {
      expect(tokens[role]).toBeTruthy();
    });
  });

  // One describe block per endpoint group
  for (const { endpoint, expectations } of MATRIX) {
    describe(`GET ${endpoint}`, () => {
      for (const role of ALL_ROLES) {
        const expected = expectations[role];
        const label = expected === 200 ? 'allowed (200)' : 'denied (403)';

        it(`${role} => ${label}`, async () => {
          const res = await authedGet(endpoint, role);
          expect(res.status).toBe(expected);
        });
      }

      // Every protected endpoint must reject unauthenticated requests
      it('unauthenticated => 401', async () => {
        const res = await request(app).get(endpoint);
        expect(res.status).toBe(401);
      });
    });
  }
});
