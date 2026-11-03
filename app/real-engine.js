/* Connects the App to the real engine when it is served by the Cutline server (npm start).
   Opened as a static site with no server, this does nothing and fake-engine.js stays in place.
   Same method names and return shapes as fake-engine.js, plus uploadMedia and live: true. */
(() => {
  if (!/^https?:$/.test(location.protocol)) return;
  const post = async (url, body, raw) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw Object.assign(Error(friendly[err.code] || err.error || `Engine error ${res.status}`), { code: err.code }); }
    return raw ? res : res.json();
  };
  const call = (fn, ...args) => post('/api/call', { fn, args });
  const friendly = {
    AI_NOT_CONFIGURED: 'This AI feature isn\'t set up on this computer yet. See "AI setup" in the Cutline README.',
    AI_REFUSED: 'The AI declined this request. Try different footage or wording.'
  };
  const real = {
    live: true,
    async uploadMedia(id, file) {
      const res = await fetch(`/api/media/${encodeURIComponent(id)}?name=${encodeURIComponent(file.name)}`, { method: 'PUT', body: file });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw Error(err.error || `Upload failed (${res.status})`); }
      return res.json();
    },
    async probeMedia(path) { return { path, note: 'Use uploadMedia(id, file); the engine probes files when they are imported.' }; },
    getThumbnails: (mediaId, count) => call('getThumbnails', mediaId, count),
    getWaveform: mediaId => call('getWaveform', mediaId),
    makeProxy: mediaId => call('makeProxy', mediaId),
    async getFrameAt(project, time, width = 960) {
      const res = await post('/api/frame', { project, time, width }, true);
      return { blob: await res.blob(), missing: (res.headers.get('X-Missing-Media') || '').split(',').filter(Boolean) };
    },
    async getAudio(project, from, to) {
      const res = await post('/api/audio', { project, from, to }, true);
      return { sampleRate: +res.headers.get('X-Sample-Rate'), channels: 2, samples: new Float32Array(await res.arrayBuffer()) };
    },
    transcribe: mediaId => call('transcribe', mediaId),
    searchFootage: (query, options) => call('searchFootage', query, options),
    analyse: project => call('analyse', project),
    async exportProject(project, preset, onProgress) {
      const { job } = await post('/api/export', { project, preset });
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 400));
        const status = await (await fetch(`/api/export/${job}`)).json();
        onProgress(status.progress);
        if (status.error) throw Error(status.error);
        if (status.done) return { demo: false, url: status.url, name: status.name, preset };
      }
    }
  };
  fetch('/api/health').then(r => r.ok ? r.json() : null).then(health => {
    if (!health?.engine) return;
    window.engine = real;
    document.body.classList.add('engine-live');
    const text = (selector, value) => { const el = document.querySelector(selector); if (el) el.textContent = value; };
    text('.intro-footnote', 'Connected to the Cutline engine · previews, analysis and MP4 export are real.');
    text('.engine-note', '');
    document.querySelector('.engine-note')?.insertAdjacentHTML('beforeend', '<span class="dot"></span> Engine connected <p>Imports are copied to this computer\'s Cutline workspace so the engine can render them. Nothing is uploaded to the internet.</p>');
    text('#ai-search', '✦ Footage search');
    text('#export-dialog > p', 'Renders an MP4 with the Cutline engine on this computer.');
    text('#export-status', 'Pick a preset, then render.');
    text('#run-export', 'Render MP4');
    text('#analyse', 'Analyse pacing');
    document.dispatchEvent(new Event('engine-live'));
  }).catch(() => {});
})();
