#!/usr/bin/env node
/**
 * Drive the shipped God's Eye View app on the connected phone (CDP).
 *
 * Every action evaluates in the app's own page, so `dataManager`, the CCTV
 * layer, the plate reader and their panels behave exactly as the operator
 * sees them — no replica of the app can prove that.
 *
 * Actions:
 *   (default)          inspect the CCTV / ALPR layers (enabled, stats, selection)
 *   set <cameraId>     select a camera in the CCTV layer
 *   find <pattern>     list cameras matching id / name / code (up to 10)
 *   calgary-list       list the Calgary cameras of the catalogue
 *   open-panel         un-collapse and scroll the CCTV panel into view
 *   badge              CcTV source badge + frame/video visibility
 *   read-current       trigger one plate read of the selected camera
 *   read <cameraId>    select then read that camera's plates
 *   enable             toggle the CCTV layer on
 *
 * Examples:
 *   node scripts/drive-phone.mjs find ncam205
 *   node scripts/drive-phone.mjs set calgary-158
 *   node scripts/drive-phone.mjs read calgary-158
 */
import { openAppSocket, connect, PORT } from './cdp-phone.mjs';

const app = await openAppSocket();
const { evaluate } = await connect(app.webSocketDebuggerUrl);

const [action, arg] = process.argv.slice(2);
console.error(
  `phone: ${app.url}\naction: ${action ?? 'inspect'}${arg ? ` ${arg}` : ''} (port ${PORT})`,
);

