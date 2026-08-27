import { useEffect, useId, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
          theme?: "auto" | "light" | "dark";
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src*="challenges.cloudflare.com/turnstile"]',
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("Turnstile failed to load")),
      );
      if (window.turnstile) resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Turnstile failed to load"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Cloudflare Turnstile widget. When siteKey is empty, renders nothing
 * (server also skips verification without TURNSTILE_SECRET_KEY).
 */
export function TurnstileWidget({
  siteKey,
  onToken,
  resetKey = 0,
}: {
  siteKey: string | null | undefined;
  onToken: (token: string | null) => void;
  /** Increment to force a fresh challenge after a failed submit. */
  resetKey?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const reactId = useId();

  useEffect(() => {
    if (!siteKey) {
      onToken(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await loadTurnstileScript();
        if (cancelled || !hostRef.current || !window.turnstile) return;
        if (widgetId.current) {
          try {
            window.turnstile.remove(widgetId.current);
          } catch {
            /* ignore */
          }
        }
        hostRef.current.innerHTML = "";
        widgetId.current = window.turnstile.render(hostRef.current, {
          sitekey: siteKey,
          callback: (token) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
          theme: "auto",
        });
      } catch {
        onToken(null);
      }
    })();
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetId.current);
        } catch {
          /* ignore */
        }
        widgetId.current = null;
      }
    };
  }, [siteKey, onToken, reactId, resetKey]);

  if (!siteKey) return null;
  return (
    <div
      className="turnstile-wrap"
      ref={hostRef}
      data-testid="turnstile"
      style={{ display: "flex", justifyContent: "center", marginBlock: "0.75rem" }}
    />
  );
}
