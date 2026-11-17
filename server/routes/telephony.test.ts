import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { PhoneStore } from "../telephony/store.ts";
import { createTelephonyRoutes } from "./telephony.ts";
import type { RouteContext } from "./table.ts";

const config = {
  accountSid: "AC00000000000000000000000000000000",
  authToken: "fixture-token",
  botPhoneNumber: "+15550000001",
  ownerPhoneNumber: "+15550000002",
  ownerName: "Fixture Owner",
  agentName: "OpenMaus",
  publicUrl: "https://voice.example.test",
};
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await removeTempDir(directory);
});

function newStore(): PhoneStore {
  const directory = mkdtempSync(join(tmpdir(), "omb-telephony-routes-"));
  directories.push(directory);
  return new PhoneStore(directory);
}

function invokeRoute(route: ReturnType<typeof createTelephonyRoutes>, path: string, body: unknown, method = "POST", scopes: string[] = ["admin", "client"]) {
  let status = 0;
  let output = "";
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(data?: string) { if (data) output += data; },
  } as unknown as RouteContext["res"];
  const ctx = {
    req: {} as RouteContext["req"],
    res,
    url: new URL(`http://127.0.0.1${path}`),
    path,
    method,
    auth: { kind: "loopback", scopes } as unknown as RequestAuth,
    json,
    readBody: async () => body,
  } as unknown as RouteContext;
  return Promise.resolve(route(ctx)).then(() => ({ status, body: output ? JSON.parse(output) as Record<string, unknown> : null }));
}

describe("Telephony routes", () => {
  it("requires explicit approval of one saved SMS draft and sends it once", async () => {
    const store = newStore();
    const sent: Array<{ to: string; body: string }> = [];
    const route = createTelephonyRoutes({
      store,
      config: () => config,
      sendSms: async (to, body) => { sent.push({ to, body }); return { ok: true, messageSid: "SMfixture" }; },
    });
    const created = await invokeRoute(route, "/api/telephony/sms/drafts", { to: "+15550000003", body: "I will call you tomorrow." });
    expect(created.status).toBe(201);
    const createdBody = created.body;
    if (!createdBody) throw new Error("draft route returned no JSON body");
    const draft = createdBody.draft as { id: string; status: string };
    expect(draft.status).toBe("draft");
    expect(created.body?.approvalRequired).toBe(true);

    const refused = await invokeRoute(route, `/api/telephony/sms/drafts/${draft.id}/approve`, { confirm: false });
    expect(refused.status).toBe(400);
    expect(sent).toHaveLength(0);

    const approved = await invokeRoute(route, `/api/telephony/sms/drafts/${draft.id}/approve`, { confirm: true });
    expect(approved.status).toBe(200);
    expect(sent).toEqual([{ to: "+15550000003", body: "I will call you tomorrow." }]);
    expect(store.find(draft.id)?.status).toBe("sent");

    const repeated = await invokeRoute(route, `/api/telephony/sms/drafts/${draft.id}/approve`, { confirm: true });
    expect(repeated.status).toBe(409);
    expect(sent).toHaveLength(1);

    const cancelRoute = createTelephonyRoutes({ store, config: () => config, sendSms: async () => { throw new Error("cancelled draft must not be sent"); } });
    const cancelledDraft = await invokeRoute(cancelRoute, "/api/telephony/sms/drafts", { to: "+15550000003", body: "Do not send this." });
    const cancelledBody = cancelledDraft.body;
    if (!cancelledBody) throw new Error("draft route returned no JSON body");
    const cancelId = (cancelledBody.draft as { id: string }).id;
    expect((await invokeRoute(cancelRoute, `/api/telephony/sms/drafts/${cancelId}/cancel`, {})).status).toBe(200);
    expect(store.find(cancelId)?.status).toBe("cancelled");
    expect((await invokeRoute(cancelRoute, `/api/telephony/sms/drafts/${cancelId}/approve`, { confirm: true })).status).toBe(409);
  });

  it("starts an outbound call through the approved admin route", async () => {
    const calls: Array<{ to: string; objective: string }> = [];
    const route = createTelephonyRoutes({
      store: newStore(),
      config: () => config,
      makeCall: async (to, objective) => { calls.push({ to, objective }); return { ok: true, callSid: "CAfixture" }; },
    });
    const result = await invokeRoute(route, "/api/telephony/calls/outbound", {
      to: "+15550000003", objective: "Ask whether Tuesday works.",
    });
    expect(result.status).toBe(200);
    expect(calls).toEqual([{ to: "+15550000003", objective: "Ask whether Tuesday works." }]);
  });

  it("serves safe readiness status and SMS history to a limited phone session", async () => {
    const store = newStore();
    store.addInboundSms({ id: "SM-in", from: "+15550000003", to: config.botPhoneNumber, body: "Hello" });
    const route = createTelephonyRoutes({ store, config: () => config, modelReady: () => true });
    const status = await invokeRoute(route, "/api/telephony/status", {}, "GET", ["client", "phone"]);
    expect(status.body).toEqual({ ready: true, phoneNumber: "••••0001", checks: { twilio: true, model: true, publicUrl: true } });
    expect(JSON.stringify(status.body)).not.toContain(config.authToken);
    const history = await invokeRoute(route, "/api/telephony/sms", {}, "GET", ["client", "phone"]);
    expect(history.body?.messages).toHaveLength(1);
    const refused = await invokeRoute(route, "/api/telephony/sms", {}, "GET", ["client"]);
    expect(refused.status).toBe(403);
  });

  it("requires owner access for phone controls", async () => {
    const route = createTelephonyRoutes({ store: newStore(), config: () => config });
    let status = 0;
    const res = {
      writeHead(code: number) { status = code; return this; },
      end() {},
    } as unknown as RouteContext["res"];
    const ctx = {
      req: {} as RouteContext["req"], res,
      url: new URL("http://127.0.0.1/api/telephony/sms"),
      path: "/api/telephony/sms", method: "GET",
      auth: { kind: "session", scopes: ["client"] } as unknown as RequestAuth,
      json,
    } as unknown as RouteContext;
    await route(ctx);
    expect(status).toBe(403);
  });
});
