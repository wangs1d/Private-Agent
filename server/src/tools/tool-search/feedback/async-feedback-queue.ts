import type { FeedbackReport } from "./feedback-models.js";

export type FeedbackQueueItem = {
  feedback: FeedbackReport;
  received_at: string;
};

export type FeedbackQueueSnapshot = {
  backend: "memory" | "rabbitmq_pending";
  queued: number;
  processed: number;
  failed: number;
  last_error: string | null;
};

export type FeedbackConsumer = (item: FeedbackQueueItem) => Promise<void>;

/**
 * Phase-5 async feedback queue.
 *
 * RabbitMQ is provisioned in docker-compose.infra.yml, but this repository does
 * not currently depend on an AMQP client. The queue therefore exposes the same
 * async boundary with an in-memory backend, so feedback logging never blocks the
 * main route. A RabbitMQ adapter can replace the internals without changing the
 * feedback API or online learner.
 */
export class AsyncFeedbackQueue {
  private readonly items: FeedbackQueueItem[] = [];
  private readonly consumers: FeedbackConsumer[] = [];
  private draining = false;
  private processed = 0;
  private failed = 0;
  private lastError: string | null = null;

  enqueue(feedback: FeedbackReport): void {
    this.items.push({
      feedback,
      received_at: new Date().toISOString(),
    });
    this.scheduleDrain();
  }

  enqueueBatch(items: FeedbackReport[]): void {
    for (const item of items) this.enqueue(item);
  }

  registerConsumer(consumer: FeedbackConsumer): void {
    this.consumers.push(consumer);
    this.scheduleDrain();
  }

  snapshot(): FeedbackQueueSnapshot {
    return {
      backend: process.env.AGENT_TOOL_FEEDBACK_QUEUE_URL ? "rabbitmq_pending" : "memory",
      queued: this.items.length,
      processed: this.processed,
      failed: this.failed,
      last_error: this.lastError,
    };
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => {
      void this.drain().finally(() => {
        this.draining = false;
        if (this.items.length > 0) this.scheduleDrain();
      });
    });
  }

  private async drain(): Promise<void> {
    while (this.items.length > 0) {
      const item = this.items.shift();
      if (!item) break;
      try {
        for (const consumer of this.consumers) {
          await consumer(item);
        }
        this.processed += 1;
      } catch (e) {
        this.failed += 1;
        this.lastError = e instanceof Error ? e.message : String(e);
        console.warn("[tool-search:feedback-queue] consumer failed", e);
      }
    }
  }
}
