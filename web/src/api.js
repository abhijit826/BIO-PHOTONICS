const BASE = (import.meta.env.VITE_API_URL || 'http://localhost:4000/api').replace(/\/$/, '');
export async function request(path, { token, ...options } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options?.headers } });
  } catch { throw new Error('Could not reach TaskFlow. Check your network and API URL.'); }
  if (response.status === 401 && token) { localStorage.removeItem('taskflow-token'); window.dispatchEvent(new Event('taskflow:expired')); }
  if (!response.ok) { let body = {}; try { body = await response.json(); } catch { } throw new Error(body.error || `Request failed (${response.status})`); }
  return response.status === 204 ? null : response.json();
}
