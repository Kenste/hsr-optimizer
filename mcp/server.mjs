#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { chromium } from 'playwright'
import { z } from 'zod/v4'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const DEFAULT_PORT = Number(process.env.HSR_MCP_PORT ?? 3210)
const DEFAULT_APP_URL = `http://127.0.0.1:${DEFAULT_PORT}/hsr-optimizer`
const APP_URL = process.env.HSR_MCP_APP_URL ?? DEFAULT_APP_URL
const START_APP = process.env.HSR_MCP_START_APP !== '0' && !process.env.HSR_MCP_APP_URL
const SYSTEM_CHROMIUM_PATH = '/usr/bin/chromium'

function getChromiumExecutablePath() {
  if (process.env.HSR_MCP_CHROMIUM_PATH === 'bundled') return undefined
  if (process.env.HSR_MCP_CHROMIUM_PATH) return process.env.HSR_MCP_CHROMIUM_PATH
  return existsSync(SYSTEM_CHROMIUM_PATH) ? SYSTEM_CHROMIUM_PATH : undefined
}

function getChromiumArgs() {
  const defaultArgs = [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE',
    '--use-angle=vulkan',
    '--disable-vulkan-surface',
    '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage',
  ]
  const extraArgs = process.env.HSR_MCP_CHROMIUM_ARGS?.split(/\s+/).filter(Boolean) ?? []
  return [...defaultArgs, ...extraArgs]
}

function jsonResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function appendMcpParam(url) {
  const parsed = new URL(url)
  parsed.searchParams.set('mcp', '1')
  return parsed.toString()
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const start = Date.now()
  let lastError
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for app at ${url}${lastError ? `: ${errorMessage(lastError)}` : ''}`)
}

class AppBridge {
  browser = null
  page = null
  appProcess = null

  async ensure() {
    if (this.page) return

    if (START_APP) {
      this.appProcess = spawn(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['run', 'start', '--', '--host', '127.0.0.1', '--port', String(DEFAULT_PORT), '--strictPort', 'false', '--open', 'false'],
        {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            BROWSER: 'none',
          },
        },
      )
      this.appProcess.stdout?.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`))
      this.appProcess.stderr?.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`))
    }

    await waitForHttp(APP_URL)

    this.browser = await chromium.launch({
      executablePath: getChromiumExecutablePath(),
      headless: true,
      args: getChromiumArgs(),
    })
    const context = await this.browser.newContext()
    this.page = await context.newPage()
    this.page.on('console', (msg) => {
      if (process.env.HSR_MCP_BROWSER_LOGS === '1') {
        process.stderr.write(`[browser:${msg.type()}] ${msg.text()}\n`)
      }
    })
    await this.page.goto(appendMcpParam(APP_URL), { waitUntil: 'domcontentloaded' })
    await this.page.waitForFunction(() => Boolean(window.__HSR_MCP__), null, { timeout: 60_000 })
  }

  async call(method, args = undefined) {
    await this.ensure()
    return this.page.evaluate(
      async ({ method, args }) => {
        const bridge = window.__HSR_MCP__
        if (!bridge) throw new Error('HSR MCP bridge is not installed')
        const fn = bridge[method]
        if (typeof fn !== 'function') throw new Error(`HSR MCP bridge method not found: ${method}`)
        return await fn(args)
      },
      { method, args },
    )
  }

  async close() {
    await this.browser?.close().catch(() => {})
    this.appProcess?.kill('SIGTERM')
  }
}

const app = new AppBridge()
const jobs = new Map()
const queue = []
let activeJob = null

function publicJob(job) {
  return {
    jobId: job.id,
    contextId: job.contextId,
    status: job.status,
    queuePosition: job.status === 'queued' ? queue.findIndex((candidate) => candidate.id === job.id) + 1 : 0,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    startResult: job.startResult,
    finalStatus: job.finalStatus,
    resultCount: job.results?.length ?? 0,
    error: job.error,
    pollAfterMs: ['queued', 'running'].includes(job.status) ? 1000 : undefined,
  }
}

async function collectOptimizationResults() {
  const first = await app.call('getOptimizationResults', { limit: 0, offset: 0 })
  const total = first.total ?? 0
  const items = []
  const pageSize = 200
  for (let offset = 0; offset < total; offset += pageSize) {
    const page = await app.call('getOptimizationResults', { limit: pageSize, offset, includeRelics: false, includeZeroStats: true })
    items.push(...(page.items ?? []))
  }
  return items
}

function trimZeroStats(item) {
  if (!item?.stats) return item
  return {
    ...item,
    stats: Object.fromEntries(Object.entries(item.stats).filter(([, value]) => value !== 0)),
  }
}

async function drainQueue() {
  if (activeJob || queue.length === 0) return

  const job = queue.shift()
  activeJob = job
  job.status = 'running'
  job.startedAt = new Date().toISOString()

  try {
    job.startResult = await app.call(job.method, job.params)

    for (;;) {
      if (job.cancelRequested) {
        await app.call('cancelOptimization')
        throw new Error('Optimization cancelled')
      }

      const status = await app.call('getOptimizationStatus')
      job.finalStatus = status
      if (status.status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 750))
    }

    job.results = await collectOptimizationResults()
    job.status = 'succeeded'
  } catch (error) {
    job.status = job.cancelRequested ? 'cancelled' : 'failed'
    job.error = errorMessage(error)
  } finally {
    job.completedAt = new Date().toISOString()
    activeJob = null
    void drainQueue()
  }
}

function enqueueOptimization(params, contextId, method = 'startOptimization') {
  const job = {
    id: randomUUID(),
    contextId,
    type: 'optimization',
    method,
    status: 'queued',
    params,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    startResult: null,
    finalStatus: null,
    results: null,
    error: null,
    cancelRequested: false,
  }
  jobs.set(job.id, job)
  queue.push(job)
  void drainQueue()
  return job
}

function cancelQueuedJobs(reason = 'Context was replaced') {
  for (const job of queue.splice(0)) {
    job.status = 'cancelled'
    job.error = reason
    job.completedAt = new Date().toISOString()
  }
}

async function readJsonInput({ json, filePath }) {
  if (json !== undefined) {
    return typeof json === 'string' ? JSON.parse(json) : json
  }
  if (!filePath) throw new Error('Provide either json or filePath')
  return JSON.parse(await readFile(filePath, 'utf8'))
}

let activeContextId = null

const server = new McpServer({
  name: 'hsr-optimizer',
  version: '0.1.0',
})

server.registerTool(
  'load_account_context',
  {
    title: 'Load account context',
    description: 'Load an HSR Optimizer save file or one of the app-supported scanner JSON formats.',
    inputSchema: {
      json: z.any().optional(),
      filePath: z.string().optional(),
    },
  },
  async (input) => {
    const parsed = await readJsonInput(input)
    cancelQueuedJobs()
    if (activeJob) {
      activeJob.cancelRequested = true
      await app.call('cancelOptimization').catch(() => {})
    }
    const result = await app.call('loadAccountContext', parsed)
    activeContextId = result.contextId
    return jsonResult(result)
  },
)

server.registerTool(
  'get_context_summary',
  {
    title: 'Get context summary',
    description: 'Return account-level counts for the active context.',
  },
  async () => jsonResult(await app.call('getContextSummary')),
)

server.registerTool(
  'list_characters',
  {
    title: 'List characters',
    description: 'List characters present in the active account context. By default returns only id and name.',
    inputSchema: {
      summary: z.boolean().optional(),
    },
  },
  async (input) => jsonResult(await app.call('listCharacters', input)),
)

server.registerTool(
  'get_character_details',
  {
    title: 'Get character details',
    description: 'Return concise account-specific character build details: light cone, equipped stats, and relic score summary.',
    inputSchema: {
      characterId: z.string().optional(),
      name: z.string().optional(),
    },
  },
  async (input) => jsonResult(await app.call('getCharacterDetails', input)),
)

server.registerTool(
  'get_character_relics',
  {
    title: 'Get character relics',
    description: 'Return full equipped relic details and relic scores for a character.',
    inputSchema: {
      characterId: z.string().optional(),
      name: z.string().optional(),
    },
  },
  async (input) => jsonResult(await app.call('getCharacterRelics', input)),
)

server.registerTool(
  'list_relic_sets',
  {
    title: 'List relic sets',
    description: 'List valid 4-piece relic set names for optimizer requestPatch fields such as relicSets and setFilters.fourPiece/twoPieceCombos.',
  },
  async () => jsonResult(await app.call('listRelicSets')),
)

server.registerTool(
  'list_ornament_sets',
  {
    title: 'List ornament sets',
    description: 'List valid 2-piece planar ornament set names for optimizer requestPatch fields such as ornamentSets and setFilters.ornaments.',
  },
  async () => jsonResult(await app.call('listOrnamentSets')),
)

server.registerTool(
  'list_relics',
  {
    title: 'List relics',
    description: 'List relics with optional filters and pagination. Relics include substats and previewSubstats; previewSubstats are locked/future substats already shown by HSR/import data for underleveled relics, not optimizer predictions.',
    inputSchema: {
      filters: z.record(z.string(), z.any()).optional(),
      limit: z.number().int().positive().optional(),
      cursor: z.number().int().nonnegative().optional(),
      scoreCharacterId: z.string().optional(),
    },
  },
  async (input) => jsonResult(await app.call('listRelics', input)),
)

server.registerTool(
  'get_relic_details',
  {
    title: 'Get relic details',
    description: 'Return full relic details and optional character-relative current score. Set includePotential for future/reroll potential analysis. previewSubstats are locked/future substats already shown by HSR/import data for underleveled relics, not optimizer predictions.',
    inputSchema: {
      relicId: z.string(),
      scoreCharacterId: z.string().optional(),
      includePotential: z.boolean().optional(),
    },
  },
  async (input) => jsonResult(await app.call('getRelicDetails', input)),
)

server.registerTool(
  'list_light_cones',
  {
    title: 'List light cones',
    description: 'List equipped account light cones or all game light cones. Provide characterId to filter to path-compatible light cones.',
    inputSchema: {
      source: z.enum(['equipped', 'game']).optional(),
      characterId: z.string().optional(),
    },
  },
  async (input) => jsonResult(await app.call('listLightCones', input)),
)

server.registerTool(
  'get_optimizer_options',
  {
    title: 'Get optimizer options',
    description: 'Return concise optimizer defaults, supported sort options, main stat options, stat weights, and requestPatch field names for a character.',
    inputSchema: {
      characterId: z.string().optional(),
      name: z.string().optional(),
    },
  },
  async (input) => jsonResult(await app.call('getOptimizerOptions', input)),
)

server.registerTool(
  'create_optimizer_draft',
  {
    title: 'Create optimizer draft',
    description: 'Create an editable optimizer draft for one character. Use draft patch tools to configure setup, filters, team, conditionals, enemy, and rotation before queuing an optimization.',
    inputSchema: {
      characterId: z.string().optional(),
      name: z.string().optional(),
      requestPatch: z.record(z.string(), z.any()).optional(),
    },
  },
  async (input) => jsonResult(await app.call('createOptimizerDraft', input)),
)

server.registerTool(
  'get_optimizer_draft',
  {
    title: 'Get optimizer draft',
    description: 'Return the current optimizer draft summary. sections can limit output to setup, relicFilters, team, conditionals, enemy, rotation, or advanced.',
    inputSchema: {
      draftId: z.string(),
      sections: z.array(z.enum(['setup', 'relicFilters', 'team', 'conditionals', 'enemy', 'rotation', 'advanced'])).optional(),
    },
  },
  async (input) => jsonResult(await app.call('getOptimizerDraft', input)),
)

server.registerTool(
  'patch_optimizer_setup',
  {
    title: 'Patch optimizer setup',
    description: 'Patch draft setup fields: characterLevel, characterEidolon, lightCone, lightConeLevel, lightConeSuperimposition, and resultsLimit.',
    inputSchema: {
      draftId: z.string(),
      patch: z.record(z.string(), z.any()),
    },
  },
  async (input) => jsonResult(await app.call('patchOptimizerSetup', input)),
)

server.registerTool(
  'patch_optimizer_relic_filters',
  {
    title: 'Patch optimizer relic filters',
    description: 'Patch draft relic/scoring filters: main stat filters, set filters, equipped/rank filters, weights, resultMinFilter, enhance, grade, and exclude.',
    inputSchema: {
      draftId: z.string(),
      patch: z.record(z.string(), z.any()),
    },
  },
  async (input) => jsonResult(await app.call('patchOptimizerRelicFilters', input)),
)

server.registerTool(
  'patch_optimizer_team',
  {
    title: 'Patch optimizer team',
    description: 'Patch draft teammates. Provide teammates as [{slot:0|1|2, characterId, useAccountBuild?:true, ...overrides}] or {slot, clear:true}. Account builds copy eidolon, light cone, SI, and active team set effects.',
    inputSchema: {
      draftId: z.string(),
      teammates: z.array(z.record(z.string(), z.any())),
    },
  },
  async (input) => jsonResult(await app.call('patchOptimizerTeam', input)),
)

server.registerTool(
  'patch_optimizer_conditionals',
  {
    title: 'Patch optimizer conditionals',
    description: 'Patch draft conditional values. Targets: character, lightCone, sets, teammate0.character, teammate0.lightCone, teammate1.character, teammate1.lightCone, teammate2.character, teammate2.lightCone.',
    inputSchema: {
      draftId: z.string(),
      target: z.enum(['character', 'lightCone', 'sets', 'teammate0.character', 'teammate0.lightCone', 'teammate1.character', 'teammate1.lightCone', 'teammate2.character', 'teammate2.lightCone']),
      values: z.record(z.string(), z.union([z.boolean(), z.number()])),
    },
  },
  async (input) => jsonResult(await app.call('patchOptimizerConditionals', input)),
)

server.registerTool(
  'patch_optimizer_enemy',
  {
    title: 'Patch optimizer enemy',
    description: 'Patch draft enemy settings: enemyLevel, enemyCount, enemyResistance, enemyEffectResistance, enemyMaxToughness, enemyElementalWeak, enemyWeaknessBroken.',
    inputSchema: {
      draftId: z.string(),
      patch: z.record(z.string(), z.any()),
    },
  },
  async (input) => jsonResult(await app.call('patchOptimizerEnemy', input)),
)

server.registerTool(
  'patch_optimizer_rotation',
  {
    title: 'Patch optimizer rotation',
    description: 'Patch draft combo/rotation settings: comboType, comboPreprocessor, comboTurnAbilities, combo, comboDot, comboStateJson.',
    inputSchema: {
      draftId: z.string(),
      patch: z.record(z.string(), z.any()),
    },
  },
  async (input) => jsonResult(await app.call('patchOptimizerRotation', input)),
)

server.registerTool(
  'get_optimizer_setup_options',
  {
    title: 'Get optimizer setup options',
    description: 'Return setup choices for a draft: eidolons, levels, superimpositions, equipped light cones, and current setup.',
    inputSchema: {
      draftId: z.string(),
    },
  },
  async (input) => jsonResult(await app.call('getOptimizerSetupOptions', input)),
)

server.registerTool(
  'get_optimizer_filter_options',
  {
    title: 'Get optimizer filter options',
    description: 'Return current relic filter choices for a draft: main stat filters, weights, setFilters, patch field names, and pointers to set-list tools.',
    inputSchema: {
      draftId: z.string(),
    },
  },
  async (input) => jsonResult(await app.call('getOptimizerFilterOptions', input)),
)

server.registerTool(
  'get_optimizer_team_options',
  {
    title: 'Get optimizer team options',
    description: 'Return possible teammate candidates from the account. By default returns compact id/name/eidolon rows; set details to include account light cone/SI and active team set effects.',
    inputSchema: {
      draftId: z.string(),
      details: z.boolean().optional(),
    },
  },
  async (input) => jsonResult(await app.call('getOptimizerTeamOptions', input)),
)

server.registerTool(
  'get_optimizer_conditionals',
  {
    title: 'Get optimizer conditionals',
    description: 'Return configurable conditional controls for a draft target and their current/default values. Use patch_optimizer_conditionals to set values.',
    inputSchema: {
      draftId: z.string(),
      target: z.enum(['character', 'lightCone', 'sets', 'teammate0.character', 'teammate0.lightCone', 'teammate1.character', 'teammate1.lightCone', 'teammate2.character', 'teammate2.lightCone']),
    },
  },
  async (input) => jsonResult(await app.call('getOptimizerConditionals', input)),
)

server.registerTool(
  'get_optimizer_rotation_options',
  {
    title: 'Get optimizer rotation options',
    description: 'Return combo type and turn ability names available for draft rotation configuration.',
    inputSchema: {
      draftId: z.string(),
    },
  },
  async (input) => jsonResult(await app.call('getOptimizerRotationOptions', input)),
)

server.registerTool(
  'validate_optimizer_draft',
  {
    title: 'Validate optimizer draft',
    description: 'Check whether a draft has candidate relics for every slot and return a cheap naive permutation estimate before queuing the long-running optimization.',
    inputSchema: {
      draftId: z.string(),
    },
  },
  async (input) => jsonResult(await app.call('validateOptimizerDraft', input)),
)

server.registerTool(
  'start_optimization_from_draft',
  {
    title: 'Start optimization from draft',
    description: 'Queue a long-running optimizer job from a configured draft. Jobs are serialized; poll get_optimization_status until complete, then fetch results.',
    inputSchema: {
      draftId: z.string(),
      resultsLimit: z.number().int().positive().optional(),
      computeEngine: z.enum(['auto', 'gpu', 'cpu']).optional(),
    },
  },
  async (input) => {
    const job = enqueueOptimization(input, activeContextId, 'startOptimizationFromDraft')
    return jsonResult(publicJob(job))
  },
)

server.registerTool(
  'start_optimization',
  {
    title: 'Start optimization',
    description: 'Advanced/raw endpoint: queue an optimizer job from a direct requestPatch. Prefer the draft workflow for normal use: create_optimizer_draft, patch the relevant sections, validate_optimizer_draft, then start_optimization_from_draft. Poll get_optimization_status until completion, then fetch results.',
    inputSchema: {
      characterId: z.string().optional(),
      name: z.string().optional(),
      requestPatch: z.record(z.string(), z.any()).optional(),
      resultsLimit: z.number().int().positive().optional(),
      computeEngine: z.enum(['auto', 'gpu', 'cpu']).optional(),
    },
  },
  async (input) => {
    const job = enqueueOptimization(input, activeContextId)
    return jsonResult(publicJob(job))
  },
)

server.registerTool(
  'get_optimization_status',
  {
    title: 'Get optimization status',
    description: 'Return queued/running/completed status for an optimization job.',
    inputSchema: {
      jobId: z.string(),
    },
  },
  async ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)
    if (job.status === 'running') {
      job.finalStatus = await app.call('getOptimizationStatus').catch(() => job.finalStatus)
    }
    return jsonResult(publicJob(job))
  },
)

server.registerTool(
  'get_optimization_results',
  {
    title: 'Get optimization results',
    description: 'Return paginated optimization results for a completed or running job. Result rows include relicIds and summarized nonzero stats by default, not raw optimizer trace data. Set includeZeroStats to include zero-valued stat fields.',
    inputSchema: {
      jobId: z.string(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
      includeZeroStats: z.boolean().optional(),
    },
  },
  async ({ jobId, limit = 25, offset = 0, includeZeroStats = false }) => {
    const job = jobs.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)
    const pageLimit = Math.min(limit, 200)

    if (job.status === 'running') {
      return jsonResult(await app.call('getOptimizationResults', { limit: pageLimit, offset, includeRelics: false, includeZeroStats }))
    }

    const results = job.results ?? []
    const items = results.slice(offset, offset + pageLimit)
    return jsonResult({
      jobId,
      status: job.status,
      total: results.length,
      offset,
      limit: pageLimit,
      items: includeZeroStats ? items : items.map(trimZeroStats),
    })
  },
)

server.registerTool(
  'cancel_job',
  {
    title: 'Cancel job',
    description: 'Cancel a queued or running optimization job.',
    inputSchema: {
      jobId: z.string(),
    },
  },
  async ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    if (job.status === 'queued') {
      const index = queue.findIndex((candidate) => candidate.id === jobId)
      if (index >= 0) queue.splice(index, 1)
      job.status = 'cancelled'
      job.completedAt = new Date().toISOString()
      job.error = 'Cancelled'
    } else if (job.status === 'running') {
      job.cancelRequested = true
      await app.call('cancelOptimization')
      job.status = 'cancelled'
      job.completedAt = new Date().toISOString()
      job.error = 'Cancelled'
    }

    return jsonResult(publicJob(job))
  },
)

server.registerTool(
  'simulate_build',
  {
    title: 'Simulate build',
    description: 'Simulate current or supplied relics with optional optimizer form overrides. Returns summarized base/combat stats and relicIds; combat stats depend on requestPatch team/enemy settings.',
    inputSchema: {
      characterId: z.string().optional(),
      name: z.string().optional(),
      relicIds: z.record(z.string(), z.string()).optional(),
      requestPatch: z.record(z.string(), z.any()).optional(),
    },
  },
  async (input) => jsonResult(await app.call('simulateBuild', input)),
)

process.on('SIGINT', async () => {
  await app.close()
  process.exit(0)
})
process.on('SIGTERM', async () => {
  await app.close()
  process.exit(0)
})

await server.connect(new StdioServerTransport())
