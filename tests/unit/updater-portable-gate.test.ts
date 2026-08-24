import { describe, expect, it, vi, beforeEach } from 'vitest';
import { autoUpdater } from 'electron-updater';

/**
 * Portable-mode update gate.
 *
 * Customer incident (pc-8308, 2026-08-24): a USB portable build v0.5.5 kept
 * prompting "update available: 0.5.4" — electron-updater compares the packaged
 * exe version against whatever latest.yml sits on OSS, and a stale feed makes
 * portable users nagged forever. Worse, an NSIS update downloaded on a USB
 * install cannot apply cleanly anyway (no installed-app entry).
 *
 * Decision: in portable mode the updater is a hard no-op — the constructor
 * skips all electron-updater wiring, every check reports status 'disabled',
 * and download/install never touch electron-updater.
 */

const hoist = vi.hoisted(() => ({
  portableMode: false,
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.5.5',
    isPackaged: true,
  },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: 'latest',
    setFeedURL: vi.fn(),
    on: vi.fn(),
    checkForUpdates: vi.fn(async () => {
      throw new Error('electron-updater must not be reached in portable mode');
    }),
    downloadUpdate: vi.fn(async () => {
      throw new Error('electron-updater download must not be reached in portable mode');
    }),
    quitAndInstall: vi.fn(() => {
      throw new Error('electron-updater quitAndInstall must not be reached in portable mode');
    }),
  },
}));

vi.mock('../../electron/utils/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/utils/paths')>();
  return {
    ...actual,
    isPortableMode: () => hoist.portableMode,
  };
});

import { AppUpdater } from '../../electron/main/updater';

describe('AppUpdater portable-mode gate', () => {
  beforeEach(() => {
    hoist.portableMode = false;
    vi.clearAllMocks();
    // Restore the throwing stubs cleared by clearAllMocks.
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(async () => {
      throw new Error('electron-updater must not be reached in portable mode');
    });
    vi.mocked(autoUpdater.downloadUpdate).mockImplementation(async () => {
      throw new Error('electron-updater download must not be reached in portable mode');
    });
    vi.mocked(autoUpdater.quitAndInstall).mockImplementation(() => {
      throw new Error('electron-updater quitAndInstall must not be reached in portable mode');
    });
  });

  it('reaches electron-updater when not portable', async () => {
    hoist.portableMode = false;
    const updater = new AppUpdater();
    await expect(updater.checkForUpdates()).rejects.toThrow(
      'electron-updater must not be reached in portable mode',
    );
    expect(updater.getStatus().status).toBe('error');
    expect(autoUpdater.setFeedURL).toHaveBeenCalled();
  });

  it('reports disabled and never wires electron-updater in portable mode', async () => {
    hoist.portableMode = true;
    const updater = new AppUpdater();

    expect(updater.getStatus().status).toBe('disabled');
    // Constructor short-circuits before any electron-updater configuration.
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(autoUpdater.on).not.toHaveBeenCalled();

    const result = await updater.checkForUpdates();
    expect(result).toBeNull();
    expect(updater.getStatus().status).toBe('disabled');
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('suppresses download in portable mode', async () => {
    hoist.portableMode = true;
    const updater = new AppUpdater();
    await updater.downloadUpdate();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('suppresses quitAndInstall in portable mode', () => {
    hoist.portableMode = true;
    const updater = new AppUpdater();
    updater.quitAndInstall();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});
