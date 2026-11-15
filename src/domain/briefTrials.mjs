import crypto from 'crypto'


//任務書條款之隨機對照(trial): 任務提示詞之改動先以「同一輪之節點隨機分兩組」驗證, 再決定採納或撤回(監控原則 §1 第 8 點)
//  A = 現行條款, B = 新條款; 指標於開試驗時事先定(寫在 metric), 由 tools/nodeAudit.mjs 依組別列出
//  一次只開一個(status 'open'); 結案改為 'adopted'(新條款成為全體之預設)或 'dropped'(撤回), 紀錄留著
//  分組: 同一輪所計畫之節點, 先依任務類型分層, 層內依 sha1(試驗 id + 節點 id) 排序後交替指派(每層之首位由輪次與層序之奇偶決定)
//        ⇒ 每輪兩組之人數差 ≤ 層數, 且與節點之內容無關; 節點重做時沿用其首次之組別(由呼叫端自節點文件帶入)
//  本檔不含任務書文字: 各試驗之 B 條款寫在 src/domain/texts.mjs, 以 clauseOn(試驗 id, 節點之 trial) 分支
let TRIALS = [
    {
        id: 'T1',
        status: 'adopted',
        since: 9,
        title: '交付版直接寫成 pick.mjs;重疊率以 quick --ref 量;同一內容不重跑完整評估',
        metric: '主: 完整評估次數 ÷ 相異選集數(r007 為 21 / 13 = 1.62; 目標 ≤ 1.2)。副: agent 秒、迴圈檢查之問題數、做夢審計之可信度(不得變差)',
        why: 'r007 之 5 個節點完整評估 21 次只有 13 個相異選集; 部分出自任務書自己之要求(實驗檔複製成 pick.mjs 再跑一次、為重疊率另跑一次 full)',
        //未經隨機對照即採納: 做夢於方向與「避免」內寫明同樣之做法時(任務書仍為舊措辭), 完整評估次數等於相異選集數(比 1.00),
        //  迴圈檢查 0 問題 ⇒ 做法本身已驗證有效且無副作用; 任務書之舊措辭與做夢之指示相牴觸, 直接改為一致, 不佔用試驗名額
        closed: { round: 8, how: '觀察(非隨機對照)', result: 'r008 完整評估 ÷ 相異選集 = 18 / 18 = 1.00;迴圈檢查 0 問題' },
    },
]

let hashOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex')

//activeTrial, 該輪進行中之試驗(一次一個); 無則 null
let activeTrial = (round, trials = TRIALS) => trials.find((t) => t.status === 'open' && typeof round === 'number' && round >= t.since) || null

//assignTrial, 一輪之分組; items: [{ id, type }](該輪所計畫之全部節點); 回 Map(節點 id → 'A' | 'B')
let assignTrial = (trialId, round, items) => {
    let out = new Map()
    let types = [...new Set(items.map((x) => x.type || 'explore'))].sort()
    types.forEach((ty, gi) => {
        let grp = items.filter((x) => (x.type || 'explore') === ty).slice().sort((a, b) => (hashOf(`${trialId}:${a.id}`) < hashOf(`${trialId}:${b.id}`) ? -1 : 1))
        grp.forEach((x, i) => {
            out.set(x.id, (i + round + gi) % 2 === 0 ? 'B' : 'A')
        })
    })
    return out
}

//variantFallback, 不知該輪之計畫時之分組(只依雜湊之奇偶; 不保證人數平衡)
let variantFallback = (trialId, nodeId) => (parseInt(hashOf(`${trialId}:${nodeId}`).slice(0, 8), 16) % 2 === 0 ? 'B' : 'A')

//clauseOn, 某試驗之新條款對此節點是否生效: 已採納 ⇒ 全體生效; 已撤回 ⇒ 全體不生效; 進行中 ⇒ 只對 B 組
let clauseOn = (trialId, taskTrial, trials = TRIALS) => {
    let t = trials.find((x) => x.id === trialId)
    if (!t || t.status === 'dropped') {
        return false
    }
    if (t.status === 'adopted') {
        return true
    }
    return !!(taskTrial && taskTrial.id === trialId && taskTrial.variant === 'B')
}


export { TRIALS, activeTrial, assignTrial, variantFallback, clauseOn }
