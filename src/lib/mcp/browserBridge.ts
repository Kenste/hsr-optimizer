import { ShowcaseSource } from 'lib/characterPreview/CharacterPreviewComponents'
import {
  getPreviewRelics,
  getShowcaseStats,
} from 'lib/characterPreview/characterPreviewController'
import {
  COMPUTE_ENGINE_CPU,
  COMPUTE_ENGINE_GPU_STABLE,
  Constants,
  type Parts,
} from 'lib/constants/constants'
import { SavedSessionKeys } from 'lib/constants/constantsSession'
import { getWebgpuDevice } from 'lib/gpu/webgpuDevice'
import { loadMcpAccountContext } from 'lib/mcp/importContext'
import { generateContext } from 'lib/optimization/context/calculateContext'
import {
  defaultTeammate,
  getDefaultForm,
} from 'lib/optimization/defaultForm'
import { generateConditionalResolverMetadata } from 'lib/optimization/combo/comboInitializers'
import {
  formatOptimizerDisplayData,
  Optimizer,
} from 'lib/optimization/optimizer'
import { ComboType } from 'lib/optimization/rotation/comboType'
import {
  AbilityKind,
  AbilityMeta,
  Abilities,
} from 'lib/optimization/rotation/turnAbilityConfig'
import { getGridColumn, SortOption } from 'lib/optimization/sortOptions'
import { RelicFilters } from 'lib/relics/relicFilters'
import { RelicScorer } from 'lib/relics/scoring/relicScorer'
import {
  hasMainStat,
  mainStatWeight,
} from 'lib/relics/scoring/substatScoring'
import {
  SetsOrnamentsNames,
  SetsRelicsNames,
} from 'lib/sets/setConfigRegistry'
import { ConditionalSetMetadata } from 'lib/optimization/rotation/setConditionalContent'
import { CharacterConditionalsResolver } from 'lib/conditionals/resolver/characterConditionalsResolver'
import { LightConeConditionalsResolver } from 'lib/conditionals/resolver/lightConeConditionalsResolver'
import { simulateBuild } from 'lib/simulations/simulateBuild'
import type { SimulationRelicByPart } from 'lib/simulations/statSimulationTypes'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { useGlobalStore } from 'lib/stores/app/appStore'
import {
  getCharacterById,
  getCharacters,
} from 'lib/stores/character/characterStore'
import { useOptimizerRequestStore } from 'lib/stores/optimizerForm/useOptimizerRequestStore'
import { normalizeForm } from 'lib/stores/optimizerForm/optimizerFormConversions'
import { resolveLcDefaults } from 'lib/stores/optimizerForm/optimizerFormStoreActions'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import {
  getRelicById,
  getRelics,
} from 'lib/stores/relic/relicStore'
import { calculateTeammateSets } from 'lib/tabs/tabOptimizer/optimizerForm/components/teammate/teammateCardUtils'
import { OptimizerTabController } from 'lib/tabs/tabOptimizer/optimizerTabController'
import {
  recalculatePermutations,
  startOptimization,
} from 'lib/tabs/tabOptimizer/optimizerForm/optimizerFormActions'
import { clone } from 'lib/utils/objectUtils'
import type {
  Character,
  CharacterId,
} from 'types/character'
import type {
  Form,
  Teammate,
} from 'types/form'
import type { LightConeId } from 'types/lightCone'
import type { Relic } from 'types/relic'

type Identifier = { characterId?: CharacterId, name?: string }
type ComputeMode = 'auto' | 'gpu' | 'cpu'
type DraftSection = 'setup' | 'relicFilters' | 'team' | 'conditionals' | 'enemy' | 'rotation' | 'advanced'
type ConditionalTarget = 'character' | 'lightCone' | 'sets' | 'teammate0.character' | 'teammate0.lightCone' | 'teammate1.character' | 'teammate1.lightCone' | 'teammate2.character' | 'teammate2.lightCone'
type OptimizerDraft = {
  id: string,
  contextId: string | null,
  revision: number,
  characterId: CharacterId,
  createdAt: string,
  updatedAt: string,
  form: Form,
}

const RELIC_PARTS = Object.values(Constants.Parts) as Parts[]
const OPTIMIZER_DISPLAY_KEYS = [
  'HP',
  'ATK',
  'DEF',
  'SPD',
  'CR',
  'CD',
  'EHR',
  'RES',
  'BE',
  'ERR',
  'OHB',
  'COMBO',
  'EHP',
  'ELEMENTAL_DMG',
  'xHP',
  'xATK',
  'xDEF',
  'xSPD',
  'xCR',
  'xCD',
  'xEHR',
  'xRES',
  'xBE',
  'xERR',
  'xOHB',
  'xELEMENTAL_DMG',
  'BASIC',
  'SKILL',
  'ULT',
  'FUA',
  'DOT',
  'BREAK',
  'MEMO_SKILL',
  'MEMO_TALENT',
  'mHP',
  'mATK',
  'mDEF',
  'mSPD',
  'mCR',
  'mCD',
  'mEHR',
  'mRES',
  'mBE',
  'mERR',
  'mOHB',
  'mELEMENTAL_DMG',
  'mxHP',
  'mxATK',
  'mxDEF',
  'mxSPD',
  'mxCR',
  'mxCD',
  'mxEHR',
  'mxRES',
  'mxBE',
  'mxERR',
  'mxOHB',
  'mxELEMENTAL_DMG',
  'mxEHP',
] as const

let activeContextId: string | null = null
const optimizerDrafts = new Map<string, OptimizerDraft>()

function deepMerge<T>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return clone(base)
  const output = (Array.isArray(base) ? [...base] : { ...(base as Record<string, unknown>) }) as Record<string, unknown>
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && output[key]
      && typeof output[key] === 'object'
      && !Array.isArray(output[key])
    ) {
      output[key] = deepMerge(output[key], value as Record<string, unknown>)
    } else {
      output[key] = clone(value)
    }
  }
  return output as T
}

