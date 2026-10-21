const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const RES = GetCurrentResourceName();
const VERSION = GetResourceMetadata(RES, 'version', 0) || '0.0.0';
const API = GetConvar('surgenode_images_api', 'https://images.surgenode.net').replace(/\/+$/, '');
const INV = GetConvar('surgenode_images_resource', 'ox_inventory');
const AUTOCONVAR = GetConvar('surgenode_images_autoconvar', 'true') !== 'false';
const DEFAULT_IMAGEPATH = `nui://${INV}/web/images`;
const IMAGE_EXT = /\.(png|webp|jpe?g)$/i;
const MAX_FILE = 2 * 1024 * 1024;

const PRUNE = GetConvar('surgenode_images_prune', 'false') === 'true';
const PRUNE_MIN_AGE = 120_000;
const PRUNE_BATCH = 400;

const FAST = 60_000;
const SLOW = 300_000;
const QUIET_AFTER = 3_600_000;

const OWN = GetResourcePath(RES);
const BACKUP = path.join(OWN, 'backup', 'images');
const HISTORY = path.join(OWN, 'backup', 'history');

const log = (...a) => console.log('^5[surgenode_images]^7', ...a);
const warn = (...a) => console.log('^3[surgenode_images]^7', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const state = {
  token: GetConvar('surgenode_images_token', '') || GetResourceKvpString('token') || '',
  linking: false,
  running: false,
  timer: null,
  failures: 0,
  hashCache: new Map(),
  lastChangeAt: Date.now(),
  lastManifestHash: null,
  lastSyncAt: 0,
  lastResult: 'not run yet',
  itemsHash: null,
  itemsError: null,
  imagepath: null,
  prunedTotal: Number(GetResourceKvpInt('pruned_total') || 0),
  pruneNote: null,
  stateHash: null,
  warnedRejects: new Set(),
  warnedConvar: null,
  warnedPrune: null,
  backup: null,
};

async function api(method, p, { json, body, headers = {} } = {}) {
  const h = { 'user-agent': `surgenode_images/${VERSION}`, ...headers };
  if (state.token) h.authorization = `Bearer ${state.token}`;
  if (json !== undefined) {
    body = JSON.stringify(json);
    h['content-type'] = 'application/json';
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(API + p, { method, headers: h, body, signal: ctrl.signal });
    const data = await r.json().catch(() => null);
    return { status: r.status, data: data || {} };
  } finally {
    clearTimeout(t);
  }
}

async function link() {
  if (state.linking) return;
  state.linking = true;
  try {
    const name = GetConvar('sv_projectName', '') || GetConvar('sv_hostname', 'FiveM server');
    const s = await api('POST', '/v1/link/start', { json: { server_name: name } });
    if (s.status !== 200) {
      warn(`Could not start linking (${s.status} ${s.data.error || ''}). Retrying in 5 minutes.`);
      return schedule(SLOW);
    }
    log('------------------------------------------------------------');
    log('Link this server to your SurgeNode image workspace:');
    log(`  ^2${s.data.link_url}^7`);
    log(`Code ^2${s.data.code}^7, valid for 15 minutes.`);
    log('------------------------------------------------------------');
    const deadline = Date.now() + s.data.expires_in * 1000;
    while (Date.now() < deadline) {
      await sleep((s.data.poll_interval || 5) * 1000);
      const p = await api('POST', '/v1/link/poll', { json: { code: s.data.code, device_secret: s.data.device_secret } });
      if (p.status === 200 && p.data.status === 'linked') {
        state.token = p.data.token;
        SetResourceKvp('token', p.data.token);
        log(`Linked to workspace ^2${p.data.workspace}^7. Images will be served from ${p.data.imagepath}`);
        return schedule(1_000);
      }
      if (p.status !== 200) break;
    }
    warn('Link code expired. A new one will be printed.');
    schedule(1_000);
  } catch (e) {
    warn(`Linking failed (${e.message}). Retrying in 5 minutes.`);
    schedule(SLOW);
  } finally {
    state.linking = false;
  }
}

function imagesDir() {
  const res = GetResourcePath(INV);
  return res ? path.join(res, 'web', 'images') : null;
}

const exists = (p) => fsp.access(p).then(() => true, () => false);

async function scan() {
  const dir = imagesDir();
  if (!dir || !(await exists(dir))) return { files: [], missing: true };
  const next = new Map();
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!d.isFile() || !IMAGE_EXT.test(d.name)) continue;
    const p = path.join(dir, d.name);
    let st;
    try { st = await fsp.stat(p); } catch { continue; }
    if (st.size === 0 || st.size > MAX_FILE) continue;
    const old = state.hashCache.get(d.name);
    if (old && old.size === st.size && old.mtime === st.mtimeMs) {
      next.set(d.name, old);
      continue;
    }
    try {
      next.set(d.name, { size: st.size, mtime: st.mtimeMs, sha256: sha256(await fsp.readFile(p)) });
    } catch {
      continue;
    }
  }
  state.hashCache = next;
  const files = [...next.entries()]
    .map(([name, v]) => ({ name, sha256: v.sha256, size: v.size }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return { files, missing: false };
}

function applyImagepath(imagepath) {
  if (!AUTOCONVAR || !imagepath) return;
  const current = GetConvar('inventory:imagepath', '');
  const ours = current.startsWith('https://img.surgenode.net/');
  if (current && current !== DEFAULT_IMAGEPATH && !ours) {
    if (state.warnedConvar !== current) warn(`inventory:imagepath is set to ${current}; leaving it alone. Set surgenode_images_autoconvar false to silence this.`);
    state.warnedConvar = current;
    return;
  }
  if (current !== imagepath) {
    SetConvarReplicated('inventory:imagepath', imagepath);
    log(`inventory:imagepath set to ${imagepath}. Players get it on their next join.`);
  }
  SetResourceKvp('imagepath', imagepath);
}

async function uploadAll(names, uploadPath) {
  const dir = imagesDir();
  let ok = 0;
  const failed = [];
  const queue = [...names];
  const worker = async () => {
    while (queue.length) {
      const name = queue.shift();
      const meta = state.hashCache.get(name);
      if (!meta) continue;
      try {
        const body = await fsp.readFile(path.join(dir, name));
        const r = await api('PUT', uploadPath + encodeURIComponent(name), {
          body,
          headers: { 'x-sn-sha256': meta.sha256, 'content-type': 'application/octet-stream' },
        });
        if (r.status === 200) ok++;
        else failed.push(`${name} (${r.data.error || r.status})`);
      } catch (e) {
        failed.push(`${name} (${e.message})`);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { ok, failed };
}

async function sync(reason = 'timer') {
  if (state.running) return;
  if (!state.token) return link();
  state.running = true;
  try {
    const { files, missing } = await scan();
    if (missing) {
      state.lastResult = `${INV}/web/images not found`;
      return;
    }
    const mh = sha256(JSON.stringify(files));
    if (mh !== state.lastManifestHash) state.lastChangeAt = Date.now();
    const imagepathNow = GetConvar('inventory:imagepath', '');

    let plan = await api('POST', '/v1/sync/plan', { json: { manifest_hash: mh, agent_version: VERSION, imagepath: imagepathNow } });
    if (plan.status === 401) return unlinked(plan.data.error);
    if (plan.status !== 200) throw new Error(`plan ${plan.status} ${plan.data.error || ''}`);
    if (plan.data.action === 'none') {
      state.lastManifestHash = mh;
      state.lastResult = `in sync (${files.length} images)`;
      state.imagepath = plan.data.imagepath;
      applyImagepath(plan.data.imagepath);
      await prune(files);
      state.failures = 0;
      return;
    }
    if (plan.data.action === 'send_files') {
      plan = await api('POST', '/v1/sync/plan', { json: { manifest_hash: mh, files, agent_version: VERSION, imagepath: imagepathNow } });
      if (plan.status !== 200) throw new Error(`plan ${plan.status} ${plan.data.error || ''}`);
    }
    for (const r of plan.data.rejected || []) {
      const k = `${r.name}\n${r.reason}`;
      if (state.warnedRejects.has(k)) continue;
      state.warnedRejects.add(k);
      const hint = r.reason === 'bad_characters' ? ' (use only letters, digits, _ . - in image names)' : '';
      warn(`Skipped ${r.name}: ${r.reason}${hint}`);
    }
    if (plan.data.workspace_status && plan.data.workspace_status !== 'active') {
      state.lastResult = `workspace ${plan.data.workspace_status}; not uploading`;
      warn(`Workspace is ${plan.data.workspace_status}; images are not being uploaded.`);
      return;
    }

    const upload = plan.data.upload || [];
    if (upload.length) {
      log(`Uploading ${plural(upload.length, 'image')} (${reason})...`);
      const r = await uploadAll(upload, plan.data.upload_path);
      if (r.failed.length) warn(`${r.failed.length} failed: ${r.failed.slice(0, 5).join(', ')}${r.failed.length > 5 ? ', ...' : ''}`);
    }
    const commit = await api('POST', '/v1/sync/commit', { json: { manifest_hash: mh } });
    if (commit.status !== 200) throw new Error(`commit ${commit.status} ${commit.data.error || ''}`);
    if (commit.data.verified) {
      state.lastManifestHash = mh;
      state.lastResult = `in sync (${commit.data.files} images)`;
      if (upload.length) log(`Synced. ${commit.data.files} images live at ${commit.data.imagepath}`);
      state.imagepath = commit.data.imagepath;
      applyImagepath(commit.data.imagepath);
      if (!state.itemsHash) reportItems();
      await prune(files);
    } else {
      state.lastResult = `${commit.data.missing_count} images still missing; retrying`;
    }
    state.failures = 0;
  } catch (e) {
    state.failures++;
    state.lastResult = `error: ${e.message}`;
    if (state.failures === 1 || state.failures % 10 === 0) warn(`Sync failed (${e.message}). Will retry.`);
  } finally {
    state.running = false;
    state.lastSyncAt = Date.now();
    if (state.token && !state.linking) schedule(nextDelay());
  }
}

function unlinked(why) {
  warn(`This server was unlinked (${why}). Printing a new link.`);
  state.token = '';
  DeleteResourceKvp('token');
  state.running = false;
  schedule(1_000);
}

function nextDelay() {
  if (state.failures) return Math.min(FAST * 2 ** Math.min(state.failures - 1, 3), SLOW) + Math.random() * 10_000;
  const base = Date.now() - state.lastChangeAt > QUIET_AFTER ? SLOW : FAST;
  return base + Math.random() * 5_000;
}

function schedule(ms) {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => (state.token ? sync() : link()), ms);
}

async function backupStats() {
  if (state.backup) return state.backup;
  let files = 0;
  let bytes = 0;
  if (await exists(BACKUP)) {
    for (const d of await fsp.readdir(BACKUP, { withFileTypes: true })) {
      if (!d.isFile()) continue;
      const st = await fsp.stat(path.join(BACKUP, d.name)).catch(() => null);
      if (!st) continue;
      bytes += st.size;
      files++;
    }
  }
  state.backup = { files, bytes };
  return state.backup;
}

async function backupFile(src, name, sha) {
  await fsp.mkdir(BACKUP, { recursive: true });
  const dst = path.join(BACKUP, name);
  let dFiles = 0;
  let dBytes = 0;
  let had = await exists(dst);
  if (had) {
    const old = await fsp.readFile(dst);
    if (sha256(old) !== sha) {
      await fsp.mkdir(HISTORY, { recursive: true });
      await fsp.rename(dst, path.join(HISTORY, `${Date.now()}-${name}`));
      dFiles -= 1;
      dBytes -= old.length;
      had = false;
    }
  }
  if (!had) await fsp.copyFile(src, dst);
  const buf = await fsp.readFile(dst);
  if (!had) {
    dFiles += 1;
    dBytes += buf.length;
  }
  return { ok: sha256(buf) === sha, dFiles, dBytes };
}

async function prune(files) {
  state.pruneNote = null;
  if (!PRUNE) {
    state.pruneNote = 'off (set surgenode_images_prune true to enable)';
    return reportState();
  }
  if (GetResourceKvpInt('prune_paused') === 1) {
    state.pruneNote = 'paused by snimages restore (run: snimages prune resume)';
    return reportState();
  }
  const current = GetConvar('inventory:imagepath', '');
  if (!state.imagepath || current !== state.imagepath) {
    state.pruneNote = `waiting: inventory:imagepath is ${current || '(default)'}, not the CDN`;
    return reportState();
  }
  const dir = imagesDir();
  const now = Date.now();
  const candidates = files
    .filter((f) => {
      const m = state.hashCache.get(f.name);
      return m && now - m.mtime > PRUNE_MIN_AGE;
    })
    .slice(0, PRUNE_BATCH);
  if (!candidates.length) return reportState();

  const v = await api('POST', '/v1/sync/verify', { json: { files: candidates.map((f) => ({ name: f.name, sha256: f.sha256 })) } });
  if (v.status !== 200) {
    state.pruneNote = `verify failed (${v.status})`;
    return reportState();
  }
  const confirmed = new Set(v.data.confirmed || []);
  let removed = 0;
  for (const f of candidates) {
    if (!confirmed.has(f.name)) continue;
    const src = path.join(dir, f.name);
    try {
      if (sha256(await fsp.readFile(src)) !== f.sha256) continue;
      const b = await backupFile(src, f.name, f.sha256);
      if (state.backup) {
        state.backup.files += b.dFiles;
        state.backup.bytes += b.dBytes;
      }
      if (!b.ok) {
        warn(`Backup of ${f.name} did not verify; keeping it.`);
        continue;
      }
      await fsp.unlink(src);
      state.hashCache.delete(f.name);
      removed++;
    } catch (e) {
      if (e.code === 'ERR_ACCESS_DENIED' || e.code === 'EACCES' || e.code === 'EPERM') {
        state.pruneNote = `blocked by the FiveM sandbox: add "add_filesystem_permission ${RES} write ${INV}" to server.cfg, above ensure ${RES}`;
        if (state.warnedPrune !== state.pruneNote) warn(state.pruneNote);
        state.warnedPrune = state.pruneNote;
        break;
      }
      warn(`Could not prune ${f.name}: ${e.message}`);
    }
  }
  if (removed) {
    state.prunedTotal += removed;
    SetResourceKvpInt('pruned_total', state.prunedTotal);
    log(`Removed ${plural(removed, 'synced image')} from ${INV}/web/images (backed up to ${RES}/backup/images). Joins get lighter after the next ${INV} restart.`);
    state.lastManifestHash = null;
  }
  return reportState();
}

function restoreAll() {
  if (!fs.existsSync(BACKUP)) return log('Nothing to restore: the backup is empty.');
  const dir = imagesDir();
  let restored = 0;
  let skipped = 0;
  try {
    for (const name of fs.readdirSync(BACKUP)) {
      const dst = path.join(dir, name);
      if (fs.existsSync(dst)) {
        skipped++;
        continue;
      }
      fs.copyFileSync(path.join(BACKUP, name), dst);
      restored++;
    }
  } catch (e) {
    return warn(`Restore failed: ${e.message}. Is "add_filesystem_permission ${RES} write ${INV}" in server.cfg?`);
  }
  SetResourceKvpInt('prune_paused', 1);
  log(`Restored ${plural(restored, 'image')} into ${INV}/web/images (${skipped} already there). Pruning is paused; remove surgenode_images_prune from server.cfg to keep it off, or run: snimages prune resume`);
  reportState();
}

async function reportState() {
  if (!state.token) return;
  const b = await backupStats();
  const body = {
    prune: PRUNE && GetResourceKvpInt('prune_paused') !== 1,
    prune_permitted: !state.pruneNote?.startsWith('blocked'),
    backup_files: b.files,
    backup_bytes: b.bytes,
    pruned_total: state.prunedTotal,
    local_files: state.hashCache.size,
    last_error: state.pruneNote,
  };
  const h = JSON.stringify(body);
  if (h === state.stateHash) return;
  const r = await api('POST', '/v1/sync/state', { json: body }).catch(() => null);
  if (r && r.status === 200) state.stateHash = h;
}

async function reportItems() {
  if (!state.token || GetResourceState(INV) !== 'started') return;
  try {
    const names = Object.keys(exports[INV].Items() || {}).sort();
    let images = {};
    try {
      images = exports[RES].GetClientImages(INV) || {};
    } catch (e) {
      if (state.itemsError !== e.message) warn(`Could not read client.image overrides (${e.message}).`);
    }
    const h = sha256(names.join('\n') + JSON.stringify(images));
    if (h === state.itemsHash) return;
    const r = await api('POST', '/v1/sync/items', { json: { items: names, images } });
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${r.data.error || ''}`.trim());
    state.itemsHash = h;
    state.itemsError = null;
  } catch (e) {
    if (state.itemsError !== e.message) warn(`Could not send the item list (${e.message}).`);
    state.itemsError = e.message;
  }
}

on('onResourceStart', (name) => {
  if (name === INV) {
    setTimeout(reportItems, 10_000);
    return;
  }
  if (name !== RES) return;
  if (typeof fetch !== 'function') {
    warn(`This FXServer's JS runtime (Node ${process.version}) has no fetch. Update FXServer to a current recommended build; surgenode_images is idle.`);
    return;
  }
  applyImagepath(GetResourceKvpString('imagepath'));
  if (GetConvar('surgenode_images_token', '') && GetResourceKvpString('token')) DeleteResourceKvp('token');
  schedule(3_000);
  setTimeout(reportItems, 15_000);
  setInterval(reportItems, 3_600_000);
});

RegisterCommand('snimages', (src, args) => {
  if (src !== 0) return;
  const sub = args[0] || 'status';
  if (sub === 'status') {
    const ago = state.lastSyncAt ? `${Math.round((Date.now() - state.lastSyncAt) / 1000)}s ago` : 'never';
    backupStats().then((b) => {
      log(`version ${VERSION}, api ${API}, inventory ${INV}`);
      log(`linked: ${state.token ? 'yes' : 'no'}; last sync: ${ago}; ${state.lastResult}`);
      log(`inventory:imagepath = ${GetConvar('inventory:imagepath', '(default)')}`);
      log(`pruning: ${state.pruneNote || (PRUNE ? 'on' : 'off')}; removed so far: ${state.prunedTotal}; backup: ${b.files} files, ${(b.bytes / 1048576).toFixed(1)} MB`);
      if (state.itemsError) log(`item list: not sent (${state.itemsError})`);
    });
  } else if (sub === 'restore') {
    restoreAll();
  } else if (sub === 'prune' && args[1] === 'resume') {
    DeleteResourceKvp('prune_paused');
    log('Pruning resumed.');
    state.lastManifestHash = null;
    sync('manual');
  } else if (sub === 'sync') {
    state.lastManifestHash = null;
    sync('manual');
  } else if (sub === 'relink') {
    unlinked('manual relink');
  } else {
    log('usage: snimages [status|sync|relink|restore|prune resume]');
  }
}, true);
