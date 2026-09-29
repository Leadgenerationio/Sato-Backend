import { EventEmitter } from 'node:events';

export type DomainEventName = 'creative.added' | 'creative.changed' | 'client.added';

export interface DomainEventPayload {
  businessId: string;
  data: Record<string, unknown>;
}

export const domainEvents = new EventEmitter();
