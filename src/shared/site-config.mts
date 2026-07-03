// Generated from site.config.json. Do not edit.

export const SITE_CONFIG = Object.freeze({
  "siteName": "Any Router",
  "pluginId": "anyrouter-status-monitor",
  "marketplace": {
    "name": "router-vitals",
    "owner": "Victor-Quqi",
    "repoUrl": "https://github.com/Victor-Quqi/router-vitals"
  },
  "endpoints": [
    {
      "id": "main",
      "host": "anyrouter.top",
      "label": "主站直连"
    },
    {
      "id": "optimized",
      "host": "a-ocnfniawgw.cn-shanghai.fcapp.run",
      "label": "大陆优化"
    }
  ],
  "defaultApiBaseUrl": "https://router-vitals-api.v1756251285.workers.dev",
  "statusPageUrl": "https://router-vitals.pages.dev",
  "cloudflare": {
    "workerName": "router-vitals-api",
    "previewWorkerName": "router-vitals-preview",
    "d1Name": "router-vitals",
    "pagesProject": "router-vitals"
  }
} as const);

export const SITE_NAME = SITE_CONFIG.siteName;
export const SITE_ENDPOINTS = SITE_CONFIG.endpoints;
export const PLUGIN_ID = SITE_CONFIG.pluginId;
export const MARKETPLACE_NAME = SITE_CONFIG.marketplace.name;
export const MARKETPLACE_OWNER = SITE_CONFIG.marketplace.owner;
export const MARKETPLACE_REPO_URL = SITE_CONFIG.marketplace.repoUrl;
export const PLUGIN_FULL_ID = `${PLUGIN_ID}@${MARKETPLACE_NAME}`;
export const PLUGIN_DATA_DIR_NAME = `${PLUGIN_ID}-${MARKETPLACE_NAME}`;
export const STATUSLINE_LAUNCHER_FILE_NAME = `${MARKETPLACE_NAME}-statusline.mjs`;
