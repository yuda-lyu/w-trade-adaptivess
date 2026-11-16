//w-trade-adaptivess 之聚合入口(自有套件慣例 src/W<Name>.mjs: 預設匯出全部 API 之物件, 供打包為 dist/w-trade-adaptivess.umd.js 作 main; ESM 使用者仍可深層匯入 src/**)
//  不另放邏輯; 各模組之函數皆可自其檔以深層路徑取用
//  三組: 評估器(eval; 與迴圈無關, 可單獨使用)、代理式迴圈之通用層(arsi; 不含交易領域之用語)、領域接線(domain; 把兩者接到 w-recursi 之樹與臂目錄)
//  命令列程式(src/cli/*.mjs)與工具(src/tools/*.mjs)是「執行即動作」之指令稿, 不在此匯出: 由專案根之進入檔載入(node src/tools/initProject.mjs 產生)
import { makeEvaluator, lowerBound, mulberry32, ntStaticOf } from './eval/evalCore.mjs'
import { loadLedger, loadIds } from './eval/ledger.mjs'
import { buildLedger, LEDGER_VERSION } from './eval/ledgerBuild.mjs'
import { scanPick, scanSnippet, loadPick, stripComments } from './eval/pickLoader.mjs'
import { scoreOf } from './eval/score.mjs'
import { createArsi } from './arsi/arsi.mjs'
import { NODE_SCHEMA, DREAM_SCHEMA, TRUST, ACTIONS, OUTCOMES, IMPROVE_KINDS, TASK_TYPES, EXPAND_DECISIONS, ARM_KINDS, CLAIM_VERDICTS, checkArmProposals, checkNodeAgentPart, checkDreamAgentPart, tallyDream, renderNodeMd, renderDreamMd, createFileRecords, roundName } from './arsi/records.mjs'
import { createToolbox } from './arsi/toolbox.mjs'
import { makeDispatch, checkQuota } from './arsi/dispatchers.mjs'
import { createResourceMonitor } from './arsi/resources.mjs'
import { runRounds, resolveRunConfig, acquireRunLock, peekRunLock, appendEvent, readEvents, trailingFailures } from './arsi/runner.mjs'
import { makeProject, outwardNoteOf, OUT_CHECK_MIN } from './domain/domain.mjs'
import { makeTexts } from './domain/texts.mjs'
import { makeVerify, scanTrace, forbiddenPats, setGuardExtra, guardExtraOf, extSurfaceOf, summaryOf, notesOf } from './domain/verify.mjs'
import { buildPickStore, infoOf, FIELD_DEFS, COLUMNS } from './domain/pickStore.mjs'
import { ARM_ID, mkArm, proposalOf, decideArgsOf } from './domain/armCatalog.mjs'
import { makeToolboxRules } from './domain/toolboxRules.mjs'
import { archiveExperience, archiveFeedback } from './domain/archiveDocs.mjs'
import { backtestCfg } from './domain/backtestCfg.mjs'
import { initProject } from './tools/initProject.mjs'
import { FD_ROOT, P, getSettings, argOf, readJson, writeJson } from './cfg.mjs'


/**
 * 自適應挑選策略之探尋框架之聚合物件(與各模組之匯出為同一實體)
 *
 * 總組裝：makeProject(st, inject)(別名createAdaptivess)；評估器：buildLedger、loadLedger、ntStaticOf、makeEvaluator、loadPick、scoreOf；
 * 代理式迴圈之通用層：createArsi、createFileRecords、createToolbox、makeDispatch、checkQuota、createResourceMonitor、runRounds、acquireRunLock、appendEvent等；
 * 領域接線：makeTexts、makeVerify、scanTrace、buildPickStore、mkArm、decideArgsOf、makeToolboxRules等；專案接入：initProject、getSettings
 *
 * @type {Object}
 * @example
 * need test in nodejs.
 *
 * import WTradeAdaptivess from 'w-trade-adaptivess/src/WTradeAdaptivess.mjs'
 *
 * //評估器單獨使用: 由策略庫建訂單帳本後, 評估一個挑選函數
 * let st = WTradeAdaptivess.getSettings()
 * let L = WTradeAdaptivess.loadLedger(st.eval.ledgerDir)
 * //訓練期之界線須明給(ctx.meta.ntAll 只計訓練期之進場數): 評估帳本涵蓋訓練期與回測期, 界線為訓練期之終點棒序(依帳本之 time0 與每棒小時數自設定之訓練期終點換算; 帳本全為訓練期者才給 L.nBars)
 * let trainEndBar = Math.round((Date.parse(`${st.periods.train.end}Z`) - Date.parse(`${L.meta.time0}Z`)) / (L.meta.barHours * 3600000))
 * L.ntStatic = WTradeAdaptivess.ntStaticOf(L, trainEndBar)
 * let ev = WTradeAdaptivess.makeEvaluator(L, { warmupDays: 180, cadenceDays: 7 })
 * let m = ev.evalPolicy((ctx) => [0, 1, 2], { accept: (sig, book) => book.open < 30, nullDraws: 16 })
 * console.log(m.op.eqYr.mean, m.selHash)
 */
let WTradeAdaptivess = {

    //總組裝(專案根由環境變數 ARSI_ROOT 或工作目錄決定; 見 cfg.mjs)
    makeProject,
    createAdaptivess: makeProject,
    initProject,

    //設定與路徑
    getSettings,
    FD_ROOT,
    P,
    argOf,
    readJson,
    writeJson,

    //評估器
    buildLedger,
    LEDGER_VERSION,
    loadLedger,
    loadIds,
    makeEvaluator,
    ntStaticOf,
    lowerBound,
    mulberry32,
    loadPick,
    scanPick,
    scanSnippet,
    stripComments,
    scoreOf,

    //代理式迴圈之通用層
    createArsi,
    createFileRecords,
    createToolbox,
    makeDispatch,
    checkQuota,
    createResourceMonitor,
    runRounds,
    resolveRunConfig,
    acquireRunLock,
    peekRunLock,
    appendEvent,
    readEvents,
    trailingFailures,
    NODE_SCHEMA,
    DREAM_SCHEMA,
    TRUST,
    ACTIONS,
    OUTCOMES,
    IMPROVE_KINDS,
    TASK_TYPES,
    EXPAND_DECISIONS,
    ARM_KINDS,
    CLAIM_VERDICTS,
    checkArmProposals,
    checkNodeAgentPart,
    checkDreamAgentPart,
    tallyDream,
    renderNodeMd,
    renderDreamMd,
    roundName,

    //領域接線
    makeTexts,
    makeVerify,
    scanTrace,
    forbiddenPats,
    setGuardExtra,
    guardExtraOf,
    extSurfaceOf,
    summaryOf,
    notesOf,
    buildPickStore,
    infoOf,
    FIELD_DEFS,
    COLUMNS,
    ARM_ID,
    mkArm,
    proposalOf,
    decideArgsOf,
    makeToolboxRules,
    archiveExperience,
    archiveFeedback,
    backtestCfg,
    outwardNoteOf,
    OUT_CHECK_MIN,

}


export default WTradeAdaptivess
