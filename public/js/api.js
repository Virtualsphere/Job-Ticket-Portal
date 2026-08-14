const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('jtp_token');
}
function getUser() {
  const raw = localStorage.getItem('jtp_user');
  return raw ? JSON.parse(raw) : null;
}
function setSession(token, user) {
  localStorage.setItem('jtp_token', token);
  localStorage.setItem('jtp_user', JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem('jtp_token');
  localStorage.removeItem('jtp_user');
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }

  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

// Multipart upload (file attachments) — needs the auth header but no JSON content-type.
async function apiUpload(path, formData) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(API_BASE + path, { method: 'POST', headers, body: formData });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `Upload failed (${res.status})`);
  return data;
}

// Download a protected file (needs the auth header, so a plain <a href> won't work).
async function apiDownload(path, filename) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(API_BASE + path, { headers });
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    throw new Error((data && data.error) || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
