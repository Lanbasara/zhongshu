const status = document.querySelector('#status');
const version = document.querySelector('#version');
const revision = document.querySelector('#revision');
const dot = document.querySelector('#dot');
const refresh = document.querySelector('#refresh');

async function check() {
  refresh.disabled = true;
  status.textContent = '正在连接服务…';
  dot.dataset.state = 'loading';
  try {
    const response = await fetch('/api/version', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Service unavailable');
    const data = await response.json();
    if (data.name !== 'zhongshu' || typeof data.version !== 'string' || data.version.length > 64 ||
        (data.revision !== 'development' && !/^[a-f0-9]{40}$/.test(data.revision))) {
      throw new Error('Invalid version response');
    }
    version.textContent = data.version;
    revision.textContent = data.revision;
    status.textContent = '前后端已连通';
    dot.dataset.state = 'ready';
  } catch {
    status.textContent = '暂时无法连接，请稍后重试';
    version.textContent = '—';
    revision.textContent = '—';
    dot.dataset.state = 'error';
  } finally {
    refresh.disabled = false;
  }
}
refresh.addEventListener('click', check);
check();
