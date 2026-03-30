export function formatDateTimeZhCN(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function encodeTitleName(titleName) {
  return encodeURIComponent(String(titleName || '').trim());
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
