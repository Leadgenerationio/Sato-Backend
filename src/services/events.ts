import { EventEmitter } from 'node:events';

// In-process domain events (creative library plan, phase 4 hooks). Webhook
// delivery and the MCP server subscribe here; producers only emit. Payload
// shape is shared by every event so a subscriber can forward it verbatim.
export type DomainEventName = 'creative.added' | 'creative.changed' | 'client.added';

export interface DomainEventPayload {
  businessId: string;
  data: Record<string, unknown>;
}

class DomainEvents extends EventEmitter {
  emit(event: DomainEventName, payload: DomainEventPayload): boolean {
    return super.emit(event, payload);
  }

  on(event: DomainEventName, listener: (payload: DomainEventPayload) => void): this {
    return super.on(event, listener);
  }

  off(event: DomainEventName, listener: (payload: DomainEventPayload) => void): this {
    return super.off(event, listener);
  }
}

export const domainEvents = new DomainEvents();
// A subscriber throwing must never break the request that emitted.
domainEvents.setMaxListeners(50);
