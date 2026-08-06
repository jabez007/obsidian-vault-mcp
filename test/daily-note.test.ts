import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import moment from 'moment';
import { getDailyNoteConfig } from '../src/index';

describe('Daily Note Logic', () => {
  let vaultDir: string;
  const fixedDate = '2026-04-13';

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-note-test-'));
    // Mock system time for moment() - use midday to avoid timezone shifts
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:00:00'));
  });

  afterEach(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('respects simple folder and format from .obsidian/daily-notes.json', async () => {
    const obsidianDir = path.join(vaultDir, '.obsidian');
    await fs.mkdir(obsidianDir, { recursive: true });
    
    const config = {
      folder: 'Journal',
      format: 'YYYY-MM-DD'
    };
    await fs.writeFile(path.join(obsidianDir, 'daily-notes.json'), JSON.stringify(config));

    const dailyConfig = await getDailyNoteConfig(vaultDir);
    const dateStr = moment().format(dailyConfig.format);
    const relativePath = path.join(dailyConfig.folder, dateStr + '.md');
    
    expect(dailyConfig.folder).toBe('Journal');
    expect(dailyConfig.format).toBe('YYYY-MM-DD');
    expect(relativePath).toBe(path.join('Journal', `${fixedDate}.md`));
  });

  it('handles nested date formats (subfolders)', async () => {
    const obsidianDir = path.join(vaultDir, '.obsidian');
    await fs.mkdir(obsidianDir, { recursive: true });
    
    const config = {
      folder: 'JRNL',
      format: 'YYYY/MM/YYYY-MM-DD'
    };
    await fs.writeFile(path.join(obsidianDir, 'daily-notes.json'), JSON.stringify(config));

    const dailyConfig = await getDailyNoteConfig(vaultDir);
    const datePath = moment().format(dailyConfig.format);
    const relativePath = path.join(dailyConfig.folder, datePath + '.md');
    
    const expectedDatePath = path.join('2026', '04', '2026-04-13');
    expect(relativePath).toBe(path.join('JRNL', `${expectedDatePath}.md`));
  });

  it('sanitizes leading slashes and trailing whitespace in folder', async () => {
    const obsidianDir = path.join(vaultDir, '.obsidian');
    await fs.mkdir(obsidianDir, { recursive: true });
    
    const config = {
      folder: ' /Internal/Daily/ ',
      format: 'YYYY-MM-DD'
    };
    await fs.writeFile(path.join(obsidianDir, 'daily-notes.json'), JSON.stringify(config));

    const dailyConfig = await getDailyNoteConfig(vaultDir);
    expect(dailyConfig.folder).toBe(path.join('Internal', 'Daily'));
  });

  it('rejects path traversal in daily note folder', async () => {
    const obsidianDir = path.join(vaultDir, '.obsidian');
    await fs.mkdir(obsidianDir, { recursive: true });
    
    const config = {
      folder: '../outside',
      format: 'YYYY-MM-DD'
    };
    await fs.writeFile(path.join(obsidianDir, 'daily-notes.json'), JSON.stringify(config));

    await expect(getDailyNoteConfig(vaultDir)).rejects.toThrow('traversal');
  });

  it('falls back to defaults when .obsidian is a symlink pointing outside the vault', async () => {
    const sharedConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-obsidian-'));
    try {
      await fs.writeFile(
        path.join(sharedConfigDir, 'daily-notes.json'),
        JSON.stringify({ folder: 'Journal', format: 'YYYY-MM-DD' }),
      );
      await fs.symlink(sharedConfigDir, path.join(vaultDir, '.obsidian'), 'dir');

      const dailyConfig = await getDailyNoteConfig(vaultDir);

      expect(dailyConfig.folder).toBe('');
      expect(dailyConfig.format).toBe('YYYY-MM-DD');
    } finally {
      await fs.rm(sharedConfigDir, { recursive: true, force: true });
    }
  });

  it('falls back to defaults if config is missing', async () => {
    const dailyConfig = await getDailyNoteConfig(vaultDir);
    const dateStr = fixedDate;
    
    expect(dailyConfig.folder).toBe('');
    expect(dailyConfig.format).toBe('YYYY-MM-DD');
    expect(path.join(dailyConfig.folder, dateStr + '.md')).toBe(`${dateStr}.md`);
  });
});
