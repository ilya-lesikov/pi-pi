/**
 * Service Registry
 *
 * Manages service lifecycle, dependency injection, and health monitoring
 * for the Acme API platform.
 *
 * @module service-registry
 * @since 2.0.0
 */

export interface ServiceConfig {
  name: string;
  version: string;
  timeout: number;
  retries: number;
  enabled: boolean;
  priority: number;
}

export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency: number;
  lastCheck: Date;
  uptime: number;
  details?: string;
}

export interface Service {
  config: ServiceConfig;
  health: ServiceHealth;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<ServiceHealth>;
}

type ServiceFactory = (config: ServiceConfig) => Service;

// Default configurations for well-known services
const DEFAULT_CONFIGS: Record<string, Partial<ServiceConfig>> = {
  database: { timeout: 5000, retries: 3, priority: 1 },
  cache: { timeout: 2000, retries: 1, priority: 2 },
  queue: { timeout: 10000, retries: 5, priority: 3 },
  search: { timeout: 3000, retries: 2, priority: 4 },
  email: { timeout: 15000, retries: 3, priority: 5 },
  storage: { timeout: 8000, retries: 2, priority: 4 },
  metrics: { timeout: 1000, retries: 0, priority: 10 },
};

export class ServiceRegistry {
  private services: Map<string, Service> = new Map();
  private factories: Map<string, ServiceFactory> = new Map();
  private startOrder: string[] = [];
  private isShuttingDown = false;

  /**
   * Register a service factory for lazy instantiation.
   * The factory is called when the service is first requested.
   */
  registerFactory(name: string, factory: ServiceFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`Factory already registered for service: ${name}`);
    }
    this.factories.set(name, factory);
  }

  /**
   * Get a service by name. Creates it from the factory if not yet instantiated.
   */
  async getService(name: string): Promise<Service> {
    const existing = this.services.get(name);
    if (existing) return existing;

    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`No factory registered for service: ${name}`);
    }

    const defaults = DEFAULT_CONFIGS[name] || {};
    const config: ServiceConfig = {
      name,
      version: '1.0.0',
      timeout: defaults.timeout ?? 5000,
      retries: defaults.retries ?? 3,
      enabled: true,
      priority: defaults.priority ?? 99,
      ...defaults,
    };

    const service = factory(config);
    this.services.set(name, service);
    return service;
  }

  /**
   * Start all registered services in priority order.
   * Lower priority numbers start first (database before cache before app).
   */
  async startAll(): Promise<void> {
    const sorted = Array.from(this.services.entries())
      .sort(([, a], [, b]) => a.config.priority - b.config.priority);

    console.log(`Starting ${sorted.length} services in priority order...`);

    for (const [name, service] of sorted) {
      if (!service.config.enabled) {
        console.log(`Skipping disabled service: ${name}`);
        continue;
      }

      try {
        const startTime = performance.now();
        await service.start();
        const elapsed = Math.round(performance.now() - startTime);
        this.startOrder.push(name);
        console.log(`Started: ${name} (v${service.config.version}) [${elapsed}ms]`);
      } catch (err) {
        console.error(`Failed to start ${name}:`, err);
        // Stop already-started services before re-throwing
        await this.stopAll();
        throw err;
      }
    }
  }

  /**
   * Stop all services in reverse startup order.
   * Ensures graceful shutdown with proper resource cleanup.
   */
  async stopAll(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log('Shutting down services...');
    const reversed = [...this.startOrder].reverse();

    for (const name of reversed) {
      const service = this.services.get(name);
      if (!service) continue;

      try {
        await service.stop();
        console.log(`Stopped: ${name}`);
      } catch (err) {
        console.error(`Error stopping ${name}:`, err);
      }
    }

    this.services.clear();
    this.startOrder = [];
    this.isShuttingDown = false;
  }

  /**
   * Run health checks on all active services concurrently.
   * Returns a summary of the overall system health.
   */
  async healthCheckAll(): Promise<Map<string, ServiceHealth>> {
    const results = new Map<string, ServiceHealth>();
    const entries = Array.from(this.services.entries());

    const checks = await Promise.allSettled(
      entries.map(async ([name, service]) => {
        const health = await service.healthCheck();
        return { name, health };
      }),
    );

    for (const result of checks) {
      if (result.status === 'fulfilled') {
        results.set(result.value.name, result.value.health);
      } else {
        // Find which service failed by matching the error
        const failedName = entries.find(
          ([, s]) => !results.has(s.config.name),
        )?.[0] ?? 'unknown';
        results.set(failedName, {
          status: 'unhealthy',
          latency: -1,
          lastCheck: new Date(),
          uptime: 0,
          details: result.reason instanceof Error ? result.reason.message : 'Unknown error',
        });
      }
    }

    return results;
  }

  /**
   * List all registered service names and their current status.
   */
  listServices(): Array<{ name: string; running: boolean; health?: ServiceHealth }> {
    return Array.from(this.factories.keys()).map(name => {
      const service = this.services.get(name);
      return {
        name,
        running: !!service,
        health: service?.health,
      };
    });
  }

  /**
   * Get the count of currently running services.
   */
  get runningCount(): number {
    return this.services.size;
  }

  /**
   * Check if a specific service is currently running.
   */
  isRunning(name: string): boolean {
    return this.services.has(name);
  }
}
