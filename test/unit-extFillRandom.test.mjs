import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { loadLedger } from '../src/eval/ledger.mjs'
import { makeTmp, writeSynthLedger, makeTrainEvaluator as makeEvaluator } from './tools/synthLedger.mjs'
//makeEvaluator: 合成帳本即訓練期帳本 ⇒ makeTrainEvaluator 補上 L.ntStatic 再建評估器(見 test/tools/synthLedger.mjs)


//擴充診斷之 api.fillRandom(規則 R-EV-46; 合約 §7): 給定各決策之兩側席數 { short, long }, 依活躍度匹配產生 draws 組可直接交給 api.simulate 之隨機選集
//  抽法: 每席自同側、依決策棒以前之活躍度(累計進場數; actDays > 0 為最近 actDays 日)之名次, 匹配「成品於評估期間至該決策為止之同側之席」之名次分佈(與 replaceNull 同一套排名與 ± 50 名之抽取);
//    同一決策內不重複; 鄰域全已用者從缺; 至該決策為止成品無該側之席者側內均勻; 只用決策棒以前之資訊; 亂數為 api 既有之確定性亂數(不影響其他 api 函數與正本)
//  輸入檢測先於計算(V19、V20: invalid <位置>: must be <期望>, 不帶輸入值); 函數物件凍結、各診斷各一份; 不進逐訊號模擬(不受重入之限)
const HALF = 50 //名次寬度(合約: 同 replaceNull 之預設)
const CFG = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 0, seed: 11 }
const CFG_S = { warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [3, 7], nullDraws: 8, seed: 11 }
let accept = (sig, book) => book.open < 6
let CJK = /[㐀-鿿]/
let errOf = (fn) => {
    try {
        fn()
    }
    catch (err) {
        return err
    }
    return null
}
let msgOf = (fn) => {
    let err = errOf(fn)
    return err === null ? null : (err instanceof Error ? err.message : `非 Error: ${String(err)}`)
}
//runExt, 以一個擴充診斷跑一次完整評估; 診斷內之斷言失敗會被評估器記為 ext.<名>.error ⇒ 於此轉為測試失敗
let runExt = (ev, fn, pick, opt = {}) => {
    let m = ev.evalPolicy(pick, { accept, ...opt, ext: [{ name: 'd', fn }] })
    assert.equal(m.ext.d.error, undefined, `擴充診斷拋錯: ${m.ext.d.error}`)
    return m
}
let rd = (dir, f, C) => {
    let b = fs.readFileSync(path.join(dir, f))
    return new C(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
let wr = (dir, f, a) => fs.writeFileSync(path.join(dir, f), Buffer.from(a.buffer, a.byteOffset, a.byteLength))
//biasPnl, 已結之單之每單位損益加上「依該策略之全期單數之名次」之偏移(最不活躍 -A、最活躍 +A, 線性)⇒ 活躍度與績效相關(匹配與否之差可量)
let biasPnl = (dir, A) => {
    let off = rd(dir, 'off.u32', Uint32Array)
    let ext = rd(dir, 'ext.i32', Int32Array)
    let pnl = rd(dir, 'pnl.f32', Float32Array)
    let n = off.length - 1
    let idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => (off[a + 1] - off[a]) - (off[b + 1] - off[b]) || a - b)
    let rk = new Int32Array(n)
    idx.forEach((s, i) => {
        rk[s] = i
    })
    for (let s = 0; s < n; s++) {
        for (let j = off[s]; j < off[s + 1]; j++) {
            if (ext[j] >= 0) {
                pnl[j] += A * (2 * rk[s] / (n - 1) - 1)
            }
        }
    }
    wr(dir, 'pnl.f32', pnl)
}
//alterFrom, 複製帳本夾並改動「進場棒 ≥ C」之單與「出場棒 ≥ C」之損益(C 以前之進場不變): 每隔一單刪除、損益反號; 序號 % 3 === 1 之策略於 C 當根另加一單(原無者)
let alterFrom = (src, dst, C) => {
    fs.cpSync(src, dst, { recursive: true })
    let off = rd(src, 'off.u32', Uint32Array)
    let ent = rd(src, 'ent.i32', Int32Array)
    let ext = rd(src, 'ext.i32', Int32Array)
    let pnl = rd(src, 'pnl.f32', Float32Array)
    let n = off.length - 1
    let meta = JSON.parse(fs.readFileSync(path.join(src, 'meta.json'), 'utf8'))
    let o2 = new Uint32Array(n + 1)
    let E = []
    let X = []
    let P = []
    let nAdd = 0
    for (let s = 0; s < n; s++) {
        o2[s] = E.length
        let hasC = false
        for (let j = off[s]; j < off[s + 1]; j++) {
            hasC = hasC || ent[j] === C
        }
        for (let j = off[s]; j < off[s + 1] && ent[j] < C; j++) {
            E.push(ent[j])
            X.push(ext[j])
            P.push(ext[j] >= C ? -pnl[j] - 0.3 : pnl[j])
        }
        if (s % 3 === 1 && !hasC) {
            E.push(C)
            X.push(C + 3)
            P.push(0.7)
            nAdd++
        }
        let q = 0
        for (let j = off[s]; j < off[s + 1]; j++) {
            if (ent[j] >= C && q++ % 2 === 0) {
                E.push(ent[j])
                X.push(ext[j])
                P.push(ext[j] >= 0 ? -pnl[j] - 0.3 : 0)
            }
        }
    }
    o2[n] = E.length
    wr(dst, 'off.u32', o2)
    wr(dst, 'ent.i32', Int32Array.from(E))
    wr(dst, 'ext.i32', Int32Array.from(X))
    wr(dst, 'pnl.f32', Float32Array.from(P))
    fs.writeFileSync(path.join(dst, 'meta.json'), JSON.stringify({ ...meta, nOrders: E.length }), 'utf8')
    return nAdd
}
//statesOf, 成品自身之狀態序列(各決策之兩側席數)
let statesOf = (api) => api.phases.map((p) => p.sels.map((s) => {
    let sh = 0
    for (let i = 0; i < s.length; i++) {
        if (api.meta.mode[s[i]] < 0) {
            sh++
        }
    }
    return { short: sh, long: s.length - sh }
}))
//pickTop, 兩側各取決策棒以前之進場數(days = 0 累計; > 0 最近 days 日)最多之若干隻; 兩側席數依決策序變動(含 0)
let pickTop = (days) => (ctx) => {
    let st = ctx.stat(days)
    let nS = [0, 1, 2, 3, 2][ctx.k % 5]
    let nL = [3, 2, 4][ctx.k % 3]
    let srt = (long) => Array.from({ length: ctx.n }, (_, i) => i).filter((s) => (ctx.meta.mode[s] > 0) === long).sort((a, b) => st.entries[b] - st.entries[a] || ctx.meta.tie[a] - ctx.meta.tie[b])
    return [...srt(false).slice(0, nS), ...srt(true).slice(0, nL)]
}
//pickSwitch, 前段(ctx.k < 20)兩側各取最安靜者、其後取最活躍者 ⇒ 成品之活躍度分佈隨時間改變(以「全期之池」抽者於前段必偏離)
let pickSwitch = (days) => (ctx) => {
    let st = ctx.stat(days)
    let late = ctx.k >= 20
    let srt = (long) => Array.from({ length: ctx.n }, (_, i) => i).filter((s) => (ctx.meta.mode[s] > 0) === long).sort((a, b) => (late ? st.entries[b] - st.entries[a] : st.entries[a] - st.entries[b]) || ctx.meta.tie[a] - ctx.meta.tie[b])
    return [...srt(false).slice(0, 2), ...srt(true).slice(0, 3)]
}
//pickLateShort, 前 10 個決策不挑做空(其後各 2 隻最活躍之做空); 做多每次 2 隻最活躍者
let pickLateShort = (ctx) => {
    let st = ctx.stat()
    let srt = (long) => Array.from({ length: ctx.n }, (_, i) => i).filter((s) => (ctx.meta.mode[s] > 0) === long).sort((a, b) => st.entries[b] - st.entries[a] || ctx.meta.tie[a] - ctx.meta.tie[b])
    return [...(ctx.k < 10 ? [] : srt(false).slice(0, 2)), ...srt(true).slice(0, 2)]
}
//sideRankAt, 由帳本獨立重算: 決策棒 b 時各策略於其側內之名次(活躍度 = 進場棒 < b〔且 ≥ b − days 日〕之單數; 同值依 tie 再依序號; 0 = 最不活躍)與側之隻數
let sideRankAt = (L, tie, b, days) => {
    let n = L.n
    let lo = days > 0 ? b - days * L.barsPerDay : -Infinity
    let cnt = new Int32Array(n)
    for (let s = 0; s < n; s++) {
        for (let j = L.off[s]; j < L.off[s + 1]; j++) {
            if (L.ent[j] < b && L.ent[j] >= lo) {
                cnt[s]++
            }
        }
    }
    let rank = new Int32Array(n)
    let size = [0, 0]
    for (let side of [0, 1]) {
        let mem = Array.from({ length: n }, (_, i) => i).filter((s) => (L.mode[s] > 0 ? 0 : 1) === side).sort((a, b2) => cnt[a] - cnt[b2] || tie[a] - tie[b2] || a - b2)
        mem.forEach((s, i) => {
            rank[s] = i
        })
        size[side] = mem.length
    }
    return { rank, size }
}
let sideOf = (L, s) => (L.mode[s] > 0 ? 0 : 1)
let statOf = (a) => {
    let mu = a.reduce((x, y) => x + y, 0) / a.length
    return { mean: mu, sd: Math.sqrt(a.reduce((x, y) => x + (y - mu) * (y - mu), 0) / a.length) }
}
//uniformFill, 對照(不匹配活躍度): 同狀態, 側內均勻抽(不重複)
let uniformFill = (api, states, rng) => {
    let side = [[], []]
    for (let s = 0; s < api.n; s++) {
        side[api.meta.mode[s] > 0 ? 0 : 1].push(s)
    }
    return states.map((ph) => ph.map((st) => {
        let used = new Set()
        let o = []
        for (let [g, c] of [[0, st.long], [1, st.short]]) {
            while (c > 0) {
                let v = side[g][Math.floor(rng() * side[g].length)]
                if (!used.has(v)) {
                    used.add(v)
                    o.push(v)
                    c--
                }
            }
        }
        return o.sort((a, b) => a - b)
    }))
}

describe('擴充診斷之 api.fillRandom:給定各決策之兩側席數之活躍度匹配隨機填席(規則 R-EV-46)', function () {
    let t
    let LA
    let ev
    let LS
    let evS
    before(() => {
        t = makeTmp('extFillRandom')
        //主帳本: 600 隻(做空 200、做多 400), 活躍度與損益相關
        writeSynthLedger(path.join(t.dir, 'a'), { n: 600, nBars: 2400, seed: 31 })
        biasPnl(path.join(t.dir, 'a'), 1.5)
        LA = loadLedger(path.join(t.dir, 'a'))
        ev = makeEvaluator(LA, CFG)
        //小帳本: 輸入檢測與完整性之案
        writeSynthLedger(path.join(t.dir, 's'), { n: 60, nBars: 2400, seed: 6 })
        LS = loadLedger(path.join(t.dir, 's'))
        evS = makeEvaluator(LS, CFG_S)
    })
    after(() => {
        t.cleanup()
    })

    it('回傳之形狀:長度 = draws(預設同 replaceNull)、每組可直接交給 simulate;各決策之兩側席數 = 狀態、皆為同側之策略、同一決策內不重複、序號升冪之 Int32Array;同一輸入同一種子 ⇒ 同結果,換種子 ⇒ 不同', () => {
        let got = {}
        for (let seed of [11, 12]) {
            runExt(ev, (api) => {
                let states = statesOf(api)
                let a = api.fillRandom(states, { draws: 5 })
                //合約: 回傳長度 draws 之陣列, 各為一組 selsByPhase(相位數、各相位之決策數同成品)
                assert(Array.isArray(a) && a.length === 5)
                for (let sets of a) {
                    assert.equal(sets.length, api.phases.length)
                    sets.forEach((ph, ri) => {
                        assert.equal(ph.length, api.phases[ri].bars.length)
                        ph.forEach((sel, k) => {
                            assert(sel instanceof Int32Array, '元素為 Int32Array')
                            let st = states[ri][k]
                            let nS = Array.from(sel).filter((s) => LA.mode[s] < 0).length
                            //合約: 每席自同側抽; 側內足夠者席數 = 狀態
                            assert.deepEqual([nS, sel.length - nS], [st.short, st.long], `相位 ${ri} 決策 ${k} 之兩側席數`)
                            //同一決策內不重複、序號升冪
                            for (let i = 1; i < sel.length; i++) {
                                assert(sel[i] > sel[i - 1], `相位 ${ri} 決策 ${k}: 升冪且不重複`)
                            }
                        })
                    })
                    //可直接交給 simulate
                    let r = api.simulate(sets)
                    assert(Number.isFinite(r.mean) && r.byPhase.length === api.phases.length)
                }
                //各抽為獨立之隨機選集(不全同)
                assert.equal(new Set(a.map((sets) => JSON.stringify(sets.map((ph) => ph.map((s) => Array.from(s)))))).size, 5, '各抽互異')
                //確定性: 同一輸入 ⇒ 同結果(同一診斷內再呼叫)
                assert.deepStrictEqual(api.fillRandom(states, { draws: 5 }), a)
                //draws 之預設 = replaceNull 之預設(max(1, min(64, nullDraws || 16)))
                assert.equal(api.fillRandom(states).length, Math.max(1, Math.min(64, api.nullDraws || 16)))
                assert.equal(api.fillRandom(states).length, api.replaceNull({}).draws)
                got[seed] = a.map((sets) => sets.map((ph) => ph.map((s) => Array.from(s))))
                return { text: 'ok' }
            }, pickTop(0), { seed })
        }
        //換種子(評估之 seed)⇒ 成品不變而抽取不同
        assert.notDeepStrictEqual(got[11], got[12])
        //nullDraws 不為 0 之評估: 預設之抽數依之
        runExt(evS, (api) => {
            assert.equal(api.nullDraws, 8)
            assert.equal(api.fillRandom(statesOf(api)).length, 8)
            return { text: 'ok' }
        }, pickTop(0))
    })

    it('與 replaceNull 之一致性(驗收 1):以成品自身之狀態序列呼叫(64 抽)後逐抽 simulate,其均值與 replaceNull({ draws: 64 })(同 actDays)之均值之差 ≤ 兩均差之 2 個標準誤;側內均勻之對照(不匹配活躍度)之差 > 該門檻之 3 倍', () => {
        for (let days of [0, 30]) {
            runExt(ev, (api) => {
                let states = statesOf(api)
                let f = statOf(api.fillRandom(states, { draws: 64, actDays: days }).map((s) => api.simulate(s).mean))
                let rn = api.replaceNull({ draws: 64, actDays: days })
                let r = api.rand(5)
                let u = statOf(Array.from({ length: 64 }, () => api.simulate(uniformFill(api, states, r)).mean))
                //門檻 = 兩均差之 2 個標準誤(母體 sd / √64; 不用「2 個母體 sd」—— 太寬而無鑑別力)
                let thr = 2 * Math.sqrt(f.sd * f.sd / 64 + rn.sd * rn.sd / 64)
                assert(thr > 0 && Math.abs(f.mean - rn.mean) <= thr, `actDays ${days}: fillRandom ${f.mean} vs replaceNull ${rn.mean}(門檻 ${thr})`)
                //鑑別力: 不匹配活躍度之填席分得出來
                assert(Math.abs(u.mean - rn.mean) > 3 * thr, `actDays ${days}: 對照 ${u.mean} vs ${rn.mean}(門檻 ${thr})`)
                //pool = 'phase'(成品整段之席之分佈): 成品之活躍度分佈不隨時間改變之下, 同一判準亦成立
                let fp = statOf(api.fillRandom(states, { draws: 64, actDays: days, pool: 'phase' }).map((s) => api.simulate(s).mean))
                let thrP = 2 * Math.sqrt(fp.sd * fp.sd / 64 + rn.sd * rn.sd / 64)
                assert(Math.abs(fp.mean - rn.mean) <= thrP, `actDays ${days}: fillRandom(phase) ${fp.mean} vs replaceNull ${rn.mean}(門檻 ${thrP})`)
                return { text: 'ok' }
            }, pickTop(days))
        }
    })

    it('狀態全為 0 席(驗收 2):各抽各決策皆為空之 Int32Array;交給 simulate 為無持倉(等效年化 0、兩側下單 0)', () => {
        runExt(ev, (api) => {
            let zero = api.phases.map((p) => p.bars.map(() => ({ short: 0, long: 0 })))
            let a = api.fillRandom(zero, { draws: 3 })
            assert.equal(a.length, 3)
            for (let sets of a) {
                assert(sets.every((ph, ri) => ph.length === api.phases[ri].bars.length && ph.every((s) => s instanceof Int32Array && s.length === 0)))
                let r = api.simulate(sets)
                assert.equal(r.mean, 0)
                assert.deepEqual(r.byPhase, api.phases.map(() => 0))
                assert.deepEqual([r.bySide.long.orders, r.bySide.short.orders], [0, 0])
            }
            return { text: 'ok' }
        }, pickTop(0))
    })

    it('活躍度匹配之結構(驗收 5 ①):每個抽出之席與「成品於第 0 ~ k 個決策之同側之某席」之側內名次差 ≤ 50(名次由帳本獨立重算;累計與最近 30 日兩種活躍度);前段挑最安靜、後段挑最活躍之成品下, 前段之抽取不落在後段之名次附近', () => {
        for (let days of [0, 30]) {
            runExt(ev, (api) => {
                let states = api.phases.map((p) => p.bars.map((b, k) => ({ short: 1 + (k % 3), long: 2 + (k % 2) })))
                let a = api.fillRandom(states, { draws: 6, actDays: days })
                let nChk = 0
                let nFar = 0
                api.phases.forEach((ph, ri) => {
                    let pool = [[], []]
                    ph.bars.forEach((b, k) => {
                        let { rank } = sideRankAt(LA, api.meta.tie, b, days)
                        for (let s of ph.sels[k]) {
                            pool[sideOf(LA, s)].push(rank[s])
                        }
                        //鑑別前提: 前段之池皆在最安靜之一端, 全期之池另有最活躍之一端(相距 > 2 × 50 名)
                        if (k === 5) {
                            let late = ph.sels[ph.sels.length - 1]
                            let { rank: rl } = sideRankAt(LA, api.meta.tie, ph.bars[ph.bars.length - 1], days)
                            for (let s of late) {
                                if (Math.min(...pool[sideOf(LA, s)].map((x) => Math.abs(x - rl[s]))) > 2 * HALF) {
                                    nFar++
                                }
                            }
                        }
                        for (let sets of a) {
                            for (let s of sets[ri][k]) {
                                let g = sideOf(LA, s)
                                let dist = Math.min(...pool[g].map((x) => Math.abs(x - rank[s])))
                                assert(dist <= HALF, `actDays ${days} 相位 ${ri} 決策 ${k}: 策略 ${s} 之名次 ${rank[s]} 與池之最近距離 ${dist}`)
                                nChk++
                            }
                        }
                    })
                })
                assert(nChk > 1000, `樣本不足 ${nChk}`)
                assert(nFar > 0, '鑑別前提: 後段之席之名次遠離前段之池')
                return { text: 'ok' }
            }, pickSwitch(days))
        }
    })

    it('活躍度匹配之統計(驗收 5 ②):各側抽出之席之側內名次百分位之均與成品之席之均之差 ≤ 50 / 側之隻數;側內均勻之對照違反之', () => {
        runExt(ev, (api) => {
            let states = statesOf(api)
            let a = api.fillRandom(states, { draws: 16 })
            let r = api.rand(9)
            let u = Array.from({ length: 16 }, () => uniformFill(api, states, r))
            let acc = { prod: [[], []], fill: [[], []], uni: [[], []] }
            let size = null
            api.phases.forEach((ph, ri) => {
                ph.bars.forEach((b, k) => {
                    let sr = sideRankAt(LA, api.meta.tie, b, 0)
                    size = sr.size
                    let put = (key, sel) => {
                        for (let s of sel) {
                            let g = sideOf(LA, s)
                            acc[key][g].push(sr.rank[s] / (sr.size[g] - 1))
                        }
                    }
                    put('prod', ph.sels[k])
                    a.forEach((sets) => put('fill', sets[ri][k]))
                    u.forEach((sets) => put('uni', sets[ri][k]))
                })
            })
            let mean = (x) => x.reduce((p, q) => p + q, 0) / x.length
            for (let g of [0, 1]) {
                let bound = HALF / size[g]
                let dF = Math.abs(mean(acc.fill[g]) - mean(acc.prod[g]))
                let dU = Math.abs(mean(acc.uni[g]) - mean(acc.prod[g]))
                assert(acc.fill[g].length > 300, `側 ${g}: 樣本`)
                assert(dF <= bound, `側 ${g}: 抽出 ${mean(acc.fill[g])} vs 成品 ${mean(acc.prod[g])}(界 ${bound})`)
                assert(dU > bound, `側 ${g}: 對照 ${mean(acc.uni[g])} 應違反(界 ${bound})`)
            }
            return { text: 'ok' }
        }, pickTop(0))
    })

    it('目標名次之池 opt.pool:未給 / null / \'toDate\' 逐位相同;\'phase\' 之每個抽出之席與「成品於本相位任一決策之同側之某席」之名次差 ≤ 50, 前段之抽取含與後段之席相近者(\'toDate\' 不含);\'phase\' 確定;成品早段無某側之席時, 該側依其後之分佈匹配(非側內均勻)', () => {
        for (let days of [0, 30]) {
            runExt(ev, (api) => {
                let states = api.phases.map((p) => p.bars.map((b, k) => ({ short: 1 + (k % 3), long: 2 + (k % 2) })))
                let base = api.fillRandom(states, { draws: 6, actDays: days })
                //合約: 預設 'toDate' ⇒ 未給、null、明給 'toDate' 之結果逐位相同
                assert.deepStrictEqual(api.fillRandom(states, { draws: 6, actDays: days, pool: 'toDate' }), base, '明給 toDate = 未給')
                assert.deepStrictEqual(api.fillRandom(states, { draws: 6, actDays: days, pool: null }), base, 'null = 未給')
                let ph = api.fillRandom(states, { draws: 6, actDays: days, pool: 'phase' })
                assert.deepStrictEqual(api.fillRandom(states, { draws: 6, actDays: days, pool: 'phase' }), ph, 'phase 之確定性')
                assert.notDeepStrictEqual(ph, base, 'phase 與 toDate 之抽取不同')
                let nChk = 0
                let near = { phase: 0, toDate: 0 }
                api.phases.forEach((p, ri) => {
                    //各決策之側內名次(由帳本獨立重算); full = 成品於本相位全部決策之席之名次, upto = 至第 k 個決策為止者
                    let ranks = p.bars.map((b) => sideRankAt(LA, api.meta.tie, b, days).rank)
                    let full = [[], []]
                    p.sels.forEach((s, k) => {
                        for (let x of s) {
                            full[sideOf(LA, x)].push(ranks[k][x])
                        }
                    })
                    let upto = [[], []]
                    p.bars.forEach((b, k) => {
                        for (let x of p.sels[k]) {
                            upto[sideOf(LA, x)].push(ranks[k][x])
                        }
                        let dist = (pool, s) => Math.min(...pool[sideOf(LA, s)].map((r) => Math.abs(r - ranks[k][s])))
                        for (let sets of ph) {
                            for (let s of sets[ri][k]) {
                                assert(dist(full, s) <= HALF, `actDays ${days} 相位 ${ri} 決策 ${k}: 策略 ${s} 與全段之池之最近距離 ${dist(full, s)}`)
                                nChk++
                                if (k < 10 && dist(upto, s) > HALF) {
                                    near.phase++
                                }
                            }
                        }
                        if (k < 10) {
                            for (let sets of base) {
                                for (let s of sets[ri][k]) {
                                    if (dist(upto, s) > HALF) {
                                        near.toDate++
                                    }
                                }
                            }
                        }
                    })
                })
                assert(nChk > 1000, `樣本不足 ${nChk}`)
                //前段(成品挑最安靜者之時)之抽取: 'phase' 含與後段之席(最活躍者)相近者, 'toDate' 不含
                assert(near.phase > 0, `actDays ${days}: 'phase' 之前段抽取應含遠離至該決策為止之池者`)
                assert.equal(near.toDate, 0, `actDays ${days}: 'toDate' 之前段抽取皆在至該決策為止之池附近`)
                return { text: 'ok' }
            }, pickSwitch(days))
        }
        //成品早段無做空之席: 'phase' 之早段做空之席依其後之席(最活躍之一端)之分佈匹配(非側內均勻); 'toDate' 於早段為側內均勻(見「不足與後備」一案)
        runExt(ev, (api) => {
            let p = api.phases[0]
            let k0 = p.sels.findIndex((s) => Array.from(s).some((x) => LA.mode[x] < 0))
            assert(k0 > 3, `前提: 前段成品無做空之席(第一個有做空者 ${k0})`)
            let ranks = p.bars.map((b) => sideRankAt(LA, api.meta.tie, b, 0))
            let fullShort = []
            p.sels.forEach((s, k) => {
                for (let x of s) {
                    if (LA.mode[x] < 0) {
                        fullShort.push(ranks[k].rank[x])
                    }
                }
            })
            let a = api.fillRandom(api.phases.map((q) => q.bars.map(() => ({ short: 3, long: 1 }))), { draws: 8, pool: 'phase' })
            let early = []
            for (let sets of a) {
                for (let k = 0; k < k0; k++) {
                    let sh = Array.from(sets[0][k]).filter((s) => LA.mode[s] < 0)
                    assert.equal(sh.length, 3, `決策 ${k}: 做空之席數`)
                    for (let s of sh) {
                        let r = ranks[k].rank[s]
                        assert(Math.min(...fullShort.map((x) => Math.abs(x - r))) <= HALF, `決策 ${k}: 策略 ${s} 之名次 ${r} 與全段之做空之池之距離`)
                        early.push(r / (ranks[k].size[1] - 1))
                    }
                }
            }
            let mu = early.reduce((x, y) => x + y, 0) / early.length
            assert(mu > 0.75, `早段做空之席之名次百分位之均 ${mu}(依其後之最活躍者匹配, 非側內均勻)`)
            return { text: 'ok' }
        }, pickLateShort)
    })

    it('資訊邊界(驗收 4):帳本於決策棒 C 以前相同、C 起不同(C 當根另加之單、其後之單抽稀、損益反號), 其後之狀態亦不同 ⇒ 決策棒 ≤ C 之各決策之抽取逐位相同;其後至少一處不同', () => {
        writeSynthLedger(path.join(t.dir, 'p'), { n: 120, nBars: 2400, seed: 41 })
        let Lp = loadLedger(path.join(t.dir, 'p'))
        let C = 360 + 20 * 42 //相位 0 之第 20 個決策之決策棒(暖機 60 日 × 6 根 + 20 × 7 日 × 6 根)
        let evP = makeEvaluator(Lp, CFG)
        assert(alterFrom(path.join(t.dir, 'p'), path.join(t.dir, 'q'), C) > 10, '鑑別前提: C 當根另加之單')
        let evQ = makeEvaluator(loadLedger(path.join(t.dir, 'q')), CFG)
        for (let days of [0, 30]) {
            let res = {}
            for (let [nm, e] of [['p', evP], ['q', evQ]]) {
                runExt(e, (api) => {
                    assert.equal(api.phases[0].bars[20], C, '前提: C 為相位 0 之決策棒')
                    //狀態: C 以前兩帳本相同; 其後不同
                    let states = api.phases.map((ph) => ph.bars.map((b, k) => (b <= C || nm === 'p' ? { short: k % 3, long: 1 + (k % 2) } : { short: 3, long: 0 })))
                    res[nm] = { sets: api.fillRandom(states, { draws: 4, actDays: days }), phase: api.fillRandom(states, { draws: 4, actDays: days, pool: 'phase' }), bars: api.phases.map((ph) => ph.bars), sels: api.phases.map((ph) => ph.sels.map((s) => Array.from(s))) }
                    return { text: 'ok' }
                }, pickTop(days))
            }
            let { p, q } = res
            let nSame = 0
            let nDiff = 0
            p.bars.forEach((bs, ri) => bs.forEach((b, k) => {
                if (b <= C) {
                    //前提: 成品於 C 以前之選集相同(挑選只見決策棒以前之資訊)
                    assert.deepEqual(q.sels[ri][k], p.sels[ri][k])
                    for (let d = 0; d < 4; d++) {
                        assert.deepEqual(Array.from(q.sets[d][ri][k]), Array.from(p.sets[d][ri][k]), `actDays ${days} 相位 ${ri} 決策 ${k}(棒 ${b})`)
                        nSame++
                    }
                }
                else if (p.sets.some((sets, d) => Array.from(sets[ri][k]).join() !== Array.from(q.sets[d][ri][k]).join())) {
                    nDiff++
                }
            }))
            assert(nSame >= 4 * 30, `樣本 ${nSame}`)
            assert(nDiff > 0, `actDays ${days}: C 以後至少一處不同(非空轉)`)
            //合約: pool = 'phase' 之池含成品其後之席(其名次依其後之帳本資料)⇒ 同一構造下, 決策棒 ≤ C 之決策之抽取會改變(不是只用決策棒以前之資訊; 文件所述屬實)
            let nEarlyPhase = 0
            p.bars.forEach((bs, ri) => bs.forEach((b, k) => {
                if (b <= C && p.phase.some((sets, d) => Array.from(sets[ri][k]).join() !== Array.from(q.phase[d][ri][k]).join())) {
                    nEarlyPhase++
                }
            }))
            assert(nEarlyPhase > 0, `actDays ${days}: pool 'phase' 於 C 以前之決策應有改變`)
        }
    })

    it('不足與後備:至該決策為止成品無做空之席 ⇒ 做空之席仍依狀態填滿(側內均勻);其後成品有做空之席 ⇒ 依其名次匹配;席數超過鄰域之可用者 ⇒ 其餘從缺(不重複、同側)', () => {
        //前 10 個決策成品不挑做空(其後各 2 隻最活躍者)
        let pick = pickLateShort
        runExt(ev, (api) => {
            let ph = api.phases[0]
            let k0 = ph.sels.findIndex((s) => Array.from(s).some((x) => LA.mode[x] < 0))
            assert(k0 > 3, `前提: 前段成品無做空之席(第一個有做空者 ${k0})`)
            let states = api.phases.map((p) => p.bars.map(() => ({ short: 3, long: 1 })))
            let a = api.fillRandom(states, { draws: 8 })
            let early = []
            for (let sets of a) {
                ph.bars.forEach((b, k) => {
                    let sh = Array.from(sets[0][k]).filter((s) => LA.mode[s] < 0)
                    assert.equal(sh.length, 3, `決策 ${k}: 做空之席數`)
                    if (k < k0) {
                        let { rank, size } = sideRankAt(LA, api.meta.tie, b, 0)
                        early.push(...sh.map((s) => rank[s] / (size[1] - 1)))
                    }
                })
            }
            //池為空時側內均勻: 名次散佈於全側(非集中於最活躍之一端)
            let mu = early.reduce((x, y) => x + y, 0) / early.length
            assert(mu > 0.3 && mu < 0.7 && Math.min(...early) < 0.2 && Math.max(...early) > 0.8, `池為空之決策之名次百分位之均 ${mu}`)
            //席數超過鄰域之可用者: 做多 400 隻之側要 400 席 ⇒ 只填得到鄰域(± 50 名)內者, 其餘從缺
            let big = api.fillRandom(api.phases.map((p) => p.bars.map(() => ({ short: 0, long: 400 }))), { draws: 2 })
            for (let sets of big) {
                for (let sel of sets[0]) {
                    let arr = Array.from(sel)
                    assert(arr.every((s) => LA.mode[s] > 0), '同側')
                    assert.equal(new Set(arr).size, arr.length, '不重複')
                    assert(arr.length >= HALF + 1 && arr.length < 400, `從缺: 填得 ${arr.length}`)
                }
            }
            return { text: 'ok' }
        }, pick)
        //該側無任何策略 ⇒ 該側之席皆從缺(帳本只有 1 隻做空之策略: 做多之側為空)
        writeSynthLedger(path.join(t.dir, 'one'), { n: 1, nBars: 2400, seed: 8 })
        let L1 = loadLedger(path.join(t.dir, 'one'))
        assert.equal(L1.mode[0], -1, '前提: 唯一之策略為做空')
        runExt(makeEvaluator(L1, CFG), (api) => {
            let only = (st) => api.fillRandom(api.phases.map((p) => p.bars.map(() => st)), { draws: 2 })
            for (let sets of only({ short: 0, long: 1 })) {
                assert(sets.every((ph) => ph.every((s) => s.length === 0)), '做多之席從缺(不以他側之策略充數)')
            }
            for (let sets of only({ short: 1, long: 1 })) {
                assert(sets.every((ph) => ph.every((s) => s.length === 1 && s[0] === 0)), '做空之席照填')
            }
            return { text: 'ok' }
        }, () => [0])
    })

    it('輸入檢測(驗收 6):形狀與值之每一類無效輸入皆拋, 訊息為 invalid <位置>: must be <期望>(英文、不帶輸入值);檢查之先後:外層 → 各相位 → 各元素 → opt → 各元素之值 → actDays → draws;數字字串收受', () => {
        runExt(evS, (api) => {
            let n = api.n
            let ok = api.phases.map((p) => p.bars.map((b, k) => ({ short: k % 2, long: 1 })))
            let want = (fn, msg, w) => {
                let m = msgOf(fn)
                assert.strictEqual(m, msg, w)
                assert(!CJK.test(m), `${w}: 英文`)
                assert(!/MARKER|98765|SECRET/.test(m), `${w}: 不帶輸入值`)
            }
            let OUT = 'invalid statesByPhase: must be an array with one entry per phase of phases[]'
            let PH = (i) => `invalid statesByPhase[${i}]: must be an array with one entry per decision of phases[${i}]`
            let EL = (i, k) => `invalid statesByPhase[${i}][${k}]: must be an object { short, long }`
            let V = (i, k, f) => `invalid statesByPhase[${i}][${k}].${f}: must be an integer from 0 to ${n}`
            let OPT = 'invalid opt: must be an object'
            let ACT = 'invalid opt.actDays: must be a non-negative integer (0 for the cumulative entry count)'
            let DR = 'invalid opt.draws: must be an integer from 1 to 64'
            let POOL = 'invalid opt.pool: must be \'toDate\' or \'phase\''
            //外層: 非陣列、相位數不同、定型陣列
            for (let [w, v] of [['undefined', undefined], ['null', null], ['字串', 'MARKER'], ['數字', 98765], ['物件', { length: 2 }], ['Set', new Set(ok)], ['少一相位', [ok[0]]], ['多一相位', [...ok, ok[0]]], ['定型陣列', new Int32Array(2)]]) {
                want(() => api.fillRandom(v), OUT, `外層 ${w}`)
            }
            //各相位: 非陣列、定型陣列、決策數不同
            want(() => api.fillRandom([5, ok[1]]), PH(0), '相位為數字')
            want(() => api.fillRandom([Int32Array.from(ok[0], () => 1), ok[1]]), PH(0), '相位為定型陣列')
            want(() => api.fillRandom([ok[0], ok[1].slice(1)]), PH(1), '決策數少一')
            want(() => api.fillRandom([ok[0], [...ok[1], ok[1][0]]]), PH(1), '決策數多一')
            //各元素: 物件以外
            let put = (el, i = 1, k = 2) => {
                let a = ok.map((ph) => ph.slice())
                a[i][k] = el
                return a
            }
            for (let [w, el] of [['null', null], ['undefined', undefined], ['數字', 98765], ['字串', 'MARKER'], ['布林', true], ['函數', () => 1], ['陣列', [1, 2]]]) {
                want(() => api.fillRandom(put(el)), EL(1, 2), `元素 ${w}`)
            }
            //opt: null 與原始值
            for (let [w, o] of [['null', null], ['數字', 98765], ['字串', 'MARKER'], ['布林', false]]) {
                want(() => api.fillRandom(ok, o), OPT, `opt ${w}`)
            }
            //各元素之值: 缺、負數、小數、超過 n、非數字、物件(valueOf 不被呼叫)、BigInt、Symbol、NaN、無限
            let called = 0
            let obj = {
                valueOf() {
                    called++
                    return 1
                },
            }
            for (let [w, v] of [['缺', undefined], ['null', null], ['負數', -1], ['小數', 1.5], ['小數字串', '1.5'], ['超過 n', n + 1], ['字串', 'MARKER'], ['物件', obj], ['BigInt', 2n], ['Symbol', Symbol('x')], ['NaN', NaN], ['無限', Infinity], ['布林', true]]) {
                want(() => api.fillRandom(put({ short: v, long: 1 }, 0, 3)), V(0, 3, 'short'), `short ${w}`)
                want(() => api.fillRandom(put({ short: 1, long: v }, 0, 3)), V(0, 3, 'long'), `long ${w}`)
            }
            want(() => api.fillRandom(put({ long: 1 }, 1, 0)), V(1, 0, 'short'), '物件缺 short')
            assert.equal(called, 0, '物件型之值之 valueOf 不被呼叫')
            //opt.actDays / opt.draws
            for (let [w, v] of [['負數', -1], ['小數', 1.5], ['字串', 'MARKER'], ['物件', {}], ['布林', true], ['無限', Infinity]]) {
                want(() => api.fillRandom(ok, { actDays: v }), ACT, `actDays ${w}`)
            }
            for (let [w, v] of [['0', 0], ['65', 65], ['負數', -1], ['小數', 1.5], ['字串', 'MARKER'], ['布林', true], ['數字字串 65', '65']]) {
                want(() => api.fillRandom(ok, { draws: v }), DR, `draws ${w}`)
            }
            //opt.pool: 只收字串 'toDate' / 'phase'(不轉型: 包裝物件、陣列、大小寫不符、前後空白皆不收)
            let toStr = {
                toString() {
                    called++
                    return 'phase'
                },
            }
            for (let [w, v] of [['物件', {}], ['包裝物件', Object('phase')], ['數字', 98765], ['其他字串', 'MARKER'], ['大小寫不符', 'Phase'], ['大寫', 'TODATE'], ['前後空白', ' phase'], ['空字串', ''], ['布林', true], ['陣列', ['phase']], ['有 toString 之物件', toStr]]) {
                want(() => api.fillRandom(ok, { pool: v }), POOL, `pool ${w}`)
            }
            assert.equal(called, 0, 'pool 之物件不呼叫其 toString')
            //先後
            want(() => api.fillRandom(put(null, 1, 0), null), EL(1, 0), '元素之形狀先於 opt')
            want(() => api.fillRandom(put({ short: -1, long: 0 }, 0, 0), null), OPT, 'opt 之種類(形狀)先於各元素之值')
            want(() => api.fillRandom(put({ short: -1, long: -1 }, 1, 1), { actDays: -1, draws: 0 }), V(1, 1, 'short'), '值: short 先於 long、先於 opt 之值')
            want(() => api.fillRandom(put({ short: 1, long: 1 }, 1, 1), { actDays: -1, draws: 0 }), ACT, 'actDays 先於 draws')
            want(() => api.fillRandom(ok, { draws: 0, pool: 'MARKER' }), DR, 'draws 先於 pool')
            want(() => api.fillRandom(put({ short: -1, long: 0 }, 0, 0), { pool: 'MARKER' }), V(0, 0, 'short'), '各元素之值先於 pool')
            want(() => api.fillRandom(put(null, 0, 0), { pool: 'MARKER' }), EL(0, 0), '形狀先於 pool')
            let two = ok.map((ph) => ph.slice())
            two[0][4] = { short: 1, long: 'MARKER' }
            two[1][1] = null
            want(() => api.fillRandom(two), EL(1, 1), '形狀(後面之相位)先於值(前面之相位)')
            let twoShape = ok.map((ph) => ph.slice())
            twoShape[0][2] = null
            twoShape[1] = twoShape[1].slice(1)
            want(() => api.fillRandom(twoShape), EL(0, 2), '多處形狀不合 ⇒ 報第一處(其後不再讀)')
            //合法: 數字字串(去頭尾空白)、0 與 n、-0、actDays / draws 之 null 與 undefined(未給)、數字字串之 actDays / draws
            let base = JSON.stringify(api.fillRandom(ok, { draws: 3, actDays: 30 }).map((s) => s.map((ph) => ph.map((x) => Array.from(x)))))
            let str = ok.map((ph) => ph.map((x) => ({ short: ` ${x.short} `, long: String(x.long) })))
            assert.equal(JSON.stringify(api.fillRandom(str, { draws: '3', actDays: ' 30' }).map((s) => s.map((ph) => ph.map((x) => Array.from(x))))), base, '數字字串')
            //席數 = n 收受: 做空之側全部(其隻數 ≤ 2 × 50 + 1 ⇒ 鄰域涵蓋全側)皆填入, 其餘從缺
            let nShort = Array.from(LS.mode).filter((x) => x < 0).length
            assert(nShort <= 2 * HALF + 1, '前提: 做空之側不大於鄰域')
            assert.equal(api.fillRandom(put({ short: n, long: 0 }), { draws: 1 })[0][1][2].length, nShort, '席數 = n 收受')
            assert.equal(api.fillRandom(put({ short: -0, long: 0 }), { draws: 1 })[0][1][2].length, 0, '-0 = 0')
            assert.equal(api.fillRandom(ok, { draws: null, actDays: null, pool: null }).length, 8)
            assert.equal(api.fillRandom(ok, { pool: 'phase', draws: 2 }).length, 2)
            assert.equal(api.fillRandom(ok, { pool: 'toDate', draws: 2 }).length, 2)
            assert.equal(api.fillRandom(ok, {}).length, 8)
            assert.equal(api.fillRandom(ok, { draws: 64 }).length, 64)
            return { text: 'ok' }
        }, pickTop(0))
    })

    it('讀取:存取子與代理之讀取拋錯 ⇒ 無效(不透傳);各陣列之 length 只讀一次;長度超過相位數 / 決策數之代理不逐索引讀取', () => {
        runExt(evS, (api) => {
            let ok = api.phases.map((p) => p.bars.map((b, k) => ({ short: k % 2, long: 1 })))
            let SECRET = () => {
                throw new Error('SECRET_X')
            }
            let want = (fn, msg, w) => {
                let m = msgOf(fn)
                assert.strictEqual(m, msg, w)
                assert(!/SECRET/.test(m), `${w}: 不透傳`)
            }
            let OUT = 'invalid statesByPhase: must be an array with one entry per phase of phases[]'
            let revoked = Proxy.revocable([], {})
            revoked.revoke()
            want(() => api.fillRandom(revoked.proxy), OUT, '外層為已撤銷之代理')
            want(() => api.fillRandom(new Proxy(ok.slice(), { get: (tg, k, rc) => (k === 'length' ? SECRET() : Reflect.get(tg, k, rc)) })), OUT, '外層讀 length 拋錯')
            want(() => api.fillRandom(new Proxy(ok.slice(), { get: (tg, k, rc) => (k === '1' ? SECRET() : Reflect.get(tg, k, rc)) })), OUT, '外層之索引拋錯')
            let accPh = ok.map((ph) => ph.slice())
            Object.defineProperty(accPh[0], 1, {
                get: SECRET,
                enumerable: true,
                configurable: true,
            })
            want(() => api.fillRandom(accPh), 'invalid statesByPhase[0]: must be an array with one entry per decision of phases[0]', '相位之元素之存取子拋錯')
            let put = (el) => {
                let a = ok.map((ph) => ph.slice())
                a[1][2] = el
                return a
            }
            want(() => api.fillRandom(put({
                get short() {
                    return SECRET()
                },
                long: 1,
            })), `invalid statesByPhase[1][2].short: must be an integer from 0 to ${api.n}`, 'short 之存取子拋錯')
            let rv = Proxy.revocable({}, {})
            rv.revoke()
            want(() => api.fillRandom(put(rv.proxy)), `invalid statesByPhase[1][2].short: must be an integer from 0 to ${api.n}`, '元素為已撤銷之代理')
            want(() => api.fillRandom(ok, {
                get actDays() {
                    return SECRET()
                },
            }), 'invalid opt.actDays: must be a non-negative integer (0 for the cumulative entry count)', 'actDays 之存取子拋錯')
            want(() => api.fillRandom(ok, {
                get draws() {
                    return SECRET()
                },
            }), 'invalid opt.draws: must be an integer from 1 to 64', 'draws 之存取子拋錯')
            let poolReads = 0
            want(() => api.fillRandom(ok, {
                get pool() {
                    return SECRET()
                },
            }), 'invalid opt.pool: must be \'toDate\' or \'phase\'', 'pool 之存取子拋錯')
            api.fillRandom(ok, {
                draws: 1,
                get pool() {
                    poolReads++
                    return 'phase'
                },
            })
            assert.equal(poolReads, 1, 'pool 只讀一次')
            want(() => api.fillRandom(ok, new Proxy({}, { get: (tg, k) => (k === 'pool' ? SECRET() : undefined) })), 'invalid opt.pool: must be \'toDate\' or \'phase\'', 'opt 為代理, 讀 pool 拋錯')
            let rvO = Proxy.revocable({}, {})
            rvO.revoke()
            want(() => api.fillRandom(ok, rvO.proxy), 'invalid opt.actDays: must be a non-negative integer (0 for the cumulative entry count)', 'opt 為已撤銷之代理')
            //length 只讀一次(外層與各相位)
            let reads = { o: 0, p: 0 }
            let cnt = (a, key) => new Proxy(a, {
                get(tg, k, rc) {
                    if (k === 'length') {
                        reads[key]++
                    }
                    return Reflect.get(tg, k, rc)
                },
            })
            let ref = JSON.stringify(api.fillRandom(ok, { draws: 2 }).map((s) => s.map((ph) => ph.map((x) => Array.from(x)))))
            assert.equal(JSON.stringify(api.fillRandom(cnt([cnt(ok[0].slice(), 'p'), ok[1]], 'o'), { draws: 2 }).map((s) => s.map((ph) => ph.map((x) => Array.from(x))))), ref)
            assert.deepEqual(reads, { o: 1, p: 1 }, 'length 只讀一次')
            //超長之代理: 不讀任何索引
            let probe = (target, len) => {
                let c = { reads: 0 }
                let proxy = new Proxy(target, {
                    get(tg, k, rc) {
                        if (k === 'length') {
                            return len
                        }
                        c.reads++
                        return Reflect.get(tg, k, rc)
                    },
                    getOwnPropertyDescriptor(tg, k) {
                        c.reads++
                        return Reflect.getOwnPropertyDescriptor(tg, k)
                    },
                })
                return { proxy, c }
            }
            let p1 = probe(ok.slice(), 5000000)
            want(() => api.fillRandom(p1.proxy), OUT, '外層超長')
            assert.equal(p1.c.reads, 0)
            let p2 = probe(ok[0].slice(), 5000000)
            want(() => api.fillRandom([p2.proxy, ok[1]]), 'invalid statesByPhase[0]: must be an array with one entry per decision of phases[0]', '相位超長')
            assert.equal(p2.c.reads, 0)
            return { text: 'ok' }
        }, pickTop(0))
    })

    //完整性(規則 R-EV-35 ②; 同 unit-evalIntegrity 之寫法)
    let TA_PROTO = Object.getPrototypeOf(Int8Array.prototype)
    let keep = (targets, fn) => {
        let saved = targets.map(([o, k]) => [o, k, Object.getOwnPropertyDescriptor(o, k)])
        try {
            return fn()
        }
        finally {
            for (let [o, k, d] of saved) {
                if (d) {
                    Object.defineProperty(o, k, d)
                }
                else {
                    delete o[k]
                }
            }
        }
    }
    let withStubs = (targets, fired, fn) => keep(targets, () => {
        let SENT = new Error('替身被呼叫')
        for (let [o, k] of targets) {
            let d = Object.getOwnPropertyDescriptor(o, k)
            let stub = function () {
                fired[k] = true
                throw SENT
            }
            Object.defineProperty(o, k, d.get ? { ...d, get: stub } : { ...d, value: stub })
        }
        return fn()
    })

    it('入口比對:內建物件被改時 ⇒ 該次呼叫拋 EVAL_INTEGRITY(where = ext)、替身未被呼叫(值之檢查〔iseint 之 trim / test〕與計算皆在比對之後);形狀或值不合者亦先比對;診斷攔下並改回者該次評估仍失敗', () => {
        let targets = [
            [String.prototype, 'trim', 'String.prototype.trim'], [RegExp.prototype, 'test', 'RegExp.prototype.test'], [Number, 'isSafeInteger', 'Number.isSafeInteger'],
            [Math, 'floor', 'Math.floor'], [Math, 'max', 'Math.max'], [Math, 'min', 'Math.min'], [TA_PROTO, 'sort', '%TypedArray%.prototype.sort'], [TA_PROTO, 'slice', '%TypedArray%.prototype.slice'],
            [Array.prototype, 'push', 'Array.prototype.push'], [Array.prototype, 'indexOf', 'Array.prototype.indexOf'],
        ]
        //參數: 數字字串之席數(經 iseint 之 trim / test)、形狀不合、值不合
        let calls = {
            strings: (api) => [api.phases.map((p) => p.bars.map(() => ({ short: ' 1', long: '2' }))), { draws: '2', actDays: '30', pool: 'phase' }],
            badShape: (api) => ['MARKER', undefined],
            badValue: (api) => [api.phases.map((p) => p.bars.map(() => ({ short: -1, long: 0 }))), undefined],
        }
        for (let [nm, mk] of Object.entries(calls)) {
            for (let [o, k, label] of targets) {
                let fired = Object.create(null)
                let inner = null
                let err = errOf(() => evS.evalPolicy(pickTop(0), {
                    accept,
                    ext: [{
                        name: 'x',
                        fn: (api) => {
                            let [a, op] = mk(api)
                            withStubs([[o, k]], fired, () => {
                                inner = errOf(() => api.fillRandom(a, op))
                            })
                            return { text: 'x' }
                        },
                    }],
                }))
                let w = `${nm} × ${label}`
                assert.equal(inner && inner.code, 'EVAL_INTEGRITY', `${w}: 入口比對(${inner && inner.message})`)
                assert.equal(inner.where, 'ext', w)
                assert(inner.items.includes(label), `${w}: ${inner.items}`)
                assert.deepEqual(Object.keys(fired), [], `${w}: 替身未被呼叫`)
                assert.equal(err && err.code, 'EVAL_INTEGRITY', `${w}: 診斷攔下並改回, 該次評估仍失敗`)
            }
        }
    })

    it('不經可被改寫之迭代器:裝上「呼叫一次即自我還原」之替身於陣列之迭代方法後呼叫 ⇒ 替身未被呼叫、該次呼叫拋 EVAL_INTEGRITY、評估失敗', () => {
        let ARR_ITER_PROTO = Object.getPrototypeOf([][Symbol.iterator]())
        for (let [o, k] of [[Array.prototype, Symbol.iterator], [Array.prototype, 'values'], [ARR_ITER_PROTO, 'next']]) {
            let called = 0
            let inner = null
            let err = keep([[o, k]], () => errOf(() => evS.evalPolicy(pickTop(0), {
                accept,
                ext: [{
                    name: 'it',
                    fn: (api) => {
                        let a = api.phases.map((p) => p.bars.map(() => ({ short: 1, long: 1 })))
                        let orig = o[k]
                        o[k] = function (...args) {
                            called++
                            o[k] = orig
                            return Reflect.apply(orig, this, args)
                        }
                        try {
                            api.fillRandom(a)
                        }
                        catch (e) {
                            inner = e
                        }
                        finally {
                            o[k] = orig
                        }
                        return { text: 'x' }
                    },
                }],
            })))
            let w = String(k)
            assert.equal(called, 0, `${w}: 替身未被呼叫`)
            assert.equal(inner && inner.code, 'EVAL_INTEGRITY', `${w}: 入口比對`)
            assert.equal(err && err.code, 'EVAL_INTEGRITY', `${w}: 評估失敗`)
        }
    })

    it('函數物件凍結且每個診斷各一份(驗收 7):一個診斷於其上掛屬性、改 call ⇒ 被拒且不影響其後之診斷;api 之函數由九增為十(fillRandom 附於末尾)', () => {
        let seen = []
        let rec = (api) => {
            seen.push(api)
            let a = api.fillRandom(statesOf(api), { draws: 2 })
            return { text: 'rec', call: String(api.fillRandom.call === Function.prototype.call), mark: String(api.fillRandom.mark), a: a.map((s) => s.map((ph) => ph.map((x) => Array.from(x)))) }
        }
        let m = evS.evalPolicy(pickTop(0), {
            accept,
            ext: [
                { name: 'before', fn: rec },
                {
                    name: 'mut',
                    fn: (api) => {
                        let errs = 0
                        for (let prop of ['call', 'apply', 'mark']) {
                            try {
                                api.fillRandom[prop] = () => null
                            }
                            catch (e) {
                                errs += e instanceof TypeError ? 1 : 0
                            }
                        }
                        return { text: 'mut', frozen: Object.isFrozen(api.fillRandom), errs, keys: Object.keys(api).filter((x) => typeof api[x] === 'function') }
                    },
                },
                { name: 'after', fn: rec },
            ],
        })
        for (let k of ['before', 'mut', 'after']) {
            assert.equal(m.ext[k].error, undefined, `${k}: ${m.ext[k].error}`)
        }
        assert.deepEqual([m.ext.mut.frozen, m.ext.mut.errs], [true, 3], '凍結: 掛屬性與改 call 皆被拒(TypeError)')
        assert.deepEqual(m.ext.mut.keys, ['simulate', 'summarize', 'replaceNull', 'sideGroups', 'geoGroups', 'market', 'factor', 'series', 'rand', 'fillRandom'])
        let { ms: _a, ...before } = m.ext.before
        let { ms: _b, ...after } = m.ext.after
        assert.deepEqual(after, before, '前一診斷之改動不影響後一診斷')
        assert.deepEqual([before.call, before.mark], ['true', 'undefined'])
        assert(seen.length === 2 && seen[0].fillRandom !== seen[1].fillRandom, '各診斷各一份函數物件')
    })

    it('重入:於 simulate 之 opts.accept 之內呼叫 ⇒ 照常回傳(與外面之呼叫逐位相同)且外層之重放結果與未呼叫者逐位相同(本函數不進逐訊號模擬)', () => {
        runExt(evS, (api) => {
            let st = statesOf(api)
            let outside = JSON.stringify(api.fillRandom(st, { draws: 2 }).map((s) => s.map((ph) => ph.map((x) => Array.from(x)))))
            let sels = api.phases.map((p) => p.sels)
            let acc = (sig, book) => book.open < 3
            let base = api.simulate(sels, null, { accept: acc })
            let inside = []
            let nested = api.simulate(sels, null, {
                accept: (sig, book) => {
                    if (inside.length < 3) {
                        inside.push(JSON.stringify(api.fillRandom(st, { draws: 2 }).map((s) => s.map((ph) => ph.map((x) => Array.from(x))))))
                    }
                    return acc(sig, book)
                },
            })
            assert.equal(inside.length, 3)
            assert(inside.every((x) => x === outside), '執行規則之內呼叫之結果與外面相同')
            assert.deepStrictEqual(nested, base, '外層之重放不受影響')
            return { text: 'ok' }
        }, pickTop(0))
    })

    it('不影響其他 api 函數與正本之亂數:呼叫前後 replaceNull / rand / simulate 之結果相同;有無呼叫 fillRandom 之診斷, 完整評估之結果(去 ext、ms)逐位相同', () => {
        let strip = (m) => JSON.stringify({ ...m, ext: undefined, ms: undefined })
        let plain = evS.evalPolicy(pickTop(0), { accept, ext: [{ name: 'd', fn: () => ({ text: 'none' }) }] })
        let m = runExt(evS, (api) => {
            let st = statesOf(api)
            let r0 = JSON.stringify(api.replaceNull({ draws: 4 }))
            let g0 = api.rand(2)
            let q0 = [g0(), g0()]
            let s0 = JSON.stringify(api.simulate(api.phases.map((p) => p.sels)))
            api.fillRandom(st, { draws: 16, actDays: 30 })
            api.fillRandom(st)
            assert.equal(JSON.stringify(api.replaceNull({ draws: 4 })), r0)
            let g1 = api.rand(2)
            assert.deepEqual([g1(), g1()], q0)
            assert.equal(JSON.stringify(api.simulate(api.phases.map((p) => p.sels))), s0)
            return { text: 'none' }
        }, pickTop(0))
        assert.equal(strip(m), strip(plain))
    })
})