function characterName(characterId: CharacterId): string {
  return (getGameMetadata().characters[characterId] as { name?: string } | undefined)?.name ?? characterId
}

function lightConeName(lightConeId: LightConeId | undefined | null): string | undefined {
  if (!lightConeId) return undefined
  return (getGameMetadata().lightCones[lightConeId] as { name?: string } | undefined)?.name ?? lightConeId
}

function resolveCharacter(input: Identifier): Character {
  if (input.characterId) {
    const character = getCharacterById(input.characterId)
    if (character) return character
  }

  const normalizedName = input.name?.trim().toLowerCase()
  if (normalizedName) {
    const match = getCharacters().find((character) => characterName(character.id).toLowerCase() === normalizedName)
    if (match) return match
  }

  throw new Error(`Character not found: ${input.characterId ?? input.name ?? '<missing>'}`)
}

function equippedRelics(character: Character): Partial<Record<string, Relic>> {
  return Object.fromEntries(
    Object.values(character.equipped ?? {})
      .filter((id): id is string => !!id)
      .map((id) => [id, getRelicById(id)])
      .filter((entry): entry is [string, Relic] => !!entry[1]),
  )
}

function summarizeRelic(relic: Relic | null | undefined) {
  if (!relic) return null
  return {
    id: relic.id,
    part: relic.part,
    set: relic.set,
    grade: relic.grade,
    enhance: relic.enhance,
    equippedBy: relic.equippedBy,
    main: relic.main,
    substats: relic.substats,
    previewSubstats: relic.previewSubstats,
  }
}

function getRelicScoreRatingReason(relic: Relic, score: ReturnType<RelicScorer['getCurrentRelicScore']>) {
  if (score.rating !== '?') return undefined
  if (relic.grade !== 5) return 'Only 5-star relics receive ratings.'
  if (score.percentScore <= 0) return 'No useful weighted substats for this character.'
  if (
    score.meta
    && hasMainStat(relic.part)
    && mainStatWeight(relic.part, relic.main.stat, score.meta) <= 0
  ) {
    return 'Wrong main stat for this character.'
  }
  return 'No rating available for this score.'
}

function summarizeRelicScore(relic: Relic, score: ReturnType<RelicScorer['getCurrentRelicScore']>) {
  return {
    percentScore: score.percentScore,
    rating: score.rating,
    ratingReason: getRelicScoreRatingReason(relic, score),
  }
}

function summarizeRelicPotential(potential: ReturnType<RelicScorer['scoreRelicPotential']>) {
  return {
    currentPct: potential.currentPct,
    bestPct: potential.bestPct,
    averagePct: potential.averagePct,
    worstPct: potential.worstPct,
    rerollAvgPct: potential.rerollAvgPct,
    blockedRerollAvgPct: potential.blockedRerollAvgPct,
    bestAddedStats: potential.meta.bestAddedStats,
    bestUpgradedStats: potential.meta.bestUpgradedStats,
    blockedStat: potential.meta.blockedStat,
  }
}

function summarizeOptimizerDisplayData(row: Record<string, unknown>, includeZeroStats = false) {
  return Object.fromEntries(
    OPTIMIZER_DISPLAY_KEYS
      .filter((key) => row[key] !== undefined)
      .filter((key) => includeZeroStats || row[key] !== 0)
      .map((key) => [key, row[key]]),
  )
}

function summarizeOptimizationRow(row: Record<string, unknown>, includeZeroStats = false) {
  return {
    id: row.id,
    score: row.COMBO ?? row.WEIGHT,
    stats: summarizeOptimizerDisplayData(row, includeZeroStats),
  }
}

function getCharacterForm(character: Character, requestPatch?: Partial<Form>): Form {
  const base = character.form?.characterId ? character.form : getDefaultForm({ id: character.id })
  return normalizeForm(deepMerge(base, requestPatch))
}

function createDraftId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function requireDraft(draftId: string): OptimizerDraft {
  const draft = optimizerDrafts.get(draftId)
  if (!draft) throw new Error(`Optimizer draft not found: ${draftId}`)
  return draft
}

function touchDraft(draft: OptimizerDraft) {
  draft.revision += 1
  draft.updatedAt = new Date().toISOString()
  draft.form = normalizeForm(draft.form)
  return draft
}

function teammateName(teammate: Partial<Teammate> | undefined): string | undefined {
  return teammate?.characterId ? characterName(teammate.characterId) : undefined
}

function summarizeTeammate(teammate: Partial<Teammate> | undefined) {
  if (!teammate?.characterId) return null
  return {
    characterId: teammate.characterId,
    name: teammateName(teammate),
    characterEidolon: teammate.characterEidolon,
    lightCone: teammate.lightCone
      ? {
        id: teammate.lightCone,
        name: lightConeName(teammate.lightCone),
        superimposition: teammate.lightConeSuperimposition,
      }
      : undefined,
    teamRelicSet: teammate.teamRelicSet,
    teamOrnamentSet: teammate.teamOrnamentSet,
  }
}

function summarizeConditionals(values: Record<string, unknown> | undefined) {
  return {
    count: Object.values(values ?? {}).filter((value) => value !== undefined).length,
  }
}

function setConditionalValues(setConditionals: Form['setConditionals'] | undefined) {
  return Object.fromEntries(
    Object.entries(setConditionals ?? {}).map(([set, tuple]) => [set, Array.isArray(tuple) ? tuple[1] : tuple]),
  )
}

