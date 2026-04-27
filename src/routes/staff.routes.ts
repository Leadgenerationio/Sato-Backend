import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as staffController from '../controllers/staff.controller.js';

export const staffRoutes: RouterType = Router();

staffRoutes.use(authMiddleware);
staffRoutes.use(requireRole('owner', 'ops_manager'));

staffRoutes.get('/staff', staffController.listStaff);
staffRoutes.get('/staff/stats', staffController.getStaffStats);
staffRoutes.post('/staff', staffController.createStaffMember);
staffRoutes.get('/staff/:id', staffController.getStaffMember);
staffRoutes.put('/staff/:id', staffController.updateStaffMember);
staffRoutes.get('/staff/:id/documents', staffController.listStaffDocuments);
staffRoutes.post('/staff/:id/documents', staffController.addStaffDocument);
staffRoutes.delete('/staff/:id/documents/:key', staffController.removeStaffDocument);
staffRoutes.get('/jobs', staffController.listJobPostings);
staffRoutes.post('/jobs', staffController.createJobPosting);
staffRoutes.get('/jobs/:id/applicants', staffController.listApplicants);
staffRoutes.patch('/applicants/:id/stage', staffController.updateApplicantStage);
staffRoutes.get('/holidays', staffController.listHolidayRequests);
staffRoutes.post('/holidays', staffController.createHolidayRequest);
staffRoutes.patch('/holidays/:id/approve', staffController.approveHolidayRequest);
staffRoutes.patch('/holidays/:id/reject', staffController.rejectHolidayRequest);
