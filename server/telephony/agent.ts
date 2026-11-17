import type { IncomingMessage, ServerResponse } from "node:http";
import twilio from "twilio";
import { WebSocket, WebSocketServer } from "ws";

import type { Upgrades } from "../routes/upgrades.ts";
import { isE164, isOwner, loadTelephonyConfig, publicPhoneUrl, sendOutboundSms, type TelephonyConfig, xmlEscape } from "./service.ts";
import { phoneCompletion } from "./model.ts";
import { PhoneStore, type PhoneChatMessage } from "./store.ts";

const VOICE_PATH = "/api/telephony/voice";
const SMS_PATH = "/api/telephony/sms";
const VOICE_COMPLETE_PATH = "/api/telephony/voice/complete";
export const PHONE_RELAY_PATH = "/api/telephony/relay";
const MAX_FORM_BYTES = 64 * 1024;
const MAX_CALL_TURNS = 20;
const MAX_SMS_PER_SENDER_HOUR = 12;

interface PublicAgentOptions {
  store: PhoneStore;
  upgrades: Upgrades;
  config?: () => TelephonyConfig;
  complete?: typeof phoneCompletion;
  sendSms?: typeof sendOutboundSms;
}

interface CallSession {
  socket: WebSocket;
  objective: string;
  history: PhoneChatMessage[];
  controller: AbortController | null;
  generation: number;
  turns: number;
}

