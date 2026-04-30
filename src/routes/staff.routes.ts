import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as staffController from '../controllers/staff.controller.js';

export const staffRoutes: RouterType = Router();

const staffFields = {
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  role: z.string().max(100).optional(),
  department: z.string().max(100).optional(),
  startDate: z.string().optional(),
  status: z.enum(['active', 'on_leave', 'terminated']).optional(),
  phone: z.string().max(50).optional(),
  notes: z.string().max(5000).optional(),
};

const createStaffSchema = z.object({ body: z.object(staffFields) });
const updateStaffSchema = z.object({ body: z.object(staffFields).partial() });

const createJobSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(200),
    department: z.string().min(1).max(100),
  }),
});

const updateApplicantStageSchema = z.object({
  body: z.object({
    stage: z.enum(['new', 'screening', 'interview', 'offer', 'hired', 'rejected']),
  }),
});

const createHolidaySchema = z.object({
  body: z.object({
    staffId: z.string().min(1),
    staffName: z.string().optional(),
    type: z.enum(['annual', 'sick', 'unpaid', 'other']),
    startDate: z.string().min(1),
    endDate: z.string().min(1),
  }),
});

staffRoutes.use(authMiddleware);
staffRoutes.use(requireRole('owner', 'ops_manager'));

staffRoutes.get('/staff', staffController.listStaff);
staffRoutes.get('/staff/stats', staffController.getStaffStats);
staffRoutes.post('/staff', validate(createStaffSchema), staffController.createStaffMember);
staffRoutes.get('/staff/:id', staffController.getStaffMember);
staffRoutes.put('/staff/:id', validate(updateStaffSchema), staffController.updateStaffMember);
staffRoutes.get('/staff/:id/documents', staffController.listStaffDocuments);
staffRoutes.post('/staff/:id/documents', staffController.addStaffDocument);
staffRoutes.delete('/staff/:id/documents/:key', staffController.removeStaffDocument);
staffRoutes.get('/jobs', staffController.listJobPostings);
staffRoutes.post('/jobs', validate(createJobSchema), staffController.createJobPosting);
staffRoutes.get('/jobs/:id/applicants', staffController.listApplicants);
staffRoutes.patch('/applicants/:id/stage', validate(updateApplicantStageSchema), staffController.updateApplicantStage);
staffRoutes.get('/holidays', staffController.listHolidayRequests);
staffRoutes.post('/holidays', validate(createHolidaySchema), staffController.createHolidayRequest);
staffRoutes.patch('/holidays/:id/approve', staffController.approveHolidayRequest);
staffRoutes.patch('/holidays/:id/reject', staffController.rejectHolidayRequest);
