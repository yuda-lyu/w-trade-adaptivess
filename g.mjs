import fs from 'fs'
import WTradeAdaptivess from './src/WTradeAdaptivess.mjs'
import { writeSynthLedger } from './test/tools/synthLedger.mjs'


let { loadLedger, ntStaticOf, makeEvaluator, loadPick } = WTradeAdaptivess


let test = async () => {
    let ms = []

    //root, 範例之工作夾(離線可跑): 以合成之訂單帳本示範評估器; 實務上帳本由策略庫建置(node g_build.mjs; 設定見 settings.json 之 source)
    let root = './_test_adaptivess'
    fs.rmSync(root, { recursive: true, force: true })
    let info = writeSynthLedger(`${root}/ledger`, { n: 60, nBars: 2400, seed: 1 })
    ms.push({ ledger: { nStrategies: info.n, nBars: info.nBars, nOrders: info.nOrders } })

    //L, ev: 讀帳本並建評估器(暖機 60 日後每 7 日決策一次; 每次決策只看得到決策棒以前之資訊)
    //  訓練期之界線須明給(ctx.meta.ntAll 只計訓練期之進場數): 此帳本全為訓練期, 給 L.nBars; 帳本涵蓋訓練期以後者給訓練期之終點棒序
    let L = loadLedger(`${root}/ledger`)
    L.ntStatic = ntStaticOf(L, L.nBars)
    let ev = makeEvaluator(L, { warmupDays: 60, cadenceDays: 7 })

    //pk: 挑選模組(依合約 contract/pick-contract.md 撰寫之檔: 預設匯出 pick(ctx), 選配匯出 accept(sig, book)); 節點 agent 所寫者即此形式
    let pk = await loadPick('./examples/pick_example.mjs')

    //m: 評估結果(相位 0 與 3、3 / 7 日新鮮度、同劑量虛無 16 抽); selHash 為選集與下單序列之指紋, 同一模組重跑必相同
    let m = ev.evalPolicy(pk.pick, { accept: pk.accept, phases: [0, 3], horizons: [3, 7], nullDraws: 16, seed: 11 })
    ms.push({
        eqYr: m.op.eqYr.mean,
        worstPhase: m.op.eqYr.min,
        monthlyOrders: m.op.monthlyOrders.mean,
        peakHold: m.op.peakHold.max,
        nullExcess: m.null.excess,
        nullP: m.null.p,
        byGroup: m.op.byGroup,
        selHash: m.selHash,
    })

    //同一模組重跑: 指紋相同
    let m2 = ev.evalPolicy(pk.pick, { accept: pk.accept, phases: [0, 3], horizons: [3, 7], nullDraws: 16, seed: 11 })
    ms.push({ reproducible: m2.selHash === m.selHash })

    fs.rmSync(root, { recursive: true, force: true })

    console.log(JSON.stringify(ms, null, 1))
    return ms
}
await test()
    .catch((err) => {
        console.log(err)
    })

//node g.mjs
