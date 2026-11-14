// 和 Worker 的 API 溝通。示範模式走 /demo/api，真實帳本走 /api，其餘完全相同。

const KEY_MODE = 'stockbot.mode';
const KEY_TOKEN = 'stockbot.token';

function read(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function write(store, key, value) {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    /* 存不了就只留在這次瀏覽 */
  }
}

let mode = new URLSearchParams(location.search).has('demo') ? 'demo' : read(localStorage, KEY_MODE) === 'demo' ? 'demo' : 'real';
export const getMode = () => mode;
export function setMode(m) {
  mode = m;
  write(localStorage, KEY_MODE, m);
}

/** 還沒設定 Cloudflare Access 的時候，可以暫時用管理金鑰（只留在這個分頁）。 */
export const setToken = (t) => write(sessionStorage, KEY_TOKEN, t || null);

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data ?? {};
  }
}

async function call(method, path, body) {
  const headers = {};
  const token = read(sessionStorage, KEY_TOKEN);
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch((mode === 'demo' ? '/demo/api' : '/api') + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, '連不上伺服器。請確認網路後再試一次。');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 不是 JSON */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error && data.error !== 'unauthorized' ? data.error : res.status === 401 ? '需要登入' : `伺服器回應 ${res.status}`, data);
  return data;
}

/** 下載一個檔案（例如匯出的 md）：帶著同樣的登入方式取回內容，再交給瀏覽器存檔。 */
async function download(path, filename) {
  const headers = {};
  const token = read(sessionStorage, KEY_TOKEN);
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch((mode === 'demo' ? '/demo/api' : '/api') + path, { headers, cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `伺服器回應 ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* 不是 JSON */
    }
    throw new ApiError(res.status, msg);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const api = {
  get: (path) => call('GET', path),
  post: (path, body = {}) => call('POST', path, body),
  download,
};
