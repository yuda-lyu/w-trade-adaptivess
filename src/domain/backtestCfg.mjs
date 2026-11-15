import path from 'path'
import { FD_ROOT } from '../cfg.mjs'


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
/**
 * 由設定取得回測期旗標之設定(settings.backtest;未設之欄用預設)
 *
 * @param {Object} st 輸入設定物件,讀取 st.backtest(enabled、privateRoot、ledgerDir、resultDir、minLadder、rule、replicas、nullDraws、grade、timeoutSec)
 * @returns {Object} 回傳設定物件 { enabled, privateRoot, ledgerDir, resultDir, minLadder, rule, replicas, nullDraws, grade, timeoutSec };replicas 預設3、nullDraws 預設64、timeoutSec 預設1200
 * @example
 * let cfg = backtestCfg({ backtest: { replicas: 5 } })
 */
let backtestCfg = (st) => {
    let b = st.backtest || {}
    let privateRoot = path.resolve(b.privateRoot || `${FD_ROOT}-private`)
    return {
        enabled: b.enabled !== false,
        privateRoot,
        ledgerDir: b.ledgerDir ? path.resolve(b.ledgerDir) : path.join(privateRoot, 'ledger', 'full'),
        resultDir: b.resultDir ? path.resolve(b.resultDir) : path.join(privateRoot, 'backtest'),
        minLadder: Number.isInteger(b.minLadder) ? b.minLadder : 0,
        rule: { meanMin: 0, worstPhaseMin: 0, ...(b.rule || {}) },
        replicas: Number.isInteger(b.replicas) && b.replicas >= 1 ? b.replicas : 3,
        nullDraws: Number.isInteger(b.nullDraws) ? b.nullDraws : 64,
        grade: { enabled: !(b.grade && b.grade.enabled === false), pAbove: 0.05, pBelow: 0.95, pStrong: 0.01, splits: 2, matchSides: true, ...(b.grade || {}) },
        timeoutSec: b.timeoutSec || 1200,
    }
}


export { backtestCfg }
export default backtestCfg
