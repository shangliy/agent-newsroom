// Visibility is a browser measurement, not proof against a malicious client.
// Keep it separate from rendered allocations and from reward-bearing actions.
export class ExposureTracker {
  constructor({ onImpression, onDwell, onError = console.error,
    setTimer = setTimeout, clearTimer = clearTimeout, active = true, retryDelayMs = 1000, maxRetries = 2,
    createObserver = callback => new IntersectionObserver(callback, { threshold: Array.from({ length: 101 }, (_, i) => i / 100) }) }) {
    Object.assign(this, { onImpression, onDwell, onError, setTimer, clearTimer, active, retryDelayMs, maxRetries });
    this.entries = new Map();
    this.observer = createObserver(entries => {
      for (const entry of entries) {
        const state = this.entries.get(entry.target); if (!state) continue;
        state.visible = entry.isIntersecting && entry.intersectionRect.height >= Math.min(160, entry.boundingClientRect.height / 2);
        this.sync(state);
      }
    });
  }
  watch(card) {
    this.entries.set(card.el, { card, visible: false, timer: null, exposed: false, dwelled: false, pending: null, dwellPending: false, retryTimer: null, impressionFailures: 0, dwellFailures: 0 });
    this.observer.observe(card.el);
  }
  isVisible(card) { return this.active && !!this.entries.get(card.el)?.visible; }
  ensure(card) {
    const state = this.entries.get(card.el);
    if (!state) return Promise.reject(new Error('卡片已卸载'));
    if (state.exposed) return Promise.resolve();
    if (!state.pending) {
      state.pending = Promise.resolve().then(() => this.onImpression(card)).then(() => { state.exposed = true; })
        .finally(() => { state.pending = null; });
    }
    return state.pending;
  }
  sync(state) {
    if (!this.active || !state.visible) {
      if (state.timer !== null) this.clearTimer(state.timer);
      if (state.retryTimer !== null) this.clearTimer(state.retryTimer);
      state.timer = null; state.retryTimer = null; return;
    }
    if (state.dwelled || state.dwellPending || state.timer !== null || state.retryTimer !== null) return;
    this.ensure(state.card).then(() => {
      if (this.entries.get(state.card.el) !== state || !this.active || !state.visible || state.timer !== null || state.dwelled) return;
      state.timer = this.setTimer(() => {
        state.timer = null;
        if (!this.active || !state.visible) return;
        state.dwellPending = true;
        Promise.resolve().then(() => this.onDwell(state.card))
          .then(() => { state.dwelled = true; })
          .catch(error => this.retry(state, 'dwellFailures', error))
          .finally(() => { state.dwellPending = false; });
      }, 8000);
    }).catch(error => this.retry(state, 'impressionFailures', error));
  }
  retry(state, field, error) {
    this.onError(error); state[field]++;
    if (state[field] > this.maxRetries || this.entries.get(state.card.el) !== state || !this.active || !state.visible || state.retryTimer !== null) return;
    state.retryTimer = this.setTimer(() => { state.retryTimer = null; this.sync(state); }, this.retryDelayMs);
  }
  setActive(active) { this.active = active; for (const state of this.entries.values()) this.sync(state); }
  dispose(card) {
    const state = this.entries.get(card.el);
    if (state?.timer !== null && state?.timer !== undefined) this.clearTimer(state.timer);
    if (state?.retryTimer !== null && state?.retryTimer !== undefined) this.clearTimer(state.retryTimer);
    this.observer.unobserve(card.el); this.entries.delete(card.el);
  }
  disconnect() {
    for (const state of [...this.entries.values()]) this.dispose(state.card);
    this.observer.disconnect();
  }
}
