import { afterEach, describe, expect, it, vi } from "vitest";

import { makeOutboundCall, sendOutboundSms, type TelephonyConfig } from "./service.ts";

const config: TelephonyConfig = {
  accountSid: "AC00000000000000000000000000000000",
  authToken: "fixture-auth-token",
  botPhoneNumber: "+15550000001",
  ownerPhoneNumber: "+15550000002",
  ownerName: "Fixture Owner",
  agentName: "OpenMaus",
  publicUrl: "https://voice.example.test",
};

afterEach(() => vi.unstubAllGlobals());

function mockTwilio(response: { sid?: string; message?: string }, status = 201) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  });
  return requests;
}

describe("Twilio REST requests", () => {
  it("places an outbound call with an escaped ConversationRelay goal", async () => {
    const requests = mockTwilio({ sid: "CAfixture" });
    const result = await makeOutboundCall("+15550000003", "Ask if they can meet <Tuesday> & confirm.", config);
    expect(result).toEqual({ ok: true, callSid: "CAfixture" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`);
    const init = requests[0]!.init;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`);
    const form = new URLSearchParams(String(init.body));
    expect(form.get("To")).toBe("+15550000003");
    expect(form.get("From")).toBe(config.botPhoneNumber);
    expect(form.get("Twiml")).toContain("Ask if they can meet &lt;Tuesday&gt; &amp; confirm.");
    expect(form.get("Twiml")).toContain("wss://voice.example.test/api/telephony/relay");
  });

  it("sends SMS from the configured number and refuses invalid numbers before the request", async () => {
    const requests = mockTwilio({ sid: "SMfixture" });
    expect(await sendOutboundSms("+15550000003", "A short reply.", config)).toEqual({ ok: true, messageSid: "SMfixture" });
    expect(await sendOutboundSms("not-a-number", "Do not send.", config)).toEqual({ ok: false, error: "Recipient must be a valid E.164 phone number." });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`);
    const form = new URLSearchParams(String(requests[0]?.init.body));
    expect(form.get("From")).toBe(config.botPhoneNumber);
    expect(form.get("Body")).toBe("A short reply.");
  });

  it("returns provider errors without leaking request credentials", async () => {
    mockTwilio({ message: "fixture rejected this request" }, 400);
    const result = await sendOutboundSms("+15550000003", "Test.", config);
    expect(result).toEqual({ ok: false, error: "fixture rejected this request" });
    expect(JSON.stringify(result)).not.toContain(config.authToken);
  });
});
