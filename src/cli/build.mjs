import path from 'path'
import { getSettings, argOf, P } from '../cfg.mjs'
import buildLedger from '../eval/ledgerBuild.mjs'


//建訂單帳本: 讀策略庫專案之 ohlc / param / strategies(唯讀)
//  node g_build.mjs [--limit N]   評估帳本(settings.eval.ledgerDir; 訓練期 + 回測期, K 線於**回測期終點**截斷 —— 不含保留期);
//                                 評估期 = 回測期, 節點與做夢經 g_eval.mjs 使用此帳本
//                                 --limit 只建前 N 隻(試算用, 輸出落 <ledgerDir>_limitN)
//  node g_build.mjs --train       只到訓練期終點之帳本(data/ledger/train; 核對或診斷用, 評估器不使用)
//  保留期(settings.periods.holdoutFrom 起)與他幣之帳本不由本腳本建立: 該數據保留給監控日後檢定, 須另行授權
//  外部序列(選配; 規則 R-EV-34): settings.source.seriesDir(相對專案根)下之各 <名>.json 一併建入帳本, 供挑選函數以 ctx.series 取用;
//    序列同樣於帳本終點截斷(時間 ≥ 終點之列對不到棒; 訓練期帳本亦然); 未設定或資料夾不存在者不建入
//  基礎單位(選配; 規則 R-EV-43): settings.source.unit = { rule: { stepSize, minQty, minNotional, asOf?, source? }, buffer = 0.1, uIni } 有給者, 帳本另存每根棒之基礎單位名義並記交易規則(入帳本鍵);
//    單一策略之全期最大同時持倉名義只記錄(輸出之 unitStat: 最大者與其策略、超過 uIni 之隻數 nStrategyOverUIni; 有超過者另列一行 WARN, 帳本照寫出、離開碼 0);
//    設定不合者不寫出(離開碼 2); 未給(或 null)⇒ 帳本與未加入本功能時逐位相同
//  每根之時長(規則 R-EV-44): settings.source.barHours 須整除 24 小時(未給為 4); 策略檔帶 settings.intervalSec 者須等於 barHours × 3600;
//    選配之 settings.source.seriesOffGridMax(0 ~ 1)= 外部序列對不到棒之比例上限(超過即不建); 不合者皆不寫出、離開碼 2
//  帳本之起點(選配; 規則 R-EV-45): settings.source.startTime(無時區之時間字串, 含; 與終點對稱)有給者, 帳本之 K 線自該根起(評估帳本與 --train 帳本皆然; time0 = startTime) —— 策略庫之 K 線因因子之暖機而早於求解窗之起點者用之;
//    須為 K 線檔內某一根之開盤時間且早於帳本終點, 不合(非字串、不在 K 線上、不早於終點、其後之 K 線不滿 100 根)者印 ERROR invalid source.startTime…、不寫出、離開碼 2; 未給(或 null)⇒ 自 K 線檔之第一根(輸出與未加入本功能時相同);
//    起點由記錄(ohlc 列)與摘要行之 startTime 欄呈現(起首列與未加入本功能時逐字相同); 起點晚於訓練期起點者(帳本未涵蓋訓練期起點)於建置成功後另印一行 WARN(離開碼仍 0)
//    回測期旗標(g_backtest.mjs)所用之全期帳本須以同一起點建(否則 g_backtest.mjs 離開碼 5)
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
let unit = st.source.unit === undefined ? null : st.source.unit
let startTime = st.source.startTime //(起首列之後才讀: 設定缺 source 等壞設定下之失敗時序同 1.0.30; 規則 R-EV-45)
let meta
try {
    meta = await buildLedger({
        libraryRoot: st.source.libraryRoot,
        keyOhlc: st.source.keyOhlc,
        barHours: st.source.barHours,
        endTime,
        ...(startTime !== undefined && startTime !== null ? { startTime } : {}),
        outDir,
        limit: train ? 0 : limit,
        seriesDir: typeof st.source.seriesDir === 'string' && st.source.seriesDir ? P(st.source.seriesDir) : null,
        ...(unit !== null ? { unit } : {}),
        ...(st.source.seriesOffGridMax !== undefined && st.source.seriesOffGridMax !== null ? { seriesOffGridMax: st.source.seriesOffGridMax } : {}),
    })
}
catch (err) {
    //每根之時長、策略檔之每根秒數之宣告、外部序列對不到棒之比例(規則 R-EV-44)、帳本之起點(規則 R-EV-45): 不寫出, 離開碼 2(設定之鍵名改為 source.*)
    let m = String(err && err.message)
    if (/^invalid (barHours|seriesOffGridMax|startTime|series |settings\.intervalSec)/.test(m)) {
        console.log(`ERROR ${m.replace(/^invalid (barHours|seriesOffGridMax|startTime)/, 'invalid source.$1')}`)
        process.exit(2)
    }
    //基礎單位之設定不合(含收盤價不合; 規則 R-EV-43): 不寫出, 離開碼 2; 其他錯誤照舊拋出
    if (unit !== null && /^invalid (unit|close)\b/.test(String(err && err.message))) {
        console.log(`ERROR ${err.message.replace(/^invalid unit/, 'invalid source.unit')}`)
        process.exit(2)
    }
    throw err
}
console.log(JSON.stringify({ key: meta.key, endTime: meta.endTime, ...(meta.startTime !== undefined ? { startTime: meta.startTime } : {}), nBars: meta.nBars, nStrategies: meta.nStrategies, nOrders: meta.nOrders, nUnsettled: meta.nUnsettled, check: meta.check, seriesNames: meta.seriesNames, ...(meta.unit ? { unit: meta.unit, unitStat: meta.unitStat } : {}), buildSec: meta.buildSec }))
//單一策略之峰值名義(規則 R-EV-43; 只記錄): 有超過研究用本金者列一行醒目之說明(離開碼仍 0)
if (meta.unit && meta.unitStat.nStrategyOverUIni > 0) {
    console.log(`WARN 單一策略之全期最大同時持倉名義超過研究用本金 ${meta.unit.uIni}u 者 ${meta.unitStat.nStrategyOverUIni} 隻(最大者 ${meta.unitStat.strategyPeakFile} ${meta.unitStat.strategyPeakNotional}u);只記錄、帳本已寫出 —— 研究用本金之檢查只施於挑選後之持倉組合(評估器)`)
}
//帳本之起點晚於訓練期起點(規則 R-EV-45; 以時刻比較〔Date.parse(`${x}Z`)〕, 寫法不同而同一時刻者不印): 帳本未涵蓋訓練期起點 ⇒ 暖機與 ctx.meta.ntAll 自帳本起點起算(評估帳本與 --train 帳本皆然); 只提示, 離開碼仍 0
//  訓練期起點須為字串且可解析; 非字串(缺、陣列、物件等)或無法解析者不印(設定之檢查另由 g_eval.mjs 等負責)
if (meta.startTime !== undefined && st.periods && st.periods.train && typeof st.periods.train.start === 'string') {
    let tTrain = Date.parse(`${st.periods.train.start}Z`)
    if (Number.isFinite(tTrain) && Date.parse(`${meta.startTime}Z`) > tTrain) {
        console.log(`WARN 帳本起點 ${meta.startTime} 晚於訓練期起點 ${st.periods.train.start}:帳本未涵蓋訓練期起點,暖機與 ctx.meta.ntAll 自帳本起點起算`)
    }
}
