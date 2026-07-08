import { CURRENT_OPTIMIZER_VERSION } from 'lib/constants/constants'
import { useAhaTuningStore } from 'lib/stores/ahaTuningStore'
import { useGlobalStore } from 'lib/stores/app/appStore'
import { getCharacters } from 'lib/stores/character/characterStore'
import { useNewFeatureStore } from 'lib/stores/newFeatureStore'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import { useScoringStore } from 'lib/stores/scoring/scoringStore'
import {
  DEFAULT_WEBSOCKET_URL,
  useScannerState,
} from 'lib/tabs/tabImport/ScannerWebsocketClient'
import { useRelicLocatorStore } from 'lib/tabs/tabRelics/RelicLocator'
import { useRelicsTabStore } from 'lib/tabs/tabRelics/useRelicsTabStore'
import { useShowcaseTabStore } from 'lib/tabs/tabShowcase/useShowcaseTabStore'
import { useWarpCalculatorStore } from 'lib/tabs/tabWarp/useWarpCalculatorStore'
import type { Relic } from 'types/relic'
import type { HsrOptimizerSaveFormat } from 'types/store'

export function serializeMcpAccountContext(): HsrOptimizerSaveFormat {
  const globalState = useGlobalStore.getState()
  const relicsTabState = useRelicsTabStore.getState()
  const relicLocatorSession = useRelicLocatorStore.getState()
  const ahaSpeedTunerSession = useAhaTuningStore.getState()
  const scannerState = useScannerState.getState()

  return {
    relics: getRelics().map(({ augmentedStats, ...rest }) => rest) as Relic[],
    characters: getCharacters(),
    scoringMetadataOverrides: useScoringStore.getState().scoringMetadataOverrides,
    showcasePreferences: useShowcaseTabStore.getState().showcasePreferences,
    optimizerMenuState: useOptimizerDisplayStore.getState().menuState,
    excludedRelicPotentialCharacters: relicsTabState.excludedRelicPotentialCharacters,
    savedSession: {
      showcaseTab: useShowcaseTabStore.getState().savedSession,
      global: globalState.savedSession,
    },
    settings: globalState.settings,
    version: CURRENT_OPTIMIZER_VERSION,
    warpRequest: useWarpCalculatorStore.getState().request,
    relicLocator: {
      inventoryWidth: relicLocatorSession.inventoryWidth,
      rowLimit: relicLocatorSession.rowLimit,
    },
    ahaSpeedTuner: {
      teammate0: ahaSpeedTunerSession.teammate0,
      teammate1: ahaSpeedTunerSession.teammate1,
      teammate2: ahaSpeedTunerSession.teammate2,
      teammate3: ahaSpeedTunerSession.teammate3,
      desiredAha: ahaSpeedTunerSession.desiredAha,
    },
    scannerSettings: {
      ingest: scannerState.ingest,
      ingestCharacters: scannerState.ingestCharacters,
      ingestOnlyExistingCharacters: scannerState.ingestOnlyExistingCharacters,
      ingestWarpResources: scannerState.ingestWarpResources,
      websocketUrl: scannerState.websocketUrl,
      customUrl: scannerState.websocketUrl !== DEFAULT_WEBSOCKET_URL,
    },
    completedMigrations: globalState.completedMigrations,
    seenFeatures: Array.from(useNewFeatureStore.getState().seenFeatures),
  }
}
