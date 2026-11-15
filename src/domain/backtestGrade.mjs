//回測期旗標之分級(純函式; 對 agent 只揭露等級, 不含任何數字)
//  參照 = 「組成相當之隨機挑」: 同決策時點、同執行規則、每次決策之隻數依訊號量之比縮放(訊號量相當),
//         且做多之比例固定為成品於回測期之平均做多比例(grade.matchSides; 靜態之多空組成相當)
//         —— 偏多 / 偏空或較活躍 / 較安靜之選集, 不因該期間之多空行情或下單量而得分或失分; 等級反映「在組成相當之下挑得好不好」與「兩側配比隨狀態改變之效果」
//  回測期等分為數段(grade.splits), 每段各自與該段之參照比, 得各段之 z; 全段之顯著性以各段 z 之合併(Σz ÷ √段數; 單側)判定
//         —— 不以「全段一次比較」判定: 成品之下單量若隨時段而異, 全段之差會混入「何時下單較多」, 那不是挑選內容
//  等級(由高至低):
//    pass   各複製版(換亂數種子)之七相位等效年化皆達判準(穩定之正績效)
//    above  未達 pass; 各段合併後顯著高於參照(單側 p ≤ pAbove), 且各段之超額皆為正, 且各複製版皆高於參照之平均
//    mixed  合併後顯著高於參照但分段或複製版不一致; 或有某一段單獨即明顯高於參照(單側 p ≤ pStrong)而合併後不顯著(只在部分期間成立)
//    level  與參照無顯著差異; 或回測期內完全沒有下單(無從判斷)
//    below  合併後顯著低於參照(單側 p ≥ pBelow)
//  輸入:
//    repsOk     [布林]: 各複製版是否達 pass 之判準
//    nOrders    主重放於回測期之下單總數
//    segZ       [數字]: 各分段之 z(本成品 − 該段參照之平均, 除以該段參照之標準差)
//    halves     [數字]: 各分段之超額(本成品 − 該段參照之平均)
//    repsAbove  [布林]: 各複製版之等效年化是否高於參照之平均
//    p          (選配)無分段資料時之全段單側 p
let GRADES = ['below', 'level', 'mixed', 'above', 'pass']

//pUpper, 標準常態之上尾機率 P(Z ≥ z)(Abramowitz–Stegun 近似; 誤差 < 1e-7)
let pUpper = (z) => {
    let t = 1 / (1 + 0.2316419 * Math.abs(z))
    let d = 0.3989422804014327 * Math.exp(-z * z / 2)
    let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
    return z >= 0 ? p : 1 - p
}

let gradeOf = ({ repsOk = [], nOrders = 0, segZ = [], halves = [], repsAbove = [], p = null } = {}, { pAbove = 0.05, pBelow = 0.95, pStrong = 0.01 } = {}) => {
    if (repsOk.length > 0 && repsOk.every((x) => x === true)) {
        return 'pass'
    }
    if (!(nOrders > 0)) {
        return 'level'
    }
    let zs = segZ.filter((z) => typeof z === 'number' && Number.isFinite(z))
    let pAll = zs.length > 0 ? pUpper(zs.reduce((s, v) => s + v, 0) / Math.sqrt(zs.length)) : p
    if (typeof pAll !== 'number' || !Number.isFinite(pAll)) {
        return 'level'
    }
    let steady = halves.length > 0 && halves.every((x) => typeof x === 'number' && x > 0) && repsAbove.length > 0 && repsAbove.every((x) => x === true)
    if (pAll <= pAbove && steady) {
        return 'above'
    }
    if (pAll <= pAbove || zs.some((z) => pUpper(z) <= pStrong)) {
        return 'mixed'
    }
    if (pAll >= pBelow) {
        return 'below'
    }
    return 'level'
}

//gradeRank, 等級之序(越大越好); 舊制之 'fail' 視同 level; 未算回 -1
let gradeRank = (g) => (g === 'fail' ? GRADES.indexOf('level') : GRADES.indexOf(g))

//gradeVetoed, 該等級是否否決(不作為起點與參考): level、below 與舊制之 fail
let gradeVetoed = (g) => g === 'level' || g === 'below' || g === 'fail'

//gradeLabel, 給人讀之一句話(不含數字)
let gradeLabel = (g) => ({
    pass: 'pass(樣本外通過:各相位、各亂數種子皆為正)',
    above: 'above(樣本外顯著高於組成相當之隨機挑,各分段與各亂數種子皆然;尚未達 pass)',
    mixed: 'mixed(樣本外只在部分期間或部分亂數種子明顯高於組成相當之隨機挑)',
    level: 'level(樣本外與組成相當之隨機挑無異 ⇒ 否決)',
    below: 'below(樣本外顯著低於組成相當之隨機挑 ⇒ 否決)',
    fail: 'fail(樣本外未通過 ⇒ 否決;舊制之二元旗標)',
}[g] || String(g))


export { GRADES, gradeOf, gradeRank, gradeVetoed, gradeLabel, pUpper }
export default gradeOf
