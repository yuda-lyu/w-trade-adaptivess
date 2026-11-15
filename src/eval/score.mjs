//判讀: 評估器之原料 raw → 分數 S、階梯 ladder、旗標 flags、格 cell(品質多樣性用)
//  **原料為評估期(= 回測期)之評估結果; 目標 = 回測期之等效年化更佳(穩定之正值)**
//  S = 0.7 × 七相位平均等效年化 + 0.3 × 最差相位等效年化(操作績效 op; 相位穩健)
//    注意: 策略庫之每隻策略皆以訓練期求得, 回測期內隨機挑之等效年化為負; S 為正且顯著高於同劑量虛無才算有內容
//  階梯(序數 0 ~ 3; 依序須全過; flags.trainLadder 為同一值之舊欄名, 指「不含檢定旗標之階梯」):
//    1 真偽: S ≥ ladder1.S 且同劑量虛無 p ≤ ladder1.nullP; 評估器另算了「同訊號量虛無」與「同活躍度虛無」(選集之每隻訊號數偏離全體隨機逾 10% 時)者, 兩者之 p 亦須 ≤ ladder1.nullP;
//            另算了「同側同活躍度虛無」(組成對照; 選集之每隻訊號數或做多比例偏離全體隨機逾 10% 時)者, 其 p 亦須 ≤ ladder1.nullP(績效可由「方向 × 活躍度」之組成重現者不算有挑選內容)
//    2 平原: 各新鮮度地平線之七相位平均皆 ≥ ladder2.freshMin 且最差相位 ≥ ladder2.worstPhaseMin
//    3 可行: 月均單 ≤ ladder3.monthlyOrders 且最大同時持倉 ≤ ladder3.peakHold
//  檢定旗標(evidence.backtest; 「回測期旗標」機制, 隨附之參考設定不啟用 —— settings.backtest.enabled = false(未設時 backtestCfg 視為啟用); 不啟用時 evidence 不帶此欄, 下述各列不作用):
//    有旗標 ⇒ flags.backtest = 該等級, 階梯改為檢定等級: pass 4 | above 3 | mixed 2 | level 1(否決)| below 0(否決)
//    未算   ⇒ flags.backtest = null, ladder = 上述階梯
//  否決 flags.vetoed: 月均單或最大持倉超過硬上限、選集恆空、審計判不可信(evidence.trust === 'untrusted')、檢定旗標為 level / below / fail
let OOS_LADDER = { pass: 4, above: 3, mixed: 2, level: 1, below: 0 }
let OOS_WHY = {
    pass: '回測期旗標 pass(樣本外通過)',
    above: '回測期旗標 above(樣本外顯著高於組成相當之隨機挑,各分段與各亂數種子皆然;尚未達「七相位皆為正」)',
    mixed: '回測期旗標 mixed(樣本外只在部分期間或部分亂數種子明顯高於組成相當之隨機挑)',
    level: '回測期旗標 level(樣本外與組成相當之隨機挑無異)',
    below: '回測期旗標 below(樣本外顯著低於組成相當之隨機挑)',
    fail: '回測期旗標 fail(樣本外未達「七相位皆為正」)',
}
/**
 * 判讀評估器之原料, 算出分數 S、階梯 ladder、旗標 flags 與格 cell
 * S = 0.7 × 七相位平均等效年化 + 0.3 × 最差相位等效年化; 階梯與檢定旗標之判準見檔頭說明
 * raw 無評估結果時回傳 S 0、ladder 0 且 flags.vetoed 為 true
 *
 * @param {Object} raw 輸入評估器之評估結果(可為帶 metrics 欄之物件, 或 metrics 本身)
 * @param {Object} opt 輸入設定物件
 * @param {Object} opt.limits 輸入硬上限物件{ monthlyOrders, peakHold }
 * @param {Object} opt.score 輸入評分門檻物件{ ladder1: { S, nullP }, ladder2: { freshMin, worstPhaseMin }, ladder3: { monthlyOrders, peakHold }, freqBands: [b1, b2] }
 * @param {String} [opt.layer=null] 輸入層名稱, 用於 cell 字串前綴, 預設null(以 ? 表示)
 * @param {Object} [opt.evidence=null] 輸入證據物件(可含 trust、backtest、backtestOK), 預設null
 * @returns {Object} 回傳 { S, ladder(0 ~ 3, 有檢定旗標時 0 ~ 4), flags: { vetoed, why, backtest, trainLadder }, cell(字串 層|low、mid、high 或 none), evaluator }
 * @example
 * let r = scoreOf(m, { limits: { monthlyOrders: 60, peakHold: 20 }, score, layer: 'L1' })
 */
