const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || '').trim();

function buildUrl(path) {
  return `${API_BASE_URL}${path}`;
}

export async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const hasBody = options.body !== undefined && options.body !== null;

  if (hasBody && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(buildUrl(path), {
    ...options,
    headers
  });

  const contentType = response.headers.get('content-type') || '';
  let payload;

  if (contentType.includes('application/json')) {
    payload = await response.json();
  } else {
    const text = await response.text();
    payload = text ? { message: text } : {};
  }

  if (!response.ok) {
    throw new Error(String(payload?.message || `请求失败(${response.status})`));
  }

  return payload;
}

export function getSuccessMessage(responseJson, fallbackMessage) {
  const message = String(responseJson?.message || '').trim();
  return message || fallbackMessage;
}
