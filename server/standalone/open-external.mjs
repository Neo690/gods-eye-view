import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Open one page in the machine's own browser.
 *
 * Provider Settings shows a "GET KEY" link per provider, and inside a shell
 * that owns the page — the packaged Electron app loads the app in its own
 * window — a plain `target="_blank"` anchor opens a second IN-APP window
 * instead of the user's browser, where they cannot sign in to the provider with
 * their stored session. So the panel asks this machine to open it, and this
 * module is what actually launches something.
 *
 * Brave is preferred when it is installed (the desktop panel exists to get
 * provider keys, and a Chromium profile with the providers already signed in is
 * where those keys live); otherwise the platform's own "open this URL" command
 * hands the page to whatever browser the user has made default. Nothing here
 * decides WHAT may be opened — the caller validates the URL against the
 * registry's sign-up pages first (keySetupKeyUrl, src/keySetupCore.mjs), and
 * every dependency is injectable so the launch plan is unit-testable without
 * starting a process.
 */

/** Every place a Brave install keeps its executable, per platform. */
function braveExecutables({ platform, environment }) {
  if (platform === 'win32') {
    const roots = [
      environment.LOCALAPPDATA,
      environment.ProgramFiles,
      environment['ProgramFiles(x86)'],
    ].filter((root) => typeof root === 'string' && root.trim() !== '');
    return roots.map((root) =>
      path.win32.join(
        root,
        'BraveSoftware',
        'Brave-Browser',
        'Application',
        'brave.exe',
      ),
    );
  }
  return [];
}

/**
 * The ordered attempts for one URL: Brave first when we can name its
 * executable (Windows), then the platform's default-browser command, which is
 * also the only fallback on macOS and Linux where Brave is found by name.
 * @returns {Array<{command: string, args: string[], kind: 'brave'|'default'}>}
 */
export function browserLaunchPlan(
  url,
  {
    platform = process.platform,
    fileSystem = fs,
    environment = process.env,
  } = {},
) {
  const target = String(url ?? '').trim();
  if (!target) return [];
  const plan = [];
  if (platform === 'win32') {
    for (const executable of braveExecutables({ platform, environment })) {
      try {
        if (fileSystem.existsSync(executable))
          plan.push({ command: executable, args: [target], kind: 'brave' });
      } catch {
        // An unreadable candidate is simply not a candidate.
      }
    }
    // explorer.exe hands a URL to the user's default browser; SystemRoot is
    // where a Windows install keeps it, and the module never consults PATH.
    const systemRoot =
      typeof environment.SystemRoot === 'string' &&
      /^[A-Za-z]:\\Windows\\?$/i.test(environment.SystemRoot.trim())
        ? environment.SystemRoot.trim().replace(/\\$/, '')
        : 'C:\\Windows';
    plan.push({
      command: path.win32.join(systemRoot, 'explorer.exe'),
      args: [target],
      kind: 'default',
    });
    return plan;
  }
  if (platform === 'darwin') {
    plan.push({
      command: 'open',
      args: ['-a', 'Brave Browser', target],
      kind: 'brave',
    });
    plan.push({ command: 'open', args: [target], kind: 'default' });
    return plan;
  }
  plan.push({ command: 'brave-browser', args: [target], kind: 'brave' });
  plan.push({ command: 'xdg-open', args: [target], kind: 'default' });
  return plan;
}

/**
 * Launch the first attempt that actually starts. Detached and ignored: the
 * browser is the user's own long-lived process, not a child of this server.
 * @returns {Promise<'brave'|'default'|null>} which kind opened it, or null.
 */
export async function openUrlInBrowser(
  url,
  {
    platform = process.platform,
    spawnImpl = spawn,
    fileSystem = fs,
    environment = process.env,
  } = {},
) {
  const plan = browserLaunchPlan(url, { platform, fileSystem, environment });
  for (const step of plan) {
    const started = await new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(step.command, step.args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        resolve(false);
        return;
      }
      if (!child || typeof child.once !== 'function') {
        resolve(false);
        return;
      }
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref?.();
        resolve(true);
      });
    });
    if (started) return step.kind;
  }
  return null;
}
