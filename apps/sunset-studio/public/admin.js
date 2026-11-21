const $ = selector => document.querySelector(selector);

async function adminRequest(path, data) {
  const response = await fetch('/api/admin/' + path, data === undefined ? undefined : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '管理员验证暂时不可用。');
  return result;
}

export class AdminSettings {
  constructor(notify) {
    this.notify = notify;
    this.dialog = $('#admin-dialog');
    this.key = $('#admin-key');
    this.submit = $('#admin-unlock');
    this.feedback = $('#admin-feedback');
    this.lock = $('#lock-settings');
    $('#admin-close').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => { this.key.value = ''; });
    $('#admin-form').addEventListener('submit', event => this.unlock(event));
    this.lock.addEventListener('click', async () => {
      try {
        await adminRequest('lock', {});
        this.lock.hidden = true;
        this.notify('API 设置已锁定。');
      } catch (error) { this.notify(error.message); }
    });
  }

  async open(showSettings) {
    this.afterUnlock = showSettings;
    try {
      const status = await adminRequest('status');
      this.lock.hidden = !status.unlocked;
      if (status.unlocked) { await showSettings(); return; }
      this.submit.disabled = !status.available;
      this.feedback.textContent = status.available ? '' : '管理员验证暂时不可用。';
    } catch (error) {
      this.submit.disabled = true;
      this.feedback.textContent = error.message;
    }
    if (!this.dialog.open) this.dialog.showModal();
    this.key.focus();
  }

  async unlock(event) {
    event.preventDefault();
    const key = this.key.value;
    this.key.value = '';
    this.submit.disabled = true;
    this.feedback.textContent = '';
    try {
      await adminRequest('unlock', {key});
      this.lock.hidden = false;
      if (this.dialog.open) {
        this.dialog.close();
        await this.afterUnlock();
      }
    } catch (error) {
      if (this.dialog.open) {
        this.feedback.textContent = error.message;
        this.key.focus();
      } else this.notify(error.message);
    } finally { this.submit.disabled = false; }
  }
}
