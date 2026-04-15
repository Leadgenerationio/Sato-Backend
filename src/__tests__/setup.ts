import { seedDefaultUsers } from '../data/users.js';

beforeAll(async () => {
  await seedDefaultUsers();
});
