import { Request, Response } from 'express';
import * as workflowService from '../services/workflow.service.js';

export async function listWorkflows(req: Request, res: Response) {
  const workflows = await workflowService.listWorkflows(req.user!);
  res.json({ status: 'success', data: { workflows } });
}

export async function getWorkflow(req: Request, res: Response) {
  const workflow = await workflowService.getWorkflow(req.params.id as string, req.user!);
  if (!workflow) {
    res.status(404).json({ status: 'error', message: 'Workflow not found' });
    return;
  }
  res.json({ status: 'success', data: { workflow } });
}

export async function createWorkflow(req: Request, res: Response) {
  const workflow = await workflowService.createWorkflow(req.body, req.user!);
  res.status(201).json({ status: 'success', data: { workflow } });
}

export async function updateWorkflow(req: Request, res: Response) {
  const workflow = await workflowService.updateWorkflow(req.params.id as string, req.body, req.user!);
  if (!workflow) {
    res.status(404).json({ status: 'error', message: 'Workflow not found' });
    return;
  }
  res.json({ status: 'success', data: { workflow } });
}

export async function toggleStatus(req: Request, res: Response) {
  const workflow = await workflowService.toggleWorkflowStatus(req.params.id as string, req.user!);
  if (!workflow) {
    res.status(404).json({ status: 'error', message: 'Workflow not found' });
    return;
  }
  res.json({ status: 'success', data: { workflow } });
}

/**
 * T4 (Sam, 2026-05-20) — explicit pause endpoint, idempotent. Calling
 * pause on an already-paused workflow returns 200 with the current row.
 */
export async function pauseWorkflow(req: Request, res: Response) {
  const workflow = await workflowService.setWorkflowStatus(req.params.id as string, 'paused', req.user!);
  if (!workflow) {
    res.status(404).json({ status: 'error', message: 'Workflow not found' });
    return;
  }
  res.json({ status: 'success', data: { workflow } });
}

/** T4 — explicit resume, idempotent. */
export async function resumeWorkflow(req: Request, res: Response) {
  const workflow = await workflowService.setWorkflowStatus(req.params.id as string, 'active', req.user!);
  if (!workflow) {
    res.status(404).json({ status: 'error', message: 'Workflow not found' });
    return;
  }
  res.json({ status: 'success', data: { workflow } });
}

export async function executeWorkflow(req: Request, res: Response) {
  const execution = await workflowService.executeWorkflow(req.params.id as string, req.user!);
  if (!execution) {
    res.status(404).json({ status: 'error', message: 'Workflow not found' });
    return;
  }
  res.json({ status: 'success', data: { execution } });
}

export async function getStepTypes(_req: Request, res: Response) {
  res.json({ status: 'success', data: { types: workflowService.getStepTypes() } });
}
