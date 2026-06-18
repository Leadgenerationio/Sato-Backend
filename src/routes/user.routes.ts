import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as userController from '../controllers/user.controller.js';

export const userRoutes: RouterType = Router();

// Sam (2026-05-27 portal meeting + jam-video #2): roleEnum gains
// 'client_admin' so admin-side promote/demote on the Portal Users card
// can target it. The Portal Users card has been PATCHing
// `/users/:id/role` with `role: 'client_admin'` since 27 May, which was
// silently failing zod validation here — fix.
const roleEnum = z.enum(['owner', 'finance_admin', 'ops_manager', 'client', 'client_admin', 'readonly']);

// Sam (2026-05-28 follow-up to jam-video #2): "when creating user Sam
// don't have the option to choose which page is visible to the user.
// Earlier it was there, when the user creation was in the client portal."
// allowedTabs surfaces the per-portal-user tab visibility on the admin
// side now that the client-portal self-service surface has been deleted.
// Same tab slugs the portal-layout FE filter reads off the user record.
const PORTAL_TAB_VALUES = ['leads', 'invoices', 'compliance', 'creatives', 'agreement'] as const;
const allowedTabsSchema = z.array(z.enum(PORTAL_TAB_VALUES)).nullable().optional();

const createUserSchema = z.object({
  body: z.object({
    email: z.string().email(),
    name: z.string().min(1).max(200),
    password: z.string().min(8).max(200),
    role: roleEnum,
    // Required when role='client' — links the portal user to the client row
    // whose data they're allowed to see. Must be omitted for internal roles.
    // Validated server-side in user.service.ts.
    clientId: z.string().uuid().optional(),
    // Optional. null = full access (default for new portal users). Only
    // meaningful for role='client'; ignored for staff + client_admin
    // (admins always see everything).
    allowedTabs: allowedTabsSchema,
  }),
});

const updateUserSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    role: roleEnum.optional(),
  }),
});

const updateRoleSchema = z.object({
  body: z.object({ role: roleEnum }),
});

const updateAllowedTabsSchema = z.object({
  body: z.object({
    allowedTabs: z.array(z.enum(PORTAL_TAB_VALUES)).nullable(),
  }),
});

// Sam (2026-06-10): admin password reset for any user. Min 8 to match the
// create-user password rule and self-service change-password.
const resetPasswordSchema = z.object({
  body: z.object({ newPassword: z.string().min(8).max(200) }),
});

userRoutes.use(authMiddleware);
userRoutes.use(requireRole('owner'));

userRoutes.get('/', userController.getUsers);
userRoutes.post('/', validate(createUserSchema), userController.createUser);
userRoutes.put('/:id', validate(updateUserSchema), userController.updateUser);
userRoutes.patch('/:id/role', validate(updateRoleSchema), userController.updateRole);
userRoutes.patch('/:id/toggle-active', userController.toggleActive);
userRoutes.patch('/:id/allowed-tabs', validate(updateAllowedTabsSchema), userController.updateAllowedTabs);
userRoutes.patch('/:id/password', validate(resetPasswordSchema), userController.resetPassword);
// Sam (2026-06-17): permanently remove a portal user (Portal Users card).
userRoutes.delete('/:id', userController.deleteUser);
// Sam (2026-06-18): (re)send the branded portal welcome/invite email.
userRoutes.post('/:id/welcome-email', userController.sendWelcomeEmail);
