export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : data?.error?.message || `The request failed (${response.status}). Please try again.`);
  if (!data) throw new Error('The server returned an empty response. Please try again.');
  return data as T;
}
export function upload<T>(path: string, field: string, file: File, onProgress?: (percent: number) => void): { promise: Promise<T>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', path); xhr.responseType = 'json'; xhr.timeout = 180000;
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response as T) : reject(new Error(xhr.response?.error?.message || xhr.response?.error || 'Upload failed. Check your file and try again.'));
    xhr.onerror = () => reject(new Error('Connection lost. Please try uploading again.'));
    xhr.ontimeout = () => reject(new Error('The upload took too long. Please try a smaller file.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    const form = new FormData(); form.append(field, file); xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
