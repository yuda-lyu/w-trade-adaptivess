//核心以名稱讀取之擴充診斷之「有值」之唯一判準(規則 R-REC-38 ⑥、⑦; R-REC-40、R-REC-42): 領域(domain.mjs)、迴圈之驗證(verify.mjs)、共同儲存區(pickStore.mjs)共用本檔之函數, 不各自內嵌
//  本檔不得匯入領域、驗證或儲存區之模組(避免循環匯入; 三者皆匯入本檔)

//RECENT_DIAG, 近期活躍度版之組成對照所用之擴充診斷名(核心以此名讀取; 成員穩健性之半庫評估之 --ext-only 與其快取之鍵〔fillPlan.mjs〕亦用此名, 同一來源)
let RECENT_DIAG = 'nullRecentAct'

//recentDiagOf, 近期活躍度版之組成對照之 side(核心讀取之擴充診斷名為 RECENT_DIAG = nullRecentAct; 取值之唯一來源): m = 正本之 metrics 或一次重放之結果之 metrics;
//  m.ext.nullRecentAct 為物件、不帶 error、其 side 為物件、side.excess 為有限數值者回該 side;
//  未載入、出錯(帶 error)、缺 side、excess 缺或非有限數值(NaN、±Infinity、字串等)者回 null(= 無值)
//  只要求超額為有限數值; 另須 p 者(「有內容」之判定)由呼叫端自行再核(domain.mjs 之 recentSideOf)
let recentDiagOf = (m) => {
    let e = m && m.ext && typeof m.ext === 'object' ? m.ext[RECENT_DIAG] : null
    let s = e && typeof e === 'object' && !e.error ? e.side : null
    return s && typeof s === 'object' && Number.isFinite(s.excess) ? s : null
}

//neutralDeltaOf, 「成品 − 中性執行」之差(規則 R-REC-40、R-REC-42; 核心以名稱讀取之擴充診斷 neutralExec = 成品之選集原樣、執行規則換成中性預設重放; 取值之唯一來源):
//  m.ext.neutralExec(m = 正本之 metrics, 或一次重放之紀錄)為物件、不帶 error、其 delta(成品之 S − 中性執行之 S)為有限數值者回 delta;
//  未載入、出錯、缺欄、非有限數值(NaN、±Infinity、字串等)者回 null(= 無值)
//  用處: 排序鍵(domain.mjs 之 rankKeyOf)、重放之紀錄(verify.mjs 之 replayExtOf)、重放另載入 neutralExec 與否之判定(verify.mjs 之 replicaExtArgsOf: 正本有值者 'board' 之範圍另加之)
let neutralDeltaOf = (m) => {
    let e = m && m.ext && typeof m.ext === 'object' ? m.ext.neutralExec : null
    return e && typeof e === 'object' && !Array.isArray(e) && !e.error && Number.isFinite(e.delta) ? e.delta : null
}

export { RECENT_DIAG, recentDiagOf, neutralDeltaOf }
