export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { body });
  return body as T;
}
export const post = <T,>(url: string, data: unknown) => api<T>(url, { method: "POST", body: JSON.stringify(data) });
