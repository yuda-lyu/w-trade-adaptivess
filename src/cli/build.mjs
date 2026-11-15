import path from 'path'
import { getSettings, argOf } from '../cfg.mjs'
import buildLedger from '../eval/ledgerBuild.mjs'


//建訂單帳本: 讀策略庫專案之 ohlc / param / strategies(唯讀)
//  node g_build.mjs [--limit N]   評估帳本(settings.eval.ledgerDir; 訓練期 + 回測期, K 線於**回測期終點**截斷 —— 不含保留期);
//                                 評估期 = 回測期, 節點與做夢經 g_eval.mjs 使用此帳本
//                                 --limit 只建前 N 隻(試算用, 輸出落 <ledgerDir>_limitN)
//  node g_build.mjs --train       只到訓練期終點之帳本(data/ledger/train; 核對或診斷用, 評估器不使用)
//  保留期(settings.periods.holdoutFrom 起)與他幣之帳本不由本腳本建立: 該數據保留給監控日後檢定, 須另行授權
let st = getSettings()
let limit = argOf('limit', 0)
let train = argOf('train', false) === true
let outDir = train ? path.join(path.dirname(path.resolve(st.eval.ledgerDir)), 'train') : (limit > 0 ? `${st.eval.ledgerDir}_limit${limit}` : st.eval.ledgerDir)
let endTime = train ? st.periods.train.end : st.periods.backtest.end
if (Date.parse(`${endTime}Z`) >= Date.parse(`${st.periods.holdoutFrom}Z`)) {
    console.log(`ERROR 帳本終點 ${endTime} 已進入保留期(${st.periods.holdoutFrom} 起);不建`)
    process.exit(2)
}
console.log(`建帳本: ${train ? '訓練期' : '評估(訓練期 + 回測期)'} 終點 ${endTime} → ${path.resolve(outDir)}`)
let meta = await buildLedger({
    libraryRoot: st.source.libraryRoot,
    keyOhlc: st.source.keyOhlc,
    barHours: st.source.barHours,
    endTime,
    outDir,
    limit: train ? 0 : limit,
})
console.log(JSON.stringify({ key: meta.key, endTime: meta.endTime, nBars: meta.nBars, nStrategies: meta.nStrategies, nOrders: meta.nOrders, nUnsettled: meta.nUnsettled, check: meta.check, buildSec: meta.buildSec }))