function respond(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/xml; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function emptyTwiML(): string {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>";
}

function canonicalUrl(config: TelephonyConfig, req: IncomingMessage, websocket: boolean): string | null {
  if (!config.publicUrl || !req.url?.startsWith("/")) return null;
  try { return publicPhoneUrl(config, req.url, websocket); }
  catch { return null; }
}

function isValidSignature(config: TelephonyConfig, req: IncomingMessage, url: string | null, params: Record<string, string> = {}): boolean {
  const signature = req.headers["x-twilio-signature"];
  if (!config.authToken || !url || typeof signature !== "string") return false;
  try {
    return twilio.validateRequest(config.authToken, signature, url, params);
  } catch {
    return false;
  }
}

async function readForm(req: IncomingMessage): Promise<Record<string, string> | null> {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer;
    size += part.length;
    if (size > MAX_FORM_BYTES) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(part);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

function asTextMessage(body: string, interruptible: boolean): string {
  return JSON.stringify({ type: "text", token: body, last: true, interruptible });
}

function buildTwiML(config: TelephonyConfig, objective: string, ownerCaller: boolean): string {
  const relayUrl = publicPhoneUrl(config, PHONE_RELAY_PATH, true);
  const actionUrl = publicPhoneUrl(config, VOICE_COMPLETE_PATH);
  const greeting = objective
    ? `Hello, this is ${config.agentName}, an AI assistant calling on behalf of ${config.ownerName}.`
    : ownerCaller
      ? `Hi, this is ${config.agentName}, your AI assistant. How can I help?`
      : `Hi, you've reached ${config.agentName}, an AI assistant. How can I help?`;
  const parameter = objective ? `<Parameter name="objective" value="${xmlEscape(objective)}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="${xmlEscape(actionUrl)}"><ConversationRelay url="${xmlEscape(relayUrl)}" welcomeGreeting="${xmlEscape(greeting)}">${parameter}</ConversationRelay></Connect></Response>`;
}

function sendSocketText(session: CallSession, text: string, interruptible: boolean): void {
  if (session.socket.readyState !== WebSocket.OPEN) return;
  session.socket.send(asTextMessage(text, interruptible));
}

function historyForPrompt(history: readonly PhoneChatMessage[], prompt: string): PhoneChatMessage[] {
  return [...history, { role: "user" as const, content: prompt }].slice(-12);
}

export function createTelephonyAgent(options: PublicAgentOptions) {
  const config = options.config ?? loadTelephonyConfig;
  const complete = options.complete ?? phoneCompletion;
  const webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FORM_BYTES });
  const sessions = new Set<CallSession>();
  const smsTasks = new Set<Promise<void>>();
  options.upgrades.route((path) => path === PHONE_RELAY_PATH);

  const processSms = async (id: string, from: string, to: string): Promise<void> => {
    try {
      const history = options.store.historyFor(from);
      const reply = await complete("text", history);
      const result = await (options.sendSms ?? sendOutboundSms)(from, reply, config());
      if (!result.ok) {
        options.store.addOutboundSms({ from: to, to: from, body: reply, replyTo: id, status: "failed", error: result.error });
        options.store.setStatus(id, "reply_failed", { error: "The SMS reply could not be delivered." });
        return;
      }
      options.store.addOutboundSms({ from: to, to: from, body: reply, replyTo: id, status: "sent", providerId: result.messageSid });
      options.store.setStatus(id, "replied");
    } catch {
      options.store.setStatus(id, "reply_failed", { error: "The assistant could not prepare a reply." });
    }
  };

  const handleWebhook = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    const settings = config();
    if (!settings.authToken || !settings.accountSid || !settings.botPhoneNumber || !settings.publicUrl) {
      req.resume();
      respond(res, 503, emptyTwiML());
      return true;
    }
    let form: Record<string, string> | null;
    try {
      form = await readForm(req);
    } catch (error) {
      respond(res, (error as { status?: number }).status ?? 400, emptyTwiML());
      return true;
    }
    if (!form) {
      req.resume();
      respond(res, 415, emptyTwiML());
      return true;
    }
    if (!isValidSignature(settings, req, canonicalUrl(settings, req, false), form)) {
      respond(res, 403, emptyTwiML());
      return true;
    }
    if (path !== VOICE_COMPLETE_PATH && form.To !== settings.botPhoneNumber) {
      respond(res, 403, emptyTwiML());
      return true;
    }

    if (path === VOICE_PATH && req.method === "POST") {
      if (!form.CallSid || !isE164(form.From || "")) {
        respond(res, 400, emptyTwiML());
        return true;
      }
      try {
        respond(res, 200, buildTwiML(settings, "", isOwner(form.From, settings)));
      } catch {
        respond(res, 503, emptyTwiML());
      }
      return true;
    }
    if (path === SMS_PATH && req.method === "POST") {
      if (!form.MessageSid || !isE164(form.From || "") || typeof form.Body !== "string") {
        respond(res, 400, emptyTwiML());
        return true;
      }
      const { created } = options.store.addInboundSms({ id: form.MessageSid, from: form.From, to: settings.botPhoneNumber, body: form.Body });
      if (created) {
        const overRate = options.store.inboundCountSince(form.From, Date.now() - 60 * 60_000) > MAX_SMS_PER_SENDER_HOUR;
        if (overRate) options.store.setStatus(form.MessageSid, "rate_limited", { error: "Reply rate limit reached." });
        else {
          const task = processSms(form.MessageSid, form.From, settings.botPhoneNumber);
          smsTasks.add(task);
          void task.finally(() => smsTasks.delete(task));
        }
      }
      respond(res, 200, emptyTwiML());
      return true;
    }
    if (path === VOICE_COMPLETE_PATH && req.method === "POST") {
      if (!form.CallSid) {
        respond(res, 400, emptyTwiML());
        return true;
      }
      respond(res, 200, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Hangup/></Response>");
      return true;
    }
    return false;
  };

  const respondToPrompt = async (session: CallSession, prompt: string): Promise<void> => {
    if (session.turns >= MAX_CALL_TURNS) {
      sendSocketText(session, "I have reached the call limit for this conversation. Thanks for calling.", false);
      session.socket.close(1000, "call turn limit");
      return;
    }
    const generation = ++session.generation;
    session.controller?.abort();
    const controller = new AbortController();
    session.controller = controller;
    session.turns += 1;
    const history = historyForPrompt(session.history, prompt);
    try {
      const reply = await complete("call", history, controller.signal, session.objective);
      if (generation !== session.generation || session.socket.readyState !== WebSocket.OPEN) return;
      sendSocketText(session, reply, true);
      session.history = [...history, { role: "assistant" as const, content: reply }].slice(-12);
    } catch {
      if (generation !== session.generation || session.socket.readyState !== WebSocket.OPEN) return;
      sendSocketText(session, "I'm having trouble reaching my assistant right now. Please try again in a moment.", true);
    }
  };

  const connectSocket = (socket: WebSocket): void => {
    let session: CallSession | null = null;
    socket.on("message", (raw, binary) => {
      if (binary) { socket.close(1003, "text messages required"); return; }
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        if (!parsed || typeof parsed !== "object") { socket.close(1007, "invalid message"); return; }
        event = parsed as Record<string, unknown>;
      } catch {
        socket.close(1007, "invalid message");
        return;
      }
      if (event.type === "setup") {
        const custom = event.customParameters && typeof event.customParameters === "object"
          ? event.customParameters as Record<string, unknown> : {};
        const objective = typeof custom.objective === "string" ? custom.objective.slice(0, 1_000) : "";
        const direction = typeof event.direction === "string" && event.direction.startsWith("outbound") ? "outbound" : "inbound";
        if (session) {
          session.controller?.abort();
          sessions.delete(session);
        }
        session = {
          socket,
          objective,
          history: [],
          controller: null,
          generation: 0,
          turns: 0,
        };
        sessions.add(session);
        if (direction === "outbound") {
          if (!objective) {
            sendSocketText(session, "I can't continue this call because its approved objective is missing.", false);
            socket.close(1008, "missing approved objective");
            return;
          }
          void respondToPrompt(session, "The person has answered. Start the conversation and work toward the approved goal.");
        }
        return;
      }
      if (!session) return;
      if (event.type === "interrupt") {
        session.controller?.abort();
        session.controller = null;
        if (typeof event.utteranceUntilInterrupt === "string" && session.history.at(-1)?.role === "assistant") {
          session.history[session.history.length - 1]!.content = event.utteranceUntilInterrupt.slice(0, 1_200);
        }
        session.generation += 1;
        return;
      }
      if (event.type === "prompt" && event.last === true && typeof event.voicePrompt === "string") {
        const prompt = event.voicePrompt.trim().slice(0, 4_000);
        if (prompt) void respondToPrompt(session, prompt);
      }
    });
    socket.once("close", () => {
      if (!session) return;
      session.controller?.abort();
      sessions.delete(session);
    });
    socket.once("error", () => {
      session?.controller?.abort();
      if (session) sessions.delete(session);
    });
  };

  webSockets.on("connection", connectSocket);

  return {
    async handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
      if ((path === VOICE_PATH || path === SMS_PATH || path === VOICE_COMPLETE_PATH) && method === "POST") {
        return handleWebhook(req, res, path);
      }
      if (path !== PHONE_RELAY_PATH || method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket") return false;
      const settings = config();
      if (!settings.authToken || !settings.publicUrl) {
        res.writeHead(503).end();
        return true;
      }
      if (!isValidSignature(settings, req, canonicalUrl(settings, req, true))) {
        res.writeHead(403).end();
        return true;
      }
      const pending = options.upgrades.pending(req);
      if (!pending) {
        res.writeHead(426).end();
        return true;
      }
      if (pending.socket.destroyed) return true;
      pending.release();
      webSockets.handleUpgrade(req, pending.socket, pending.head, (socket) => webSockets.emit("connection", socket, req));
      res.detachSocket(pending.socket);
      return true;
    },
    close(): void {
      for (const session of sessions) {
        session.controller?.abort();
        session.socket.close(1001, "server shutting down");
      }
      sessions.clear();
      webSockets.close();
    },
    async drain(): Promise<void> {
      await Promise.all(smsTasks);
    },
  };
}
