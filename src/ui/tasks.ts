import { api, connectService, ensureService } from '../execution/browser/client';
import { terminalStatuses, type TaskInfo } from '../contracts/tasks';

const labels: Record<string, string> = { queued: '排队中', running: '计算中', completed: '完成', failed: '失败', cancelled: '已取消', interrupted: '服务重启中断' };
let busy = false;

export async function refreshTasks() {
  if (busy) return;
  busy = true;
  const status = document.getElementById('serverStatus')!;
  try {
    await ensureService();
    const tasks = await api<TaskInfo[]>('/tasks');
    status.textContent = '服务器计算 · 关闭页面不取消已提交任务 · 单点内部进度暂不估算';
    const list = document.getElementById('serverTaskList')!;
    list.replaceChildren();
    for (const task of tasks) {
      const row = document.createElement('div');
      row.className = 'server-task'; row.dataset.taskId = task.id;
      const text = document.createElement('span');
      text.textContent = `${task.label} · ${labels[task.status]} · ${task.completed}/${task.total} · ${task.id.slice(0, 8)}${task.error ? ' · ' + task.error : ''}`;
      row.appendChild(text);
      if (task.completed > 0) {
        const download = document.createElement('a');
        download.href = `/api/tasks/${task.id}/download`; download.textContent = '下载输入与结果'; download.className = 'btn btn-sm';
        row.appendChild(download);
      }
      const button = document.createElement('button');
      button.className = 'btn btn-sm';
      const done = terminalStatuses.includes(task.status);
      button.textContent = done ? '删除记录' : '取消计算';
      button.onclick = async () => {
        button.disabled = true;
        try { await api(`/tasks/${task.id}${done ? '' : '/cancel'}`, { method: done ? 'DELETE' : 'POST' }); }
        catch (error) { status.textContent = String(error); }
        finally { await refreshTasks(); }
      };
      row.appendChild(button); list.appendChild(row);
    }
    if (!tasks.length) list.textContent = '暂无任务。任务和结果保留时间由服务器配置（默认 24 小时）。';
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  finally { busy = false; }
}

export function initTasks() {
  document.getElementById('serverConnect')!.onclick = async () => {
    const input = document.getElementById('serverAccessKey') as HTMLInputElement;
    try { await connectService(input.value); input.value = ''; await refreshTasks(); }
    catch (error) { document.getElementById('serverStatus')!.textContent = String(error); }
  };
  document.getElementById('serverRefresh')!.onclick = () => { void refreshTasks(); };
  window.addEventListener('simulation-task', () => { void refreshTasks(); });
  const timer = setInterval(() => { if (!document.hidden) void refreshTasks(); }, 3000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  void refreshTasks();
}
