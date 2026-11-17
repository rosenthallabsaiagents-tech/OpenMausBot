import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";

export type PhoneMessageStatus = "received" | "processing" | "replied" | "reply_failed" | "draft" | "sending" | "sent" | "failed" | "cancelled" | "rate_limited";

export interface PhoneMessage {
  id: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  body: string;
  receivedAt: number;
  status: PhoneMessageStatus;
  replyTo?: string;
  providerId?: string;
  error?: string;
}

export interface PhoneChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface StoredState {
  version: 1;
  messages: PhoneMessage[];
}

const MAX_MESSAGES = 200;
const MAX_HISTORY = 12;

function isPhoneMessage(value: unknown): value is PhoneMessage {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PhoneMessage>;
  return typeof row.id === "string" && (row.direction === "inbound" || row.direction === "outbound")
    && typeof row.from === "string" && typeof row.to === "string" && typeof row.body === "string"
    && typeof row.receivedAt === "number" && typeof row.status === "string";
}

export class PhoneStore {
  readonly #file: string;
  readonly #messages: PhoneMessage[];

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#file = join(dataDir, "telephony.json");
    if (!existsSync(this.#file)) {
      this.#messages = [];
      return;
    }
    const raw: unknown = JSON.parse(readFileSync(this.#file, "utf8"));
    if (!raw || typeof raw !== "object" || (raw as Partial<StoredState>).version !== 1
      || !Array.isArray((raw as Partial<StoredState>).messages)
      || !(raw as StoredState).messages.every(isPhoneMessage)) {
      throw new Error("The telephony message store has an unsupported format.");
    }
    this.#messages = (raw as StoredState).messages.slice(-MAX_MESSAGES);
  }

  messages(): PhoneMessage[] {
    return this.#messages.slice().reverse().map((message) => ({ ...message }));
  }

  find(id: string): PhoneMessage | undefined {
    const message = this.#messages.find((item) => item.id === id);
    return message ? { ...message } : undefined;
  }

  addInboundSms(input: { id: string; from: string; to: string; body: string }): { created: boolean; message: PhoneMessage } {
    const existing = this.#messages.find((item) => item.id === input.id);
    if (existing) return { created: false, message: { ...existing } };
    const message: PhoneMessage = {
      id: input.id,
      direction: "inbound",
      from: input.from,
      to: input.to,
      body: input.body.slice(0, 4_000),
      receivedAt: Date.now(),
      status: "processing",
    };
    this.#messages.push(message);
    this.#save();
    return { created: true, message: { ...message } };
  }

  addOutboundSms(input: { from: string; to: string; body: string; replyTo?: string; status: "sent" | "failed"; providerId?: string; error?: string }): PhoneMessage {
    const message: PhoneMessage = {
      id: randomUUID(),
      direction: "outbound",
      from: input.from,
      to: input.to,
      body: input.body.slice(0, 4_000),
      receivedAt: Date.now(),
      status: input.status,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
    this.#messages.push(message);
    this.#trimAndSave();
    return { ...message };
  }

  createSmsDraft(input: { to: string; body: string; from: string }): PhoneMessage {
    const message: PhoneMessage = {
      id: randomUUID(),
      direction: "outbound",
      from: input.from,
      to: input.to,
      body: input.body,
      receivedAt: Date.now(),
      status: "draft",
    };
    this.#messages.push(message);
    this.#trimAndSave();
    return { ...message };
  }

  claimSmsDraft(id: string): PhoneMessage | null {
    const message = this.#messages.find((item) => item.id === id);
    if (!message || message.direction !== "outbound" || message.status !== "draft") return null;
    message.status = "sending";
    this.#save();
    return { ...message };
  }

  setStatus(id: string, status: PhoneMessageStatus, details: { providerId?: string; error?: string } = {}): boolean {
    const message = this.#messages.find((item) => item.id === id);
    if (!message) return false;
    message.status = status;
    if (details.providerId) message.providerId = details.providerId;
    if (details.error) message.error = details.error;
    else delete message.error;
    this.#save();
    return true;
  }

  inboundCountSince(from: string, since: number): number {
    return this.#messages.filter((item) => item.direction === "inbound" && item.from === from && item.receivedAt >= since).length;
  }

  historyFor(phone: string): PhoneChatMessage[] {
    return this.#messages
      .filter((item) => (item.from === phone || item.to === phone)
        && (item.direction === "inbound" ? ["processing", "replied"].includes(item.status) : item.status === "sent"))
      .slice(-MAX_HISTORY)
      .map((item) => ({ role: item.direction === "inbound" ? "user" : "assistant", content: item.body }));
  }

  #trimAndSave(): void {
    if (this.#messages.length > MAX_MESSAGES) this.#messages.splice(0, this.#messages.length - MAX_MESSAGES);
    this.#save();
  }

  #save(): void {
    const state: StoredState = { version: 1, messages: this.#messages };
    writeFileAtomic(this.#file, `${JSON.stringify(state)}\n`, { mode: 0o600, durable: false });
  }
}
