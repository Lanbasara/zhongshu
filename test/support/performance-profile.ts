/** Engineering acceptance profile, not a production SLA or a measurement result.
 * Harness resources are measured separately. A viewport is not a physical phone.
 */
export const performanceProfile = {
  id: 'long-term-v1',
  application: { cpuCores: 2, memoryBytes: 4 * 1024 ** 3, steadyRssBytes: 1024 ** 3 },
  host: { platform: 'linux', storage: 'local-ssd' },
  browser: { engine: 'chromium', width: 1280, height: 800, cpuThrottle: [1, 4], steadyHeapBytes: 256 * 1024 ** 2 },
  network: { roundTripMs: 80, bitsPerSecond: 10_000_000 },
  latency: { archiveVisibleP95Ms: 1000, inputPaintP95Ms: 100, saveBytesP95Ms: 500, idleEditWindowP95Ms: 5000 },
  data: { summaryItems: 50, summaryBytes: 256 * 1024, previewBytes: 8 * 1024, bodyChunkBytes: 64 * 1024, chatDomNodes: 5000 },
  corpus: { totalItems: [10_000, 100_000, 1_000_000], conversationItems: 60_000, workspaceConversations: [40, 1000], workspaces: 300, offlineItems: [2001, 20_000], directoryEntries: [201, 10_000] },
  soak: { durationHours: 24, sampleIntervalSeconds: 30 },
} as const;
