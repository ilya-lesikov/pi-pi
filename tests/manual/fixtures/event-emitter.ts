/**
 * Typed Event Emitter
 *
 * A minimal, type-safe event system for internal pub/sub communication.
 * Used by services to broadcast lifecycle and domain events.
 */

export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

export interface EventSubscription {
  unsubscribe(): void;
}

export class EventEmitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<EventHandler<any>>>();

  /**
   * Subscribe to an event. Returns a subscription object with unsubscribe().
   */
  on<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): EventSubscription {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    return {
      unsubscribe: () => {
        this.handlers.get(event)?.delete(handler);
      },
    };
  }

  /**
   * Subscribe to an event for a single emission only.
   */
  once<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): EventSubscription {
    const wrapper: EventHandler<Events[K]> = (data) => {
      sub.unsubscribe();
      return handler(data);
    };
    const sub = this.on(event, wrapper);
    return sub;
  }

  /**
   * Emit an event, calling all registered handlers.
   * Handlers are called in registration order.
   * Async handlers are awaited sequentially.
   */
  async emit<K extends keyof Events>(event: K, data: Events[K]): Promise<void> {
    const handlers = this.handlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      await handler(data);
    }
  }

  /**
   * Remove all handlers for a specific event, or all events if no event specified.
   */
  removeAllListeners(event?: keyof Events): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }

  /**
   * Get the number of handlers registered for a specific event.
   */
  listenerCount(event: keyof Events): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
