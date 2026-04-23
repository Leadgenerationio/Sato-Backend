import bcryptjs from 'bcryptjs';
import type { UserRole } from '../types/index.js';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  businessId: string | null;
  clientId: string | null;
  isActive: boolean;
  isPrimaryOwner: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// In-memory user store — replace with Drizzle + PostgreSQL later
const users: User[] = [];

export async function seedDefaultUsers() {
  if (users.length > 0) return;

  const ownerHash = await bcryptjs.hash('owner123', 12);
  const financeHash = await bcryptjs.hash('finance123', 12);
  const opsHash = await bcryptjs.hash('ops123', 12);
  const clientHash = await bcryptjs.hash('client123', 12);
  const readonlyHash = await bcryptjs.hash('readonly123', 12);

  users.push(
    {
      id: '1',
      email: 'owner@stato.app',
      passwordHash: ownerHash,
      name: 'Sam Owner',
      role: 'owner',
      businessId: '26d6b2b4-c867-460e-8473-eca2b1ffd232',
      clientId: null,
      isActive: true,
      isPrimaryOwner: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: '2',
      email: 'finance@stato.app',
      passwordHash: financeHash,
      name: 'Finance Admin',
      role: 'finance_admin',
      businessId: '26d6b2b4-c867-460e-8473-eca2b1ffd232',
      clientId: null,
      isActive: true,
      isPrimaryOwner: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: '3',
      email: 'ops@stato.app',
      passwordHash: opsHash,
      name: 'Ops Manager',
      role: 'ops_manager',
      businessId: '26d6b2b4-c867-460e-8473-eca2b1ffd232',
      clientId: null,
      isActive: true,
      isPrimaryOwner: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: '4',
      email: 'client@stato.app',
      passwordHash: clientHash,
      name: 'Client User',
      role: 'client',
      businessId: null,
      // Matches the demo client UUID seeded by db/seed.ts when SEED_DEMO_DATA is on.
      clientId: '00000000-0000-0000-0000-000000000001',
      isActive: true,
      isPrimaryOwner: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: '5',
      email: 'readonly@stato.app',
      passwordHash: readonlyHash,
      name: 'Readonly User',
      role: 'readonly',
      businessId: '26d6b2b4-c867-460e-8473-eca2b1ffd232',
      clientId: null,
      isActive: true,
      isPrimaryOwner: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  );

  console.log('Seeded default users:');
  console.log('  owner@stato.app / owner123       (owner)');
  console.log('  finance@stato.app / finance123   (finance_admin)');
  console.log('  ops@stato.app / ops123           (ops_manager)');
  console.log('  client@stato.app / client123     (client)');
  console.log('  readonly@stato.app / readonly123 (readonly)');
}

export function findUserByEmail(email: string): User | undefined {
  return users.find((u) => u.email === email);
}

export function findUserById(id: string): User | undefined {
  return users.find((u) => u.id === id);
}

export function getAllUsers(): User[] {
  return users;
}

export function addUser(user: User): void {
  users.push(user);
}

let nextId = 6;
export function getNextId(): string {
  return String(nextId++);
}
