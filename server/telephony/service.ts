import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface TelephonyConfig {
  accountSid: string;
  authToken: string;
  botPhoneNumber: string;
  ownerPhoneNumber: string;
  ownerName: string;
  agentName: string;
  publicUrl: string;
}

export function telephonyEnvironment(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (env.OMB_VERIFICATION_FIXTURE === "1") return env;
  const envPath = resolve(".env");
  if (!existsSync(envPath)) return env;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || env[match[1]!] !== undefined) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    env[match[1]!] = value;
  }
  return env;
}

export function loadTelephonyConfig(): TelephonyConfig {
  const env = telephonyEnvironment();
  return {
    accountSid: env.TWILIO_ACCOUNT_SID || "",
    authToken: env.TWILIO_AUTH_TOKEN || "",
    botPhoneNumber: env.TWILIO_PHONE_NUMBER || "",
    ownerPhoneNumber: env.OWNER_PHONE_NUMBER || env.USER_AUTHORIZED_PHONE_NUMBER || "",
    ownerName: env.PHONE_OWNER_NAME?.trim() || "the account owner",
    agentName: env.PHONE_AGENT_NAME?.trim() || "OpenMaus",
    publicUrl: (env.TELEPHONY_PUBLIC_URL || env.OMB_PUBLIC_URL || "").replace(/\/+$/, ""),
  };
}

export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value.trim());
}

export function isOwner(fromNumber: string, config: TelephonyConfig = loadTelephonyConfig()): boolean {
  return isE164(fromNumber) && isE164(config.ownerPhoneNumber) && fromNumber.trim() === config.ownerPhoneNumber.trim();
}

export function xmlEscape(value: string): string {
  const clean = Array.from(value).filter((char) => {
    const code = char.codePointAt(0)!;
    return code >= 0x20 || code === 0x09;
  }).join("");
  return clean.replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  })[char]!);
}

export function publicPhoneUrl(config: TelephonyConfig, path: string, websocket = false): string {
  let base: URL;
  try { base = new URL(config.publicUrl); }
  catch { throw new Error("Set TELEPHONY_PUBLIC_URL to the public HTTPS address of this server."); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !path.startsWith("/")) {
    throw new Error("Set TELEPHONY_PUBLIC_URL to the public HTTPS address of this server.");
  }
  const prefix = `${websocket ? "wss:" : "https:"}//${base.host}${base.pathname.replace(/\/+$/, "")}`;
  return `${prefix}${path}`;
}

export function conversationRelayTwiML(config: TelephonyConfig, objective = ""): string {
  const outbound = Boolean(objective.trim());
  const greeting = outbound
    ? `Hello, this is ${config.agentName}, an AI assistant calling on behalf of ${config.ownerName}.`
    : `Hi, you've reached ${config.agentName}, an AI assistant. How can I help?`;
  const parameters = [
    `<Parameter name="direction" value="${outbound ? "outbound" : "inbound"}"/>`,
    ...(outbound ? [`<Parameter name="objective" value="${xmlEscape(objective.trim())}"/>`] : []),
  ].join("");
  const relayUrl = publicPhoneUrl(config, "/api/telephony/relay", true);
  const actionUrl = publicPhoneUrl(config, "/api/telephony/voice/complete");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="${xmlEscape(actionUrl)}"><ConversationRelay url="${xmlEscape(relayUrl)}" welcomeGreeting="${xmlEscape(greeting)}">${parameters}</ConversationRelay></Connect></Response>`;
}

async function twilioPost(
  resource: "Calls" | "Messages",
  fields: URLSearchParams,
  config: TelephonyConfig,
): Promise<{ sid?: string; error?: string }> {
  if (!config.accountSid || !config.authToken || !isE164(config.botPhoneNumber)) {
    return { error: "Twilio account credentials and a valid Twilio phone number are required." };
  }
  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/${resource}.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: fields.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json().catch(() => ({})) as { sid?: string; message?: string };
    if (!response.ok) return { error: data.message || `Twilio request failed (${response.status}).` };
    return { sid: data.sid };
  } catch (error) {
    return { error: error instanceof Error && error.name === "TimeoutError" ? "Twilio request timed out." : "Could not reach Twilio." };
  }
}

export async function makeOutboundCall(
  to: string,
  objective: string,
  config: TelephonyConfig = loadTelephonyConfig(),
): Promise<{ ok: boolean; callSid?: string; error?: string }> {
  const recipient = to.trim();
  const goal = objective.trim();
  if (!isE164(recipient)) return { ok: false, error: "Recipient must be a valid E.164 phone number." };
  if (!goal || goal.length > 1_000) return { ok: false, error: "Call objective must contain 1 to 1000 characters." };
  let twiml: string;
  try {
    twiml = conversationRelayTwiML(config, goal);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Phone service is not configured." };
  }
  const params = new URLSearchParams({ To: recipient, From: config.botPhoneNumber, Twiml: twiml });
  const result = await twilioPost("Calls", params, config);
  return result.sid ? { ok: true, callSid: result.sid } : { ok: false, error: result.error || "Twilio did not return a call id." };
}

export async function sendOutboundSms(
  to: string,
  body: string,
  config: TelephonyConfig = loadTelephonyConfig(),
): Promise<{ ok: boolean; messageSid?: string; error?: string }> {
  const recipient = to.trim();
  const text = body.trim();
  if (!isE164(recipient)) return { ok: false, error: "Recipient must be a valid E.164 phone number." };
  if (!text || text.length > 1_500) return { ok: false, error: "Text must contain 1 to 1500 characters." };
  const result = await twilioPost("Messages", new URLSearchParams({ To: recipient, From: config.botPhoneNumber, Body: text }), config);
  return result.sid ? { ok: true, messageSid: result.sid } : { ok: false, error: result.error || "Twilio did not return a message id." };
}
