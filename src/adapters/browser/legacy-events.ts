import * as parameters from '../../ui/parameters.js';
import * as strategy from '../../ui/strategy.js';
import * as simulation from '../../ui/simulation.js';
import * as sensitivity from '../../ui/sensitivity.js';
import * as snapshots from '../../ui/snapshots.js';
import * as reportExport from '../../ui/export.js';
import { runCrossAnalysis } from '../../ui/cross.js';

export function bindLegacyEvents() {
  Object.assign(window, {
    exportParams: parameters.exportParams,
    importParamsFromBox: parameters.importParamsFromBox,
    applyEstimatedParams: parameters.applyEstimatedParams,
    toggleSparseFields: parameters.toggleSparseFields,
    toggleSingleBatchHints: parameters.toggleSingleBatchHints,
    toggleDerivationPanel: parameters.toggleDerivationPanel,
    togglePdPanel: parameters.togglePdPanel,
    recalcAll: parameters.recalcAll,
    syncMaxBatchFromInput: strategy.syncMaxBatchFromInput,
    switchMode: strategy.switchMode,
    setPrefetchPolicy: strategy.setPrefetchPolicy,
    syncPrefetchSelect: strategy.syncPrefetchSelect,
    saveStrategy: strategy.saveStrategy,
    loadStrategy: strategy.loadStrategy,
    deleteStrategy: strategy.deleteStrategy,
    applyStrategies: simulation.applyStrategies,
    runAllStrategies: simulation.runAllStrategies,
    runSensitivity: sensitivity.runSensitivity,
    exportSensImage: reportExport.exportSensImage,
    exportSensHtml: reportExport.exportSensHtml,
    selectAllSensSnaps: snapshots.selectAllSensSnaps,
    clearSensSnaps: snapshots.clearSensSnaps,
    toggleSensSnap: snapshots.toggleSensSnap,
    removeSensSnap: snapshots.removeSensSnap,
    runCrossAnalysis,
  });
}
