import * as fs from "fs/promises";
import * as path from "path";
import moment from "moment";
import { getSafeFilePath } from "./utils.js";

const DEFAULT_DAILY_NOTE_FORMAT = "YYYY-MM-DD";

export async function getDailyNoteConfig(
    vaultPath: string,
): Promise<{ folder: string; format: string }> {
    let configPath: string;
    try {
        configPath = getSafeFilePath(vaultPath, path.join(".obsidian", "daily-notes.json"));
    } catch {
        // A .obsidian folder symlinked outside the vault boundary (a common
        // way to share settings between vaults) is a config lookup, not a
        // note access: fall back to defaults instead of failing the tool.
        console.error(
            "Daily-notes config resolves outside the vault boundary; using defaults. " +
            "Add the real .obsidian location to OBSIDIAN_ALLOWED_VAULTS to use it.",
        );
        return { folder: "", format: DEFAULT_DAILY_NOTE_FORMAT };
    }
    try {
        const data = await fs.readFile(configPath, "utf-8");
        const config = JSON.parse(data);
        let folder = String(config.folder || "").trim();

        folder = folder.replace(/^[\\/]+|[\\/]+$/g, "");
        if (folder.split(/[\\/]/).some((segment) => segment === "..")) {
            throw new Error(`Invalid daily note folder (traversal): ${folder}`);
        }

        return {
            folder,
            format: config.format || DEFAULT_DAILY_NOTE_FORMAT,
        };
    } catch (error: any) {
        if (error.message?.includes("traversal")) throw error;
        return { folder: "", format: DEFAULT_DAILY_NOTE_FORMAT };
    }
}

export async function getOrCreateDailyNote(
    vaultPath: string,
): Promise<{ file_path: string; content: string }> {
    const dailyConfig = await getDailyNoteConfig(vaultPath);
    const relativePath = path.join(
        dailyConfig.folder,
        moment().format(dailyConfig.format) + ".md",
    );
    const filePath = getSafeFilePath(vaultPath, relativePath);
    let content = "";
    try {
        content = await fs.readFile(filePath, "utf-8");
    } catch {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        content = `# ${moment().format(dailyConfig.format)}\n\n`;
        await fs.writeFile(filePath, content, "utf-8");
    }
    return { file_path: path.relative(vaultPath, filePath), content };
}
