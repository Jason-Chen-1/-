const recognitionSampleRate = 16000;

class RecognitionPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new ArrayBuffer(Math.round(recognitionSampleRate * 0.032) * 2);
    this.pcm = new DataView(this.buffer);
    this.offset = 0;
    this.sampleWeight = 0;
    this.weightedSample = 0;
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') {
        this.send();
        this.finished = true;
        this.port.postMessage('flushed');
      }
    };
  }

  send() {
    if (!this.offset) return;
    const data = this.buffer.slice(0, this.offset);
    this.port.postMessage(data, [data]);
    this.offset = 0;
  }

  process(inputs) {
    if (this.finished) return false;
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (const value of samples) {
      let remaining = recognitionSampleRate;
      while (remaining > 0) {
        const weight = Math.min(remaining, sampleRate - this.sampleWeight);
        this.sampleWeight += weight;
        this.weightedSample += value * weight;
        remaining -= weight;
        if (this.sampleWeight !== sampleRate) continue;
        const sample = this.weightedSample / sampleRate;
        this.pcm.setInt16(this.offset, Math.max(-1, Math.min(1, sample)) * 32767, true);
        this.offset += 2;
        this.sampleWeight = 0;
        this.weightedSample = 0;
        if (this.offset === this.pcm.byteLength) this.send();
      }
    }
    return true;
  }
}

registerProcessor('recognition-pcm', RecognitionPCM);