function summarizeDraft(draft: OptimizerDraft, requestedSections?: DraftSection[]) {
  const sections = new Set<DraftSection>(requestedSections ?? ['setup', 'team'])
  const form = draft.form
  const result: Record<string, unknown> = {
    draftId: draft.id,
    contextId: draft.contextId,
    revision: draft.revision,
    characterId: draft.characterId,
    name: characterName(draft.characterId),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  }

  if (sections.has('setup')) {
    result.setup = {
      characterId: form.characterId,
      name: characterName(form.characterId),
      characterLevel: form.characterLevel,
      characterEidolon: form.characterEidolon,
      lightCone: {
        id: form.lightCone,
        name: lightConeName(form.lightCone),
        level: form.lightConeLevel,
        superimposition: form.lightConeSuperimposition,
      },
      resultsLimit: form.resultsLimit,
    }
  }

  if (sections.has('relicFilters')) {
    result.relicFilters = {
      includeEquippedRelics: form.includeEquippedRelics,
      keepCurrentRelics: form.keepCurrentRelics,
      rankFilter: form.rankFilter,
      enhance: form.enhance,
      grade: form.grade,
      mainStatUpscaleLevel: form.mainStatUpscaleLevel,
      mainStats: {
        Body: form.mainBody,
        Feet: form.mainFeet,
        PlanarSphere: form.mainPlanarSphere,
        LinkRope: form.mainLinkRope,
      },
      relicSets: form.relicSets,
      ornamentSets: form.ornamentSets,
      setFilters: form.setFilters,
      weights: form.weights,
      resultMinFilter: form.resultMinFilter,
    }
  }

  if (sections.has('team')) {
    result.team = {
      teammate0: summarizeTeammate(form.teammate0),
      teammate1: summarizeTeammate(form.teammate1),
      teammate2: summarizeTeammate(form.teammate2),
    }
  }

  if (sections.has('conditionals')) {
    result.conditionals = {
      character: summarizeConditionals(form.characterConditionals),
      lightCone: summarizeConditionals(form.lightConeConditionals),
      sets: summarizeConditionals(setConditionalValues(form.setConditionals)),
      teammate0: {
        character: summarizeConditionals(form.teammate0?.characterConditionals),
        lightCone: summarizeConditionals(form.teammate0?.lightConeConditionals),
      },
      teammate1: {
        character: summarizeConditionals(form.teammate1?.characterConditionals),
        lightCone: summarizeConditionals(form.teammate1?.lightConeConditionals),
      },
      teammate2: {
        character: summarizeConditionals(form.teammate2?.characterConditionals),
        lightCone: summarizeConditionals(form.teammate2?.lightConeConditionals),
      },
    }
  }

  if (sections.has('enemy')) {
    result.enemy = {
      enemyLevel: form.enemyLevel,
      enemyCount: form.enemyCount,
      enemyResistance: form.enemyResistance,
      enemyEffectResistance: form.enemyEffectResistance,
      enemyMaxToughness: form.enemyMaxToughness,
      enemyElementalWeak: form.enemyElementalWeak,
      enemyWeaknessBroken: form.enemyWeaknessBroken,
    }
  }

  if (sections.has('rotation')) {
    result.rotation = {
      comboType: form.comboType,
      comboPreprocessor: form.comboPreprocessor,
      comboTurnAbilities: form.comboTurnAbilities,
      combo: (form as Record<string, unknown>).combo,
      comboDot: form.comboDot,
    }
  }

  if (sections.has('advanced')) {
    result.advanced = {
      resultSort: form.resultSort,
      statDisplay: form.statDisplay,
      memoDisplay: form.memoDisplay,
      resultsLimit: form.resultsLimit,
      deprioritizeBuffs: form.deprioritizeBuffs,
      combatBuffs: form.combatBuffs,
    }
  }

  return result
}

function mergeMainLightConeDefaults(form: Form) {
  if (!form.lightCone) return
  const defaults = resolveLcDefaults(form, getGameMetadata(), false)
  if (defaults) form.lightConeConditionals = { ...defaults, ...form.lightConeConditionals }
}

function mergeMainCharacterDefaults(form: Form) {
  const controller = CharacterConditionalsResolver.get({
    characterId: form.characterId,
    characterEidolon: form.characterEidolon,
  })
  const defaults = controller.defaults?.()
  if (defaults) form.characterConditionals = { ...defaults, ...form.characterConditionals }
}

function applyTeammateAccountBuild(teammate: Partial<Teammate>, characterId: CharacterId) {
  const character = getCharacterById(characterId)
  if (!character) return teammate
  const sets = calculateTeammateSets(character)
  return {
    ...teammate,
    characterId,
    characterEidolon: character.form?.characterEidolon ?? 0,
    lightCone: character.form?.lightCone,
    lightConeSuperimposition: character.form?.lightConeSuperimposition ?? 1,
    ...sets,
  }
}

function mergeTeammateDefaults(teammate: Partial<Teammate>) {
  if (!teammate.characterId) return teammate
  const charController = CharacterConditionalsResolver.get({
    characterId: teammate.characterId,
    characterEidolon: teammate.characterEidolon ?? 0,
  })
  const charDefaults = charController.teammateDefaults?.()
  if (charDefaults) {
    teammate.characterConditionals = { ...charDefaults, ...teammate.characterConditionals }
  }

  if (teammate.lightCone) {
    const lcDefaults = resolveLcDefaults({
      characterId: teammate.characterId,
      characterEidolon: teammate.characterEidolon ?? 0,
      lightCone: teammate.lightCone,
      lightConeSuperimposition: teammate.lightConeSuperimposition ?? 1,
    }, getGameMetadata(), true)
    if (lcDefaults) {
      teammate.lightConeConditionals = { ...lcDefaults, ...teammate.lightConeConditionals }
    }
  }

  return teammate
}

