let token = localStorage.getItem('admin_token') ?? '';

export function hasToken() {
  return Boolean(token);
}

export function setAdminToken(value: string) {
  token = value;
  localStorage.setItem('admin_token', value);
}

export async function adminRoomWsUrl(roomId: string): Promise<string> {
  const { ticket } = await request<{ ticket: string; expiresIn: number }>(
    `/api/admin/rooms/${roomId}/observer-ticket`,
    { method: 'POST', body: '{}' },
  );
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/admin/rooms/${roomId}/ws?ticket=${encodeURIComponent(ticket)}`;
}

export function logout() {
  token = '';
  localStorage.removeItem('admin_token');
  localStorage.removeItem('admin_profile');
  location.reload();
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (res.status === 401) {
    logout();
    throw new Error('UNAUTHORIZED');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const fallbackMessage =
      body.error === 'VALIDATION'
        ? '提交内容格式不正确，请检查后重试'
        : body.error ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(body.message ?? fallbackMessage), {
      code: body.error,
      details: body.details,
      issues: body.issues,
      roomId: body.roomId,
    });
  }
  return res.json();
}

export function rm(cents: string | number | bigint): string {
  const value = BigInt(cents);
  const sign = value < 0n ? '-' : '';
  const amount = value < 0n ? -value : value;
  return `${sign}${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

export function post<T>(path: string, body: unknown) {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function patch<T>(path: string, body: unknown) {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function uploadAdminFile<T>(path: string, file: File, field = 'file'): Promise<T> {
  const body = new FormData();
  body.append(field, file);
  const res = await fetch(path, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  });
  if (res.status === 401) {
    logout();
    throw new Error('UNAUTHORIZED');
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const messages: Record<string, string> = {
      FILE_REQUIRED: '请选择要上传的图片',
      UNSUPPORTED_FILE_TYPE: '仅支持 JPG、PNG 或 WEBP',
      FILE_CONTENT_MISMATCH: '图片文件已损坏或类型不正确',
      FILE_TOO_LARGE: '图片不能超过 5MB',
    };
    throw new Error(
      payload.message
        ?? messages[payload.error as string]
        ?? payload.error
        ?? `HTTP ${res.status}`,
    );
  }
  return res.json();
}

export function put<T>(path: string, body: unknown) {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}

export function del<T>(path: string) {
  return request<T>(path, { method: 'DELETE' });
}

export async function openProtectedUpload(reference: string) {
  const filename = reference.match(
    /(?:upload:\/\/|\/uploads\/)([0-9a-f-]{36}\.(?:jpg|png|webp|pdf))$/,
  )?.[1];
  if (!filename) throw new Error('INVALID_UPLOAD_REFERENCE');
  const popup = window.open('', '_blank');
  if (popup) popup.opener = null;
  const res = await fetch(`/api/admin/uploads/${encodeURIComponent(filename)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    popup?.close();
    throw new Error(res.status === 404 ? 'UPLOAD_NOT_FOUND' : `HTTP ${res.status}`);
  }
  const objectUrl = URL.createObjectURL(await res.blob());
  if (popup) popup.location.href = objectUrl;
  else window.open(objectUrl, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/** 下载需 Authorization 的文件（如流水 CSV） */
export async function downloadAuthorized(path: string, filename: string) {
  const res = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    logout();
    throw new Error('UNAUTHORIZED');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
