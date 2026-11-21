const $ = selector => document.querySelector(selector);
const roles = ['chad', 'rick', 'june'];

export class FishVoices {
  constructor(notify, admin) {
    this.notify = notify;
    this.admin = admin;
    this.config = {configured: false, enabled: false};
    this.audio = new Audio();
    this.bind();
    this.ready = this.refresh();
  }

  async refresh() {
    try {
      const response = await fetch('/api/fish/status');
      if (!response.ok) throw new Error();
      this.config = await response.json();
    } catch { this.config = {configured: false, enabled: false}; }
  }

  async request(route, data = {}, signal) {
    const response = await fetch('/api/fish/' + route, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data), signal,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || '无法连接 Fish Audio。');
    }
    return response;
  }

  async open() {
    await this.admin.open(async () => {
      await this.refresh();
      $('#fish-key').value = '';
      $('#fish-key').placeholder = this.config.configured ? '留空保留现有 Key' : '输入 Fish Audio API Key';
      $('#fish-model').value = this.config.model || 's2.1-pro';
      for (const who of roles) $('#fish-' + who).value = this.config.voices?.[who] || '';
      $('#fish-feedback').textContent = this.config.enabled ? 'Fish Audio 已启用。' : '请填写 Fish Audio Key。';
      $('#fish-dialog').showModal();
    });
  }

  async save() {
    const key = $('#fish-key');
    const data = {
      apiKey: key.value, model: $('#fish-model').value, enabled: true, speed: 1.12,
      voices: Object.fromEntries(roles.map(who => [who, $('#fish-' + who).value])),
    };
    key.value = '';
    this.config = await (await this.request('config', data)).json();
    key.placeholder = '留空保留现有 Key';
    $('#fish-feedback').textContent = '配音设置已保存。';
  }

  async speak(turn, signal) {
    const response = await this.request('speech', {who: turn.who, text: turn.text, emotion: turn.emotion}, signal);
    return URL.createObjectURL(await response.blob());
  }

  bind() {
    const dialog = $('#fish-dialog');
    const feedback = $('#fish-feedback');
    const act = (button, action) => button.addEventListener('click', async () => {
      button.disabled = true;
      feedback.textContent = '';
      try { await action(); }
      catch (error) { feedback.textContent = error.message; }
      finally { button.disabled = false; }
    });
    $('#fish-settings').addEventListener('click', () => this.open());
    for (const button of ['#fish-close', '#fish-done']) $(button).addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      this.audio.pause();
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = null;
      $('#fish-key').value = '';
    });
    act($('#fish-save'), () => this.save());
    for (const button of document.querySelectorAll('[data-voice-preview]')) {
      act(button, async () => {
        this.audio.pause();
        await this.save();
        feedback.textContent = '正在生成试听…';
        const who = button.dataset.voicePreview;
        const url = await this.speak({who, emotion: who === 'june' ? 'amused' : 'annoyed'});
        if (dialog.open) { this.play(url); feedback.textContent = '正在播放试听。'; }
        else URL.revokeObjectURL(url);
      });
    }
    act($('#fish-forget'), async () => {
      this.audio.pause();
      this.config = await (await this.request('disconnect')).json();
      $('#fish-key').placeholder = '输入 Fish Audio API Key';
      feedback.textContent = 'Fish Audio Key 已清除。';
    });
  }

  play(url) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = url;
    this.audio.src = url;
    this.audio.play().catch(() => this.notify('请点击试听按钮播放。'));
    this.audio.onended = () => {
      URL.revokeObjectURL(url);
      if (this.url === url) this.url = null;
    };
  }
}