function normalizeTeammatePatch(current: Partial<Teammate>, patch: Record<string, unknown>) {
  if (patch.clear) return defaultTeammate() as Partial<Teammate>

  let next = { ...current }
  const characterId = patch.characterId as CharacterId | undefined
  if (characterId && patch.useAccountBuild !== false) {
    next = applyTeammateAccountBuild(next, characterId)
  }

  next = deepMerge(next, patch as Partial<Teammate>)
  delete (next as Record<string, unknown>).slot
  delete (next as Record<string, unknown>).clear
  delete (next as Record<string, unknown>).useAccountBuild
  return mergeTeammateDefaults(next)
}

function normalizeConditionalItems(items: unknown[] | undefined, currentValues: Record<string, unknown> | undefined, defaultValues: Record<string, unknown> | undefined) {
  return (items ?? []).map((item) => {
    const record = item as Record<string, unknown>
    const id = String(record.id)
    const type = record.formItem ?? record.type
    const options = Array.isArray(record.selectOptions)
      ? record.selectOptions.map((option) => {
        const optionRecord = option as Record<string, unknown>
        return {
          value: optionRecord.value,
          label: optionRecord.label ?? optionRecord.display ?? optionRecord.text ?? optionRecord.value,
        }
      })
      : undefined

    return {
      id,
      type,
      label: record.text ?? record.label ?? id,
      description: typeof record.content === 'string' ? record.content : undefined,
      currentValue: currentValues?.[id],
      defaultValue: defaultValues?.[id],
      disabled: record.disabled,
      min: record.min,
      max: record.max,
      percent: record.percent,
      options,
    }
  })
}

function getConditionalTarget(draft: OptimizerDraft, target: ConditionalTarget) {
  const form = draft.form
  if (target === 'character') {
    const resolver = CharacterConditionalsResolver.get({
      characterId: form.characterId,
      characterEidolon: form.characterEidolon,
    }, true)
    const defaults = resolver.defaults?.()
    const currentValues = { ...defaults, ...form.characterConditionals }
    return {
      target,
      currentValues,
      defaults,
      options: normalizeConditionalItems(resolver.content?.(), currentValues, defaults),
    }
  }

  if (target === 'lightCone') {
    const resolver = LightConeConditionalsResolver.get(generateConditionalResolverMetadata(form, getGameMetadata()), true)
    const defaults = resolver.defaults?.()
    const currentValues = { ...defaults, ...form.lightConeConditionals }
    return {
      target,
      currentValues,
      defaults,
      options: normalizeConditionalItems(resolver.content?.(), currentValues, defaults),
    }
  }

  if (target === 'sets') {
    const currentValues = setConditionalValues(form.setConditionals)
    return {
      target,
      currentValues,
      options: Object.entries(ConditionalSetMetadata).map(([set, metadata]) => ({
        id: set,
        type: metadata.type,
        modifiable: metadata.modifiable ?? false,
        currentValue: currentValues[set],
        options: metadata.selectionOptions?.(((key: string) => key) as never)?.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      })),
    }
  }

  const [, indexText, kind] = target.match(/^teammate([0-2])\.(character|lightCone)$/) ?? []
  const index = Number(indexText) as 0 | 1 | 2
  const teammate = form[`teammate${index}` as const]
  if (!teammate?.characterId) throw new Error(`No teammate configured in slot ${index}`)

  if (kind === 'character') {
    const resolver = CharacterConditionalsResolver.get({
      characterId: teammate.characterId,
      characterEidolon: teammate.characterEidolon,
    }, true)
    const defaults = resolver.teammateDefaults?.()
    const currentValues = { ...defaults, ...teammate.characterConditionals }
    return {
      target,
      currentValues,
      defaults,
      options: normalizeConditionalItems(resolver.teammateContent?.(), currentValues, defaults),
    }
  }

  const resolver = LightConeConditionalsResolver.get(generateConditionalResolverMetadata(teammate as Form, getGameMetadata()), true)
  const defaults = resolver.teammateDefaults?.()
  const currentValues = { ...defaults, ...teammate.lightConeConditionals }
  return {
    target,
    currentValues,
    defaults,
    options: normalizeConditionalItems(resolver.teammateContent?.(), currentValues, defaults),
  }
}

function patchConditionals(draft: OptimizerDraft, target: ConditionalTarget, values: Record<string, boolean | number>) {
  const form = draft.form
  if (target === 'character') form.characterConditionals = { ...form.characterConditionals, ...values }
  else if (target === 'lightCone') form.lightConeConditionals = { ...form.lightConeConditionals, ...values }
  else if (target === 'sets') {
    const setConditionals = { ...form.setConditionals } as Record<string, [undefined, boolean | number]>
    for (const [key, value] of Object.entries(values)) {
      const existing = setConditionals[key]
      setConditionals[key] = existing ? [existing[0], value] : [undefined, value]
    }
    form.setConditionals = setConditionals as Form['setConditionals']
  } else {
    const [, indexText, kind] = target.match(/^teammate([0-2])\.(character|lightCone)$/) ?? []
    const teammate = form[`teammate${Number(indexText) as 0 | 1 | 2}` as const]
    if (!teammate?.characterId) throw new Error(`No teammate configured for conditional target: ${target}`)
    if (kind === 'character') teammate.characterConditionals = { ...teammate.characterConditionals, ...values }
    else teammate.lightConeConditionals = { ...teammate.lightConeConditionals, ...values }
  }
}

function getRelicsByPart(character: Character, relicIds?: Partial<Record<Parts, string>>): Partial<Record<Parts, Relic>> {
  const build = relicIds ?? character.equipped
  const byPart: Partial<Record<Parts, Relic>> = {}
  for (const part of RELIC_PARTS) {
    const relic = getRelicById(build?.[part])
    if (relic) byPart[part] = clone(relic)
  }
  return byPart
}

