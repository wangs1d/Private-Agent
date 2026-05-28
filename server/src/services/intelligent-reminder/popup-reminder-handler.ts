import type { ReminderInstance, PopupReminderConfig } from "./types.js";

export interface PopupReminderHandlerDeps {
  sendToClient: (userId: string, payload: Record<string, unknown>) => Promise<void>;
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
}

export class PopupReminderHandler {
  private deps: PopupReminderHandlerDeps;
  private activePopups = new Map<string, { closeTimer?: NodeJS.Timeout }>();

  constructor(deps: PopupReminderHandlerDeps) {
    this.deps = deps;
  }

  async handle(instance: ReminderInstance): Promise<void> {
    const config = instance.popupConfig ?? {};
    const userId = instance.config.metadata?.userId as string | undefined;

    if (!userId) {
      this.deps.logger?.error("Popup reminder missing userId in metadata");
      return;
    }

    const payload = {
      type: "reminder_popup",
      reminderId: instance.config.id,
      title: instance.config.title,
      message: instance.config.message,
      priority: instance.config.priority,
      level: instance.currentLevel,
      timestamp: new Date().toISOString(),
      showConfirmButton: config.showConfirmButton ?? true,
      confirmText: config.confirmText ?? "我知道了",
      position: config.position ?? "center",
    };

    try {
      await this.deps.sendToClient(userId, payload);
      this.deps.logger?.info(`Popup reminder sent: ${instance.config.id}`);

      if (config.autoCloseAfterMs && config.autoCloseAfterMs > 0) {
        const closeTimer = setTimeout(() => {
          this.activePopups.delete(instance.config.id);
        }, config.autoCloseAfterMs);

        this.activePopups.set(instance.config.id, { closeTimer });
      } else {
        this.activePopups.set(instance.config.id, {});
      }
    } catch (error) {
      this.deps.logger?.error(`Failed to send popup reminder: ${error}`);
      throw error;
    }
  }

  async handleUserAction(
    reminderId: string,
    action: "confirm" | "dismiss",
  ): Promise<boolean> {
    const popup = this.activePopups.get(reminderId);
    if (!popup) {
      return false;
    }

    if (popup.closeTimer) {
      clearTimeout(popup.closeTimer);
    }

    this.activePopups.delete(reminderId);
    this.deps.logger?.info(`Popup ${action}: ${reminderId}`);
    return true;
  }

  getActivePopupCount(): number {
    return this.activePopups.size;
  }

  cleanup(): void {
    for (const popup of this.activePopups.values()) {
      if (popup.closeTimer) {
        clearTimeout(popup.closeTimer);
      }
    }
    this.activePopups.clear();
  }
}
