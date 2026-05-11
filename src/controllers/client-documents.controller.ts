import type { Request, Response } from 'express';
import * as service from '../services/client-documents.service.js';

export async function list(req: Request, res: Response) {
  const clientId = req.params.id as string;
  const docs = await service.listDocuments(clientId, req.user!);
  if (docs === null) {
    res.status(404).json({ status: 'error', message: 'Client not found' });
    return;
  }
  res.json({ status: 'success', data: { documents: docs } });
}

export async function add(req: Request, res: Response) {
  const clientId = req.params.id as string;
  const doc = await service.addDocument(clientId, req.body, req.user!);
  if (!doc) {
    res.status(404).json({ status: 'error', message: 'Client not found' });
    return;
  }
  res.status(201).json({ status: 'success', data: { document: doc } });
}

export async function remove(req: Request, res: Response) {
  const clientId = req.params.id as string;
  const docId = req.params.docId as string;
  const ok = await service.removeDocument(clientId, docId, req.user!);
  if (!ok) {
    res.status(404).json({ status: 'error', message: 'Document not found' });
    return;
  }
  res.status(204).end();
}