function requireCompleteRelics(relicsByPart: Partial<Record<Parts, Relic>>): SimulationRelicByPart {
  const missing = RELIC_PARTS.filter((part) => !relicsByPart[part])
  if (missing.length) {
    throw new Error(`Cannot simulate build; missing relics for ${missing.join(', ')}`)
  }
  RelicFilters.condenseRelicSubstatsForOptimizerSingle(Object.values(relicsByPart))
  return relicsByPart as SimulationRelicByPart
}

async function setComputeEngine(mode: ComputeMode): Promise<string> {
  if (mode === 'cpu') {
    useGlobalStore.getState().setSavedSessionKey(SavedSessionKeys.computeEngine, COMPUTE_ENGINE_CPU)
    return COMPUTE_ENGINE_CPU
  }

  if (mode === 'gpu') {
    useGlobalStore.getState().setSavedSessionKey(SavedSessionKeys.computeEngine, COMPUTE_ENGINE_GPU_STABLE)
    return COMPUTE_ENGINE_GPU_STABLE
  }

  const device = await getWebgpuDevice(false)
  if (!device) {
    useGlobalStore.getState().setSavedSessionKey(SavedSessionKeys.computeEngine, COMPUTE_ENGINE_CPU)
    return COMPUTE_ENGINE_CPU
  }
  device.destroy()
  useGlobalStore.getState().setSavedSessionKey(SavedSessionKeys.computeEngine, COMPUTE_ENGINE_GPU_STABLE)
  return COMPUTE_ENGINE_GPU_STABLE
}

function getTrimmedCharacterDetails(character: Character) {
  const preview = getPreviewRelics(ShowcaseSource.CHARACTER_TAB, character, equippedRelics(character))
  const stats = getShowcaseStats(character, preview.displayRelics, null)

  return {
    id: character.id,
    name: characterName(character.id),
    lightCone: {
      id: character.form?.lightCone,
      name: lightConeName(character.form?.lightCone),
      superimposition: character.form?.lightConeSuperimposition,
    },
    stats: Object.fromEntries(
      Object.entries(stats).filter(([key]) => !['relicSetIndex', 'ornamentSetIndex', 'ELEMENTAL_DMG'].includes(key)),
    ),
    relicScore: preview.scoringResults.totalScore,
    correctMainStats: preview.scoringResults.correctMainStats,
    relicScores: preview.scoringResults.relics.map(({ meta, ...score }) => score),
  }
}

