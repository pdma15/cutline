/* Replace window.engine with the real engine using the same methods.
   All AI data and export progress below are explicitly simulated. */
(() => {
  const words = ['Every', 'great', 'adventure', 'begins', 'with', 'one', 'small', 'step.'];
  window.engine = {
    async probeMedia(path) { return { path, duration: 8, codec: 'demo', width: 1920, height: 1080, fps: 30, audioChannels: 2 }; },
    async getThumbnails(mediaId, count) { return Array.from({ length: count }, (_, i) => ({ mediaId, time: i * 2, colour: '#64847a' })); },
    async getWaveform() { return [0.2, 0.6, 0.4, 0.8, 0.5, 0.3, 0.7, 0.4]; },
    async makeProxy() { return null; },
    async getFrameAt(project, time) { return { demo: true, colour: time < 8 ? '#7f9fa4' : '#b5ad8f' }; },
    async getAudio() { return { demo: true, samples: [] }; },
    async transcribe(mediaId) { return words.map((text, i) => ({ text, start: i * 0.7, end: (i + 1) * 0.7, speaker: 'Demo narrator', mediaId })); },
    async searchFootage(query) { return query ? [{ mediaId: 'm1', time: 0, label: 'Demo: mountain opening' }] : []; },
    async analyse() { return { demo: true, hookScore: 82, flags: [{ time: 12, label: 'Try a closer shot here' }] }; },
    async exportProject(project, preset, onProgress) {
      for (let progress = 0; progress <= 100; progress += 10) {
        onProgress(progress);
        await new Promise(resolve => setTimeout(resolve, 70));
      }
      return { demo: true, message: 'Export request only; no video rendered.', preset, project };
    }
  };
})();
