// ============================================================
//  backend/lib/historyManager.js
//  Manages separate history files for each sensor module
// ============================================================
const fs = require("fs").promises;
const path = require("path");

class HistoryManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.historiesDir = path.join(dataDir, "histories");
  }

  async init() {
    try {
      await fs.mkdir(this.historiesDir, { recursive: true });
      console.log(`[HISTORY] Initialized histories directory: ${this.historiesDir}`);
    } catch (err) {
      console.warn(`[HISTORY] Failed to create histories directory:`, err.message);
    }
  }

  async addEntry(module, entry) {
    if (!entry) return;
    const file = path.join(this.historiesDir, `${module}-history.json`);
    try {
      let data = [];
      try {
        const content = await fs.readFile(file, "utf8");
        data = JSON.parse(content);
      } catch (e) {
        // File doesn't exist yet, start fresh
        data = [];
      }
      
      // Add entry with timestamp if not present
      const entryWithTs = { ...entry, ts: entry.ts || Date.now() };
      data.push(entryWithTs);
      
      // Keep only last N entries
      const limit = this.limits[module] || 500;
      if (data.length > limit) {
        data = data.slice(-limit);
      }
      
      await fs.writeFile(file, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn(`[HISTORY] Failed to add ${module} entry:`, err.message);
    }
  }

  async addMultiple(module, entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const file = path.join(this.historiesDir, `${module}-history.json`);
    try {
      let data = [];
      try {
        const content = await fs.readFile(file, "utf8");
        data = JSON.parse(content);
      } catch (e) {
        data = [];
      }
      
      const limit = this.limits[module] || 500;
      const withTs = entries.map(e => ({ ...e, ts: e.ts || Date.now() }));
      data.push(...withTs);
      
      if (data.length > limit) {
        data = data.slice(-limit);
      }
      
      await fs.writeFile(file, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn(`[HISTORY] Failed to add ${module} entries:`, err.message);
    }
  }

  async getHistory(module) {
    const file = path.join(this.historiesDir, `${module}-history.json`);
    try {
      const content = await fs.readFile(file, "utf8");
      return JSON.parse(content);
    } catch (err) {
      return [];
    }
  }

  async clearHistory(module) {
    const file = path.join(this.historiesDir, `${module}-history.json`);
    try {
      await fs.unlink(file);
      console.log(`[HISTORY] Cleared ${module} history`);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn(`[HISTORY] Failed to clear ${module} history:`, err.message);
      }
    }
  }

  async cleanup(olderThanDays = 30) {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    try {
      const files = await fs.readdir(this.historiesDir);
      for (const file of files) {
        const filePath = path.join(this.historiesDir, file);
        try {
          const content = await fs.readFile(filePath, "utf8");
          let data = JSON.parse(content);
          const originalLen = data.length;
          data = data.filter(e => (e.ts || 0) > cutoff);
          
          if (data.length < originalLen) {
            await fs.writeFile(filePath, JSON.stringify(data, null, 2));
            console.log(`[HISTORY] Cleaned ${file}: ${originalLen} → ${data.length}`);
          }
        } catch (err) {
          console.warn(`[HISTORY] Error processing ${file}:`, err.message);
        }
      }
    } catch (err) {
      console.warn(`[HISTORY] Cleanup failed:`, err.message);
    }
  }

  setLimits(limits) {
    this.limits = limits || {
      adsb: 500,
      wifi: 200,
      ble: 200,
      rf433: 200,
      nrf24: 50,
      lora: 100,
      nethunter: 100,
      alerts: 200,
    };
  }
}

module.exports = HistoryManager;