export const HsrMcpBridge = {
  loadAccountContext(json: unknown) {
    const result = loadMcpAccountContext(json)
    activeContextId = result.contextId
    optimizerDrafts.clear()
    return result
  },

  getContextSummary() {
    const relics = getRelics()
    const characters = getCharacters()
    return {
      contextId: activeContextId,
      characterCount: characters.length,
      relicCount: relics.length,
      lightConeCount: new Set(characters.map((c) => c.form?.lightCone).filter(Boolean)).size,
    }
  },

  listCharacters(options: { summary?: boolean } = {}) {
    return getCharacters().map((character) => {
      const base = {
        id: character.id,
        name: characterName(character.id),
      }

      if (!options.summary) return base

      try {
        const preview = getPreviewRelics(ShowcaseSource.CHARACTER_TAB, character, equippedRelics(character))
        return {
          ...base,
          eidolon: character.form?.characterEidolon,
          lightConeName: lightConeName(character.form?.lightCone),
          lightConeSuperimposition: character.form?.lightConeSuperimposition,
          equippedRelicCount: Object.values(character.equipped ?? {}).filter(Boolean).length,
          relicScore: preview.scoringResults.totalScore,
          correctMainStats: preview.scoringResults.correctMainStats,
        }
      } catch (error) {
        return {
          ...base,
          summaryError: error instanceof Error ? error.message : String(error),
        }
      }
    })
  },

  getCharacterDetails(input: Identifier) {
    const character = resolveCharacter(input)
    return getTrimmedCharacterDetails(character)
  },

  getCharacterRelics(input: Identifier) {
    const character = resolveCharacter(input)
    const preview = getPreviewRelics(ShowcaseSource.CHARACTER_TAB, character, equippedRelics(character))
    return {
      characterId: character.id,
      name: characterName(character.id),
      equipped: Object.fromEntries(Object.entries(preview.displayRelics).map(([part, relic]) => [part, summarizeRelic(relic)])),
      relicScores: preview.scoringResults.relics.map(({ meta, ...score }) => score),
    }
  },

  listRelicSets() {
    return {
      total: SetsRelicsNames.length,
      items: SetsRelicsNames,
    }
  },

  listOrnamentSets() {
    return {
      total: SetsOrnamentsNames.length,
      items: SetsOrnamentsNames,
    }
  },

  listRelics(options: {
    filters?: Partial<Pick<Relic, 'part' | 'set' | 'equippedBy' | 'grade' | 'enhance'>>,
    limit?: number,
    cursor?: number,
    scoreCharacterId?: CharacterId,
  } = {}) {
    const filters = options.filters ?? {}
    const start = options.cursor ?? 0
    const limit = Math.min(options.limit ?? 100, 500)
    const scorer = options.scoreCharacterId ? new RelicScorer() : null
    const all = getRelics().filter((relic) => {
      if (filters.part && relic.part !== filters.part) return false
      if (filters.set && relic.set !== filters.set) return false
      if (filters.equippedBy && relic.equippedBy !== filters.equippedBy) return false
      if (filters.grade && relic.grade !== filters.grade) return false
      if (filters.enhance && relic.enhance !== filters.enhance) return false
      return true
    })
    const page = all.slice(start, start + limit).map((relic) => ({
      ...summarizeRelic(relic),
      score: scorer ? summarizeRelicScore(relic, scorer.getCurrentRelicScore(relic, options.scoreCharacterId!)) : undefined,
    }))

    return {
      items: page,
      nextCursor: start + limit < all.length ? start + limit : null,
      total: all.length,
    }
  },

  getRelicDetails(input: { relicId: string, scoreCharacterId?: CharacterId, includePotential?: boolean }) {
    const relic = getRelicById(input.relicId)
    if (!relic) throw new Error(`Relic not found: ${input.relicId}`)
    const scorer = input.scoreCharacterId ? new RelicScorer() : null
    const currentScore = scorer ? scorer.getCurrentRelicScore(relic, input.scoreCharacterId!) : undefined
    const potential = scorer && input.includePotential ? scorer.scoreRelicPotential(relic, input.scoreCharacterId!, true) : undefined
    return {
      ...summarizeRelic(relic),
      currentScore: currentScore ? summarizeRelicScore(relic, currentScore) : undefined,
      potential: potential ? summarizeRelicPotential(potential) : undefined,
    }
  },

  listLightCones(options: { source?: 'equipped' | 'game', characterId?: CharacterId } = {}) {
    const metadata = getGameMetadata().lightCones
    const characterPath = options.characterId ? getGameMetadata().characters[options.characterId]?.path : undefined
    const pathMatches = (path: string | undefined) => !characterPath || path === characterPath

    if (options.source === 'game') {
      return Object.values(metadata)
        .filter((lightCone) => pathMatches(lightCone.path))
        .map((lightCone) => ({
          id: lightCone.id,
          name: (lightCone as { name?: string }).name,
          path: lightCone.path,
          rarity: lightCone.rarity,
        }))
    }

    const equipped = new Map<string, { id: string, name?: string, path?: string, rarity?: number, superimpositions: Set<number>, characterIds: CharacterId[] }>()
    for (const character of getCharacters()) {
      const id = character.form?.lightCone
      if (!id) continue
      if (!pathMatches(metadata[id]?.path)) continue
      const current = equipped.get(id) ?? {
        id,
        name: lightConeName(id),
        path: metadata[id]?.path,
        rarity: metadata[id]?.rarity,
        superimpositions: new Set<number>(),
        characterIds: [],
      }
      current.superimpositions.add(character.form.lightConeSuperimposition)
      current.characterIds.push(character.id)
      equipped.set(id, current)
    }

    return [...equipped.values()].map((entry) => ({
      ...entry,
      superimpositions: [...entry.superimpositions].sort(),
    }))
  },

  getOptimizerOptions(input: Identifier) {
    const character = resolveCharacter(input)
    const form = getCharacterForm(character)
    return {
      characterId: character.id,
      name: characterName(character.id),
      defaults: {
        resultSort: form.resultSort,
        statDisplay: form.statDisplay,
        memoDisplay: form.memoDisplay,
        resultsLimit: form.resultsLimit,
        includeEquippedRelics: form.includeEquippedRelics,
        keepCurrentRelics: form.keepCurrentRelics,
        rankFilter: form.rankFilter,
        enhance: form.enhance,
        grade: form.grade,
        mainStatUpscaleLevel: form.mainStatUpscaleLevel,
      },
      sortOptions: Object.values(SortOption).map((option) => ({
        key: option.key,
        isComputedRating: option.isComputedRating ?? false,
      })),
      mainStatOptions: {
        Body: form.mainBody,
        Feet: form.mainFeet,
        PlanarSphere: form.mainPlanarSphere,
        LinkRope: form.mainLinkRope,
      },
      weights: form.weights,
      setFilters: form.setFilters,
      enemyDefaults: {
        count: form.enemyCount,
        level: form.enemyLevel,
        elementalWeak: form.enemyElementalWeak,
        resistance: form.enemyResistance,
        effectResistance: form.enemyEffectResistance,
        weaknessBroken: form.enemyWeaknessBroken,
        maxToughness: form.enemyMaxToughness,
      },
      requestPatchFields: {
        mainStats: ['mainBody', 'mainFeet', 'mainPlanarSphere', 'mainLinkRope'],
        relicFilters: ['includeEquippedRelics', 'keepCurrentRelics', 'rankFilter', 'enhance', 'grade', 'exclude', 'relicSets', 'ornamentSets', 'setFilters'],
        scoring: ['resultSort', 'statDisplay', 'memoDisplay', 'weights', 'resultsLimit', 'resultMinFilter'],
        enemy: ['enemyCount', 'enemyLevel', 'enemyElementalWeak', 'enemyResistance', 'enemyEffectResistance', 'enemyWeaknessBroken', 'enemyMaxToughness'],
        team: ['teammate0', 'teammate1', 'teammate2'],
      },
    }
  },

  createOptimizerDraft(input: Identifier & { requestPatch?: Partial<Form> }) {
    const character = resolveCharacter(input)
    const now = new Date().toISOString()
    const draft: OptimizerDraft = {
      id: createDraftId(),
      contextId: activeContextId,
      revision: 1,
      characterId: character.id,
      createdAt: now,
      updatedAt: now,
      form: getCharacterForm(character, input.requestPatch),
    }
    mergeMainCharacterDefaults(draft.form)
    mergeMainLightConeDefaults(draft.form)
    optimizerDrafts.set(draft.id, draft)
    return summarizeDraft(draft)
  },

  getOptimizerDraft(input: { draftId: string, sections?: DraftSection[] }) {
    return summarizeDraft(requireDraft(input.draftId), input.sections)
  },

  patchOptimizerSetup(input: { draftId: string, patch: Partial<Form> }) {
    const draft = requireDraft(input.draftId)
    const allowed = ['characterLevel', 'characterEidolon', 'lightCone', 'lightConeLevel', 'lightConeSuperimposition', 'resultsLimit'] as const
    for (const key of allowed) {
      if (input.patch[key] !== undefined) {
        ;(draft.form as Record<string, unknown>)[key] = input.patch[key]
      }
    }
    mergeMainCharacterDefaults(draft.form)
    mergeMainLightConeDefaults(draft.form)
    return summarizeDraft(touchDraft(draft), ['setup', 'conditionals'])
  },

  patchOptimizerRelicFilters(input: { draftId: string, patch: Partial<Form> }) {
    const draft = requireDraft(input.draftId)
    const allowed = [
      'includeEquippedRelics',
      'keepCurrentRelics',
      'rankFilter',
      'enhance',
      'grade',
      'mainStatUpscaleLevel',
      'mainBody',
      'mainFeet',
      'mainPlanarSphere',
      'mainLinkRope',
      'relicSets',
      'ornamentSets',
      'setFilters',
      'weights',
      'resultMinFilter',
      'exclude',
    ] as const

    for (const key of allowed) {
      if (input.patch[key] !== undefined) {
        ;(draft.form as Record<string, unknown>)[key] = clone(input.patch[key])
      }
    }

    return summarizeDraft(touchDraft(draft), ['relicFilters'])
  },

  patchOptimizerTeam(input: { draftId: string, teammates: Array<Record<string, unknown>> }) {
    const draft = requireDraft(input.draftId)
    for (const patch of input.teammates) {
      const slot = patch.slot as 0 | 1 | 2 | undefined
      if (slot !== 0 && slot !== 1 && slot !== 2) throw new Error('Each teammate patch must include slot 0, 1, or 2')
      const key = `teammate${slot}` as 'teammate0' | 'teammate1' | 'teammate2'
      draft.form[key] = normalizeTeammatePatch(draft.form[key], patch) as Teammate
    }
    return summarizeDraft(touchDraft(draft), ['team', 'conditionals'])
  },

  patchOptimizerConditionals(input: { draftId: string, target: ConditionalTarget, values: Record<string, boolean | number> }) {
    const draft = requireDraft(input.draftId)
    patchConditionals(draft, input.target, input.values)
    return summarizeDraft(touchDraft(draft), ['conditionals'])
  },

  patchOptimizerEnemy(input: { draftId: string, patch: Partial<Form> }) {
    const draft = requireDraft(input.draftId)
    const allowed = ['enemyLevel', 'enemyCount', 'enemyResistance', 'enemyEffectResistance', 'enemyMaxToughness', 'enemyElementalWeak', 'enemyWeaknessBroken'] as const
    for (const key of allowed) {
      if (input.patch[key] !== undefined) {
        ;(draft.form as Record<string, unknown>)[key] = input.patch[key]
      }
    }
    return summarizeDraft(touchDraft(draft), ['enemy'])
  },

  patchOptimizerRotation(input: { draftId: string, patch: Partial<Form> }) {
    const draft = requireDraft(input.draftId)
    const patch = input.patch as Record<string, unknown>
    const allowed = ['comboType', 'comboPreprocessor', 'comboTurnAbilities', 'combo', 'comboDot', 'comboStateJson'] as const
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        ;(draft.form as Record<string, unknown>)[key] = clone(patch[key])
      }
    }
    return summarizeDraft(touchDraft(draft), ['rotation'])
  },

  getOptimizerSetupOptions(input: { draftId: string }) {
    const draft = requireDraft(input.draftId)
    const lightCones = HsrMcpBridge.listLightCones({ source: 'equipped', characterId: draft.characterId })
    return {
      draftId: draft.id,
      eidolons: [0, 1, 2, 3, 4, 5, 6],
      characterLevels: [1, 20, 30, 40, 50, 60, 70, 80],
      lightConeLevels: [1, 20, 30, 40, 50, 60, 70, 80],
      lightConeSuperimpositions: [1, 2, 3, 4, 5],
      lightCones,
      current: summarizeDraft(draft, ['setup']).setup,
    }
  },

  getOptimizerFilterOptions(input: { draftId: string }) {
    const draft = requireDraft(input.draftId)
    const form = draft.form
    return {
      draftId: draft.id,
      mainStatOptions: {
        Body: form.mainBody,
        Feet: form.mainFeet,
        PlanarSphere: form.mainPlanarSphere,
        LinkRope: form.mainLinkRope,
      },
      setFilters: form.setFilters,
      weights: form.weights,
      filterFields: ['includeEquippedRelics', 'keepCurrentRelics', 'rankFilter', 'enhance', 'grade', 'mainStatUpscaleLevel', 'mainBody', 'mainFeet', 'mainPlanarSphere', 'mainLinkRope', 'relicSets', 'ornamentSets', 'setFilters', 'weights', 'resultMinFilter', 'exclude'],
      setLists: {
        relicSetsTool: 'list_relic_sets',
        ornamentSetsTool: 'list_ornament_sets',
      },
      current: summarizeDraft(draft, ['relicFilters']).relicFilters,
    }
  },

  getOptimizerTeamOptions(input: { draftId: string, details?: boolean }) {
    const draft = requireDraft(input.draftId)
    return {
      draftId: draft.id,
      slots: [0, 1, 2],
      current: summarizeDraft(draft, ['team']).team,
      candidates: getCharacters()
        .filter((character) => character.id !== draft.characterId)
        .map((character) => {
          const base = {
            characterId: character.id,
            name: characterName(character.id),
            characterEidolon: character.form?.characterEidolon,
          }
          if (!input.details) return base
          return {
            ...base,
            lightCone: character.form?.lightCone
              ? {
                id: character.form.lightCone,
                name: lightConeName(character.form.lightCone),
                superimposition: character.form.lightConeSuperimposition,
              }
              : undefined,
            ...calculateTeammateSets(character),
          }
        }),
    }
  },

  getOptimizerConditionals(input: { draftId: string, target: ConditionalTarget }) {
    return getConditionalTarget(requireDraft(input.draftId), input.target)
  },

  getOptimizerRotationOptions(input: { draftId: string }) {
    const draft = requireDraft(input.draftId)
    return {
      draftId: draft.id,
      comboTypes: Object.values(ComboType),
      abilities: Object.values(Abilities).map((name) => {
        const kind = name === 'NULL' ? AbilityKind.NULL : name.split('_').slice(1).join('_') as AbilityKind
        return {
          name,
          kind,
          label: AbilityMeta[kind]?.label ?? name,
          category: AbilityMeta[kind]?.category,
        }
      }),
      current: summarizeDraft(draft, ['rotation']).rotation,
    }
  },

  validateOptimizerDraft(input: { draftId: string }) {
    const draft = requireDraft(input.draftId)
    const counts = Optimizer.getFilteredRelicCounts(draft.form).counts
    const permutationsNaive = RELIC_PARTS.reduce((product, part) => product * (counts[part] ?? 0), 1)
    const warnings = []
    if (!draft.form.lightCone) warnings.push('No light cone configured.')
    for (const part of RELIC_PARTS) {
      if ((counts[part] ?? 0) === 0) warnings.push(`No candidate relics remain for ${part}.`)
    }
    return {
      draftId: draft.id,
      valid: warnings.length === 0,
      warnings,
      relicCountsByPart: counts,
      permutationsNaive,
      note: 'Set-filter-aware valid permutations are calculated when the queued optimization starts.',
    }
  },

  async startOptimizationFromDraft(input: { draftId: string, resultsLimit?: number, computeEngine?: ComputeMode }) {
    const draft = requireDraft(input.draftId)
    return HsrMcpBridge.startOptimization({
      characterId: draft.characterId,
      requestPatch: draft.form,
      resultsLimit: input.resultsLimit ?? draft.form.resultsLimit,
      computeEngine: input.computeEngine,
    })
  },

  async startOptimization(input: Identifier & {
    requestPatch?: Partial<Form>,
    resultsLimit?: number,
    computeEngine?: ComputeMode,
  }) {
    const character = resolveCharacter(input)
    const form = getCharacterForm(character, {
      ...input.requestPatch,
      resultsLimit: input.resultsLimit ?? input.requestPatch?.resultsLimit,
    })
    const engine = await setComputeEngine(input.computeEngine ?? 'auto')

    useOptimizerRequestStore.getState().loadForm(form)
    useOptimizerDisplayStore.getState().setFocusCharacterId(character.id)
    recalculatePermutations()
    startOptimization()

    const state = useOptimizerDisplayStore.getState()
    return {
      contextId: activeContextId,
      characterId: character.id,
      engine,
      optimizationId: state.optimizationId,
      permutations: state.permutations,
      permutationsNaive: state.permutationsNaive,
      status: state.optimizationInProgress ? 'running' : 'started',
      pollAfterMs: 1000,
    }
  },

  getOptimizationStatus() {
    const state = useOptimizerDisplayStore.getState()
    return {
      optimizationId: state.optimizationId,
      status: state.optimizationInProgress ? 'running' : 'succeeded',
      engine: state.optimizerRunningEngine,
      progress: state.optimizerProgress,
      permutations: state.permutations,
      permutationsNaive: state.permutationsNaive,
      permutationsSearched: state.permutationsSearched,
      permutationsResults: state.permutationsResults,
      startedAt: state.optimizerStartTime,
      endedAt: state.optimizerEndTime,
      pollAfterMs: state.optimizationInProgress ? 1000 : undefined,
    }
  },

  getOptimizationResults(input: { limit?: number, offset?: number, includeRelics?: boolean, includeZeroStats?: boolean } = {}) {
    const offset = input.offset ?? 0
    const limit = Math.min(input.limit ?? 25, 200)
    const rows = OptimizerTabController.getRows()
    const state = useOptimizerDisplayStore.getState()
    const form = useOptimizerRequestStore.getState()
    const sortOption = SortOption[form.resultSort ?? 'COMBO']
    const sortColumn = getGridColumn(sortOption, form.statDisplay, form.memoDisplay)

    return {
      total: rows.length,
      offset,
      limit,
      sortColumn,
      items: rows.slice(offset, offset + limit).map((row) => ({
        ...summarizeOptimizationRow(row as unknown as Record<string, unknown>, input.includeZeroStats),
        relicIds: OptimizerTabController.calculateRelicIdsFromId(row.id),
        relics: input.includeRelics ? OptimizerTabController.calculateRelicsFromId(row.id) : undefined,
      })),
      status: state.optimizationInProgress ? 'running' : 'succeeded',
    }
  },

  simulateBuild(input: Identifier & {
    relicIds?: Partial<Record<Parts, string>>,
    requestPatch?: Partial<Form>,
  }) {
    const character = resolveCharacter(input)
    const form = getCharacterForm(character, input.requestPatch)
    const context = generateContext(form)
    const relicsByPart = requireCompleteRelics(getRelicsByPart(character, input.relicIds))
    const { x } = simulateBuild(relicsByPart, context, null, null, true)
    const result = formatOptimizerDisplayData(x)
    return {
      characterId: character.id,
      result: summarizeOptimizerDisplayData(result as unknown as Record<string, unknown>, true),
      relicIds: Object.fromEntries(RELIC_PARTS.map((part) => [part, (relicsByPart[part] as Relic).id])),
    }
  },

  cancelOptimization() {
    Optimizer.cancel()
    useOptimizerDisplayStore.getState().setOptimizationInProgress(false)
    return HsrMcpBridge.getOptimizationStatus()
  },
}

export function installHsrMcpBridge(): void {
  window.__HSR_MCP__ = HsrMcpBridge
}
