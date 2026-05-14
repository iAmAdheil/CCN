// Tiny auth client. Talks to the backend's /auth/* routes and persists the
// session JWT in localStorage so reloads stay signed in until expiry.

const STORAGE_KEY = "vc:auth-session-v1";

export interface AuthSession {
  token: string;
  email: string;
  expiresAt: number; // ms epoch
}

function backendBase(): string {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  return env?.VITE_SIGNAL_URL ?? `http://${window.location.hostname}:3000`;
}

export function loadSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.email !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    if (parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed as AuthSession;
  } catch {
    return null;
  }
}

export function saveSession(session: AuthSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export async function requestMagicLink(email: string): Promise<{ ok: true; previewUrl?: string } | { ok: false; error: string }> {
  try {
    const resp = await fetch(`${backendBase()}/auth/request-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      return { ok: false, error: data?.error ?? `HTTP ${resp.status}` };
    }
    return { ok: true, previewUrl: data.previewUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "request failed" };
  }
}

export async function redeemMagicToken(token: string): Promise<AuthSession | { error: string }> {
  try {
    const resp = await fetch(`${backendBase()}/auth/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      return { error: data?.error ?? `HTTP ${resp.status}` };
    }
    return {
      token: data.token,
      email: data.email,
      expiresAt: Date.now() + (data.expSeconds ?? 86_400) * 1000,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "redeem failed" };
  }
}

// Strip ?magic=... from the URL and return whatever was there. Returns null
// if no magic param was present.
export function consumeMagicParamFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("magic");
    if (!token) return null;
    url.searchParams.delete("magic");
    window.history.replaceState({}, "", url.toString());
    return token;
  } catch {
    return null;
  }
}
