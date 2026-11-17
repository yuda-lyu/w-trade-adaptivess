import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { makeEvaluator } from '../../src/eval/evalCore.mjs'


//測試用: 暫存夾與合成之訂單帳本(格式同 src/eval/ledgerBuild.mjs 之輸出, 供 loadLedger 讀取)
//  暫存一律落 test/_tmp/<案名>_<pid>_<亂碼>(gitignore; 各測試於 after 自刪); 測試不寫 ./tmp
export const FD_TEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FD_ROOT = path.resolve(FD_TEST, '..')
export const FD_TMP = path.join(FD_TEST, '_tmp')

export let makeTmp = (name) => {
    let dir = path.join(FD_TMP, `${name}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(dir, { recursive: true })
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

//makeTrainEvaluator, 合成帳本即訓練期帳本(帳本全期 = 訓練期)時建評估器: 未給 L.ntStatic 者依帳本逐策略之進場數(全期)補上, 再呼叫 makeEvaluator
//  makeEvaluator 要求呼叫端明給 L.ntStatic(訓練期之進場數; 未給即拒絕); 此處之計數以逐策略之位置差獨立計算, 不借用 src 之 ntStaticOf(以便驗證它)
export let makeTrainEvaluator = (L, cfg) => {
    if (!L.ntStatic) {
        let nt = new Int32Array(L.n)
        for (let s = 0; s < L.n; s++) {
            nt[s] = L.off[s + 1] - L.off[s]
        }
        L.ntStatic = nt
    }
    return makeEvaluator(L, cfg)
}

let lcg = (seed) => {
    let a = seed >>> 0
    return () => {
        a = (Math.imul(a, 1664525) + 1013904223) >>> 0
        return a / 4294967296
    }
}

let writeBin = (fp, arr) => fs.writeFileSync(fp, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))

//writeSynthLedger, 於 dir 寫出合成帳本; opt: { n(策略數), nBars(K 棒數; 4 小時一根), seed, identical(true = 全部策略之訂單相同), series(外部序列之名稱陣列; 預設無), dense(true = 每隻策略每 1 ~ 3 棒進場一次 ⇒ 任一決策視窗內每個被選之策略皆有訊號, 可由訊號還原選集, 且各策略之累計進場數不同; 預設 false), cut(< nBars 之正整數時: 以 nBars 根生成後只寫出前 cut 根 —— 同 seed 之 cut 帳本 = 較長帳本之前綴〔同一策略庫以較早之終點截斷所建之帳本; 進場棒 ≥ cut 之單不收, 出場棒 ≥ cut 者記為未結〕; meta.nBars = cut; 預設不截斷) }
//  每隻策略: 逐棒以各自之機率進場(同棒至多一單), 持有 1 ~ 40 棒後出場; 出場棒超出帳本者為未結(ext = -1, pnl = 0); 損益為 ±
//  series(規則 R-EV-34): 給名稱者另寫 ser.f64(另用一組亂數, 不動既有欄之內容; 第 1 條序列之前 3 根為缺值)與 meta.seriesNames; 未給者不寫(與舊帳本同)
export let writeSynthLedger = (dir, { n = 60, nBars = 2400, seed = 1, identical = false, series = null, dense = false, cut = 0 } = {}) => {
    fs.mkdirSync(dir, { recursive: true })
    let nOut = Number.isInteger(cut) && cut > 0 && cut < nBars ? cut : nBars //寫出之 K 棒數(生成仍以 nBars 根: 各亂數之取用次序與不截斷者相同)
    let rnd = lcg(seed)
    let off = new Uint32Array(n + 1)
    let ent = []
    let ext = []
    let pnl = []
    let mode = new Int8Array(n)
    //dense: 第 s 隻策略每 (1 + s % 3) 棒進場一次(任一決策視窗內皆有訊號, 且各策略之累計進場數不同 ⇒ 活躍度名次有變化)
    let gen = (r, s = 0) => {
        let p = 0.01 + r() * 0.08
        if (dense) {
            p = 2 //r() < 2 恆真(仍照常取亂數, 與非 dense 之亂數取用次序相同); 進場與否由下列間隔決定
        }
        let es = []
        let xs = []
        let ps = []
        for (let b = 0; b < nBars; b++) {
            if (r() < p && (!dense || b % (1 + (s % 3)) === 0)) {
                let x = b + 1 + Math.floor(r() * 40)
                es.push(b)
                if (x < nBars) {
                    xs.push(x)
                    ps.push(Math.fround((r() - 0.45) * 4))
                }
                else {
                    xs.push(-1)
                    ps.push(0)
                }
            }
        }
        return { es, xs, ps }
    }
    let shared = identical ? gen(lcg(seed + 99)) : null
    for (let s = 0; s < n; s++) {
        off[s] = ent.length
        mode[s] = s % 3 === 0 ? -1 : 1
        let g = shared || gen(rnd, s)
        if (nOut < nBars) {
            //截斷: 進場棒 < nOut 之單照收(g.es 升冪; g.es / g.xs / g.ps 等長); 出場棒 ≥ nOut(或原為未結)者記為未結(ext = -1, pnl = 0)
            for (let i = 0; i < g.es.length && g.es[i] < nOut; i++) {
                let closed = g.xs[i] >= 0 && g.xs[i] < nOut
                ent.push(g.es[i])
                ext.push(closed ? g.xs[i] : -1)
                pnl.push(closed ? g.ps[i] : 0)
            }
        }
        else {
            ent.push(...g.es)
            ext.push(...g.xs)
            pnl.push(...g.ps)
        }
    }
    off[n] = ent.length
    let px = new Float64Array(nBars * 5)
    let c = 100
    for (let i = 0; i < nBars; i++) {
        let o = c
        c = Math.max(1, c + (rnd() - 0.5) * 2)
        px[i * 5] = o
        px[i * 5 + 1] = Math.max(o, c) + rnd()
        px[i * 5 + 2] = Math.min(o, c) - rnd()
        px[i * 5 + 3] = c
        px[i * 5 + 4] = 1000 * rnd()
    }
    let keyOff = new Uint32Array(n + 1)
    let keyIdx = new Uint16Array(n)
    for (let s = 0; s < n; s++) {
        keyOff[s] = s
        keyIdx[s] = s % 2
    }
    keyOff[n] = n
    //進場規則之條件欄與因子序列欄(規則 R-EV-29; 另用一組亂數, 不動既有欄之內容): 2 個因子 × nBars, 因子 1 之前 5 根為缺值
    //  合成帳本之訂單不是由條件算出(逐棒隨機進場), 此處只供驗 ctx.meta 之三欄與 ctx.factor 之取值範圍
    let rf = lcg(seed + 7)
    let keySym = new Int8Array(n)
    let keyTh = new Float64Array(n)
    let keyOr = new Uint8Array(n)
    for (let s = 0; s < n; s++) {
        keySym[s] = s % 4 < 2 ? 1 : -1
        keyTh[s] = rf() - 0.5
        keyOr[s] = 0
    }
    let fac = new Float64Array(2 * nBars)
    for (let i = 0; i < 2 * nBars; i++) {
        fac[i] = rf() * 2 - 1
    }
    fac.fill(NaN, nBars, nBars + 5)
    //逐棒之欄於截斷時只留前 nOut 根(因子 / 序列各自之區段 [i * nBars, i * nBars + nOut))
    let barCut = (a, rows) => {
        if (nOut === nBars) {
            return a
        }
        let out = new Float64Array(rows * nOut)
        for (let i = 0; i < rows; i++) {
            out.set(a.subarray(i * nBars, i * nBars + nOut), i * nOut)
        }
        return out
    }
    writeBin(path.join(dir, 'keySym.i8'), keySym)
    writeBin(path.join(dir, 'keyTh.f64'), keyTh)
    writeBin(path.join(dir, 'keyOr.u8'), keyOr)
    writeBin(path.join(dir, 'fac.f64'), barCut(fac, 2))
    writeBin(path.join(dir, 'off.u32'), off)
    writeBin(path.join(dir, 'ent.i32'), Int32Array.from(ent))
    writeBin(path.join(dir, 'ext.i32'), Int32Array.from(ext))
    writeBin(path.join(dir, 'pnl.f32'), Float32Array.from(pnl))
    writeBin(path.join(dir, 'mode.i8'), mode)
    writeBin(path.join(dir, 'tp.f32'), new Float32Array(n).fill(0.05))
    writeBin(path.join(dir, 'sl.f32'), new Float32Array(n).fill(0.05))
    writeBin(path.join(dir, 'nKeys.u8'), new Uint8Array(n).fill(1))
    writeBin(path.join(dir, 'lv.i32'), new Int32Array(n))
    writeBin(path.join(dir, 'fitNt.i32'), new Int32Array(n))
    writeBin(path.join(dir, 'cls.u8'), new Uint8Array(n * 3))
    writeBin(path.join(dir, 'keyOff.u32'), keyOff)
    writeBin(path.join(dir, 'keyIdx.u16'), keyIdx)
    writeBin(path.join(dir, 'px.f64'), nOut === nBars ? px : px.subarray(0, nOut * 5))
    let seriesNames = Array.isArray(series) && series.length ? series.slice() : null
    if (seriesNames) {
        let rs = lcg(seed + 13)
        let ser = new Float64Array(seriesNames.length * nBars)
        for (let i = 0; i < ser.length; i++) {
            ser[i] = rs() * 100
        }
        ser.fill(NaN, 0, 3)
        writeBin(path.join(dir, 'ser.f64'), barCut(ser, seriesNames.length))
    }
    fs.writeFileSync(path.join(dir, 'ids.json'), JSON.stringify(Array.from({ length: n }, (_, i) => `s${i}.json`)), 'utf8')
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 0, key: `synth${seed}${identical ? 'i' : ''}`, endTime: '2099-01-01T00:00:00', time0: '2022-07-01T00:00:00', barHours: 4, nBars: nOut, nStrategies: n, nOrders: ent.length, keyNames: ['k0', 'k1'], ...(seriesNames ? { seriesNames } : {}) }), 'utf8')
    return { dir, n, nBars: nOut, nOrders: ent.length }
}
