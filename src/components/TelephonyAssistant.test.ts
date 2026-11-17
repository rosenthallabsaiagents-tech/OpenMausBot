import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hasPhoneAccess, TelephonyAssistant } from "./TelephonyAssistant";

describe("the phone assistant panel", () => {
  it("admits owners and phone-scoped sessions, but not ordinary client sessions", () => {
    expect(hasPhoneAccess({ kind: "loopback" })).toBe(true);
    expect(hasPhoneAccess({ kind: "loopback", trust: "service" })).toBe(false);
    expect(hasPhoneAccess({ kind: "session", id: "a", label: "Owner", scopes: ["admin"], expiresAt: 1 })).toBe(true);
    expect(hasPhoneAccess({ kind: "session", id: "p", label: "Phone", scopes: ["client", "phone"], expiresAt: 1 })).toBe(true);
    expect(hasPhoneAccess({ kind: "session", id: "c", label: "Client", scopes: ["client"], expiresAt: 1 })).toBe(false);
    expect(hasPhoneAccess(null)).toBe(false);
  });

  it("renders an accessible loading state before the session check", () => {
    const markup = renderToStaticMarkup(createElement(TelephonyAssistant));
    expect(markup).toContain("Phone assistant");
    expect(markup).toContain("Checking phone access");
  });
});
