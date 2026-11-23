import path from 'path'
import { FD_ROOT } from '../cfg.mjs'
import { cfgNumOf } from '../eval/cfgNum.mjs'
import { rsiNumOf, RSI_NUM_KINDS } from '../arsi/rsiNums.mjs'

//objOf, 非物件(含陣列、null)視為空物件
let objOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

//omit, 去掉指定之鍵(其餘之鍵與次序不變)
let omit = (o, ks) => Object.fromEntries(Object.entries(o).filter(([k]) => !ks.includes(k)))

//reqNumOf, 影響回測期旗標之數字(rule、grade): 未給(undefined 或 null)取預設; 數字或其數字字串轉為數值後須合種類(RSI_NUM_KINDS); 給了而無效拋 invalid <where>: must be <說明>(同 cfgNumOf 之口徑)
let reqNumOf = (v, def, where, kind) => {
    if (v === undefined || v === null) {
        return def
    }
    let x = rsiNumOf(v, kind)
    if (x === null) {
        throw new Error(`invalid ${where}: must be ${RSI_NUM_KINDS[kind][0]}`)
    }
    return x
}


//回測期旗標之設定(settings.backtest; 未設之欄用預設)
//  privateRoot  私有根: 全期帳本與各節點之回測期數字皆放此處, 位於專案夾之外 —— 節點 agent 之工作區只限專案夾, 讀不到;
//               回測期數字只有迴圈(與主代理)看得到, 對節點 agent 與做夢 agent 只揭露旗標(pass / fail)
//  minLadder    節點之訓練期階梯達此值才算回測期旗標; 預設 0 = 凡可評估且未超過硬上限之成品皆算
//               (訓練期對策略庫為樣本內, 「訓練期勝過隨機」不能當作樣本外檢驗之門檻: 依市況切換多空之類機制在訓練期看不出差別, 只在樣本外才分得出來)
//  rule         旗標判準: 回測期七相位之等效年化平均 > meanMin 且最差相位 > worstPhaseMin(「穩定之正績效」)
//  replicas     複製版之數目(預設 3): 以不同之亂數種子(挑選函數之 ctx.rand)各重放一次, **全部**達 rule 才 pass
//               —— 成品若含隨機抽取, 單一種子之 pass 可能只是那一次抽到之策略碰巧賺; 不含隨機者各複製版相同, 無影響
//  nullDraws    回測期隨機挑(虛無)之抽數; 分級(grade)以它為參照
//  grade        分級旗標(預設啟用): 未達 pass 者再依「對訊號量相當之隨機挑」分為 above / mixed / level / below(定義見 backtestGrade.mjs)
//               enabled false ⇒ 只有 pass / fail(二元); pAbove / pBelow 為各段合併後之單側 p 之門檻、pStrong 為單一分段「明顯較高」之門檻;
//               splits 為回測期等分之段數(各段之超額須同為正才算 above); matchSides(預設 true)= 參照之做多比例固定為成品於回測期之平均做多比例
//               —— 二元旗標於全部成品皆 fail 時不提供任何方向; 分級只多揭露每個成品之等級(不含數字), above / mixed 不否決、可作為起點
//  數值之欄(minLadder、replicas、nullDraws、timeoutSec)影響回測期旗標之結果(排程第 547 項; 與 settings.eval 之數值鍵同一口徑, R-EV-44 ④之二、R-EV-50): 未給(undefined 或 null)= 預設;
//    數字原樣、數字字串轉為數值後才使用(K4、K7); 給了而無效(非整數、負數、布林、非數字字串…)⇒ 拋 invalid backtest.<鍵>: must be …(不帶輸入值; 原: 不合者被靜默改用預設 ——
//    replicas: 2.5 與 '5' 都靜默為 3 份複製版、nullDraws: '32' 與 1.5 都靜默為 64 抽、timeoutSec: 0 與 'abc' 靜默為 1200 秒)
/**
 * 由設定取得回測期旗標之設定(settings.backtest;未設之欄用預設);數值之欄(minLadder、replicas、nullDraws、timeoutSec)給了而無效者拋 invalid backtest.<鍵>: must be …
 *
 * @param {Object} st 輸入設定物件,讀取 st.backtest(enabled、privateRoot、ledgerDir、resultDir、minLadder、rule、replicas、nullDraws、grade、timeoutSec)
 * @returns {Object} 回傳設定物件 { enabled, privateRoot, ledgerDir, resultDir, minLadder, rule, replicas, nullDraws, grade, timeoutSec };minLadder 預設0(非負整數)、replicas 預設3(正整數)、nullDraws 預設64(非負整數)、timeoutSec 預設1200(正數,秒;換成毫秒不超過 2147483647)
 * @example
 * let cfg = backtestCfg({ backtest: { replicas: 5 } })
 */
