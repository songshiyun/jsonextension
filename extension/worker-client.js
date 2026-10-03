export class JSONWorker {
  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.nextId = 0;
    this.pending = new Map();
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data.result);
      else pending.reject(Object.assign(new Error(data.error.message), data.error));
    };
    this.worker.onerror = () => {
      for (const entry of this.pending.values()) entry.reject(new Error('JSON 解析器启动失败，请重新加载扩展。'));
      this.pending.clear();
    };
  }
  run(type, source, content) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, source, content });
    });
  }
  close() { this.worker.terminate(); this.pending.clear(); }
}
