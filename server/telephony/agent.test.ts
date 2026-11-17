import { mkdtempSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import twilio from "twilio";
import { WebSocket } from "ws";

import { PhoneStore } from "./store.ts";
import { createTelephonyAgent } from "./agent.ts";
import type { TelephonyConfig } from "./service.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createUpgrades } from "../routes/upgrades.ts";

const AUTH_TOKEN = "fixture-only-auth-token";
const PHONE_CONFIG: TelephonyConfig = {
  accountSid: "AC00000000000000000000000000000000",
  authToken: AUTH_TOKEN,
  botPhoneNumber: "+15550000001",
  ownerPhoneNumber: "+15550000002",
  ownerName: "Fixture Owner",
  agentName: "OpenMaus",
  publicUrl: "https://voice.example.test",
};

interface Fixture {
  origin: string;
  store: PhoneStore;
  completions: Array<{ channel: string; history: unknown; objective?: string }>;
  agent: ReturnType<typeof createTelephonyAgent>;
  track(socket: WebSocket): void;
  stop(): Promise<void>;
}

let fixture: Fixture | undefined;
const directories: string[] = [];

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
  for (const directory of directories.splice(0)) await removeTempDir(directory);
});

async function startFixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "omb-telephony-agent-"));
  directories.push(directory);
  const store = new PhoneStore(directory);
  const upgrades = createUpgrades();
  const completions: Fixture["completions"] = [];
  const agent = createTelephonyAgent({
    store,
    upgrades,
    config: () => PHONE_CONFIG,
    complete: async (channel, history, _signal, objective) => {
      completions.push({ channel, history: history.map((item) => ({ ...item })), objective });
      return channel === "text" ? "Thanks for your message. What else should I know?" : "Sure. I can help with that.";
    },
    sendSms: async () => ({ ok: true, messageSid: "SMfixture-reply" }),
  });
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (await agent.handle(req, res, path, req.method ?? "GET")) return;
    res.writeHead(404).end();
  };
  const server = createServer((req, res) => { void handle(req, res); });
  upgrades.attach(server, handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const clients = new Set<WebSocket>();
  return {
    origin: `127.0.0.1:${address.port}`,
    store,
    completions,
    agent,
    track(socket) { clients.add(socket); },
    async stop() {
      agent.close();
      upgrades.close();
      for (const socket of clients) socket.terminate();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

function sign(path: string, params: Record<string, string>, websocket = false): string {
  const base = websocket ? PHONE_CONFIG.publicUrl.replace(/^https:/i, "wss:") : PHONE_CONFIG.publicUrl;
  return twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${base}${path}`, params);
}

function post(path: string, params: Record<string, string>, signature = sign(path, params)): Promise<{ status: number; body: string }> {
  if (!fixture) throw new Error("fixture not started");
  const encoded = new URLSearchParams(params).toString();
  const [host, portText] = fixture.origin.split(":");
  return new Promise((resolve, reject) => {
    const req = request({
      host,
      port: Number(portText),
      path,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(encoded),
        "x-twilio-signature": signature,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

function until<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      const value = read();
      if (value !== undefined) { resolve(value); return; }
      if (Date.now() - startedAt >= timeoutMs) { reject(new Error("fixture timed out")); return; }
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe("Twilio phone-agent fixture", () => {
  it("rejects unsigned requests and serves signed owner calls with Conversation Relay", async () => {
    fixture = await startFixture();
    const fields = { CallSid: "CAfixture", From: PHONE_CONFIG.ownerPhoneNumber, To: PHONE_CONFIG.botPhoneNumber };
    const rejected = await post("/api/telephony/voice", fields, "invalid-signature");
    expect(rejected.status).toBe(403);
    const answered = await post("/api/telephony/voice", fields);
    expect(answered.status).toBe(200);
    expect(answered.body).toContain("wss://voice.example.test/api/telephony/relay");
    expect(answered.body).toContain("Hi, this is OpenMaus, your AI assistant.");
    expect(answered.body).toContain("<Connect action=\"https://voice.example.test/api/telephony/voice/complete\">");
  });

  it("replies to an inbound SMS using only the isolated model and Twilio fakes", async () => {
    fixture = await startFixture();
    const fields = {
      MessageSid: "SMfixture-inbound",
      From: "+15550000003",
      To: PHONE_CONFIG.botPhoneNumber,
      Body: "Can you call me after lunch?",
    };
    const response = await post("/api/telephony/sms", fields);
    expect(response.status).toBe(200);
    await fixture.agent.drain();
    expect(fixture.completions).toHaveLength(1);
    expect(fixture.completions[0]?.channel).toBe("text");
    expect(fixture.completions[0]?.history).toContainEqual({ role: "user", content: fields.Body });
    expect(fixture.store.messages().map(({ direction, status, body }) => ({ direction, status, body }))).toEqual([
      { direction: "outbound", status: "sent", body: "Thanks for your message. What else should I know?" },
      { direction: "inbound", status: "replied", body: fields.Body },
    ]);
  });

  it("accepts a signed Conversation Relay WebSocket and answers completed speech turns", async () => {
    fixture = await startFixture();
    const relayPath = "/api/telephony/relay";
    const socket = new WebSocket(`ws://${fixture.origin}${relayPath}`, {
      headers: { "x-twilio-signature": sign(relayPath, {}, true) },
    } as never);
    fixture.track(socket);
    const received: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    const opened = new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await opened;
    socket.send(JSON.stringify({ type: "setup", direction: "inbound", customParameters: {} }));
    socket.send(JSON.stringify({ type: "prompt", last: true, voicePrompt: "Can you help me?" }));
    const reply = await until(() => received.find((message) => message.type === "text"));
    expect(reply).toMatchObject({ type: "text", token: "Sure. I can help with that.", last: true, interruptible: true });
    expect(fixture.completions[0]?.channel).toBe("call");
    expect(fixture.completions[0]?.history).toContainEqual({ role: "user", content: "Can you help me?" });
    socket.close();
  });

  it("answers the signed Connect action callback even when Twilio omits To", async () => {
    fixture = await startFixture();
    const fields = { CallSid: "CAfixture" };
    const response = await post("/api/telephony/voice/complete", fields);
    expect(response.status).toBe(200);
    expect(response.body).toContain("<Hangup/>");
  });
});
