import { Request, Response } from 'express';
import * as staffService from '../services/staff.service.js';

export async function listStaff(_req: Request, res: Response) {
  const staff = await staffService.listStaff();
  res.json({ status: 'success', data: { staff } });
}

export async function getStaffMember(req: Request, res: Response) {
  const member = await staffService.getStaffMember(req.params.id);
  if (!member) {
    res.status(404).json({ status: 'error', message: 'Staff member not found' });
    return;
  }
  res.json({ status: 'success', data: { member } });
}

export async function getStaffStats(_req: Request, res: Response) {
  const stats = await staffService.getStaffStats();
  res.json({ status: 'success', data: { stats } });
}

export async function createStaffMember(req: Request, res: Response) {
  const member = await staffService.createStaffMember(req.body);
  res.status(201).json({ status: 'success', data: { member } });
}

export async function updateStaffMember(req: Request, res: Response) {
  const member = await staffService.updateStaffMember(req.params.id, req.body);
  if (!member) {
    res.status(404).json({ status: 'error', message: 'Staff member not found' });
    return;
  }
  res.json({ status: 'success', data: { member } });
}

export async function createJobPosting(req: Request, res: Response) {
  const { title, department } = req.body;
  if (!title || !department) {
    res.status(400).json({ status: 'error', message: 'Title and department required' });
    return;
  }
  const job = await staffService.createJobPosting({ title, department });
  res.status(201).json({ status: 'success', data: { job } });
}

export async function listJobPostings(_req: Request, res: Response) {
  const jobs = await staffService.listJobPostings();
  res.json({ status: 'success', data: { jobs } });
}

export async function listApplicants(req: Request, res: Response) {
  const applicants = await staffService.listApplicants(req.params.id);
  res.json({ status: 'success', data: { applicants } });
}

export async function updateApplicantStage(req: Request, res: Response) {
  const { stage } = req.body;
  if (!stage) {
    res.status(400).json({ status: 'error', message: 'Stage is required' });
    return;
  }
  const applicant = await staffService.updateApplicantStage(req.params.id, stage);
  if (!applicant) {
    res.status(404).json({ status: 'error', message: 'Applicant not found' });
    return;
  }
  res.json({ status: 'success', data: { applicant } });
}

export async function listHolidayRequests(_req: Request, res: Response) {
  const holidays = await staffService.listHolidayRequests();
  res.json({ status: 'success', data: { holidays } });
}

export async function createHolidayRequest(req: Request, res: Response) {
  const { staffId, staffName, type, startDate, endDate } = req.body;
  if (!staffId || !staffName || !type || !startDate || !endDate) {
    res.status(400).json({ status: 'error', message: 'All fields are required: staffId, staffName, type, startDate, endDate' });
    return;
  }
  const holiday = await staffService.createHolidayRequest({ staffId, staffName, type, startDate, endDate });
  res.status(201).json({ status: 'success', data: { holiday } });
}

export async function approveHolidayRequest(req: Request, res: Response) {
  const holiday = await staffService.approveHolidayRequest(req.params.id, req.user!.email);
  if (!holiday) {
    res.status(404).json({ status: 'error', message: 'Holiday request not found' });
    return;
  }
  res.json({ status: 'success', data: { holiday } });
}

export async function rejectHolidayRequest(req: Request, res: Response) {
  const holiday = await staffService.rejectHolidayRequest(req.params.id, req.user!.email);
  if (!holiday) {
    res.status(404).json({ status: 'error', message: 'Holiday request not found' });
    return;
  }
  res.json({ status: 'success', data: { holiday } });
}
