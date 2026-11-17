import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "@/state/api";
import { isOwnerOrAdmin, readSessionState, type SessionState } from "@/lib/session";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";
import { ServerPairingCard } from "./ServerPairingCard";

interface PhoneMessage {
  id: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  body: string;
  receivedAt: number;
  status: string;
}

interface PhoneStatus {
  ready: boolean;
  phoneNumber: string | null;
  checks: { twilio: boolean; model: boolean; publicUrl: boolean };
}

export function hasPhoneAccess(session: SessionState | null): boolean {
  if (session?.kind === "loopback") return session.trust !== "service";
  return session?.kind === "session" && (session.scopes.includes("admin") || session.scopes.includes("phone"));
}

const fieldClass = "min-h-11 w-full min-w-0 rounded-lg border border-hairline/60 bg-inset px-3 py-2 text-base text-ink outline-none placeholder:text-ink-tertiary focus:border-accent sm:text-[14px]";
const buttonClass = "ui-button pointer-coarse:min-h-11";

export function TelephonyAssistant({ simple = false, allowPairing = false }: { simple?: boolean; allowPairing?: boolean }) {
  const [session, setSession] = useState<SessionState | null>(null);
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [messages, setMessages] = useState<PhoneMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [smsTo, setSmsTo] = useState("");
  const [smsBody, setSmsBody] = useState("");
  const [callTo, setCallTo] = useState("");
  const [callObjective, setCallObjective] = useState("");
  const [reviewCall, setReviewCall] = useState(false);

  const refresh = useCallback(async (background = false) => {
    setError(null);
    try {
      const [nextStatus, nextMessages] = await Promise.all([
        api<PhoneStatus>("/api/telephony/status", { background }),
        api<{ messages: PhoneMessage[] }>("/api/telephony/sms", { background }),
      ]);
      setStatus(nextStatus);
      setMessages(Array.isArray(nextMessages.messages) ? nextMessages.messages : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    void readSessionState().then((next) => {
      if (!current) return;
      setSession(next);
      if (hasPhoneAccess(next)) void refresh();
      else setLoading(false);
    });
    return () => { current = false; };
  }, [refresh]);

  useEffect(() => {
    if (!hasPhoneAccess(session)) return;
    const timer = setInterval(() => void refresh(true), 20_000);
    return () => clearInterval(timer);
  }, [refresh, session]);

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("/api/telephony/sms/drafts", {
        method: "POST",
        body: JSON.stringify({ to: smsTo.trim(), body: smsBody.trim() }),
      });
      setSmsBody("");
      setNotice(t("phone.assistant.draftCreated"));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function approveDraft(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/telephony/sms/drafts/${encodeURIComponent(id)}/approve`, {
        method: "POST", body: JSON.stringify({ confirm: true }),
      });
      setNotice(t("phone.assistant.textSent"));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function cancelDraft(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/telephony/sms/drafts/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function placeCall() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ callSid?: string }>("/api/telephony/calls/outbound", {
        method: "POST", body: JSON.stringify({ to: callTo.trim(), objective: callObjective.trim() }),
      });
      setNotice(t("phone.assistant.callStarted", { id: result.callSid ?? "" }));
      setReviewCall(false);
      setCallObjective("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !session) {
    return <Card title={t("phone.assistant.title")}><p className="text-[13px] text-ink-secondary">{t("phone.assistant.loading")}</p></Card>;
  }

  if (!hasPhoneAccess(session)) {
    return (
      <Card title={t("phone.assistant.title")} subtitle={t("phone.assistant.subtitle")}>
        <p data-phone-assistant-pairing-needed className="text-[13px] leading-relaxed text-ink-secondary">{t("phone.assistant.pairingNeeded")}</p>
      </Card>
    );
  }

  const drafts = messages.filter((message) => message.direction === "outbound" && message.status === "draft");
  const history = messages.filter((message) => message.status !== "draft");
  const checkLabel = (value: boolean) => value ? t("phone.assistant.ready") : t("phone.assistant.needsSetup");

  return (
    <Card title={t("phone.assistant.title")} subtitle={t("phone.assistant.subtitle")}>
      <div className="flex flex-col gap-4">
        <section aria-label={t("phone.assistant.status")} className="rounded-xl bg-inset p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[13px] font-medium text-ink">
              {status?.ready ? t("phone.assistant.ready") : t("phone.assistant.needsSetup")}
              {status?.phoneNumber ? <span className="ml-2 text-ink-secondary">{status.phoneNumber}</span> : null}
            </div>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void refresh()}>{t("phone.assistant.refresh")}</button>
          </div>
          {status && <ul className="mt-2 grid gap-1 text-[12px] text-ink-secondary sm:grid-cols-3">
            <li>{t("phone.assistant.twilio")}: {checkLabel(status.checks.twilio)}</li>
            <li>{t("phone.assistant.model")}: {checkLabel(status.checks.model)}</li>
            <li>{t("phone.assistant.publicUrl")}: {checkLabel(status.checks.publicUrl)}</li>
          </ul>}
        </section>

        {allowPairing && isOwnerOrAdmin(session) && <ServerPairingCard phoneAssistantOnly simple={simple} />}

        <form onSubmit={(event) => void createDraft(event)} className="grid gap-3 rounded-xl border border-hairline/40 p-3">
          <h3 className="text-[14px] font-medium text-ink">{t("phone.assistant.newText")}</h3>
          <label className="grid gap-1 text-[12px] text-ink-secondary">
            {t("phone.assistant.to")}
            <input required type="tel" inputMode="tel" autoComplete="tel" placeholder="+15551234567" value={smsTo} onChange={(event) => setSmsTo(event.target.value)} className={fieldClass} />
          </label>
          <label className="grid gap-1 text-[12px] text-ink-secondary">
            {t("phone.assistant.message")}
            <textarea required maxLength={1500} rows={3} value={smsBody} onChange={(event) => setSmsBody(event.target.value)} className={fieldClass} />
          </label>
          <div><button type="submit" disabled={busy || !status?.checks.twilio} className={buttonClass}>{t("phone.assistant.saveDraft")}</button></div>
        </form>

        <form onSubmit={(event) => { event.preventDefault(); setReviewCall(true); }} className="grid gap-3 rounded-xl border border-hairline/40 p-3">
          <h3 className="text-[14px] font-medium text-ink">{t("phone.assistant.outboundCall")}</h3>
          <label className="grid gap-1 text-[12px] text-ink-secondary">
            {t("phone.assistant.to")}
            <input required type="tel" inputMode="tel" autoComplete="tel" placeholder="+15551234567" value={callTo} onChange={(event) => setCallTo(event.target.value)} className={fieldClass} />
          </label>
          <label className="grid gap-1 text-[12px] text-ink-secondary">
            {t("phone.assistant.objective")}
            <textarea required maxLength={1000} rows={2} value={callObjective} onChange={(event) => setCallObjective(event.target.value)} className={fieldClass} />
          </label>
          {reviewCall ? (
            <div role="group" aria-label={t("phone.assistant.reviewCall")} className="flex flex-wrap items-center gap-2 rounded-lg bg-inset p-3">
              <p className="min-w-0 flex-1 text-[13px] text-ink">{t("phone.assistant.confirmCall", { to: callTo, objective: callObjective })}</p>
              <button type="button" disabled={busy || !status?.checks.twilio || !status?.checks.model || !status?.checks.publicUrl} onClick={() => void placeCall()} className="ui-button ui-button-primary pointer-coarse:min-h-11">{t("phone.assistant.placeCall")}</button>
              <button type="button" disabled={busy} onClick={() => setReviewCall(false)} className={buttonClass}>{t("common.cancel")}</button>
            </div>
          ) : <div><button type="submit" disabled={busy || !status?.checks.twilio || !status?.checks.model || !status?.checks.publicUrl} className={buttonClass}>{t("phone.assistant.reviewCall")}</button></div>}
        </form>

        {drafts.length > 0 && <section aria-label={t("phone.assistant.pendingTexts")} className="grid gap-2">
          <h3 className="text-[14px] font-medium text-ink">{t("phone.assistant.pendingTexts")}</h3>
          {drafts.map((message) => <article key={message.id} className="grid gap-2 rounded-xl border border-hairline/40 p-3">
            <div className="text-[12px] text-ink-secondary">{message.to}</div>
            <p className="whitespace-pre-wrap break-words text-[14px] text-ink">{message.body}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy || !status?.checks.twilio} onClick={() => void approveDraft(message.id)} className="ui-button ui-button-primary pointer-coarse:min-h-11">{t("phone.assistant.approveSend")}</button>
              <button type="button" disabled={busy} onClick={() => void cancelDraft(message.id)} className={buttonClass}>{t("common.cancel")}</button>
            </div>
          </article>)}
        </section>}

        {notice && <p role="status" className="text-[13px] text-ink-secondary">{notice}</p>}
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}

        <section aria-label={t("phone.assistant.history")} className="grid gap-2">
          <h3 className="text-[14px] font-medium text-ink">{t("phone.assistant.history")}</h3>
          {history.length === 0 ? <p className="text-[13px] text-ink-secondary">{t("phone.assistant.noMessages")}</p> : history.slice(0, 30).map((message) => (
            <article key={message.id} className="grid gap-1 rounded-lg bg-inset px-3 py-2">
              <div className="flex flex-wrap justify-between gap-2 text-[11px] text-ink-secondary">
                <span>{t(message.direction === "inbound" ? "phone.assistant.inbound" : "phone.assistant.outbound")}: {message.direction === "inbound" ? message.from : message.to}</span>
                <time dateTime={new Date(message.receivedAt).toISOString()}>{new Date(message.receivedAt).toLocaleString()}</time>
              </div>
              <p className="whitespace-pre-wrap break-words text-[13px] text-ink">{message.body}</p>
              {message.status !== (message.direction === "inbound" ? "replied" : "sent") && <p className="text-[11px] text-ink-tertiary">{message.status}</p>}
            </article>
          ))}
        </section>
      </div>
    </Card>
  );
}
