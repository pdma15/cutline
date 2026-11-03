/* Plain JavaScript. Project data is serializable; browser media URLs live separately. */
'use strict';
const $ = selector => document.querySelector(selector);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clone = value => JSON.parse(JSON.stringify(value));
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const storageKey = 'cutline-project-v1';
const urls = new Map(), audioPlayers = new Map();
let project = demoProject(), selected = null, playhead = 0, playing = false, speed = 1;
let undoStack = [], redoStack = [], pixels = 28, selectedWord = null, toastTimer, lastFrame = 0;
let previewSource = '', transcript = [], saveWarning = false, pacingFlags = [];
function demoProject(name = 'A little adventure') {
  return { version: 1, name, settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000 },
    media: [
      { id: 'm1', path: 'Mountain morning.mp4', type: 'video', duration: 8, proxyPath: null, demo: true },
      { id: 'm2', path: 'The scenic route.mp4', type: 'video', duration: 10, proxyPath: null, demo: true },
      { id: 'm3', path: 'Golden hour.jpg', type: 'image', duration: 6, proxyPath: null, demo: true },
      { id: 'm4', path: 'A softer pace.mp3', type: 'audio', duration: 24, proxyPath: null, demo: true }
    ], tracks: [
      { id: 'v1', kind: 'video', clips: [
        { id:'c1', mediaId:'m1', start:0, in:0, out:8, effects:[] },
        { id:'c2', mediaId:'m2', start:8, in:0, out:10, effects:[] },
        { id:'c3', mediaId:'m3', start:18, in:0, out:6, effects:[] }
      ] },
      { id:'a1', kind:'audio', clips:[{id:'c4',mediaId:'m4',start:0,in:0,out:24,effects:[],volume:0.35}] },
      { id:'t1', kind:'text', clips:[] }
    ], markers: [], comments: [] };
}
function notify(message) {
  $('#toast').textContent = message; $('#toast').style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').style.display = 'none', 4000);
}
function duration() { return Math.max(0, ...project.tracks.flatMap(t => t.clips.map(c => c.start + c.out - c.in))); }
function timecode(t) { return `${String(Math.floor(t / 60)).padStart(2,'0')}:${(t % 60).toFixed(2).padStart(5,'0')}`; }
function findClip(id = selected) {
  for (const track of project.tracks) { const clip = track.clips.find(c => c.id === id); if (clip) return {clip, track}; }
  return null;
}
function mediaFor(clip) { return project.media.find(m => m.id === clip.mediaId); }
function currentClips(kind) { return project.tracks.filter(t => t.kind === kind).flatMap(t => t.clips).filter(c => playhead >= c.start && playhead < c.start + c.out - c.in); }
function persist() {
  try { localStorage.setItem(storageKey, JSON.stringify(project)); $('#save-status').textContent = 'Saved on this device'; }
  catch { $('#save-status').textContent = 'Save JSON to keep changes'; if (!saveWarning) { notify('Browser storage unavailable. Download your project JSON to keep it.'); saveWarning = true; } }
}
function change(edit) {
  pause(); pacingFlags = []; undoStack.push(clone(project)); if (undoStack.length > 50) undoStack.shift(); redoStack = [];
  edit(); project.approved = false; persist(); render();
}
function history(redo) {
  const from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack;
  if (!from.length) return;
  pause(); to.push(clone(project)); project = from.pop(); selected = null; playhead = Math.min(playhead, duration()); persist(); render();
}
function render() {
  $('#project-name').value = project.name;
  const {width,height,fps} = project.settings;
  $('#project-info').textContent = `${width} × ${height} · ${fps} fps`;
  $('#aspect').value = width === height ? 'square' : width < height ? 'vertical' : 'wide';
  $('#canvas').className = $('#aspect').value;
  $('#media-count').textContent = `${project.media.length} files`;
  $('#clip-count').textContent = `${project.tracks.reduce((n,t) => n + t.clips.length,0)} clips`;
  $('#undo').disabled = !undoStack.length; $('#redo').disabled = !redoStack.length;
  $('#approve').textContent = project.approved ? '✓ Approved locally' : 'Mark approved';
  for (const player of audioPlayers.values()) player.pause(); audioPlayers.clear();
  renderMedia(); renderTimeline(); renderInspector(); renderComments(); updatePreview();
}
function renderMedia() {
  const query = $('#search').value.toLowerCase(), onlyStars = $('#favorites').checked;
  const media = project.media.filter(m => (!onlyStars || m.favorite) && m.path.toLowerCase().includes(query));
  $('#media-list').innerHTML = media.map(m => `<div class="media-card" draggable="true" data-media="${m.id}"><div class="thumb ${m.type}"><span>${m.type === 'audio' ? '♫' : m.type === 'image' ? '▧' : '▷'}</span><button class="star" data-star="${m.id}" aria-label="${m.favorite?'Unstar':'Star'} ${escapeHTML(m.path)}">${m.favorite?'★':'☆'}</button><button class="add" data-add="${m.id}" aria-label="Add ${escapeHTML(m.path)} to timeline">+</button><small>${timecode(m.duration)}</small></div><div class="media-name" title="${escapeHTML(m.path)}">${escapeHTML(m.path)}</div><div class="media-meta">${m.demo ? 'DEMO' : urls.has(m.id) ? 'LOCAL FILE' : 'REIMPORT TO RELINK'} · ${m.type.toUpperCase()}</div></div>`).join('') || '<p class="hint">No matching media.</p>';
  for (const m of media.filter(m => m.type === 'image' && urls.has(m.id))) {
    const image = document.createElement('img'); image.src = urls.get(m.id); image.alt = '';
    $(`[data-media="${m.id}"] .thumb`).prepend(image);
  }
}
function renderTimeline() {
  const length = Math.max(30, duration() + 5), width = 112 + length * pixels;
  $('#timeline-content').style.width = `${width}px`;
  const interval = pixels < 22 ? 5 : 2;
  $('#ruler').innerHTML = Array.from({length:Math.ceil(length / interval)}, (_,i) => `<span class="tick" style="left:${i * interval * pixels}px">${timecode(i * interval).slice(0,5)}</span>`).join('');
  $('#tracks').innerHTML = project.tracks.map(t => `<div class="track" data-track="${t.id}"><div class="track-label">${t.kind === 'audio' ? '♫' : t.kind === 'text' ? 'T' : '▣'} &nbsp; ${escapeHTML(t.id.toUpperCase())}</div>${t.clips.map(c => `<button draggable="true" class="clip ${t.kind} ${selected === c.id ? 'selected' : ''}" data-clip="${c.id}" style="left:${112 + c.start * pixels}px;width:${Math.max(4,(c.out-c.in)*pixels)}px" title="${escapeHTML(c.name || mediaFor(c)?.path || c.text || 'Title')}">${escapeHTML(c.name || mediaFor(c)?.path || c.text || 'Title')}<small>${timecode(c.out-c.in)}</small></button>`).join('')}</div>`).join('');
  $('#markers').innerHTML = pacingFlags.filter(f => f.time <= duration()).map(f => `<span class="pacing-flag" style="left:${112+f.time*pixels}px" title="${escapeHTML(f.label)}">DEMO PACE ↓</span>`).join('') + project.markers.map((m,i) => `<button class="marker-pin" data-marker="${i}" style="left:${112 + m.time*pixels}px" title="Marker at ${timecode(m.time)}; click to seek, double-click to remove">◆</button>`).join('');
  updateTime();
}
function renderInspector() {
  const found = findClip(); $('#inspector').hidden = !found; $('#inspector-empty').hidden = !!found;
  if (!found) return;
  const {clip:c, track:t} = found, colour = c.effects?.find(e => e.type === 'colour') || {};
  $('#clip-type').textContent = `${t.kind} / ${c.id.slice(0,8)}`;
  $('#clip-name').value = c.name || mediaFor(c)?.path || 'Title';
  $('#clip-start').value = c.start.toFixed(2); $('#clip-in').value = c.in.toFixed(2); $('#clip-out').value = c.out.toFixed(2);
  $('#volume').value = Math.round((c.volume ?? 1)*100); $('#volume-value').value = `${$('#volume').value}%`;
  $('#title-text').value = c.text || ''; $('#exposure').value = colour.exposure || 0; $('#saturation').value = colour.saturation ?? 1;
  $('#transition').value = c.transitionIn?.type || 'none';
}
function updateTime() {
  $('#time').textContent = timecode(playhead); $('#duration').textContent = `/ ${timecode(duration())}`;
  $('#scrub').max = duration() || 1; $('#scrub').value = playhead;
  $('#playhead').style.left = `${112 + playhead*pixels}px`;
}
function setMediaPlaying(player, target, volume) {
  player.volume = Math.max(0, Math.min(1, volume)); player.playbackRate = Math.abs(speed);
  if (Number.isFinite(player.duration) && Math.abs(player.currentTime-target) > (playing ? 0.18 : 0.025)) player.currentTime = Math.max(0,Math.min(target,player.duration));
  if (playing && speed > 0) {
    if (player.paused && !player.dataset.blocked) player.play().catch(() => { player.dataset.blocked = '1'; notify('This browser could not play that file. Try a browser-compatible MP4 or MP3.'); });
  } else player.pause();
}
function updatePreview() {
  updateTime();
  const c = currentClips('video').at(-1), m = c && mediaFor(c), url = m && urls.get(m.id);
  const video = $('#video'), image = $('#image');
  $('#demo-frame').hidden = !m?.demo;
  $('#empty-frame').hidden = !!m && (!!m.demo || !!url);
  $('#empty-frame').textContent = m && !url ? 'Reimport this file to relink its preview' : 'No video at this moment';
  video.hidden = !(url && m.type === 'video'); image.hidden = !(url && m.type === 'image');
  if (url && m.type === 'video') {
    if (previewSource !== url) { video.src = url; previewSource = url; delete video.dataset.blocked; }
    setMediaPlaying(video, c.in + playhead - c.start, c.volume ?? 1);
  } else { video.pause(); if (previewSource) { video.removeAttribute('src'); video.load(); previewSource = ''; } }
  if (url && m.type === 'image' && image.getAttribute('src') !== url) image.src = url;
  const colour = c?.effects?.find(e => e.type === 'colour') || {};
  const filter = `brightness(${Math.pow(2,colour.exposure || 0)}) saturate(${colour.saturation ?? 1})`;
  for (const element of [video,image,$('#demo-frame')]) element.style.filter = filter;
  $('#demo-frame').style.background = c?.mediaId === 'm2' ? 'linear-gradient(#9b9d8d,#d3bb96)' : c?.mediaId === 'm3' ? 'linear-gradient(#b18a76,#e4c5a0)' : '';
  $('#title-overlay').textContent = [...(c?.text ? [c.text] : []), ...currentClips('text').map(t => t.text)].join('\n');
  $('#preview-badge').textContent = m?.demo ? 'DEMO FRAME · NO SOURCE VIDEO' : url ? 'LOCAL PREVIEW' : 'PREVIEW';
  const activeAudio = new Set();
  for (const a of currentClips('audio')) {
    const media = mediaFor(a), source = media && urls.get(media.id); if (!source) continue;
    activeAudio.add(a.id);
    if (!audioPlayers.has(a.id)) audioPlayers.set(a.id,new Audio(source));
    setMediaPlaying(audioPlayers.get(a.id),a.in+playhead-a.start,a.volume ?? 1);
  }
  for (const [id,player] of audioPlayers) if (!activeAudio.has(id)) player.pause();
}
function pause() { playing = false; $('#play').textContent = '▶'; $('#play').setAttribute('aria-label','Play'); $('#video').pause(); for (const player of audioPlayers.values()) player.pause(); }
function play() {
  if (!duration()) return notify('Add a clip to the timeline first.');
  if (playhead >= duration() && speed > 0) playhead = 0;
  if (playhead <= 0 && speed < 0) playhead = duration();
  playing = true; lastFrame = performance.now(); $('#play').textContent = 'Ⅱ'; $('#play').setAttribute('aria-label','Pause');
}
function seek(time) { playhead = Math.min(duration(), Math.max(0,time)); updatePreview(); }
function tick(now) {
  if (playing) {
    playhead = Math.max(0, Math.min(duration(),playhead + (now-lastFrame)/1000 * speed));
    if (playhead >= duration() || playhead <= 0) pause();
    updatePreview();
  }
  lastFrame = now; requestAnimationFrame(tick);
}
function selectClip(id) { selected = id; renderTimeline(); renderInspector(); }
function snapped(time, track, exclude) {
  if (!$('#snap').checked) return Math.max(0,time);
  const candidates = [0,playhead,...track.clips.filter(c => c.id !== exclude).flatMap(c => [c.start,c.start+c.out-c.in])];
  const close = candidates.sort((a,b) => Math.abs(a-time)-Math.abs(b-time))[0];
  return Math.max(0,Math.abs(close-time)*pixels < 10 ? close : Math.round(time*project.settings.fps)/project.settings.fps);
}
function overlaps(track, start, length, exclude) { return track.clips.some(c => c.id !== exclude && start < c.start+c.out-c.in-0.001 && start+length > c.start+0.001); }
function addMedia(id, targetTrack, start) {
  const m = project.media.find(m => m.id === id); if (!m) return;
  const track = targetTrack || project.tracks.find(t => t.kind === (m.type === 'audio' ? 'audio' : 'video'));
  if (!track || track.kind !== (m.type === 'audio' ? 'audio' : 'video')) return notify('Drop this media on a matching video or audio track.');
  const at = start ?? Math.max(0,...track.clips.map(c => c.start+c.out-c.in));
  if (overlaps(track,at,m.duration)) return notify('That space is occupied. Move the clip to an empty part of the track.');
  change(() => { const c = {id:uid(),mediaId:id,start:at,in:0,out:m.duration,effects:[]}; track.clips.push(c); selected=c.id; });
}
function removeClip(ripple = false) {
  const found = findClip(); if (!found) return notify('Select a timeline clip first.');
  change(() => { const {clip:c,track:t} = found; t.clips = t.clips.filter(x => x.id !== c.id); if (ripple) for (const next of t.clips) if (next.start >= c.start+c.out-c.in-0.001) next.start -= c.out-c.in; selected=null; playhead=Math.min(playhead,duration()); });
}
function splitClip() {
  const found = findClip(); if (!found) return notify('Select a timeline clip first.');
  const {clip:c,track:t} = found, offset = playhead-c.start;
  if (offset <= 1/project.settings.fps || offset >= c.out-c.in-1/project.settings.fps) return notify('Place the playhead inside the selected clip.');
  change(() => { const right = {...clone(c),id:uid(),start:playhead,in:c.in+offset}; c.out=c.in+offset; t.clips.push(right); selected=right.id; });
}
function download(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const a = document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
function validateProject(p) {
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
  if (!p || p.version !== 1 || typeof p.name !== 'string' || !p.settings || ![p.settings.width,p.settings.height,p.settings.fps,p.settings.sampleRate].every(n => finite(n) && n>0) || p.settings.fps>240 || !Array.isArray(p.media) || !Array.isArray(p.tracks) || !Array.isArray(p.markers) || !Array.isArray(p.comments)) throw Error('Unsupported project. Open a version 1 Cutline JSON file.');
  const ids = new Set(); const checkId = id => { if (!safeId(id) || ids.has(id)) throw Error('Invalid or duplicate project ID.'); ids.add(id); };
  if (p.media.length>1000 || p.tracks.length>30 || p.comments.length>1000 || p.markers.length>1000) throw Error('Project is too large for this compact frontend.');
  p.media.forEach(m => {checkId(m.id); if (!['video','audio','image'].includes(m.type) || typeof m.path !== 'string' || !finite(m.duration) || m.duration<=0 || m.duration>86400) throw Error('Invalid media metadata.');});
  p.tracks.forEach(t => {
    checkId(t.id); if (!['video','audio','text'].includes(t.kind) || !Array.isArray(t.clips) || t.clips.length>2000) throw Error('Invalid track.');
    t.clips.forEach(c => {
      checkId(c.id); const m=p.media.find(m => m.id===c.mediaId);
      if (![c.start,c.in,c.out].every(finite) || c.start<0 || c.in<0 || c.out<=c.in || c.start+c.out-c.in>86400 || (t.kind!=='text' && (!m || c.out>m.duration+0.01 || (t.kind==='audio')!==(m.type==='audio'))) || !Array.isArray(c.effects) || c.effects.some(e => !e || typeof e.type!=='string') || (c.text!==undefined && typeof c.text!=='string') || (c.volume!==undefined && (!finite(c.volume) || c.volume<0 || c.volume>1))) throw Error('Invalid clip data.');
    });
    const sorted=[...t.clips].sort((a,b) => a.start-b.start);
    if (sorted.some((c,i) => i && c.start<sorted[i-1].start+sorted[i-1].out-sorted[i-1].in-0.001)) throw Error('Overlapping clips on one track are not supported.');
  });
  if (p.markers.some(m => !finite(m.time) || m.time<0) || p.comments.some(c => !safeId(c.id) || !finite(c.time) || c.time<0 || typeof c.text!=='string' || typeof c.author!=='string')) throw Error('Invalid marker or comment.');
  return p;
}
async function importFiles(files) {
  for (const file of files) {
    const type = file.type.split('/')[0]; if (!['video','image','audio'].includes(type)) { notify(`Unsupported file: ${file.name}`); continue; }
    const url=URL.createObjectURL(file); let length=6;
    try {
      if (type !== 'image') length = await new Promise((resolve,reject) => {
        const probe=document.createElement(type); const timeout=setTimeout(() => {probe.removeAttribute('src'); probe.load(); reject(Error('Metadata timed out'));},10000);
        const finish = (ok) => {clearTimeout(timeout); const d=probe.duration; probe.removeAttribute('src'); probe.load(); ok && Number.isFinite(d) && d>0 ? resolve(d) : reject(Error('Unsupported media'));};
        probe.onloadedmetadata=()=>finish(true); probe.onerror=()=>finish(false); probe.preload='metadata'; probe.src=url;
      });
      const existing=project.media.find(m => !m.demo && m.path===file.name && m.type===type && (m.size===undefined || m.size===file.size) && (m.modified===undefined || m.modified===file.lastModified));
      if (existing) { if (Math.abs(existing.duration-length)>0.25) throw Error('Relink duration differs'); if(urls.has(existing.id)) URL.revokeObjectURL(urls.get(existing.id)); urls.set(existing.id,url); render(); notify(`Relinked ${file.name}`); }
      else change(() => { const id=uid(); urls.set(id,url); project.media.push({id,path:file.name,type,duration:length,proxyPath:null,size:file.size,modified:file.lastModified}); });
    } catch { URL.revokeObjectURL(url); notify(`Could not read ${file.name}. Try a browser-compatible file.`); }
  }
  $('#files').value='';
}
async function loadTranscript() {
  transcript=await window.engine.transcribe('m1');
  $('#transcript').innerHTML=transcript.map((w,i) => `<button class="word" data-word="${i}">${escapeHTML(w.text)}</button>`).join('');
}
function renderComments() {
  $('#comments').innerHTML=project.comments.map(c => `<article class="comment ${c.resolved?'resolved':''}"><button data-seek="${c.time}">${timecode(c.time)}</button> <small>${escapeHTML(c.author)}</small><p>${escapeHTML(c.text)}</p><button data-resolve="${c.id}">${c.resolved?'Reopen':'Resolve'}</button></article>`).join('');
}
// Controls and delegated lists keep the DOM and project data separate.
$('#simple').onclick=()=>setMode(false); $('#pro').onclick=()=>setMode(true);
function setMode(pro) {
  document.body.classList.toggle('pro',pro); $('#simple').setAttribute('aria-pressed',!pro); $('#pro').setAttribute('aria-pressed',pro); $('#mode-label').textContent=pro?'PRO WORKSPACE':'SIMPLE WORKSPACE';
  if (!pro && ['transcript','review'].some(t => !$(`#${t}-panel`).hidden)) $('[data-tab="media"]').click();
}
document.querySelectorAll('[data-tab]').forEach(button => button.onclick=()=>{
  document.querySelectorAll('[data-tab]').forEach(b => {b.classList.toggle('active',b===button); $(`#${b.dataset.tab}-panel`).hidden=b!==button;});
  if (button.dataset.tab==='transcript') loadTranscript();
});
$('#import').onclick=()=>$('#files').click(); $('#files').onchange=e=>importFiles([...e.target.files]);
$('#ai-search').onclick=async()=>{const query=$('#search').value.trim();if(!query)return notify('Type a footage search above first.');const hits=await engine.searchFootage(query);$('#search-results').textContent=hits.map(h=>`${h.label} at ${timecode(h.time)}`).join(' · ')||'No demo matches';if(hits.length){const hit=hits[0],c=project.tracks.filter(t=>t.kind==='video').flatMap(t=>t.clips).find(c=>c.mediaId===hit.mediaId&&hit.time>=c.in&&hit.time<c.out);if(c){pause();seek(c.start+hit.time-c.in);selectClip(c.id);}}};
$('#add-track').onclick=()=>{if(project.tracks.length>=30)return notify('This frontend supports up to 30 tracks.');change(()=>project.tracks.push({id:uid(),kind:$('#track-kind').value,clips:[]}));};
$('#search').oninput=renderMedia; $('#favorites').onchange=renderMedia;
$('#media-list').onclick=e=>{
  const add=e.target.closest('[data-add]'), star=e.target.closest('[data-star]');
  if (add) addMedia(add.dataset.add);
  if (star) change(()=>{const m=project.media.find(m=>m.id===star.dataset.star);m.favorite=!m.favorite;});
};
$('#media-list').ondragstart=e=>{const card=e.target.closest('[data-media]'); if(card)e.dataTransfer.setData('text/plain',JSON.stringify({media:card.dataset.media}));};
$('#tracks').ondragstart=e=>{const button=e.target.closest('[data-clip]'); if(button){selectClip(button.dataset.clip); const c=findClip().clip; e.dataTransfer.setData('text/plain',JSON.stringify({clip:c.id,offset:(e.clientX-button.getBoundingClientRect().left)/pixels}));}};
$('#tracks').ondragover=e=>{if(e.target.closest('.track'))e.preventDefault();};
$('#tracks').ondrop=e=>{
  e.preventDefault(); const row=e.target.closest('.track'); if(!row)return;
  let data; try{data=JSON.parse(e.dataTransfer.getData('text/plain'));}catch{return;}
  const target=project.tracks.find(t=>t.id===row.dataset.track), x=(e.clientX-row.getBoundingClientRect().left-112)/pixels;
  const at=snapped(Math.max(0,x-(data.offset||0)),target,data.clip);
  if(data.media)return addMedia(data.media,target,at);
  const found=findClip(data.clip);if(!found)return;
  if(found.track.kind!==target.kind)return notify('Move clips between tracks of the same type.');
  if(overlaps(target,at,found.clip.out-found.clip.in,found.clip.id))return notify('That space is occupied.');
  change(()=>{found.track.clips=found.track.clips.filter(c=>c.id!==found.clip.id);found.clip.start=at;target.clips.push(found.clip);selected=found.clip.id;});
};
$('#tracks').onclick=e=>{const c=e.target.closest('[data-clip]');if(c)selectClip(c.dataset.clip);else if(!e.target.closest('.track-label')){const r=$('#timeline-content').getBoundingClientRect();pause();seek((e.clientX-r.left-112)/pixels);}};
$('#ruler').onpointerdown=e=>{
  const ruler=$('#ruler'); pause(); ruler.setPointerCapture(e.pointerId);
  const scrub=event=>seek((event.clientX-ruler.getBoundingClientRect().left)/pixels);scrub(e);
  ruler.onpointermove=scrub;ruler.onpointerup=()=>ruler.onpointermove=null;ruler.onlostpointercapture=()=>ruler.onpointermove=null;
};
$('#zoom').oninput=e=>{pixels=+e.target.value;renderTimeline();};
$('#markers').onclick=e=>{const b=e.target.closest('[data-marker]');if(b){pause();seek(project.markers[+b.dataset.marker].time);}};
$('#markers').ondblclick=e=>{const b=e.target.closest('[data-marker]');if(b)change(()=>project.markers.splice(+b.dataset.marker,1));};
$('#play').onclick=()=>{if(playing)pause();else{speed=1;play();}};
$('#back').onclick=()=>{pause();seek(playhead-1/project.settings.fps);};$('#forward').onclick=()=>{pause();seek(playhead+1/project.settings.fps);};
$('#scrub').oninput=e=>{pause();seek(+e.target.value);};
$('#undo').onclick=()=>history(false);$('#redo').onclick=()=>history(true);$('#split').onclick=splitClip;$('#ripple').onclick=()=>removeClip(true);$('#delete').onclick=()=>removeClip();
$('#marker').onclick=()=>change(()=>project.markers.push({id:uid(),time:playhead}));
$('#volume').oninput=e=>$('#volume-value').value=`${e.target.value}%`;
$('#inspector').onsubmit=e=>{
  e.preventDefault();const found=findClip();if(!found)return;
  const {clip:c,track:t}=found,start=+$('#clip-start').value,sourceIn=+$('#clip-in').value,out=+$('#clip-out').value;
  if (![start,sourceIn,out].every(Number.isFinite)||start<0||sourceIn<0||out<=sourceIn||start+out-sourceIn>86400)return notify('Use valid times with source out greater than source in.');
  if(t.kind!=='text'&&out>mediaFor(c).duration+0.001)return notify('Source out cannot exceed the original file duration.');
  if(overlaps(t,start,out-sourceIn,c.id))return notify('The new timing overlaps another clip.');
  change(()=>{Object.assign(c,{name:$('#clip-name').value,start,in:sourceIn,out,volume:+$('#volume').value/100,text:$('#title-text').value});c.effects=c.effects.filter(e=>e.type!=='colour');c.effects.push({type:'colour',exposure:+$('#exposure').value,saturation:+$('#saturation').value});c.transitionIn=$('#transition').value==='none'?null:{type:$('#transition').value,duration:0.5};});
};
$('#add-title').onclick=()=>{
  const t=project.tracks.find(t=>t.kind==='text'),start=playhead;
  if(!t)return notify('This project has no text track.');if(overlaps(t,start,4))return notify('Move the playhead to an empty part of the text track.');
  change(()=>{const c={id:uid(),start,in:0,out:4,text:'Your title here',effects:[]};t.clips.push(c);selected=c.id;});
};
$('#aspect').onchange=e=>change(()=>{const sizes={wide:[1920,1080],vertical:[1080,1920],square:[1080,1080]};[project.settings.width,project.settings.height]=sizes[e.target.value];});
$('#project-name').onchange=e=>{const name=e.target.value.trim().slice(0,100)||'Untitled project';change(()=>project.name=name);};
$('#save').onclick=()=>download(project,`${project.name.replace(/[^a-z0-9_-]/gi,'_')||'project'}.json`);
$('#open').onclick=()=>$('#project-file').click();
$('#project-file').onchange=async e=>{
  const file=e.target.files[0];if(!file)return;
  try{if(file.size>5e6)throw Error('Project JSON must be smaller than 5 MB.');const p=validateProject(JSON.parse(await file.text()));change(()=>{project=p;selected=null;playhead=0;});notify('Project opened. Reimport original files to relink local previews.');}catch(err){notify(err.message);}e.target.value='';
};
document.querySelectorAll('[data-template]').forEach(b=>b.onclick=()=>{if(!confirm('Replace this project with a demo template? Save JSON first. You can also undo this change.'))return;change(()=>{project=demoProject(b.dataset.template);if(b.dataset.template==='Blank project'){project.media=[];project.tracks.forEach(t=>t.clips=[]);}else project.tracks.find(t=>t.kind==='text').clips.push({id:uid(),start:0,in:0,out:4,text:b.dataset.template,effects:[]});selected=null;playhead=0;});});
$('#transcript').onclick=e=>{const b=e.target.closest('[data-word]');if(!b)return;selectedWord=+b.dataset.word;document.querySelectorAll('.word').forEach(w=>w.classList.toggle('selected',w===b));const w=transcript[selectedWord];const c=project.tracks.filter(t=>t.kind==='video').flatMap(t=>t.clips).find(c=>c.mediaId===w.mediaId&&w.start>=c.in&&w.end<=c.out);if(c){pause();seek(c.start+w.start-c.in);}else notify('This word is no longer on the timeline.');};
$('#cut-word').onclick=()=>{
  if(selectedWord===null)return notify('Select a demo transcript word first.');const w=transcript[selectedWord];
  let match;for(const t of project.tracks.filter(t=>t.kind==='video')){const c=t.clips.find(c=>c.mediaId===w.mediaId&&w.start>=c.in&&w.end<=c.out);if(c){match={t,c};break;}}
  if(!match)return notify('This word has already been cut.');
  change(()=>{const {t,c}=match,length=w.end-w.start,originalEnd=c.out,at=c.start+w.start-c.in;for(const next of t.clips)if(next.start>=c.start+originalEnd-c.in-0.001)next.start-=length;t.clips=t.clips.filter(x=>x.id!==c.id);if(w.start>c.in+0.001)t.clips.push({...clone(c),out:w.start});if(w.end<originalEnd-0.001)t.clips.push({...clone(c),id:uid(),start:at,in:w.end,out:originalEnd});selected=null;playhead=Math.min(playhead,duration());});
};
$('#analyse').onclick=async()=>{const result=await engine.analyse(project);pacingFlags=result.flags;renderTimeline();$('#analysis').textContent=`Simulated hook score: ${result.hookScore}/100. Demo flag at 00:12: ${result.flags[0].label}.`;};
$('#comment-form').onsubmit=e=>{e.preventDefault();const text=$('#comment').value.trim(),author=$('#author').value.trim();if(!text||!author)return;change(()=>project.comments.push({id:uid(),time:playhead,author,text,resolved:false}));$('#comment').value='';};
$('#comments').onclick=e=>{const seekButton=e.target.closest('[data-seek]'),resolve=e.target.closest('[data-resolve]');if(seekButton){pause();seek(+seekButton.dataset.seek);}if(resolve)change(()=>{const c=project.comments.find(c=>c.id===resolve.dataset.resolve);c.resolved=!c.resolved;});};
$('#approve').onclick=()=>{change(()=>{});project.approved=true;persist();renderComments();$('#approve').textContent='✓ Approved locally';};
$('#export').onclick=()=>$('#export-dialog').showModal();
$('#run-export').onclick=async()=>{
  $('#run-export').disabled=true;$('#export-status').textContent='Simulating export progress…';const snapshot=clone(project);
  try{const result=await engine.exportProject(snapshot,$('#preset').value,p=>$('#export-progress').value=p);download(result,'cutline-export-request.json');$('#export-status').textContent='Export request downloaded. No MP4 has been rendered.';}catch{notify('Demo export failed. Your project is still available.');}finally{$('#run-export').disabled=false;}
};
$('#help').onclick=()=>$('#help-dialog').showModal();
document.addEventListener('keydown',e=>{
  if(e.target.closest('input,textarea,select,[contenteditable=true]')||document.querySelector('dialog[open]'))return;
  const key=e.key.toLowerCase();
  if((e.ctrlKey||e.metaKey)&&key==='z'){e.preventDefault();history(e.shiftKey);return;}
  if((e.ctrlKey||e.metaKey)&&key==='s'){e.preventDefault();$('#save').click();return;}
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.code==='Space'){e.preventDefault();$('#play').click();}
  if(key==='s')splitClip();if(key==='m')$('#marker').click();if(key==='delete'||key==='backspace'){e.preventDefault();removeClip();}
  if(key==='arrowleft'){$('#back').click();e.preventDefault();}if(key==='arrowright'){$('#forward').click();e.preventDefault();}
  if(key==='k')pause();if(key==='l'){speed=1;play();}if(key==='j'){speed=-1;play();}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
window.addEventListener('beforeunload',()=>{for(const url of urls.values())URL.revokeObjectURL(url);});
try{const saved=localStorage.getItem(storageKey);if(saved){project=validateProject(JSON.parse(saved));notify('Recovered your last edit. Reimport local media to restore previews.');}}catch{notify('Could not recover the saved edit. Starting with a demo; use Open project to restore a JSON backup.');}
$('#video').onloadedmetadata=()=>updatePreview();
render();requestAnimationFrame(tick);
