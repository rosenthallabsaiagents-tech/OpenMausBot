import { PASS, type RouteContext, type RouteHandler } from "./table.ts";
import { isE164, loadTelephonyConfig, makeOutboundCall, publicPhoneUrl, sendOutboundSms, type TelephonyConfig } from "../telephony/service.ts";
import type { PhoneStore } from "../telephony/store.ts";
import { phoneAgentReady } from "../telephony/model.ts";

interface TelephonyRouteOptions {
  store: PhoneStore;
  config?: () => TelephonyConfig;
  modelReady?: () => boolean;
  sendSms?: typeof sendOutboundSms;
  makeCall?: typeof makeOutboundCall;
}

export function createTelephonyRoutes(options: TelephonyRouteOptions): RouteHandler {
  const config = options.config ?? loadTelephonyConfig;
  return async ({ req, res, path, method, auth, json, readBody }: RouteContext) => {
    if (!path.startsWith("/api/telephony/")) return PASS;
    if (!auth.scopes.includes("admin") && !auth.scopes.includes("phone")) {
      return json(res, 403, { error: "Pair this device with phone assistant access to use phone controls." });
    }

    if (method === "GET" && path === "/api/telephony/status") {
      const settings = config();
      const twilioReady = Boolean(settings.accountSid && settings.authToken && isE164(settings.botPhoneNumber));
      const modelReady = (options.modelReady ?? phoneAgentReady)();
      let publicUrlReady = false;
      try { publicPhoneUrl(settings, "/api/telephony/voice"); publicUrlReady = true; } catch {}
      return json(res, 200, {
        ready: twilioReady && modelReady && publicUrlReady,
        phoneNumber: isE164(settings.botPhoneNumber) ? `••••${settings.botPhoneNumber.slice(-4)}` : null,
        checks: { twilio: twilioReady, model: modelReady, publicUrl: publicUrlReady },
      });
    }

    if (method === "GET" && path === "/api/telephony/sms") {
      return json(res, 200, { messages: options.store.messages() });
    }

    if (method === "POST" && path === "/api/telephony/calls/outbound") {
      const body = await readBody(req) as { to?: unknown; objective?: unknown };
      if (typeof body?.to !== "string" || typeof body.objective !== "string") {
        return json(res, 400, { error: "Recipient and call objective are required." });
      }
      const result = await (options.makeCall ?? makeOutboundCall)(body.to, body.objective, config());
      return json(res, result.ok ? 200 : 502, result);
    }

    if (method === "POST" && path === "/api/telephony/sms/drafts") {
      const body = await readBody(req) as { to?: unknown; body?: unknown };
      if (typeof body?.to !== "string" || typeof body.body !== "string" || !isE164(body.to) || !body.body.trim()) {
        return json(res, 400, { error: "A valid E.164 recipient and message body are required." });
      }
      if (body.body.trim().length > 1_500) return json(res, 400, { error: "Text must be 1500 characters or fewer." });
      const draft = options.store.createSmsDraft({ to: body.to.trim(), body: body.body.trim(), from: config().botPhoneNumber });
      return json(res, 201, { draft, approvalRequired: true });
    }

    const approve = /^\/api\/telephony\/sms\/drafts\/([0-9a-f-]+)\/approve$/i.exec(path);
    if (method === "POST" && approve) {
      const body = await readBody(req) as { confirm?: unknown };
      if (body?.confirm !== true) return json(res, 400, { error: "Set confirm to true to approve this exact text." });
      const draft = options.store.claimSmsDraft(approve[1]!);
      if (!draft) return json(res, 409, { error: "This text draft is missing or has already been handled." });
      const result = await (options.sendSms ?? sendOutboundSms)(draft.to, draft.body, config());
      options.store.setStatus(draft.id, result.ok ? "sent" : "failed", {
        ...(result.messageSid ? { providerId: result.messageSid } : {}),
        ...(!result.ok && result.error ? { error: result.error } : {}),
      });
      return json(res, result.ok ? 200 : 502, result);
    }

    const cancel = /^\/api\/telephony\/sms\/drafts\/([0-9a-f-]+)\/cancel$/i.exec(path);
    if (method === "POST" && cancel) {
      const draft = options.store.find(cancel[1]!);
      if (!draft || draft.direction !== "outbound" || draft.status !== "draft") {
        return json(res, 409, { error: "This text draft is missing or has already been handled." });
      }
      options.store.setStatus(draft.id, "cancelled");
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/api/telephony/sms/outbound") {
      const body = await readBody(req) as { draftId?: unknown; confirm?: unknown };
      if (typeof body?.draftId !== "string") return json(res, 400, { error: "Approve a saved draft by draftId." });
      if (body.confirm !== true) return json(res, 400, { error: "Set confirm to true to approve this exact text." });
      const draft = options.store.claimSmsDraft(body.draftId);
      if (!draft) return json(res, 409, { error: "This text draft is missing or has already been handled." });
      const result = await (options.sendSms ?? sendOutboundSms)(draft.to, draft.body, config());
      options.store.setStatus(draft.id, result.ok ? "sent" : "failed", {
        ...(result.messageSid ? { providerId: result.messageSid } : {}),
        ...(!result.ok && result.error ? { error: result.error } : {}),
      });
      return json(res, result.ok ? 200 : 502, result);
    }

    return PASS;
  };
}
