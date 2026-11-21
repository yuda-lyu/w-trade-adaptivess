//量尺之主鍵改為挑選內容時對名次之影響之估法(規則 R-REC-49; 純函數; 唯讀): 供主控於設定 rsi.rankBy 之前讀出兩種次序之差
//  rows 之每列 { id, key, content, exposure }: key = 排序鍵(rankKeyOf), content = 挑選內容(contentOf 之 v), exposure = 是否為側別曝險(布林)
//  呼叫端已取「可信、未被否決、有挑選內容之值、排序鍵為有限數值」之成品; 兩種次序:
//    排序鍵 = key 由高至低(同值依 id); 挑選內容 = content 由高至低(同值依 key 由高至低、再依 id; 與 rsi.rankBy = content 之次鍵同)
//  量: 兩者之第一名; Spearman ρ(同值取平均名次)與 Kendall τ-b(以兩個值本身計, 同值之對不計入一致或不一致); 前 k 名之交集之個數; 各自之前 k 名中曝險者之個數
let idCmp = (a, b) => (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0))
let avgRanks = (vals) => {
    //名次 1 = 最高; 同值者取平均名次
    let idx = vals.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v)
    let r = new Array(vals.length)
    for (let s = 0; s < idx.length;) {
        let e = s
        while (e + 1 < idx.length && idx[e + 1].v === idx[s].v) {
            e++
        }
        for (let j = s; j <= e; j++) {
            r[idx[j].i] = (s + e) / 2 + 1
        }
        s = e + 1
    }
    return r
}
let pearson = (x, y) => {
    let n = x.length
    let mx = x.reduce((a, b) => a + b, 0) / n
    let my = y.reduce((a, b) => a + b, 0) / n
    let sxy = 0
    let sxx = 0
    let syy = 0
    for (let i = 0; i < n; i++) {
        sxy += (x[i] - mx) * (y[i] - my)
        sxx += (x[i] - mx) ** 2
        syy += (y[i] - my) ** 2
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null
}
let kendallB = (x, y) => {
    let c = 0
    let d = 0
    let tx = 0
    let ty = 0
    for (let i = 0; i < x.length; i++) {
        for (let j = i + 1; j < x.length; j++) {
            let a = Math.sign(x[i] - x[j])
            let b = Math.sign(y[i] - y[j])
            if (a === 0 && b === 0) {
                continue
            }
            if (a === 0) {
                tx++
            }
            else if (b === 0) {
                ty++
            }
            else if (a === b) {
                c++
            }
            else {
                d++
            }
        }
    }
    let den = Math.sqrt((c + d + tx) * (c + d + ty))
    return den > 0 ? (c - d) / den : null
}

/**
 * 兩種次序(排序鍵 / 挑選內容)之差(純函數;唯讀之估法)
 *
 * @param {Array<Object>} rows 輸入候選之列 { id, key, content, exposure }(key 與 content 須為有限數值;不合之列略去)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Number} [opt.k=10] 輸入前幾名
 * @returns {Object} 回傳 { n, k, firstKey, firstContent, sameFirst, spearman, kendall, overlap, exposureKey, exposureContent, byKey, byContent }(byKey / byContent 為兩種次序之 id 陣列);n < 2 者 spearman 與 kendall 為 null
 * @example
 * let r = rankCompareOf([{ id: 'a', key: 3, content: 1, exposure: false }, { id: 'b', key: 2, content: 5, exposure: true }])
 * // => r.sameFirst === false
 */
let rankCompareOf = (rows, { k = 10 } = {}) => {
    let xs = (Array.isArray(rows) ? rows : []).filter((x) => x && typeof x.id === 'string' && Number.isFinite(x.key) && Number.isFinite(x.content))
    let kk = Number.isInteger(k) && k >= 1 ? k : 10
    let byKey = xs.slice().sort((a, b) => (b.key - a.key) || idCmp(a, b))
    let byContent = xs.slice().sort((a, b) => (b.content - a.content) || (b.key - a.key) || idCmp(a, b))
    let topK = byKey.slice(0, kk)
    let topC = byContent.slice(0, kk)
    let inC = new Set(topC.map((x) => x.id))
    let n = xs.length
    let spearman = n >= 2 ? pearson(avgRanks(xs.map((x) => x.key)), avgRanks(xs.map((x) => x.content))) : null
    let kendall = n >= 2 ? kendallB(xs.map((x) => x.key), xs.map((x) => x.content)) : null
    return {
        n,
        k: kk,
        firstKey: byKey.length ? byKey[0].id : null,
        firstContent: byContent.length ? byContent[0].id : null,
        sameFirst: byKey.length > 0 && byKey[0].id === byContent[0].id,
        spearman,
        kendall,
        overlap: topK.filter((x) => inC.has(x.id)).length,
        exposureKey: topK.filter((x) => x.exposure === true).length,
        exposureContent: topC.filter((x) => x.exposure === true).length,
        byKey: byKey.map((x) => x.id),
        byContent: byContent.map((x) => x.id),
    }
}


export { rankCompareOf }