switch (action) {
  case 'calgary-list': {
    const ok = await evaluate(`(async () => {
      const dm = window.__godsEyeView && window.__godsEyeView.dataManager;
      const cctv = dm && dm.layers && dm.layers.get('cctv');
      if (!cctv?.module?.getUIState) return { ok: false };
      const state = cctv.module.getUIState();
      return {
        ok: true,
        total: state.cameras.length,
        calgary: state.cameras
          .filter((c) => String(c.id || '').startsWith('calgary-'))
          .map((c) => ({ id: c.id, name: String(c.name ?? c.label ?? '') })),
      };
    })()`);
    console.log(JSON.stringify(ok, null, 2));
    break;
  }

  case 'badge': {
    const ok = await evaluate(`(() => {
      const badge = document.getElementById('cctv-source-badge');
      const video = document.getElementById('cctv-video');
      const frame = document.getElementById('cctv-frame');
      return {
        ok: true,
        badge: badge ? badge.textContent.trim() : null,
        videoHidden: video ? video.hidden : null,
        frameVisible: frame ? !frame.hidden : null,
      };
    })()`);
    console.log(JSON.stringify(ok, null, 2));
    break;
  }

  case 'open-panel': {
    const ok = await evaluate(`(() => {
      const panel = document.getElementById('cctv-panel');
      if (!panel) return { ok: false, reason: 'no cctv-panel' };
      panel.classList.remove('collapsed');
      panel.scrollIntoView({ block: 'start' });
      return { ok: true, collapsed: panel.classList.contains('collapsed') };
    })()`);
    console.log(JSON.stringify(ok, null, 2));
    break;
  }

  case 'read-current': {
    const ok = await evaluate(`(async () => {
      const dm = window.__godsEyeView && window.__godsEyeView.dataManager;
      const reader = dm && dm.layers && dm.layers.get('plate-reader');
      if (!reader?.module) return { ok: false, reason: 'plate-reader layer missing' };
      if (!dm.isEnabled('plate-reader'))
        await dm.toggle('plate-reader', { origin: 'programmatic' });
      await dm.waitForLayerSettled('plate-reader');
      const chip = reader.module
        .getRowControls()
        .chips.find((c) => c.id === 'read');
      if (!chip || chip.disabled)
        return { ok: false, reason: 'read chip not available' };
      chip.onClick();
      for (let i = 0; i < 40; i += 1) {
        const stats = reader.module.getStats();
        if (!stats.busy) return { ok: true, stats };
        await new Promise((r) => setTimeout(r, 1000));
      }
      return { ok: false, reason: 'read still busy after 40s', stats: reader.module.getStats() };
    })()`);
    console.log(JSON.stringify(ok, null, 2));
    break;
  }

  case 'read': {
    const ok = await evaluate(`(async () => {
      const dm = window.__godsEyeView && window.__godsEyeView.dataManager;
      const cctv = dm.layers.get('cctv');
      const reader = dm.layers.get('plate-reader');
      cctv.module.selectCamera(${JSON.stringify(arg)});
      if (!dm.isEnabled('plate-reader'))
        await dm.toggle('plate-reader', { origin: 'programmatic' });
      await dm.waitForLayerSettled('plate-reader');
      const chip = (reader.module.getRowControls().chips || []).find(
        (c) => c.id === 'read',
      );
      if (!chip || chip.disabled)
        return { ok: false, reason: 'read chip not available' };
      chip.onClick();
      for (let i = 0; i < 40; i += 1) {
        const stats = reader.module.getStats();
        if (!stats.busy) return { ok: true, stats };
        await new Promise((r) => setTimeout(r, 1000));
      }
      return { ok: false, reason: 'read still busy after 40s', stats: reader.module.getStats() };
    })()`);
    console.log(JSON.stringify(ok, null, 2));
    break;
  }

  case 'find': {
    const ok = await evaluate(`(async () => {
      const dm = window.__godsEyeView && window.__godsEyeView.dataManager;
      const cctv = dm && dm.layers && dm.layers.get('cctv');
      if (!cctv?.module?.getUIState) return { ok: false };
      const state = cctv.module.getUIState();
      const needle = ${JSON.stringify(arg)}.toLowerCase();
      const hits = state.cameras
        .filter(
          (c) =>
            String(c.id || '').toLowerCase().includes(needle) ||
            String(c.name || c.label || '').toLowerCase().includes(needle) ||
            String(c.code || '').toLowerCase().includes(needle),
        )
        .slice(0, 10)
        .map((c) => ({ id: c.id, name: c.name ?? c.label, code: c.code }));
      return { ok: true, total: state.cameras.length, hits };
    })()`);
    console.log(JSON.stringify(ok, null, 2));
    break;
  }

  case 'enable': {
    const ok = await evaluate(`(async () => {
      const dm = window.__godsEyeView && window.__godsEyeView.dataManager;
      await dm.toggle('cctv', { origin: 'programmatic' });
      const entry = dm.layers.get('cctv');
      return {
        ok: true,
        enabled: entry.enabled,
        lifecycle: entry.lifecycleState,
        stats: entry.module.getStats ? entry.module.getStats() : null,
      };
    })()`);
    console.log(JSON.stringify(ok, null, 2));
    break;
  }

  case 'set': {
    const ok = await evaluate(`(() => {
      const dm = window.__godsEyeView && window.__godsEyeView.dataManager;
      const cctv = dm.layers && dm.layers.get('cctv');
      if (!cctv?.module || typeof cctv.module.selectCamera !== 'function')
        return { ok: false, reason: 'cctv layer missing' };
      const found = cctv.module.selectCamera(${JSON.stringify(arg)});
      return { ok: found, selected: cctv.module.getParams().selectedCameraId };
    })()`);
    console.log(JSON.stringify(ok, null, 2));
    break;
  }

  default: {
    const state = await evaluate(`(async () => {
      const dm = window.__godsEyeView && window.__godsEyeView.dataManager;
      if (!dm) return { ok: false, reason: 'no __godsEyeView' };
      const out = { ok: true, url: location.href, layers: [] };
      for (const [id, entry] of dm.layers) {
        const module = entry.module || {};
        let stats = null;
        try { stats = module.getStats ? module.getStats() : null; } catch {}
        let params = null;
        try { params = module.getParams ? module.getParams() : null; } catch {}
        if (id === 'cctv' || id === 'alpr-cameras' || id.includes('alpr') || id === 'plate-reader') {
          out.layers.push({
            id,
            enabled: entry.enabled,
            lifecycle: entry.lifecycleState,
            stats,
            params: params && { selectedCameraId: params.selectedCameraId },
          });
        }
      }
      return out;
    })()`);
    console.log(JSON.stringify(state, null, 2));
  }
}

// The DevTools WebSocket keeps the event loop alive; a driver runs one action
// and leaves, so it must exit explicitly once its output is flushed.
process.exit(0);
