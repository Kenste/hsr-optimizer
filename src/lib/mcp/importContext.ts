import { hoyolabParser, type HoyolabData } from 'lib/importer/hoyoLabFormatParser'
import {
  ScannerSourceToParser,
  ValidScannerSources,
} from 'lib/importer/importConfig'
import type { ScannerParserJson } from 'lib/importer/kelzFormatParser'
import * as persistenceService from 'lib/services/persistenceService'
import { getCharacters } from 'lib/stores/character/characterStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import type { Form } from 'types/form'
import type { Relic } from 'types/relic'
import type { HsrOptimizerSaveFormat } from 'types/store'

export type McpImportFormat = 'save' | 'hoyolab' | 'scanner'

export type McpImportResult = {
  contextId: string,
  format: McpImportFormat,
  characterCount: number,
  relicCount: number,
  warnings: string[],
}

function hasNativeSaveShape(value: unknown): value is HsrOptimizerSaveFormat {
  const candidate = value as Partial<HsrOptimizerSaveFormat> | null
  return !!candidate && (Array.isArray(candidate.characters) || Array.isArray(candidate.relics))
}

function normalizeImportedCharacters(characters: Form[]): Form[] {
  return [...characters]
    .sort((a, b) => (b.characterLevel ?? 0) - (a.characterLevel ?? 0))
    .map((character) => ({
      ...character,
      characterLevel: 80,
      lightConeLevel: 80,
    }))
}

function replaceWithScannerData(relics: Relic[], characters: Form[]): void {
  persistenceService.loadSaveData({ relics: [], characters: [] }, false, false)
  persistenceService.mergeRelics(relics, normalizeImportedCharacters(characters))
}

export function loadMcpAccountContext(json: unknown): McpImportResult {
  const warnings: string[] = []
  const candidate = json as Partial<ScannerParserJson> & Partial<HoyolabData>

  if (candidate.data?.avatar_list) {
    const output = hoyolabParser(candidate as HoyolabData)
    replaceWithScannerData(output.relics as Relic[], output.characters as Form[])
    return {
      contextId: crypto.randomUUID(),
      format: 'hoyolab',
      characterCount: getCharacters().length,
      relicCount: getRelics().length,
      warnings,
    }
  }

  if (candidate.source && ValidScannerSources.includes(candidate.source)) {
    const parser = ScannerSourceToParser[candidate.source]
    const output = parser.parse(candidate as ScannerParserJson)
    replaceWithScannerData(output.relics, output.characters)
    if (parser.badRollInfo) {
      warnings.push('Scanner file contained bad roll info; results may be less accurate.')
    }
    return {
      contextId: crypto.randomUUID(),
      format: 'scanner',
      characterCount: getCharacters().length,
      relicCount: getRelics().length,
      warnings,
    }
  }

  if (hasNativeSaveShape(json)) {
    persistenceService.loadSaveData(json, false, false)
    return {
      contextId: crypto.randomUUID(),
      format: 'save',
      characterCount: getCharacters().length,
      relicCount: getRelics().length,
      warnings,
    }
  }

  throw new Error('Unsupported account JSON. Expected an optimizer save file or an existing supported scanner/importer format.')
}
