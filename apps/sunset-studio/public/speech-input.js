const permanentErrors = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']);

function appendTranscript(left, right) {
  const separator = /[a-z0-9]$/i.test(left) && /^[a-z0-9]/i.test(right) ? ' ' : '';
  return left + separator + right;
}

// A browser recognition session can end without the user finishing their brief.
export class SpeechInput {
  constructor({
    Recognition, onText = () => {}, onState = () => {}, onSubmit = () => {}, onError = () => {},
    schedule = (callback, delay) => setTimeout(callback, delay),
    unschedule = timer => clearTimeout(timer), restartDelay = 160, stopTimeout = 2000,
  }) {
    Object.assign(this, {Recognition, onText, onState, onSubmit, onError, schedule, unschedule, restartDelay, stopTimeout});
    this.active = false;
  }

  start(draft = '') {
    if (this.active) return;
    this.active = true;
    this.stopping = false;
    this.committed = draft;
    this.parts = [];
    this.failures = 0;
    this.onState(true, 'starting');
    this.open();
  }

  value() {
    return this.parts.reduce(appendTranscript, this.committed).trim();
  }

  open() {
    if (!this.active || this.stopping) return;
    try {
      const recognition = new this.Recognition();
      this.recognition = recognition;
      recognition.lang = 'zh-CN';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => {
        if (this.recognition === recognition && !this.stopping) this.onState(true, 'listening');
      };
      recognition.onresult = event => {
        if (this.recognition !== recognition) return;
        this.parts.length = event.results.length;
        for (let index = event.resultIndex; index < event.results.length; index++) {
          this.parts[index] = event.results[index][0].transcript;
        }
        this.failures = 0;
        this.onText(this.value());
      };
      recognition.onerror = ({error}) => {
        if (this.recognition !== recognition || this.stopping) return;
        if (permanentErrors.has(error)) {
          this.fail(error);
        } else if (error !== 'no-speech' && error !== 'aborted') {
          this.failures++;
          if (this.failures >= 4) this.fail(error);
        }
      };
      recognition.onend = () => {
        if (this.recognition !== recognition) return;
        this.detach();
        if (this.stopping) this.finish(true);
        else this.reconnect();
      };
      recognition.start();
    } catch (error) {
      this.detach();
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
        this.fail('not-allowed');
        return;
      }
      this.failures++;
      if (this.failures >= 4) this.fail('start-failed');
      else this.reconnect();
    }
  }

  reconnect() {
    this.committed = this.value();
    this.parts = [];
    this.onText(this.committed);
    this.onState(true, 'reconnecting');
    this.restartTimer = this.schedule(() => this.open(), this.restartDelay * 2 ** this.failures);
  }

  stop() {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    this.unschedule(this.restartTimer);
    if (!this.recognition) {
      this.finish(true);
      return;
    }
    this.onState(true, 'finishing');
    this.stopTimer = this.schedule(() => this.finish(true), this.stopTimeout);
    try {
      this.recognition.stop();
    } catch {
      this.finish(true);
    }
  }

  cancel() {
    if (this.active) this.finish(false);
  }

  fail(error) {
    this.finish(false);
    this.onError(error);
  }

  detach() {
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
    }
    return recognition;
  }

  finish(submit) {
    if (!this.active) return;
    const text = this.value();
    this.active = false;
    this.unschedule(this.restartTimer);
    this.unschedule(this.stopTimer);
    const recognition = this.detach();
    try { recognition?.abort(); } catch {}
    this.onState(false, 'idle');
    if (submit && text) this.onSubmit(text);
  }
}
