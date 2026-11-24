// 挑選模組範例(只示範寫法, 不代表任何有效之挑法)
//  挑選(〔機制〕之寫法): 逐策略之入選條件 —— 近 180 日已結單數 ≥ 5, 且該策略自身之每單平均損益與勝率達其方向(做多 / 做空)各自之門檻者入選; 每隻是否入選只由其自身之量決定
//    不取名次、分位、前 K、固定席數、庫比例或庫彙總量 ⇒ 入選隻數與多空組成是結果, 可多、可少、可為零(門檻之取值使某一側恆無入選者, 該側即不下單; 兩側各有自己之條件)
//    真實策略庫(數萬隻)須自行以條件之鬆緊與 accept 之上限, 使月均單與最大同時持倉落在硬限制內(月均單 ≤ 400、最大同時持倉 ≤ 50; 合約 §4); 本範例之門檻(做多 0.3 / 0.5、做空 0.25 / 0.5)為示範值, 不是有效之挑法
//    〔線索〕(依名次取前 K、依分位或固定席數)之寫法不屬節點任務之交付(見合約 §5「判讀名詞」之形式)
//  執行(中性預設): 兩側各自一份上限 —— 做多在倉達 25 單即不再下做多單、做空同; 不設每日上限
//  合約見 docs/pick-contract.md; 評估: node g_eval.mjs --pick examples/pick_example.mjs --mode quick
export const meta = { arms: [], params: { lookbackDays: 180, minClosed: 5, long: { minAvgPnl: 0.3, minWinRate: 0.5 }, short: { minAvgPnl: 0.25, minWinRate: 0.5 }, maxHoldPerSide: 25 }, desc: '範例: 逐策略條件(近 180 日已結單 ≥ 5、每單平均損益與勝率達各側之門檻)入選; 各側持倉上限 25' }

export default function pick(ctx) {
    let cfg = meta.params
    let st = ctx.stat(cfg.lookbackDays) //近 180 日之統計(各陣列長度 ctx.n; 只在本次呼叫內有效, 勿跨決策保存)
    let mode = ctx.meta.mode //1 做多 / -1 做空(靜態屬性)
    let ids = []
    for (let s = 0; s < ctx.n; s++) {
        let c = st.closed[s]
        if (c < cfg.minClosed) {
            continue
        }
        let side = mode[s] === 1 ? cfg.long : cfg.short
        if (st.pnl[s] / c >= side.minAvgPnl && st.wins[s] / c >= side.minWinRate) {
            ids.push(s)
        }
    }
    return ids
}

export function accept(sig, book) {
    return sig.mode === 1 ? book.openLong < 25 : book.openShort < 25
}
