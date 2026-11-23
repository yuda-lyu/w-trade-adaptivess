import path from 'path'
import { FD_ROOT } from '../cfg.mjs'
import { cfgNumOf } from '../eval/cfgNum.mjs'
import { rsiNumOf, RSI_NUM_KINDS } from '../arsi/rsiNums.mjs'
import { boolOpt, objReq, isPlain, badInput, strReq } from '../arsi/inputs.mjs'

//objSect, 節(rule、grade): 未給(undefined 或 null)= 空物件; 一般物件原樣; 其餘拋 invalid <where>: must be an object
let objSect = (v, where) => (v === undefined || v === null ? {} : objReq(v, where))

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
    //settings.backtest 本身(給了而不是一般物件 ⇒ 拋 invalid backtest: must be an object; 原: `|| {}` 使 `false`、`'x'`、0 等靜默視為空物件而回測期旗標照常啟用 —— 與「關閉」之意圖相反;
    //  未給〔undefined、null〕= 空物件); 路徑欄(privateRoot = 禁區之錨與回測期數字之所在、ledgerDir、resultDir)給了而非非空字串 ⇒ 拋 invalid backtest.<鍵>: must be a non-empty string(原: 空字串、false、0 靜默取預設,
    //  其餘非字串於 path.resolve 拋原生 TypeError); 未給(undefined、null)= 預設
    let b = st.backtest === undefined || st.backtest === null ? {} : st.backtest
    if (!isPlain(b)) {
        throw badInput('backtest', 'an object')
    }
    let pathOf = (v, where) => (v === undefined || v === null ? null : strReq(v, where))
    let privateRootArg = pathOf(b.privateRoot, 'backtest.privateRoot')
    let ledgerDirArg = pathOf(b.ledgerDir, 'backtest.ledgerDir')
    let resultDirArg = pathOf(b.resultDir, 'backtest.resultDir')
    let privateRoot = path.resolve(privateRootArg || `${FD_ROOT}-private`)
    //每個鍵只讀一次(檢查之值即使用之值)
    let minLadder = cfgNumOf(b.minLadder, 0, 'backtest.minLadder', 'nonNegInt')
    let replicas = cfgNumOf(b.replicas, 3, 'backtest.replicas', 'posInt')
    let nullDraws = cfgNumOf(b.nullDraws, 64, 'backtest.nullDraws', 'nonNegInt')
    let timeoutSec = cfgNumOf(b.timeoutSec, 1200, 'backtest.timeoutSec', 'timerSec')
    //旗標判準與分級之數字(rule.meanMin、rule.worstPhaseMin、grade.pAbove、pBelow、pStrong、splits; 排程第 595 項之接續, R-EV-44 ④之二、R-BT-12): 同上之口徑 ——
    //  未給(undefined 或 null)= 預設; 數字原樣、數字字串轉為數值後才使用(K4、K7); 給了而無效 ⇒ 拋 invalid backtest.<鍵>: must be …(不帶輸入值)
    //  原: 展開合併進來, 字串與非數字成 NaN 或隱式轉型之比較而靜默(`mean > '0.5'` 以數值比、`'abc'` 使旗標恆為 fail、`''` 與 false 被當 0、`splits: '2'` 經 Math.round 而可用但 `'abc'` 為 NaN)
    //rule、grade 給了而不是一般物件(如字串、陣列、數字、布林)⇒ 拋 invalid backtest.rule / grade: must be an object(原: objOf 靜默視為空物件 ⇒ `grade: "false"` 之分級照常啟用); 未給(undefined 或 null)= 空物件
    let rl = objSect(b.rule, 'backtest.rule')
    let gr = objSect(b.grade, 'backtest.grade')
    let meanMin = reqNumOf(rl.meanMin, 0, 'backtest.rule.meanMin', 'num')
    let worstPhaseMin = reqNumOf(rl.worstPhaseMin, 0, 'backtest.rule.worstPhaseMin', 'num')
    let pAbove = reqNumOf(gr.pAbove, 0.05, 'backtest.grade.pAbove', 'unit')
    let pBelow = reqNumOf(gr.pBelow, 0.95, 'backtest.grade.pBelow', 'unit')
    let pStrong = reqNumOf(gr.pStrong, 0.01, 'backtest.grade.pStrong', 'unit')
    let splits = reqNumOf(gr.splits, 2, 'backtest.grade.splits', 'posInt')
    //決定回測期旗標之布林(enabled、grade.enabled、grade.matchSides; R-EV-54 ②, K5): 給了而不是 true / false(字串 'false'、'true'、數字、空字串皆非布林)⇒ 拋 invalid backtest.<鍵>: must be a boolean(不帶輸入值); 未給(undefined 或 null)= 預設(true、true、true)
    //  原: enabled 以 `!== false` 判 ⇒ `enabled: "false"`、`0` 仍啟用; grade.enabled 以 `=== false` 判 ⇒ `"false"` 仍啟用分級、`null` 之展開覆蓋使分級關閉; matchSides 展開之原值覆蓋預設 ⇒ `"true"` 於 `=== true` 判定下關閉
    let enabled = boolOpt(b.enabled, true, 'backtest.enabled')
    let gradeEnabled = boolOpt(gr.enabled, true, 'backtest.grade.enabled')
    let matchSides = boolOpt(gr.matchSides, true, 'backtest.grade.matchSides')
    //其餘之鍵(含未知之鍵)照舊展開(次序同改前: 預設之鍵在前, 展開之鍵覆蓋)
    let ruleRest = omit(rl, ['meanMin', 'worstPhaseMin'])
    let gradeRest = omit(gr, ['pAbove', 'pBelow', 'pStrong', 'splits', 'enabled', 'matchSides'])
    return {
        enabled,
        privateRoot,
        ledgerDir: ledgerDirArg ? path.resolve(ledgerDirArg) : path.join(privateRoot, 'ledger', 'full'),
        resultDir: resultDirArg ? path.resolve(resultDirArg) : path.join(privateRoot, 'backtest'),
        minLadder,
        rule: { meanMin, worstPhaseMin, ...ruleRest },
        replicas,
        nullDraws,
        grade: { enabled: gradeEnabled, pAbove, pBelow, pStrong, splits, matchSides, ...gradeRest },
        timeoutSec,
    }
}


export { backtestCfg }
export default backtestCfg
