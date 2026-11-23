// 挑選模組範例(只示範寫法, 不代表任何有效之挑法)
//  挑選: 近 180 日已結單數 ≥ 5 者, 依近 180 日每單平均損益由高至低取前 40; 同分以 ctx.meta.tie 為次鍵(不用序號)
//    —— 寫法之示範;取前 K 屬〔線索〕之形式(見合約 §5「判讀名詞」之形式),節點任務之交付須為〔機制〕(每隻策略依自身之量是否達門檻入選)
//  執行(中性預設): 兩側各自一份上限 —— 做多在倉達 25 單即不再下做多單、做空同; 不設每日上限
//  合約見 docs/pick-contract.md; 評估: node g_eval.mjs --pick examples/pick_example.mjs --mode quick
export const meta = { arms: [], params: { lookbackDays: 180, minClosed: 5, take: 40, maxHoldPerSide: 25 }, desc: '範例: 近 180 日每單平均損益前 40; 各側持倉上限 25' }

export default function pick(ctx) {
    let st = ctx.stat(180) //近 180 日之統計(各陣列長度 ctx.n; 只在本次呼叫內有效, 勿跨決策保存)
    let tie = ctx.meta.tie
    let cands = []
    for (let s = 0; s < ctx.n; s++) {
        if (st.closed[s] >= 5) {
            cands.push(s)
        }
    }
    cands.sort((a, b) => (st.pnl[b] / st.closed[b]) - (st.pnl[a] / st.closed[a]) || tie[a] - tie[b])
    return cands.slice(0, 40)
}

export function accept(sig, book) {
    return sig.mode === 1 ? book.openLong < 25 : book.openShort < 25
}