let scoreOf = (raw, { limits, score, layer = null, evidence = null } = {}) => {
    let m = raw && raw.metrics ? raw.metrics : raw
    let why = []
    if (!m || !m.op) {
        return { S: 0, ladder: 0, flags: { vetoed: true, why: ['無評估結果'], backtest: null, trainLadder: 0 }, cell: `${layer || '?'}|none`, evaluator: 1 }
    }
    let mean = m.op.eqYr.mean
    let min = m.op.eqYr.min
    let S = Math.round((0.7 * mean + 0.3 * min) * 100) / 100
    let mo = m.op.monthlyOrders.mean
    let pk = m.op.peakHold.max
    //hard: 使階梯歸零之否決(成品本身不可用)
    let hard = false
    if (mo > limits.monthlyOrders) {
        hard = true
        why.push(`月均單 ${mo.toFixed(0)} > ${limits.monthlyOrders}`)
    }
    if (pk > limits.peakHold) {
        hard = true
        why.push(`最大同時持倉 ${pk} > ${limits.peakHold}`)
    }
    if (m.sel && m.sel.sizeMax === 0) {
        hard = true
        why.push('選集恆空')
    }
    if (evidence && evidence.trust === 'untrusted') {
        hard = true
        why.push('審計判不可信')
    }
    let backtest = evidence && typeof evidence.backtest === 'string' && (evidence.backtest in OOS_WHY) ? evidence.backtest : (evidence && typeof evidence.backtestOK === 'boolean' ? (evidence.backtestOK ? 'pass' : 'fail') : null)
    let trainLadder = 0
    let volOk = !m.nullVol || m.nullVol.p <= score.ladder1.nullP
    //同活躍度虛無(有算時): 選集只是較安靜 / 較活躍而無其他內容者, 不算過階梯 1
    let actOk = !m.nullAct || m.nullAct.p <= score.ladder1.nullP
    //同側同活躍度虛無(有算時 = 選集之方向或活躍度偏離全體隨機): 績效可由「方向 × 活躍度」之組成重現者(同組成之隨機替換一樣好), 不算過階梯 1
    //  此虛無一律計算; 只在 triggered(選集之每隻訊號數或做多比例偏離全體隨機逾 10%)時列入階梯 1 —— 舊結果無 triggered 欄者(當時只在偏離時才算)視為 triggered
    let sideReq = !!m.nullSideAct && m.nullSideAct.triggered !== false
    let sideOk = !sideReq || m.nullSideAct.p <= score.ladder1.nullP
    let l1 = S >= score.ladder1.S && m.null && m.null.p <= score.ladder1.nullP && volOk && actOk && sideOk
    if (!l1) {
        why.push(`階梯 1 未過: S ${S}(門檻 ${score.ladder1.S}), 虛無 p ${m.null ? m.null.p : '未算'}(門檻 ${score.ladder1.nullP})${m.nullVol ? `, 同訊號量虛無 p ${m.nullVol.p}` : ''}${m.nullAct ? `, 同活躍度虛無 p ${m.nullAct.p}` : ''}${sideReq ? `, 同側同活躍度虛無 p ${m.nullSideAct.p}(組成可重現 ${m.nullSideAct.share === null ? '—' : `${Math.round(m.nullSideAct.share * 100)}%`})` : ''}`)
    }
    if (l1 && !hard) {
        trainLadder = 1
        let hs = Object.keys(m.fresh || {})
        let freshOk = hs.length > 0 && hs.every((H) => m.fresh[H].eqYr.mean >= score.ladder2.freshMin)
        let l2 = freshOk && min >= score.ladder2.worstPhaseMin
        if (!l2) {
            why.push(`階梯 2 未過: 新鮮度 ${hs.map((H) => `${H}d ${m.fresh[H].eqYr.mean.toFixed(1)}`).join(' / ')}(皆須 ≥ ${score.ladder2.freshMin}), 最差相位 ${min.toFixed(1)}(須 ≥ ${score.ladder2.worstPhaseMin})`)
        }
        if (l2) {
            trainLadder = 2
            let l3 = mo <= score.ladder3.monthlyOrders && pk <= score.ladder3.peakHold
            if (!l3) {
                why.push(`階梯 3 未過: 月均單 ${mo.toFixed(0)}(須 ≤ ${score.ladder3.monthlyOrders}), 最大持倉 ${pk}(須 ≤ ${score.ladder3.peakHold})`)
            }
            if (l3) {
                trainLadder = 3
            }
        }
    }
    let ladder = trainLadder
    if (backtest) {
        why.push(`${OOS_WHY[backtest]};訓練期階梯 ${trainLadder}`)
        if (backtest in OOS_LADDER) {
            ladder = hard ? 0 : OOS_LADDER[backtest]
        }
    }
    let oosVeto = backtest === 'level' || backtest === 'below' || backtest === 'fail'
    let [b1, b2] = score.freqBands
    let band = mo < b1 ? 'low' : (mo < b2 ? 'mid' : 'high')
    return { S, ladder, flags: { vetoed: hard || oosVeto, why, backtest, trainLadder }, cell: `${layer || '?'}|${band}`, evaluator: 1 }
}


export { scoreOf }
export default scoreOf