let backtestCfg = (st) => {
    let b = st.backtest || {}
    let privateRoot = path.resolve(b.privateRoot || `${FD_ROOT}-private`)
    //每個鍵只讀一次(檢查之值即使用之值)
    let minLadder = cfgNumOf(b.minLadder, 0, 'backtest.minLadder', 'nonNegInt')
    let replicas = cfgNumOf(b.replicas, 3, 'backtest.replicas', 'posInt')
    let nullDraws = cfgNumOf(b.nullDraws, 64, 'backtest.nullDraws', 'nonNegInt')
    let timeoutSec = cfgNumOf(b.timeoutSec, 1200, 'backtest.timeoutSec', 'timerSec')
    //旗標判準與分級之數字(rule.meanMin、rule.worstPhaseMin、grade.pAbove、pBelow、pStrong、splits; 排程第 595 項之接續, R-EV-44 ④之二、R-BT-12): 同上之口徑 ——
    //  未給(undefined 或 null)= 預設; 數字原樣、數字字串轉為數值後才使用(K4、K7); 給了而無效 ⇒ 拋 invalid backtest.<鍵>: must be …(不帶輸入值)
    //  原: 展開合併進來, 字串與非數字成 NaN 或隱式轉型之比較而靜默(`mean > '0.5'` 以數值比、`'abc'` 使旗標恆為 fail、`''` 與 false 被當 0、`splits: '2'` 經 Math.round 而可用但 `'abc'` 為 NaN)
    let rl = objOf(b.rule)
    let gr = objOf(b.grade)
    let meanMin = reqNumOf(rl.meanMin, 0, 'backtest.rule.meanMin', 'num')
    let worstPhaseMin = reqNumOf(rl.worstPhaseMin, 0, 'backtest.rule.worstPhaseMin', 'num')
    let pAbove = reqNumOf(gr.pAbove, 0.05, 'backtest.grade.pAbove', 'unit')
    let pBelow = reqNumOf(gr.pBelow, 0.95, 'backtest.grade.pBelow', 'unit')
    let pStrong = reqNumOf(gr.pStrong, 0.01, 'backtest.grade.pStrong', 'unit')
    let splits = reqNumOf(gr.splits, 2, 'backtest.grade.splits', 'posInt')
    //其餘之鍵(含 grade.enabled、matchSides 與未知之鍵)照舊展開(次序同改前: 預設之鍵在前, 展開之鍵覆蓋)
    let ruleRest = omit(rl, ['meanMin', 'worstPhaseMin'])
    let gradeRest = omit(gr, ['pAbove', 'pBelow', 'pStrong', 'splits'])
    return {
        enabled: b.enabled !== false,
        privateRoot,
        ledgerDir: b.ledgerDir ? path.resolve(b.ledgerDir) : path.join(privateRoot, 'ledger', 'full'),
        resultDir: b.resultDir ? path.resolve(b.resultDir) : path.join(privateRoot, 'backtest'),
        minLadder,
        rule: { meanMin, worstPhaseMin, ...ruleRest },
        replicas,
        nullDraws,
        grade: { enabled: !(b.grade && b.grade.enabled === false), pAbove, pBelow, pStrong, splits, matchSides: true, ...gradeRest },
        timeoutSec,
    }
}


export { backtestCfg }
export default backtestCfg
